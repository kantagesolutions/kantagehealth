-- An organization can now hold a network of clinics, and staff can be assigned to one clinic or all.
--
-- Until now the only way a clinic came into existence was as the first clinic of a new organization, so
-- a dentist with several practices could not be onboarded as one organization. Administrators can now
-- add clinics, correct their details, and take them in and out of service. Inactive clinics take no
-- bookings, because the booking function already requires an active clinic.
--
-- Additive for the API version still serving during the deploy. New functions use new names rather than
-- overloads: migration 012's leftover overload is what once stopped every staff member signing in.
-- platform_access gains a column, keeping every column the previous version reads.

CREATE OR REPLACE FUNCTION clinical.platform_create_location(
  p_organization_id uuid,
  p_name text,
  p_timezone text,
  p_address text
)
RETURNS TABLE(location_id uuid, clinic_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_location uuid:=gen_random_uuid();
BEGIN
  IF NOT EXISTS(SELECT 1 FROM clinical.organizations WHERE id=p_organization_id AND status IN ('active','suspended')) THEN
    RAISE EXCEPTION 'Clinics can only be added to an active or suspended organization';
  END IF;
  IF length(trim(coalesce(p_name,''))) < 2 THEN RAISE EXCEPTION 'Clinic name is required'; END IF;
  IF EXISTS(SELECT 1 FROM clinical.locations WHERE organization_id=p_organization_id AND lower(trim(name))=lower(trim(p_name))) THEN
    RAISE EXCEPTION 'This organization already has a clinic with that name';
  END IF;
  INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status)
  VALUES(v_location,p_organization_id,trim(p_name),trim(p_timezone),trim(coalesce(p_address,'')),'active');
  RETURN QUERY SELECT v_location,trim(p_name);
END; $$;

