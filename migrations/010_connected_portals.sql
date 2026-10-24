CREATE TABLE clinical.patient_portal_accounts (
  organization_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  cognito_sub text NOT NULL,
  username text NOT NULL,
  status text NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','active','disabled')),
  email_sent boolean NOT NULL DEFAULT false,
  text_sent boolean NOT NULL DEFAULT false,
  sms_consent boolean NOT NULL DEFAULT false,
  invited_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  PRIMARY KEY(organization_id,patient_id),
  UNIQUE(cognito_sub),
  UNIQUE(username),
  FOREIGN KEY(organization_id,patient_id) REFERENCES clinical.patients(organization_id,id)
);

ALTER TABLE clinical.patient_portal_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.patient_portal_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_portal_org_scope ON clinical.patient_portal_accounts
  USING(organization_id=(SELECT clinical.org_id()))
  WITH CHECK(organization_id=(SELECT clinical.org_id()));
GRANT SELECT,INSERT,UPDATE ON clinical.patient_portal_accounts TO kh_request;

ALTER TABLE clinical.appointments ALTER COLUMN provider_user_id DROP NOT NULL;
ALTER TABLE clinical.appointments ALTER COLUMN start_time DROP NOT NULL;
ALTER TABLE clinical.appointments ALTER COLUMN duration_minutes DROP NOT NULL;
ALTER TABLE clinical.appointments DROP CONSTRAINT IF EXISTS appointments_duration_minutes_check;
ALTER TABLE clinical.appointments ADD CONSTRAINT appointments_duration_minutes_check CHECK(duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 480);
ALTER TABLE clinical.appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE clinical.appointments ADD CONSTRAINT appointments_status_check CHECK(status IN ('requested','confirmed','completed','cancelled','no_show'));

ALTER TABLE clinical.booking_inquiries
  ADD COLUMN IF NOT EXISTS activation_status text NOT NULL DEFAULT 'pending' CHECK(activation_status IN ('pending','invited','partial','failed'));

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
  WHERE p.organization_id=v_organization_id AND (
    (p_email IS NOT NULL AND p.email IS NOT NULL AND lower(p.email)=lower(p_email))
    OR regexp_replace(p.phone,'[^0-9]','','g')=regexp_replace(p_phone,'[^0-9]','','g')
  ) ORDER BY (p.location_id=v_location_id) DESC,p.created_at DESC LIMIT 1;
  IF v_patient_id IS NULL THEN
    INSERT INTO clinical.patients(organization_id,location_id,first_name,last_name,phone,email,status)
    VALUES(v_organization_id,v_location_id,p_first_name,p_last_name,p_phone,p_email,'new') RETURNING id INTO v_patient_id;
  ELSE
    UPDATE clinical.patients SET first_name=p_first_name,last_name=p_last_name,phone=p_phone,email=coalesce(p_email,email)
    WHERE organization_id=v_organization_id AND id=v_patient_id;
  END IF;
  INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id)
  VALUES(v_organization_id,v_location_id,v_patient_id) ON CONFLICT DO NOTHING;
  INSERT INTO clinical.booking_inquiries(organization_id,location_id,patient_id,first_name,last_name,phone,email,appointment_type,preferred_date,preferred_contact,preferred_time,message,source_ip,user_agent)
  VALUES(v_organization_id,v_location_id,v_patient_id,p_first_name,p_last_name,p_phone,p_email,p_appointment_type,p_preferred_date,p_preferred_contact,p_preferred_time,p_message,p_source_ip,left(p_user_agent,256))
  RETURNING id INTO v_inquiry_id;
  INSERT INTO clinical.appointments(organization_id,location_id,patient_id,provider_user_id,service,start_time,duration_minutes,status)
  VALUES(v_organization_id,v_location_id,v_patient_id,NULL,p_appointment_type,NULL,NULL,'requested');
  RETURN QUERY SELECT v_inquiry_id,v_patient_id;
