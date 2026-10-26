-- Suspend, archive, restore and delete for organizations and staff.
--
-- Dental records must be kept for years, and the audit trail must survive the things it describes.
-- So deleting is permanent only when there is nothing to keep: no patients, no clinical or financial
-- records, no staff activity. Anything holding records is archived instead: hidden, all access cut,
-- data retained, and restorable. Every foreign key into organizations, clinics and staff is
-- NO ACTION, so the database itself also refuses a delete that would take records with it.
--
-- Additive for the API version still serving during the deploy: existing statuses and function
-- signatures keep working, and the new ones are only reached by the new version.

ALTER TABLE clinical.organizations DROP CONSTRAINT IF EXISTS organizations_status_check;
ALTER TABLE clinical.organizations ADD CONSTRAINT organizations_status_check
  CHECK (status IN ('provisioning','active','suspended','archived'));
ALTER TABLE clinical.users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE clinical.users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active','inactive','archived'));

-- An organization's own audit history would otherwise block its deletion. The entry survives with its
-- name in target_label; only the reference is cleared.
ALTER TABLE clinical.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_organization_id_fkey;
ALTER TABLE clinical.platform_audit_log ADD CONSTRAINT platform_audit_log_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES clinical.organizations(id) ON DELETE SET NULL;

ALTER TABLE clinical.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_action_check;
ALTER TABLE clinical.platform_audit_log ADD CONSTRAINT platform_audit_log_action_check CHECK (action IN (
  'organizations.create','organizations.suspend','organizations.activate','organizations.archive','organizations.delete',
  'clinics.create',
  'staff.invite','staff.update','staff.deactivate','staff.activate','staff.archive','staff.delete'
));