-- Corrects a clinic's name, address and timezone. Returns the previous values for the audit entry.
CREATE OR REPLACE FUNCTION clinical.platform_update_location(
  p_organization_id uuid,
  p_location_id uuid,
  p_name text,
  p_timezone text,
  p_address text
)
RETURNS TABLE(previous_name text, previous_timezone text, previous_address text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_name text; v_timezone text; v_address text;
BEGIN
  IF length(trim(coalesce(p_name,''))) < 2 THEN RAISE EXCEPTION 'Clinic name is required'; END IF;
  SELECT name,timezone,address INTO v_name,v_timezone,v_address FROM clinical.locations
  WHERE organization_id=p_organization_id AND id=p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clinic not found'; END IF;
  IF EXISTS(SELECT 1 FROM clinical.locations WHERE organization_id=p_organization_id AND id<>p_location_id AND lower(trim(name))=lower(trim(p_name))) THEN
    RAISE EXCEPTION 'This organization already has a clinic with that name';
  END IF;
  UPDATE clinical.locations SET name=trim(p_name),timezone=trim(p_timezone),address=trim(coalesce(p_address,''))
  WHERE organization_id=p_organization_id AND id=p_location_id;
  RETURN QUERY SELECT v_name,v_timezone,v_address;
END; $$;

-- Takes a clinic out of service or back in. The last active clinic cannot be deactivated: an
-- organization with none would have nowhere for patients to book and nowhere for staff to work.
CREATE OR REPLACE FUNCTION clinical.platform_set_location_status(p_organization_id uuid,p_location_id uuid,p_status text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_name text;
BEGIN
  IF p_status NOT IN ('active','inactive') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  SELECT name INTO v_name FROM clinical.locations WHERE organization_id=p_organization_id AND id=p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clinic not found'; END IF;
  IF p_status='inactive' AND NOT EXISTS(
    SELECT 1 FROM clinical.locations WHERE organization_id=p_organization_id AND id<>p_location_id AND status='active'
  ) THEN
    RAISE EXCEPTION 'This is the organization''s only active clinic. Add or reactivate another clinic first.';
  END IF;
  UPDATE clinical.locations SET status=p_status WHERE organization_id=p_organization_id AND id=p_location_id;
  RETURN v_name;
END; $$;

-- Every clinic in an organization, with what an administrator needs to manage it. Counts only, never
-- patients.
CREATE OR REPLACE FUNCTION clinical.platform_clinics(p_organization_id uuid)
RETURNS TABLE(location_id uuid, name text, address text, timezone text, status text, staff_count bigint, patient_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT l.id,l.name,l.address,l.timezone,l.status,
    (SELECT count(DISTINCT r.user_id) FROM clinical.user_roles r JOIN clinical.users u ON u.organization_id=r.organization_id AND u.id=r.user_id
      WHERE r.organization_id=l.organization_id AND u.status='active' AND (r.location_id IS NULL OR r.location_id=l.id)),
    (SELECT count(*) FROM clinical.patients p WHERE p.organization_id=l.organization_id AND p.location_id=l.id)
  FROM clinical.locations l
  WHERE l.organization_id=p_organization_id
  ORDER BY (l.status='active') DESC,l.name;
$$;

-- Editing a staff member now also sets which clinic they work at. A NULL clinic means every clinic in
-- the organization. New name rather than an overload of platform_update_staff.
CREATE OR REPLACE FUNCTION clinical.platform_update_staff_profile(
  p_organization_id uuid,
  p_user_id uuid,
  p_name text,
  p_email text,
  p_role text,
  p_location_id uuid
)
RETURNS TABLE(previous_name text, previous_email text, previous_roles text[], previous_clinic text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_name text; v_email text; v_roles text[]; v_clinic text;
BEGIN
  IF NOT clinical.assignable_role(p_role) THEN RAISE EXCEPTION 'Staff role is invalid'; END IF;
  IF length(trim(p_name)) < 2 THEN RAISE EXCEPTION 'Staff name is required'; END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM clinical.locations WHERE organization_id=p_organization_id AND id=p_location_id AND status='active'
  ) THEN RAISE EXCEPTION 'Clinic assignment is invalid'; END IF;
  SELECT u.name,u.email INTO v_name,v_email FROM clinical.users u
   WHERE u.organization_id=p_organization_id AND u.id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;
  SELECT coalesce(array_agg(r.role ORDER BY r.role),'{}'),
         CASE WHEN bool_or(r.location_id IS NULL) OR count(*)=0 THEN 'All clinics' ELSE max(l.name) END
    INTO v_roles,v_clinic
    FROM clinical.user_roles r LEFT JOIN clinical.locations l ON l.organization_id=r.organization_id AND l.id=r.location_id
   WHERE r.organization_id=p_organization_id AND r.user_id=p_user_id;
  UPDATE clinical.users SET name=trim(p_name),email=lower(trim(p_email))
   WHERE organization_id=p_organization_id AND id=p_user_id;
  DELETE FROM clinical.user_roles WHERE organization_id=p_organization_id AND user_id=p_user_id;
  INSERT INTO clinical.user_roles(organization_id,user_id,role,location_id) VALUES(p_organization_id,p_user_id,p_role,p_location_id);
  RETURN QUERY SELECT v_name,v_email,v_roles,v_clinic;
END; $$;

-- The access list now says where each person works. Every earlier column is kept, in order.
DROP FUNCTION IF EXISTS clinical.platform_access();
CREATE FUNCTION clinical.platform_access()
RETURNS TABLE(organization_id uuid,user_id uuid,organization_name text,name text,email text,status text,roles text[],location_id uuid,clinic_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT u.organization_id,u.id,o.name,u.name,u.email,u.status,
    coalesce(array_agg(DISTINCT r.role) FILTER(WHERE r.role IS NOT NULL),'{}'),
    CASE WHEN bool_or(r.location_id IS NULL) THEN NULL ELSE max(r.location_id::text)::uuid END,
    CASE WHEN bool_or(r.location_id IS NULL) OR count(r.role)=0 THEN 'All clinics' ELSE max(l.name) END
  FROM clinical.users u JOIN clinical.organizations o ON o.id=u.organization_id
  LEFT JOIN clinical.user_roles r ON r.organization_id=u.organization_id AND r.user_id=u.id
  LEFT JOIN clinical.locations l ON l.organization_id=r.organization_id AND l.id=r.location_id
  GROUP BY u.organization_id,u.id,o.name,u.name,u.email,u.status ORDER BY o.name,u.name;
$$;

ALTER TABLE clinical.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_action_check;
ALTER TABLE clinical.platform_audit_log ADD CONSTRAINT platform_audit_log_action_check CHECK (action IN (
  'organizations.create','organizations.suspend','organizations.activate','organizations.archive','organizations.delete',
  'clinics.create','clinics.update','clinics.deactivate','clinics.activate',
  'staff.invite','staff.update','staff.deactivate','staff.activate','staff.archive','staff.delete'
));

REVOKE ALL ON FUNCTION clinical.platform_create_location(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_update_location(uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_set_location_status(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_clinics(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_update_staff_profile(uuid,uuid,text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.platform_create_location(uuid,text,text,text) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_update_location(uuid,uuid,text,text,text) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_set_location_status(uuid,uuid,text) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_clinics(uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_update_staff_profile(uuid,uuid,text,text,text,uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_access() TO kh_request;
