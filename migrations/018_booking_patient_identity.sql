-- An anonymous booking can no longer change an existing patient's record.
--
-- Until now a public booking matched an existing patient by email OR phone alone, then overwrote that
-- patient's name, phone and email with whatever the form submitted. Anyone who knew a patient's phone
-- number could book with their own email, take over the record's contact details, and, once staff
-- enabled portal access, receive the activation email and the patient's documents.
--
-- Now a booking is treated as the same patient only on a strong match: first name, last name, email and
-- phone all agree with one patient. Even then nothing about that patient is changed. Anything weaker
-- creates a new patient, and the closest existing patient is recorded on the booking request so staff
-- can decide. A parent booking for a child usually shares the email and phone but not the first name,
-- so families stay separate instead of being merged into one chart.
--
-- Additive for the API version still serving during the deploy: the booking function keeps its
-- signature and result, and the new column is nullable.

ALTER TABLE clinical.booking_inquiries ADD COLUMN IF NOT EXISTS possible_match_patient_id uuid;
ALTER TABLE clinical.booking_inquiries DROP CONSTRAINT IF EXISTS booking_inquiries_possible_match_fkey;
ALTER TABLE clinical.booking_inquiries ADD CONSTRAINT booking_inquiries_possible_match_fkey
  FOREIGN KEY (organization_id, possible_match_patient_id) REFERENCES clinical.patients(organization_id, id);