-- Same signatures as migration 010; each now also accepts 'archived'.
CREATE OR REPLACE FUNCTION clinical.platform_set_organization_status(p_organization_id uuid,p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
BEGIN
  IF p_status NOT IN ('active','suspended','archived') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE clinical.organizations SET status=p_status WHERE id=p_organization_id;
  RETURN FOUND;
END; $$;
CREATE OR REPLACE FUNCTION clinical.platform_set_user_status(p_organization_id uuid,p_user_id uuid,p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
BEGIN
  IF p_status NOT IN ('active','inactive','archived') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  UPDATE clinical.users SET status=p_status WHERE organization_id=p_organization_id AND id=p_user_id;
  RETURN FOUND;
END; $$;

-- What an organization holds that must be kept. All zero means it can be deleted permanently.
CREATE OR REPLACE FUNCTION clinical.platform_organization_records(p_organization_id uuid)
RETURNS TABLE(staff bigint, patients bigint, appointments bigint, clinical_records bigint, documents bigint,
              billing bigint, booking_requests bigint, activity bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT
    (SELECT count(*) FROM clinical.users WHERE organization_id=p_organization_id),
    (SELECT count(*) FROM clinical.patients WHERE organization_id=p_organization_id)
      + (SELECT count(*) FROM clinical.patient_portal_accounts WHERE organization_id=p_organization_id),
    (SELECT count(*) FROM clinical.appointments WHERE organization_id=p_organization_id),
    (SELECT count(*) FROM clinical.care_records WHERE organization_id=p_organization_id),
    (SELECT count(*) FROM clinical.documents WHERE organization_id=p_organization_id),
    (SELECT count(*) FROM clinical.payments WHERE organization_id=p_organization_id)
      + (SELECT count(*) FROM clinical.invoices WHERE organization_id=p_organization_id)
      + (SELECT count(*) FROM clinical.payment_plans WHERE organization_id=p_organization_id),
    (SELECT count(*) FROM clinical.booking_inquiries WHERE organization_id=p_organization_id),
    (SELECT count(*) FROM clinical.audit_log WHERE organization_id=p_organization_id)
      + (SELECT count(*) FROM clinical.support_access_sessions WHERE organization_id=p_organization_id)
      + (SELECT count(*) FROM clinical.tasks WHERE organization_id=p_organization_id);
$$;

-- Permanently removes an organization that holds nothing to keep, with its clinics and configuration.
-- Refuses otherwise. Returns the name for the audit entry.
CREATE OR REPLACE FUNCTION clinical.platform_delete_organization(p_organization_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_name text; r record;
BEGIN
  SELECT name INTO v_name FROM clinical.organizations WHERE id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organization not found'; END IF;
  SELECT * INTO r FROM clinical.platform_organization_records(p_organization_id);
  IF r.staff + r.patients + r.appointments + r.clinical_records + r.documents + r.billing + r.booking_requests + r.activity > 0 THEN
    RAISE EXCEPTION 'This organization has records that must be kept. Archive it instead.';
  END IF;
  DELETE FROM clinical.appointment_types WHERE organization_id=p_organization_id;
  DELETE FROM clinical.office_hours WHERE organization_id=p_organization_id;
  DELETE FROM clinical.operatories WHERE organization_id=p_organization_id;
  DELETE FROM clinical.providers WHERE organization_id=p_organization_id;
  DELETE FROM clinical.location_members WHERE organization_id=p_organization_id;
  DELETE FROM clinical.organization_members WHERE organization_id=p_organization_id;
  DELETE FROM clinical.subscriptions WHERE organization_id=p_organization_id;
  DELETE FROM clinical.locations WHERE organization_id=p_organization_id;
  DELETE FROM clinical.organizations WHERE id=p_organization_id;
  RETURN v_name;
END; $$;

-- What a staff member has done that must be kept. All zero means they can be deleted permanently.
CREATE OR REPLACE FUNCTION clinical.platform_staff_records(p_organization_id uuid,p_user_id uuid)
RETURNS TABLE(activity bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT
    (SELECT count(*) FROM clinical.audit_log WHERE organization_id=p_organization_id AND actor_user_id=p_user_id)
    + (SELECT count(*) FROM clinical.appointments WHERE organization_id=p_organization_id AND provider_user_id=p_user_id)
    + (SELECT count(*) FROM clinical.care_records WHERE organization_id=p_organization_id AND provider_user_id=p_user_id)
    + (SELECT count(*) FROM clinical.tasks WHERE organization_id=p_organization_id AND assigned_user_id=p_user_id)
    + (SELECT count(*) FROM clinical.support_access_sessions WHERE organization_id=p_organization_id
         AND (requested_by_user_id=p_user_id OR approved_by_user_id=p_user_id));
$$;

-- Permanently removes a staff member who has never acted, with their roles and memberships.
-- Refuses otherwise. Returns the name for the audit entry.
CREATE OR REPLACE FUNCTION clinical.platform_delete_staff(p_organization_id uuid,p_user_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_name text; v_activity bigint;
BEGIN
  SELECT name INTO v_name FROM clinical.users WHERE organization_id=p_organization_id AND id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;
  SELECT activity INTO v_activity FROM clinical.platform_staff_records(p_organization_id,p_user_id);
  IF v_activity > 0 THEN
    RAISE EXCEPTION 'This staff member has activity that must be kept. Archive them instead.';
  END IF;
  DELETE FROM clinical.user_roles WHERE organization_id=p_organization_id AND user_id=p_user_id;
  DELETE FROM clinical.user_capabilities WHERE organization_id=p_organization_id AND user_id=p_user_id;
  DELETE FROM clinical.location_members WHERE organization_id=p_organization_id AND user_id=p_user_id;
  DELETE FROM clinical.organization_members WHERE organization_id=p_organization_id AND user_id=p_user_id;
  DELETE FROM clinical.providers WHERE organization_id=p_organization_id AND user_id=p_user_id;
  DELETE FROM clinical.users WHERE organization_id=p_organization_id AND id=p_user_id;
  RETURN v_name;
END; $$;

REVOKE ALL ON FUNCTION clinical.platform_organization_records(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_delete_organization(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_staff_records(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_delete_staff(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.platform_organization_records(uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_delete_organization(uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_staff_records(uuid,uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_delete_staff(uuid,uuid) TO kh_request;
