CREATE OR REPLACE FUNCTION clinical.platform_create_organization(
  p_slug text,
  p_name text,
  p_clinic_name text,
  p_timezone text,
  p_address text
)
RETURNS TABLE(organization_id uuid, location_id uuid, organization_name text, clinic_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clinical
AS $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_location uuid := gen_random_uuid();
BEGIN
  IF p_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' THEN
    RAISE EXCEPTION 'Organization slug is invalid';
  END IF;
  IF length(trim(p_name)) < 2 OR length(trim(p_clinic_name)) < 2 THEN
    RAISE EXCEPTION 'Organization and clinic names are required';
  END IF;
  INSERT INTO clinical.organizations(id,slug,name,status)
  VALUES(v_org,p_slug,trim(p_name),'active');
  INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status)
  VALUES(v_location,v_org,trim(p_clinic_name),trim(p_timezone),trim(p_address),'active');
  RETURN QUERY SELECT v_org,v_location,trim(p_name),trim(p_clinic_name);
END;
$$;

CREATE OR REPLACE FUNCTION clinical.platform_create_staff(
  p_organization_id uuid,
  p_cognito_subject text,
  p_email text,
  p_name text,
  p_role text,
  p_location_id uuid DEFAULT NULL
)
RETURNS TABLE(user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clinical
AS $$
DECLARE v_user uuid;
BEGIN
  IF p_role NOT IN ('owner','clinician','front_desk','billing','auditor') THEN
    RAISE EXCEPTION 'Staff role is invalid';
  END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM clinical.locations WHERE organization_id=p_organization_id AND id=p_location_id AND status='active'
  ) THEN
    RAISE EXCEPTION 'Clinic assignment is invalid';
  END IF;
  INSERT INTO clinical.users(organization_id,cognito_sub,email,name,status)
  VALUES(p_organization_id,p_cognito_subject,lower(trim(p_email)),trim(p_name),'active')
  ON CONFLICT(organization_id,cognito_sub) DO UPDATE
  SET email=excluded.email,name=excluded.name,status='active'
  RETURNING id INTO v_user;
  INSERT INTO clinical.user_roles(organization_id,user_id,role,location_id)
  VALUES(p_organization_id,v_user,p_role,p_location_id)
  ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT v_user;
END;
$$;

REVOKE ALL ON FUNCTION clinical.platform_create_organization(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_create_staff(uuid,text,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.platform_create_organization(text,text,text,text,text) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_create_staff(uuid,text,text,text,text,uuid) TO kh_request;
