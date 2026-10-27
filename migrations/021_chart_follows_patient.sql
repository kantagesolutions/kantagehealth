-- Patients move between the clinics of their network, and their chart follows them.
--
-- Until now every records table was locked to the clinic that wrote it, so a patient who moved arrived
-- at the new clinic without their history. A clinic linked to a patient now reads that patient's
-- appointments, care records, documents, payments and invoices from every clinic in the organization.
-- Writing is unchanged: a clinic can add to a chart only under its own name. Postgres combines
-- permissive policies with OR, so the new read policy sits beside the existing "scoped" policy and
-- nothing is dropped. Booking requests stay clinic-local: they are operational, not clinical.
--
-- A patient's current clinic is their home location_id. A booking by a recognised returning patient,
-- a confirmed possible match, or a booking from the patient portal moves the home clinic to the clinic
-- they chose and adds a link. Earlier links are kept, so earlier clinics keep reading the care they gave.
--
-- Additive for the API version still serving during the deploy: new policies, a new column with a
-- default, new functions under new names, and replaced functions keep their signatures and results.

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['appointments','care_records','documents','payments','invoices'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS chart_follows_patient ON clinical.%I',t);
    -- patient_locations is itself limited to the caller's clinic, so this reads "linked to my clinic".
    EXECUTE format('CREATE POLICY chart_follows_patient ON clinical.%I FOR SELECT USING (organization_id=(SELECT clinical.org_id()) AND patient_id IN (SELECT pl.patient_id FROM clinical.patient_locations pl))',t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON clinical.%I(organization_id,patient_id)',t||'_patient_idx',t);
  END LOOP;
END $$;

-- Where a booking request came from, so staff and the activity feed can tell them apart.
ALTER TABLE clinical.booking_inquiries ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'website';
ALTER TABLE clinical.booking_inquiries DROP CONSTRAINT IF EXISTS booking_inquiries_source_check;
ALTER TABLE clinical.booking_inquiries ADD CONSTRAINT booking_inquiries_source_check CHECK(source IN ('website','patient_portal'));

-- Every move between clinics, so reports can count patients arriving at and leaving each clinic, and
-- the clinic a patient first joined is known after they move. Written only by move_patient_to_clinic;
-- the request role has no access to the table at all.
CREATE TABLE IF NOT EXISTS clinical.patient_moves (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL,
  reason text NOT NULL CHECK(reason IN ('website_booking','patient_portal_booking','confirmed_match')),
  moved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,patient_id) REFERENCES clinical.patients(organization_id,id),
  FOREIGN KEY(organization_id,from_location_id) REFERENCES clinical.locations(organization_id,id),
  FOREIGN KEY(organization_id,to_location_id) REFERENCES clinical.locations(organization_id,id)
);
CREATE INDEX IF NOT EXISTS patient_moves_patient_idx ON clinical.patient_moves(organization_id,patient_id,moved_at);
ALTER TABLE clinical.patient_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.patient_moves FORCE ROW LEVEL SECURITY;

-- Moves a patient's home clinic and links them there. Every patient is linked to their home clinic
-- when created and links are never removed, so the clinic they leave keeps reading the care it gave.
-- Only called from the functions below; never granted to the request role.
CREATE OR REPLACE FUNCTION clinical.move_patient_to_clinic(p_organization_id uuid, p_patient_id uuid, p_location_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,clinical AS $$
DECLARE v_home uuid;
BEGIN
  SELECT location_id INTO v_home FROM clinical.patients WHERE organization_id=p_organization_id AND id=p_patient_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patient not found'; END IF;
  INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES(p_organization_id,p_location_id,p_patient_id) ON CONFLICT DO NOTHING;
  IF v_home IS DISTINCT FROM p_location_id THEN
    UPDATE clinical.patients SET location_id=p_location_id WHERE organization_id=p_organization_id AND id=p_patient_id;
    INSERT INTO clinical.patient_moves(organization_id,patient_id,from_location_id,to_location_id,reason)
    VALUES(p_organization_id,p_patient_id,v_home,p_location_id,p_reason);
  END IF;
END; $$;
REVOKE ALL ON FUNCTION clinical.move_patient_to_clinic(uuid,uuid,uuid,text) FROM PUBLIC;

-- As migration 018, except that a recognised returning patient now moves to the clinic they booked.
-- Their name, email and phone are still never changed from here.
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
    INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES(v_organization_id,v_location_id,v_patient_id) ON CONFLICT DO NOTHING;
  ELSE
    -- The patient chose this clinic, so their profile moves here. Nothing else about them changes: the
    -- submitted details live on the booking request itself.
    PERFORM clinical.move_patient_to_clinic(v_organization_id,v_patient_id,v_location_id,'website_booking');
  END IF;

  INSERT INTO clinical.booking_inquiries(organization_id,location_id,patient_id,first_name,last_name,phone,email,appointment_type,preferred_date,preferred_contact,preferred_time,message,sms_consent,source_ip,user_agent,possible_match_patient_id)
  VALUES(v_organization_id,v_location_id,v_patient_id,p_first_name,p_last_name,p_phone,p_email,p_appointment_type,p_preferred_date,p_preferred_contact,p_preferred_time,p_message,p_sms_consent,p_source_ip,left(p_user_agent,256),v_possible_match)
  RETURNING id INTO v_inquiry_id;
  INSERT INTO clinical.appointments(organization_id,location_id,patient_id,provider_user_id,service,start_time,duration_minutes,status)
  VALUES(v_organization_id,v_location_id,v_patient_id,NULL,p_appointment_type,NULL,NULL,'requested');
  RETURN QUERY SELECT v_inquiry_id,v_patient_id;
END;
$$;

-- As migration 018, with two changes. Confirming "same patient" moves that patient to this clinic.
-- And the link to this clinic is made before the requested appointment is moved onto them: the
-- appointment's clinic and patient must be linked, so the 018 order failed whenever the existing patient
-- had never been seen at this clinic.
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
  PERFORM clinical.move_patient_to_clinic(v_org,v_existing,v_loc,'confirmed_match');
  UPDATE clinical.booking_inquiries SET patient_id=v_existing,possible_match_patient_id=NULL WHERE id=p_inquiry_id;
  UPDATE clinical.appointments SET patient_id=v_existing WHERE organization_id=v_org AND patient_id=v_new;
  DELETE FROM clinical.patient_locations WHERE organization_id=v_org AND patient_id=v_new;
  DELETE FROM clinical.patients WHERE organization_id=v_org AND id=v_new;
  RETURN v_existing;
END; $$;

-- The clinics a patient can choose from: an organization's active clinics. No patient data, and the
-- API strips the internal ids before anything reaches a browser.
CREATE OR REPLACE FUNCTION clinical.booking_clinics(p_organization_id uuid)
RETURNS TABLE(location_id uuid, name text, address text, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT l.id,l.name,l.address,l.timezone FROM clinical.locations l
  JOIN clinical.organizations o ON o.id=l.organization_id AND o.status='active'
  WHERE l.organization_id=p_organization_id AND l.status='active'
  ORDER BY l.name;
$$;

-- Every clinic in the caller's organization, in or out of service, so a chart can say which clinic
-- gave each piece of care. Names only.
CREATE OR REPLACE FUNCTION clinical.network_clinic_names()
RETURNS TABLE(location_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT l.id,l.name FROM clinical.locations l WHERE l.organization_id=clinical.org_id();
$$;

-- A signed-in patient asks for an appointment at the clinic they choose. The patient is identified by
-- their portal account, so there is no matching on submitted details: the request carries the details
-- already on their record, and their profile moves to the chosen clinic.
CREATE OR REPLACE FUNCTION clinical.create_patient_portal_booking(
  p_organization_id uuid,
  p_actor_sub text,
  p_location_id uuid,
  p_appointment_type text,
  p_preferred_date date,
  p_preferred_contact text,
  p_preferred_time text,
  p_message text,
  p_source_ip inet,
  p_user_agent text
) RETURNS TABLE(inquiry_id uuid, clinic_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_patient uuid; v_first text; v_last text; v_phone text; v_email text; v_sms boolean; v_clinic text; v_inquiry uuid;
BEGIN
  SELECT p.id,p.first_name,p.last_name,p.phone,p.email,pa.sms_consent INTO v_patient,v_first,v_last,v_phone,v_email,v_sms
  FROM clinical.patient_portal_accounts pa JOIN clinical.patients p ON p.organization_id=pa.organization_id AND p.id=pa.patient_id
  WHERE pa.organization_id=p_organization_id AND pa.cognito_sub=p_actor_sub AND pa.status IN ('invited','active');
  IF v_patient IS NULL THEN RAISE EXCEPTION 'Patient profile not found'; END IF;
  SELECT l.name INTO v_clinic FROM clinical.locations l JOIN clinical.organizations o ON o.id=l.organization_id AND o.status='active'
  WHERE l.organization_id=p_organization_id AND l.id=p_location_id AND l.status='active';
  IF v_clinic IS NULL THEN RAISE EXCEPTION 'That clinic is not taking bookings.'; END IF;
  PERFORM set_config('app.current_org',p_organization_id::text,true),set_config('app.current_location',p_location_id::text,true);
  PERFORM clinical.move_patient_to_clinic(p_organization_id,v_patient,p_location_id,'patient_portal_booking');
  INSERT INTO clinical.booking_inquiries(organization_id,location_id,patient_id,first_name,last_name,phone,email,appointment_type,preferred_date,preferred_contact,preferred_time,message,sms_consent,source_ip,user_agent,source)
  VALUES(p_organization_id,p_location_id,v_patient,v_first,v_last,v_phone,v_email,p_appointment_type,p_preferred_date,p_preferred_contact,p_preferred_time,p_message,coalesce(v_sms,false),p_source_ip,left(coalesce(p_user_agent,''),256),'patient_portal')
  RETURNING id INTO v_inquiry;
  INSERT INTO clinical.appointments(organization_id,location_id,patient_id,provider_user_id,service,start_time,duration_minutes,status)
  VALUES(p_organization_id,p_location_id,v_patient,NULL,p_appointment_type,NULL,NULL,'requested');
  RETURN QUERY SELECT v_inquiry,v_clinic;
END; $$;

-- The patient portal home, as migration 010, with the patient's current clinic, their organization, and
-- the clinic of each appointment, so the portal no longer needs a clinic written into its code.
CREATE OR REPLACE FUNCTION clinical.patient_portal_home(p_organization_id uuid,p_actor_sub text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT jsonb_build_object(
    'patient',jsonb_build_object('id',p.id,'firstName',p.first_name,'lastName',p.last_name,'email',p.email,'phone',p.phone),
    'organization',jsonb_build_object('name',o.name),
    'clinic',jsonb_build_object('id',hl.id,'name',hl.name,'address',hl.address,'timezone',hl.timezone),
    'appointments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'service',a.service,'startTime',a.start_time,'durationMinutes',a.duration_minutes,'status',a.status,'clinic',al.name) ORDER BY a.start_time NULLS FIRST)
      FROM clinical.appointments a LEFT JOIN clinical.locations al ON al.organization_id=a.organization_id AND al.id=a.location_id
      WHERE a.organization_id=p.organization_id AND a.patient_id=p.id),'[]'::jsonb),
    'documents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'contentType',d.content_type,'status',d.status,'createdAt',d.created_at) ORDER BY d.created_at DESC) FROM clinical.documents d WHERE d.organization_id=p.organization_id AND d.patient_id=p.id AND d.status='ready'),'[]'::jsonb)
  )
  FROM clinical.patient_portal_accounts pa JOIN clinical.patients p ON p.organization_id=pa.organization_id AND p.id=pa.patient_id
  JOIN clinical.organizations o ON o.id=p.organization_id
  JOIN clinical.locations hl ON hl.organization_id=p.organization_id AND hl.id=p.location_id
  WHERE pa.organization_id=p_organization_id AND pa.cognito_sub=p_actor_sub AND pa.status IN ('invited','active');
$$;

-- The activity feed, as migration 017, now saying whether a booking came from a website or the patient
-- portal. Still only the organization, the clinic and the time; the result columns are unchanged.
CREATE OR REPLACE FUNCTION clinical.platform_activity()
RETURNS TABLE(
  organization_name text,
  location_name text,
  action text,
  occurred_at timestamptz,
  source text,
  actor_name text,
  actor_role text,
  target_label text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clinical
AS $$
  SELECT * FROM (
    SELECT o.name, l.name, a.action, a.at, 'staff'::text,
           coalesce(u.name,'Staff member'), a.actor_role, a.subject_type
      FROM clinical.audit_log a
      JOIN clinical.organizations o ON o.id=a.organization_id
      LEFT JOIN clinical.locations l ON l.organization_id=a.organization_id AND l.id=a.location_id
      LEFT JOIN clinical.users u ON u.organization_id=a.organization_id AND u.id=a.actor_user_id
    UNION ALL
    SELECT coalesce(o.name,'Platform'), NULL, p.action, p.at, 'admin'::text,
           p.actor, 'platform administrator', p.target_label
      FROM clinical.platform_audit_log p
      LEFT JOIN clinical.organizations o ON o.id=p.organization_id
    UNION ALL
    SELECT o.name, l.name, 'bookings.received'::text, b.created_at,
           CASE b.source WHEN 'patient_portal' THEN 'patient portal' ELSE 'website' END,
           CASE b.source WHEN 'patient_portal' THEN 'Patient portal' ELSE 'Public booking form' END,
           'patient request', ''::text
      FROM clinical.booking_inquiries b
      JOIN clinical.organizations o ON o.id=b.organization_id
      LEFT JOIN clinical.locations l ON l.organization_id=b.organization_id AND l.id=b.location_id
  ) events
  ORDER BY 4 DESC
  LIMIT 200;
$$;

REVOKE ALL ON FUNCTION clinical.booking_clinics(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.network_clinic_names() FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.create_patient_portal_booking(uuid,text,uuid,text,date,text,text,text,inet,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.booking_clinics(uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.network_clinic_names() TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.create_patient_portal_booking(uuid,text,uuid,text,date,text,text,text,inet,text) TO kh_request;
