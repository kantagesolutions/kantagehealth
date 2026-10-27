-- Removing a sign in identity preserves the clinical chart, staff history, and audit trail.
-- These definer functions give platform administration narrowly scoped access despite forced RLS.
-- Archived usernames must not reserve a Cognito name forever. Live accounts remain unique.
ALTER TABLE clinical.patient_portal_accounts DROP CONSTRAINT IF EXISTS patient_portal_accounts_username_key;
ALTER TABLE clinical.patient_portal_accounts DROP CONSTRAINT IF EXISTS patient_portal_accounts_cognito_sub_key;
CREATE UNIQUE INDEX patient_portal_active_username_key ON clinical.patient_portal_accounts(username)
  WHERE status IN ('invited','active');
CREATE UNIQUE INDEX patient_portal_active_sub_key ON clinical.patient_portal_accounts(cognito_sub)
  WHERE status IN ('invited','active');
ALTER TABLE clinical.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_target_type_check;
ALTER TABLE clinical.platform_audit_log ADD CONSTRAINT platform_audit_log_target_type_check
  CHECK (target_type IN ('organization','clinic','staff','patient'));
ALTER TABLE clinical.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_action_check;
ALTER TABLE clinical.platform_audit_log ADD CONSTRAINT platform_audit_log_action_check CHECK (action IN (
  'organizations.create','organizations.update','organizations.suspend','organizations.activate','organizations.archive','organizations.delete',
  'clinics.create','clinics.update','clinics.deactivate','clinics.activate',
  'staff.invite','staff.update','staff.deactivate','staff.activate','staff.archive','staff.delete','staff.login_remove',
  'patients.login_remove'
));

CREATE FUNCTION clinical.platform_patient_logins(p_organization_id uuid)
RETURNS TABLE(patient_id uuid,name text,username text,status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT p.id,concat_ws(' ',p.first_name,p.last_name),a.username,a.status
  FROM clinical.patient_portal_accounts a
  JOIN clinical.patients p ON p.organization_id=a.organization_id AND p.id=a.patient_id
  WHERE a.organization_id=p_organization_id
  ORDER BY p.last_name,p.first_name,p.id;
$$;

CREATE FUNCTION clinical.platform_patient_login_identity(p_organization_id uuid,p_patient_id uuid)
RETURNS TABLE(name text,username text,cognito_sub text,status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT concat_ws(' ',p.first_name,p.last_name),a.username,a.cognito_sub,a.status
  FROM clinical.patient_portal_accounts a
  JOIN clinical.patients p ON p.organization_id=a.organization_id AND p.id=a.patient_id
  WHERE a.organization_id=p_organization_id AND a.patient_id=p_patient_id;
$$;

CREATE FUNCTION clinical.platform_archive_patient_login(p_organization_id uuid,p_patient_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
BEGIN
  UPDATE clinical.patient_portal_accounts SET status='disabled'
  WHERE organization_id=p_organization_id AND patient_id=p_patient_id;
  RETURN FOUND;
END; $$;

CREATE FUNCTION clinical.platform_active_patient_login_count(p_cognito_sub text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT count(*) FROM clinical.patient_portal_accounts
  WHERE cognito_sub=p_cognito_sub AND status IN ('invited','active');
$$;

CREATE FUNCTION clinical.platform_staff_login_identity(p_organization_id uuid,p_user_id uuid)
RETURNS TABLE(name text,username text,status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT u.name,u.cognito_sub,u.status FROM clinical.users u
  WHERE u.organization_id=p_organization_id AND u.id=p_user_id;
$$;

CREATE FUNCTION clinical.platform_active_staff_login_count(p_username text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT count(*) FROM clinical.users WHERE cognito_sub=p_username AND status='active';
$$;

REVOKE ALL ON FUNCTION clinical.platform_patient_logins(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_patient_login_identity(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_archive_patient_login(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_active_patient_login_count(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_staff_login_identity(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_active_staff_login_count(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.platform_patient_logins(uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_patient_login_identity(uuid,uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_archive_patient_login(uuid,uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_active_patient_login_count(text) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_staff_login_identity(uuid,uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_active_staff_login_count(text) TO kh_request;
