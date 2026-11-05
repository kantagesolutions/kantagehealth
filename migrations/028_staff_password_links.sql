-- One-time links that let a new staff member choose their own password, instead of signing in with a
-- temporary one first. Only a SHA-256 of each link's secret is stored, so a database read cannot be
-- turned into a working link. A link works once, for 72 hours, and only while the account is active;
-- issuing a new link for someone retires every earlier one.
CREATE TABLE clinical.staff_password_links (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,user_id) REFERENCES clinical.users(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX staff_password_links_user ON clinical.staff_password_links(organization_id,user_id);
-- No policies: the request role reaches this table only through the functions below.
ALTER TABLE clinical.staff_password_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.staff_password_links FORCE ROW LEVEL SECURITY;

ALTER TABLE clinical.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_action_check;
ALTER TABLE clinical.platform_audit_log ADD CONSTRAINT platform_audit_log_action_check CHECK (action IN (
  'organizations.create','organizations.update','organizations.suspend','organizations.activate','organizations.archive','organizations.delete',
  'clinics.create','clinics.update','clinics.deactivate','clinics.activate',
  'staff.invite','staff.update','staff.deactivate','staff.activate','staff.archive','staff.delete','staff.login_remove',
  'staff.password_link','staff.password_set',
  'patients.login_remove','patients.delete'
));

CREATE FUNCTION clinical.platform_issue_staff_password_link(p_organization_id uuid,p_user_id uuid,p_token_hash text,p_expires_at timestamptz)
RETURNS TABLE(username text,name text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
DECLARE v_user clinical.users%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM clinical.users u WHERE u.organization_id=p_organization_id AND u.id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found' USING ERRCODE='P0001'; END IF;
  IF v_user.status<>'active' THEN RAISE EXCEPTION 'Restore this staff member before sending a password link' USING ERRCODE='P0001'; END IF;
  UPDATE clinical.staff_password_links SET used_at=now()
    WHERE organization_id=p_organization_id AND user_id=p_user_id AND used_at IS NULL;
  INSERT INTO clinical.staff_password_links(token_hash,organization_id,user_id,expires_at)
    VALUES (p_token_hash,p_organization_id,p_user_id,p_expires_at);
  RETURN QUERY SELECT v_user.cognito_sub,v_user.name;
END; $$;

-- Who a link is for, if it can still be used. Read before the password is set and consumed after, so
-- a password the identity service rejects does not use the link up.
CREATE FUNCTION clinical.staff_password_link_target(p_organization_id uuid,p_token_hash text)
RETURNS TABLE(user_id uuid,username text,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT u.id,u.cognito_sub,u.name
  FROM clinical.staff_password_links l
  JOIN clinical.users u ON u.organization_id=l.organization_id AND u.id=l.user_id
  WHERE l.organization_id=p_organization_id AND l.token_hash=p_token_hash
    AND l.used_at IS NULL AND l.expires_at>now() AND u.status='active';
$$;

CREATE FUNCTION clinical.consume_staff_password_link(p_organization_id uuid,p_token_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
BEGIN
  UPDATE clinical.staff_password_links SET used_at=now()
    WHERE organization_id=p_organization_id AND token_hash=p_token_hash AND used_at IS NULL;
  RETURN FOUND;
END; $$;

REVOKE ALL ON FUNCTION clinical.platform_issue_staff_password_link(uuid,uuid,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.staff_password_link_target(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.consume_staff_password_link(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.platform_issue_staff_password_link(uuid,uuid,text,timestamptz) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.staff_password_link_target(uuid,text) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.consume_staff_password_link(uuid,text) TO kh_request;
