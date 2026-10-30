-- Platform administrators may permanently delete only an empty patient shell.
-- Clinical, financial, booking and movement history is never cascaded away. The UI reads the
-- counts below, but the delete function repeats the checks while holding a row lock so a stale UI
-- or concurrent write cannot bypass them. Disabled portal identities may be cleaned up with the
-- empty shell; active identities must be removed through the existing audited login-removal flow.

ALTER TABLE clinical.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_action_check;
ALTER TABLE clinical.platform_audit_log ADD CONSTRAINT platform_audit_log_action_check CHECK (action IN (
  'organizations.create','organizations.update','organizations.suspend','organizations.activate','organizations.archive','organizations.delete',
  'clinics.create','clinics.update','clinics.deactivate','clinics.activate',
  'staff.invite','staff.update','staff.deactivate','staff.activate','staff.archive','staff.delete','staff.login_remove',
  'patients.login_remove','patients.delete'
));

CREATE FUNCTION clinical.platform_patients(p_organization_id uuid)
RETURNS TABLE(patient_id uuid,name text,email text,phone text,username text,portal_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT p.id,concat_ws(' ',p.first_name,p.last_name),p.email,p.phone,a.username,a.status
  FROM clinical.patients p
  LEFT JOIN clinical.patient_portal_accounts a
    ON a.organization_id=p.organization_id AND a.patient_id=p.id
  WHERE p.organization_id=p_organization_id
  ORDER BY p.last_name,p.first_name,p.id;
$$;

CREATE FUNCTION clinical.platform_patient_records(p_organization_id uuid,p_patient_id uuid)
RETURNS TABLE(appointments bigint,clinical_records bigint,documents bigint,billing bigint,
              booking_requests bigint,moves bigint,active_portal bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT
    (SELECT count(*) FROM clinical.appointments WHERE organization_id=p_organization_id AND patient_id=p_patient_id),
    (SELECT count(*) FROM clinical.care_records WHERE organization_id=p_organization_id AND patient_id=p_patient_id),
    (SELECT count(*) FROM clinical.documents WHERE organization_id=p_organization_id AND patient_id=p_patient_id),
    (SELECT count(*) FROM clinical.payments WHERE organization_id=p_organization_id AND patient_id=p_patient_id)
      + (SELECT count(*) FROM clinical.invoices WHERE organization_id=p_organization_id AND patient_id=p_patient_id)
      + (SELECT count(*) FROM clinical.payment_plans WHERE organization_id=p_organization_id AND patient_id=p_patient_id),
    (SELECT count(*) FROM clinical.booking_inquiries WHERE organization_id=p_organization_id
       AND (patient_id=p_patient_id OR possible_match_patient_id=p_patient_id)),
    (SELECT count(*) FROM clinical.patient_moves WHERE organization_id=p_organization_id AND patient_id=p_patient_id),
    (SELECT count(*) FROM clinical.patient_portal_accounts WHERE organization_id=p_organization_id
       AND patient_id=p_patient_id AND status IN ('invited','active'));
$$;

CREATE FUNCTION clinical.platform_delete_patient(p_organization_id uuid,p_patient_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_name text; r record;
BEGIN
  SELECT concat_ws(' ',first_name,last_name) INTO v_name
  FROM clinical.patients
  WHERE organization_id=p_organization_id AND id=p_patient_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patient not found'; END IF;

  SELECT * INTO r FROM clinical.platform_patient_records(p_organization_id,p_patient_id);
  IF r.active_portal > 0 THEN
    RAISE EXCEPTION 'Remove this patient''s portal sign in before deleting the patient.';
  END IF;
  IF r.appointments + r.clinical_records + r.documents + r.billing + r.booking_requests + r.moves > 0 THEN
    RAISE EXCEPTION 'This patient has records that must be kept and cannot be deleted.';
  END IF;

  DELETE FROM clinical.patient_portal_accounts
  WHERE organization_id=p_organization_id AND patient_id=p_patient_id;
  DELETE FROM clinical.patient_locations
  WHERE organization_id=p_organization_id AND patient_id=p_patient_id;
  DELETE FROM clinical.patients
  WHERE organization_id=p_organization_id AND id=p_patient_id;
  RETURN v_name;
END; $$;

REVOKE ALL ON FUNCTION clinical.platform_patients(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_patient_records(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_delete_patient(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.platform_patients(uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_patient_records(uuid,uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_delete_patient(uuid,uuid) TO kh_request;
