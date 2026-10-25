ALTER TABLE clinical.booking_inquiries
  ADD COLUMN IF NOT EXISTS sms_consent boolean NOT NULL DEFAULT false;

DROP FUNCTION IF EXISTS clinical.create_public_booking_inquiry(text,text,text,text,text,date,text,text,text,inet,text);

CREATE FUNCTION clinical.create_public_booking_inquiry(
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
  v_inquiry_id uuid;
BEGIN
  IF v_organization_id IS NULL OR v_location_id IS NULL THEN RAISE EXCEPTION 'Booking scope is unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM clinical.organizations WHERE id=v_organization_id AND status='active')
     OR NOT EXISTS(SELECT 1 FROM clinical.locations WHERE organization_id=v_organization_id AND id=v_location_id AND status='active') THEN
    RAISE EXCEPTION 'Booking destination is unavailable';
  END IF;
  SELECT p.id INTO v_patient_id FROM clinical.patients p
  WHERE p.organization_id=v_organization_id AND ((p_email IS NOT NULL AND p.email IS NOT NULL AND lower(p.email)=lower(p_email)) OR regexp_replace(p.phone,'[^0-9]','','g')=regexp_replace(p_phone,'[^0-9]','','g'))
  ORDER BY (p.location_id=v_location_id) DESC,p.created_at DESC LIMIT 1;
  IF v_patient_id IS NULL THEN
    INSERT INTO clinical.patients(organization_id,location_id,first_name,last_name,phone,email,status)
    VALUES(v_organization_id,v_location_id,p_first_name,p_last_name,p_phone,p_email,'new') RETURNING id INTO v_patient_id;
  ELSE
    UPDATE clinical.patients SET first_name=p_first_name,last_name=p_last_name,phone=p_phone,email=coalesce(p_email,email)
    WHERE organization_id=v_organization_id AND id=v_patient_id;
  END IF;
  INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES(v_organization_id,v_location_id,v_patient_id) ON CONFLICT DO NOTHING;
  INSERT INTO clinical.booking_inquiries(organization_id,location_id,patient_id,first_name,last_name,phone,email,appointment_type,preferred_date,preferred_contact,preferred_time,message,sms_consent,source_ip,user_agent)
  VALUES(v_organization_id,v_location_id,v_patient_id,p_first_name,p_last_name,p_phone,p_email,p_appointment_type,p_preferred_date,p_preferred_contact,p_preferred_time,p_message,p_sms_consent,p_source_ip,left(p_user_agent,256))
  RETURNING id INTO v_inquiry_id;
  INSERT INTO clinical.appointments(organization_id,location_id,patient_id,provider_user_id,service,start_time,duration_minutes,status)
  VALUES(v_organization_id,v_location_id,v_patient_id,NULL,p_appointment_type,NULL,NULL,'requested');
  RETURN QUERY SELECT v_inquiry_id,v_patient_id;
END;
$$;

REVOKE ALL ON FUNCTION clinical.create_public_booking_inquiry(text,text,text,text,text,date,text,text,text,boolean,inet,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.create_public_booking_inquiry(text,text,text,text,text,date,text,text,text,boolean,inet,text) TO kh_request;

CREATE OR REPLACE FUNCTION clinical.platform_activity()
RETURNS TABLE(organization_name text,location_name text,action text,occurred_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT o.name,l.name,a.action,a.occurred_at
  FROM clinical.audit_log a JOIN clinical.organizations o ON o.id=a.organization_id
  LEFT JOIN clinical.locations l ON l.organization_id=a.organization_id AND l.id=a.location_id
  ORDER BY a.occurred_at DESC LIMIT 100;
$$;
REVOKE ALL ON FUNCTION clinical.platform_activity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.platform_activity() TO kh_request;

ALTER TABLE clinical.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE clinical.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN (
  'patients.list','patients.read','patients.create','patients.search','patients.link',
  'records.read','records.create','appointments.read','appointments.create','appointments.schedule',
  'bookings.read','documents.read','documents.upload','payments.read','payments.create',
  'locations.read','support.requested','support.approved','support.list','portal.invite'
));