END;
$$;

CREATE OR REPLACE FUNCTION clinical.patient_portal_home(p_organization_id uuid,p_actor_sub text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT jsonb_build_object(
    'patient',jsonb_build_object('id',p.id,'firstName',p.first_name,'lastName',p.last_name,'email',p.email,'phone',p.phone),
    'appointments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'service',a.service,'startTime',a.start_time,'durationMinutes',a.duration_minutes,'status',a.status) ORDER BY a.start_time NULLS FIRST) FROM clinical.appointments a WHERE a.organization_id=p.organization_id AND a.patient_id=p.id),'[]'::jsonb),
    'documents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'contentType',d.content_type,'status',d.status,'createdAt',d.created_at) ORDER BY d.created_at DESC) FROM clinical.documents d WHERE d.organization_id=p.organization_id AND d.patient_id=p.id AND d.status='ready'),'[]'::jsonb)
  )
  FROM clinical.patient_portal_accounts pa JOIN clinical.patients p ON p.organization_id=pa.organization_id AND p.id=pa.patient_id
  WHERE pa.organization_id=p_organization_id AND pa.cognito_sub=p_actor_sub AND pa.status IN ('invited','active');
$$;
REVOKE ALL ON FUNCTION clinical.patient_portal_home(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.patient_portal_home(uuid,text) TO kh_request;

CREATE OR REPLACE FUNCTION clinical.platform_clients()
RETURNS TABLE(organization_id uuid,name text,slug text,status text,clinic_count bigint,staff_count bigint,patient_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT o.id,o.name,o.slug,o.status,
    (SELECT count(*) FROM clinical.locations l WHERE l.organization_id=o.id),
    (SELECT count(*) FROM clinical.users u WHERE u.organization_id=o.id),
    (SELECT count(*) FROM clinical.patients p WHERE p.organization_id=o.id)
  FROM clinical.organizations o ORDER BY o.name;
$$;
CREATE OR REPLACE FUNCTION clinical.platform_access()
RETURNS TABLE(organization_id uuid,user_id uuid,organization_name text,name text,email text,status text,roles text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT u.organization_id,u.id,o.name,u.name,u.email,u.status,coalesce(array_agg(DISTINCT r.role) FILTER(WHERE r.role IS NOT NULL),'{}')
  FROM clinical.users u JOIN clinical.organizations o ON o.id=u.organization_id
  LEFT JOIN clinical.user_roles r ON r.organization_id=u.organization_id AND r.user_id=u.id
  GROUP BY u.organization_id,u.id,o.name,u.name,u.email,u.status ORDER BY o.name,u.name;
$$;
CREATE OR REPLACE FUNCTION clinical.platform_set_organization_status(p_organization_id uuid,p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
BEGIN
  IF p_status NOT IN ('active','suspended') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE clinical.organizations SET status=p_status WHERE id=p_organization_id;
  RETURN FOUND;
END; $$;
CREATE OR REPLACE FUNCTION clinical.platform_set_user_status(p_organization_id uuid,p_user_id uuid,p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
BEGIN
  IF p_status NOT IN ('active','inactive') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE clinical.users SET status=p_status WHERE organization_id=p_organization_id AND id=p_user_id;
  RETURN FOUND;
END; $$;
REVOKE ALL ON FUNCTION clinical.platform_clients() FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_access() FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_set_organization_status(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_set_user_status(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.platform_clients() TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_access() TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_set_organization_status(uuid,text) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_set_user_status(uuid,uuid,text) TO kh_request;

ALTER TABLE clinical.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE clinical.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN (
  'patients.list','patients.read','patients.create','patients.search','patients.link',
  'records.read','records.create','appointments.read','appointments.create','appointments.schedule',
  'bookings.read','documents.read','documents.upload','payments.read','payments.create',
  'locations.read','support.requested','support.approved','support.list'
));
