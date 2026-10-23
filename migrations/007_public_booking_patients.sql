ALTER TABLE clinical.booking_inquiries
  ADD COLUMN IF NOT EXISTS patient_id uuid,
  ADD COLUMN IF NOT EXISTS preferred_contact text NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS preferred_time text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS message text NOT NULL DEFAULT '';

ALTER TABLE clinical.booking_inquiries
  DROP CONSTRAINT IF EXISTS booking_inquiries_patient_fkey;

ALTER TABLE clinical.booking_inquiries
  ADD CONSTRAINT booking_inquiries_patient_fkey
  FOREIGN KEY (organization_id, patient_id)
  REFERENCES clinical.patients(organization_id, id);

CREATE INDEX IF NOT EXISTS booking_inquiries_patient_idx
  ON clinical.booking_inquiries(organization_id, location_id, patient_id, created_at DESC);

DROP FUNCTION IF EXISTS clinical.create_public_booking_inquiry(text,text,text,text,text,date,inet,text);

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
  IF v_organization_id IS NULL OR v_location_id IS NULL THEN
    RAISE EXCEPTION 'Booking scope is unavailable';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM clinical.organizations WHERE id=v_organization_id AND status='active')
     OR NOT EXISTS(SELECT 1 FROM clinical.locations WHERE organization_id=v_organization_id AND id=v_location_id AND status='active') THEN
    RAISE EXCEPTION 'Booking destination is unavailable';
  END IF;

  SELECT p.id INTO v_patient_id
  FROM clinical.patients p
  WHERE p.organization_id=v_organization_id
    AND (
      (p_email IS NOT NULL AND p.email IS NOT NULL AND lower(p.email)=lower(p_email))
      OR regexp_replace(p.phone,'[^0-9]','','g')=regexp_replace(p_phone,'[^0-9]','','g')
    )
  ORDER BY (p.location_id=v_location_id) DESC, p.created_at DESC
  LIMIT 1;

  IF v_patient_id IS NULL THEN
    INSERT INTO clinical.patients(organization_id,location_id,first_name,last_name,phone,email,status)
    VALUES(v_organization_id,v_location_id,p_first_name,p_last_name,p_phone,p_email,'new')
    RETURNING id INTO v_patient_id;
  ELSE
    UPDATE clinical.patients
    SET first_name=p_first_name,last_name=p_last_name,phone=p_phone,email=coalesce(p_email,email)
    WHERE organization_id=v_organization_id AND id=v_patient_id;
  END IF;

  INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id)
  VALUES(v_organization_id,v_location_id,v_patient_id)
  ON CONFLICT DO NOTHING;

  INSERT INTO clinical.booking_inquiries(
    organization_id,location_id,patient_id,first_name,last_name,phone,email,
    appointment_type,preferred_date,preferred_contact,preferred_time,message,
    source_ip,user_agent
  ) VALUES(
    v_organization_id,v_location_id,v_patient_id,p_first_name,p_last_name,p_phone,p_email,
    p_appointment_type,p_preferred_date,p_preferred_contact,p_preferred_time,p_message,
    p_source_ip,left(p_user_agent,256)
  ) RETURNING id INTO v_inquiry_id;

  RETURN QUERY SELECT v_inquiry_id,v_patient_id;
END;
$$;

REVOKE ALL ON FUNCTION clinical.create_public_booking_inquiry(text,text,text,text,text,date,text,text,text,inet,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.create_public_booking_inquiry(text,text,text,text,text,date,text,text,text,inet,text) TO kh_request;
