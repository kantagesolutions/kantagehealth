-- A linked clinic may maintain a shared patient's contact details without moving the
-- patient's home clinic or gaining access to another organization's records.
CREATE OR REPLACE FUNCTION clinical.update_linked_patient(
  p_patient_id uuid, p_first_name text, p_last_name text, p_phone text, p_email text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = clinical, pg_temp
AS $$
DECLARE
  v_org uuid := clinical.org_id();
  v_location uuid := clinical.location_id();
BEGIN
  IF v_org IS NULL OR v_location IS NULL OR NOT EXISTS (
    SELECT 1 FROM clinical.patient_locations
    WHERE organization_id = v_org AND location_id = v_location AND patient_id = p_patient_id
  ) THEN
    RAISE EXCEPTION 'Patient not found at this clinic';
  END IF;

  -- Cognito still owns the recovery address of an activated portal account.
  IF EXISTS (
    SELECT 1 FROM clinical.patient_portal_accounts a
    JOIN clinical.patients p ON p.organization_id = a.organization_id AND p.id = a.patient_id
    WHERE a.organization_id = v_org AND a.patient_id = p_patient_id
      AND a.status IN ('invited', 'active')
      AND p.email IS DISTINCT FROM p_email
  ) THEN
    RAISE EXCEPTION 'Portal email cannot be changed here. Contact an administrator to update login recovery.';
  END IF;

  UPDATE clinical.patients
  SET first_name = p_first_name, last_name = p_last_name, phone = p_phone, email = p_email
  WHERE organization_id = v_org AND id = p_patient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patient not found'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION clinical.update_linked_patient(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.update_linked_patient(uuid,text,text,text,text) TO kh_request;

ALTER TABLE clinical.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE clinical.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN (
  'patients.list','patients.read','patients.create','patients.update','patients.search','patients.link',
  'records.read','records.create','appointments.read','appointments.create','appointments.schedule',
  'bookings.read','bookings.match_confirmed','bookings.match_dismissed',
  'documents.read','documents.upload','payments.read','payments.create',
  'locations.read','support.requested','support.approved','support.list','portal.invite','portal.reset',
  'reports.read'
));
