CREATE TABLE clinical.booking_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  first_name text NOT NULL CHECK(length(first_name) BETWEEN 1 AND 100),
  last_name text NOT NULL CHECK(length(last_name) BETWEEN 1 AND 100),
  phone text NOT NULL CHECK(length(phone) BETWEEN 7 AND 40),
  email text CHECK(email IS NULL OR length(email) BETWEEN 3 AND 254),
  appointment_type text NOT NULL CHECK(length(appointment_type) BETWEEN 1 AND 160),
  preferred_date date,
  status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','scheduled','declined','spam')),
  source_ip inet,
  user_agent text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id)
);
ALTER TABLE clinical.booking_inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.booking_inquiries FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON clinical.booking_inquiries USING (organization_id=(SELECT clinical.org_id()) AND location_id=(SELECT clinical.location_id())) WITH CHECK (organization_id=(SELECT clinical.org_id()) AND location_id=(SELECT clinical.location_id()));
CREATE INDEX booking_inquiries_scope_created_idx ON clinical.booking_inquiries(organization_id,location_id,status,created_at DESC);
GRANT SELECT,UPDATE ON clinical.booking_inquiries TO kh_request;

CREATE FUNCTION clinical.create_public_booking_inquiry(
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_email text,
  p_appointment_type text,
  p_preferred_date date,
  p_source_ip inet,
  p_user_agent text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=clinical,pg_temp
AS $$
DECLARE
  v_organization_id uuid:=clinical.org_id();
  v_location_id uuid:=clinical.location_id();
  v_id uuid;
BEGIN
  IF v_organization_id IS NULL OR v_location_id IS NULL THEN
    RAISE EXCEPTION 'Booking scope is unavailable';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM clinical.organizations WHERE id=v_organization_id AND status='active')
     OR NOT EXISTS(SELECT 1 FROM clinical.locations WHERE organization_id=v_organization_id AND id=v_location_id AND status='active') THEN
    RAISE EXCEPTION 'Booking destination is unavailable';
  END IF;
  INSERT INTO clinical.booking_inquiries(organization_id,location_id,first_name,last_name,phone,email,appointment_type,preferred_date,source_ip,user_agent)
  VALUES(v_organization_id,v_location_id,p_first_name,p_last_name,p_phone,p_email,p_appointment_type,p_preferred_date,p_source_ip,left(p_user_agent,256))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION clinical.create_public_booking_inquiry(text,text,text,text,text,date,inet,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.create_public_booking_inquiry(text,text,text,text,text,date,inet,text) TO kh_request;
