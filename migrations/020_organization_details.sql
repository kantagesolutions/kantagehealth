-- Administrators can correct an organization's name.
--
-- The name is all an organization holds besides its System ID, which is permanent because it identifies
-- the organization, and its status, which has its own audited actions. A clinic's name, address and
-- timezone are edited on the clinic.
--
-- Additive for the API version still serving during the deploy: a new function under a new name, and one
-- more allowed audit action.

-- Renames an organization. Returns the previous name for the audit entry.
CREATE OR REPLACE FUNCTION clinical.platform_update_organization(p_organization_id uuid, p_name text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_previous text;
BEGIN
  IF length(trim(coalesce(p_name,''))) < 2 THEN RAISE EXCEPTION 'Organization name is required'; END IF;
  SELECT name INTO v_previous FROM clinical.organizations WHERE id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organization not found'; END IF;
  UPDATE clinical.organizations SET name=trim(p_name) WHERE id=p_organization_id;
  RETURN v_previous;
END; $$;

ALTER TABLE clinical.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_action_check;
ALTER TABLE clinical.platform_audit_log ADD CONSTRAINT platform_audit_log_action_check CHECK (action IN (
  'organizations.create','organizations.update','organizations.suspend','organizations.activate','organizations.archive','organizations.delete',
  'clinics.create','clinics.update','clinics.deactivate','clinics.activate',
  'staff.invite','staff.update','staff.deactivate','staff.activate','staff.archive','staff.delete'
));

REVOKE ALL ON FUNCTION clinical.platform_update_organization(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.platform_update_organization(uuid,text) TO kh_request;