CREATE OR REPLACE FUNCTION clinical.create_public_booking_inquiry(
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text,
  p_appointment_type text,
  p_preferred_date date,
  p_preferred_contact text,
  p_preferred_time text,
  p_message text,
  p_sms_consent boolean,
  p_source_ip inet,
  p_user_agent text
) RETURNS TABLE(inquiry_id uuid, patient_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=clinical,pg_temp
AS $$
DECLARE
  v_organization_id uuid:=clinical.org_id();
  v_location_id uuid:=clinical.location_id();
  v_patient_id uuid;
  v_possible_match uuid;
  v_inquiry_id uuid;
  v_phone text:=regexp_replace(coalesce(p_phone,''),'[^0-9]','','g');
BEGIN
  IF v_organization_id IS NULL OR v_location_id IS NULL THEN RAISE EXCEPTION 'Booking scope is unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM clinical.organizations WHERE id=v_organization_id AND status='active')
     OR NOT EXISTS(SELECT 1 FROM clinical.locations WHERE organization_id=v_organization_id AND id=v_location_id AND status='active') THEN
    RAISE EXCEPTION 'Booking destination is unavailable';
  END IF;

  -- Strong match: the same person by name, email and phone.
  SELECT p.id INTO v_patient_id FROM clinical.patients p
  WHERE p.organization_id=v_organization_id
    AND p_email IS NOT NULL AND p.email IS NOT NULL AND lower(trim(p.email))=lower(trim(p_email))
    AND v_phone<>'' AND regexp_replace(p.phone,'[^0-9]','','g')=v_phone
    AND lower(trim(p.first_name))=lower(trim(p_first_name))
    AND lower(trim(p.last_name))=lower(trim(p_last_name))
  -- Established records before ones that anonymous bookings created, then the oldest. Preferring the
  -- newest would let a record someone else created with these details outrank the real patient.
  ORDER BY (p.status='new') ASC,p.created_at ASC LIMIT 1;

  IF v_patient_id IS NULL THEN
    -- Not certainly the same person. Note the closest existing patient for staff, then create a new one.
    -- Closest means the most details in common, then established over booking-created, then oldest.
    -- Ranking by recency instead would put a record an attacker created with a patient's phone number
    -- ahead of the real patient, and staff confirming "same patient" would merge into the attacker's.
    SELECT p.id INTO v_possible_match FROM clinical.patients p
    WHERE p.organization_id=v_organization_id
      AND ((p_email IS NOT NULL AND p.email IS NOT NULL AND lower(trim(p.email))=lower(trim(p_email)))
        OR (v_phone<>'' AND regexp_replace(p.phone,'[^0-9]','','g')=v_phone))
    ORDER BY ((p_email IS NOT NULL AND p.email IS NOT NULL AND lower(trim(p.email))=lower(trim(p_email)))::int
              + (v_phone<>'' AND regexp_replace(p.phone,'[^0-9]','','g')=v_phone)::int
              + (lower(trim(p.last_name))=lower(trim(p_last_name)))::int
              + (lower(trim(p.first_name))=lower(trim(p_first_name)))::int) DESC,
             (p.status='new') ASC,p.created_at ASC
    LIMIT 1;
    INSERT INTO clinical.patients(organization_id,location_id,first_name,last_name,phone,email,status)
    VALUES(v_organization_id,v_location_id,p_first_name,p_last_name,p_phone,p_email,'new') RETURNING id INTO v_patient_id;
  END IF;
  -- An existing patient's details are never changed from here: the submitted details live on the
  -- booking request itself.

  INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES(v_organization_id,v_location_id,v_patient_id) ON CONFLICT DO NOTHING;
  INSERT INTO clinical.booking_inquiries(organization_id,location_id,patient_id,first_name,last_name,phone,email,appointment_type,preferred_date,preferred_contact,preferred_time,message,sms_consent,source_ip,user_agent,possible_match_patient_id)
  VALUES(v_organization_id,v_location_id,v_patient_id,p_first_name,p_last_name,p_phone,p_email,p_appointment_type,p_preferred_date,p_preferred_contact,p_preferred_time,p_message,p_sms_consent,p_source_ip,left(p_user_agent,256),v_possible_match)
  RETURNING id INTO v_inquiry_id;
  INSERT INTO clinical.appointments(organization_id,location_id,patient_id,provider_user_id,service,start_time,duration_minutes,status)
  VALUES(v_organization_id,v_location_id,v_patient_id,NULL,p_appointment_type,NULL,NULL,'requested');
  RETURN QUERY SELECT v_inquiry_id,v_patient_id;
END;
$$;

-- What staff see about a possible match: who, at which clinic, and which detail matched. Limited to
-- booking requests at the caller's own clinic.
CREATE OR REPLACE FUNCTION clinical.booking_possible_matches()
RETURNS TABLE(inquiry_id uuid, match_name text, match_clinic text, matched_on text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT b.id, concat_ws(' ',p.first_name,p.last_name), l.name,
         concat_ws(' and ',
           CASE WHEN b.email IS NOT NULL AND p.email IS NOT NULL AND lower(trim(b.email))=lower(trim(p.email)) THEN 'email' END,
           CASE WHEN regexp_replace(b.phone,'[^0-9]','','g')=regexp_replace(p.phone,'[^0-9]','','g') THEN 'phone' END)
  FROM clinical.booking_inquiries b
  JOIN clinical.patients p ON p.organization_id=b.organization_id AND p.id=b.possible_match_patient_id
  JOIN clinical.locations l ON l.organization_id=p.organization_id AND l.id=p.location_id
  WHERE b.organization_id=clinical.org_id() AND b.location_id=clinical.location_id();
$$;

-- Staff decide a possible match. "Same patient" moves the booking request and its requested appointment
-- to the existing patient, links them to this clinic, and removes the new record, which holds nothing
-- else. It refuses if staff have already added anything to the new record. "Different person" clears it.
CREATE OR REPLACE FUNCTION clinical.resolve_booking_match(p_inquiry_id uuid, p_same_patient boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_org uuid:=clinical.org_id(); v_loc uuid:=clinical.location_id(); v_new uuid; v_existing uuid;
BEGIN
  SELECT patient_id,possible_match_patient_id INTO v_new,v_existing FROM clinical.booking_inquiries
  WHERE id=p_inquiry_id AND organization_id=v_org AND location_id=v_loc FOR UPDATE;
  IF v_new IS NULL THEN RAISE EXCEPTION 'Booking request not found'; END IF;
  IF v_existing IS NULL THEN RAISE EXCEPTION 'This booking request has no possible match'; END IF;
  IF NOT p_same_patient THEN
    UPDATE clinical.booking_inquiries SET possible_match_patient_id=NULL WHERE id=p_inquiry_id;
    RETURN v_new;
  END IF;
  IF EXISTS(SELECT 1 FROM clinical.care_records WHERE organization_id=v_org AND patient_id=v_new)
     OR EXISTS(SELECT 1 FROM clinical.documents WHERE organization_id=v_org AND patient_id=v_new)
     OR EXISTS(SELECT 1 FROM clinical.payments WHERE organization_id=v_org AND patient_id=v_new)
     OR EXISTS(SELECT 1 FROM clinical.invoices WHERE organization_id=v_org AND patient_id=v_new)
     OR EXISTS(SELECT 1 FROM clinical.patient_portal_accounts WHERE organization_id=v_org AND patient_id=v_new)
     OR EXISTS(SELECT 1 FROM clinical.appointments WHERE organization_id=v_org AND patient_id=v_new AND status<>'requested')
     OR EXISTS(SELECT 1 FROM clinical.booking_inquiries WHERE organization_id=v_org AND patient_id=v_new AND id<>p_inquiry_id) THEN
    RAISE EXCEPTION 'This record already has its own history, so it cannot be merged automatically.';
  END IF;
  UPDATE clinical.booking_inquiries SET patient_id=v_existing,possible_match_patient_id=NULL WHERE id=p_inquiry_id;
  UPDATE clinical.appointments SET patient_id=v_existing WHERE organization_id=v_org AND patient_id=v_new;
  INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES(v_org,v_loc,v_existing) ON CONFLICT DO NOTHING;
  DELETE FROM clinical.patient_locations WHERE organization_id=v_org AND patient_id=v_new;
  DELETE FROM clinical.patients WHERE organization_id=v_org AND id=v_new;
  RETURN v_existing;
END; $$;

ALTER TABLE clinical.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE clinical.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN (
  'patients.list','patients.read','patients.create','patients.search','patients.link',
  'records.read','records.create','appointments.read','appointments.create','appointments.schedule',
  'bookings.read','bookings.match_confirmed','bookings.match_dismissed',
  'documents.read','documents.upload','payments.read','payments.create',
  'locations.read','support.requested','support.approved','support.list','portal.invite'
));

REVOKE ALL ON FUNCTION clinical.booking_possible_matches() FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.resolve_booking_match(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.booking_possible_matches() TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.resolve_booking_match(uuid,boolean) TO kh_request;
