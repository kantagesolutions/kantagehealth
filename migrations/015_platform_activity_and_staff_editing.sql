-- Platform administration becomes auditable, and administrators can correct staff accounts.
--
-- clinical.audit_log cannot record administrator actions: every row needs a clinic location and an
-- actor who is a staff member inside that organization. Platform administrators are neither, so
-- they get an append-only log of their own.
--
-- Everything here is additive, with one deliberate exception below. The deploy applies migrations
-- while the previous API version is still serving, so no column, result column or function that
-- version depends on is removed or renamed.

-- The exception: migration 012 added staff_workspaces(uuid, text[]) but left migration 008's
-- staff_workspaces(uuid, text) in place. The API passes an untyped array, which Postgres resolved to
-- the single-text version, comparing each account with the literal string "{a,b}". It matched nobody,
-- so since 012 every staff member has seen "No clinic assigned". Dropping the stale overload is what
-- lets the API version still serving during the deploy start working too, as soon as this runs.
DROP FUNCTION IF EXISTS clinical.staff_workspaces(uuid, text);

CREATE TABLE clinical.platform_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (action IN (
    'organizations.create','organizations.suspend','organizations.activate',
    'clinics.create',
    'staff.invite','staff.update','staff.deactivate','staff.activate'
  )),
  organization_id uuid REFERENCES clinical.organizations(id),
  target_type text NOT NULL CHECK (target_type IN ('organization','clinic','staff')),
  target_id uuid,
  target_label text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_log_at_idx ON clinical.platform_audit_log(at DESC);

-- Same protections as clinical.audit_log: reachable only through the definer functions below, and
-- nothing may ever change or remove an entry.
ALTER TABLE clinical.platform_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical.platform_audit_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON clinical.platform_audit_log FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON clinical.platform_audit_log FROM kh_request;

CREATE OR REPLACE FUNCTION clinical.platform_record_activity(
  p_actor text,
  p_action text,
  p_organization_id uuid,
  p_target_type text,
  p_target_id uuid,
  p_target_label text,
  p_metadata jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, clinical
AS $$
  INSERT INTO clinical.platform_audit_log(actor,action,organization_id,target_type,target_id,target_label,metadata)
  VALUES(p_actor,p_action,p_organization_id,p_target_type,p_target_id,coalesce(p_target_label,''),coalesce(p_metadata,'{}'));
$$;

-- One source of truth for which roles exist: clinical.role_capabilities. Vendor support access is
-- granted through audited support sessions, never assigned as a staff role.
CREATE OR REPLACE FUNCTION clinical.assignable_role(p_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clinical
AS $$
  SELECT p_role <> 'kantage_support' AND EXISTS(SELECT 1 FROM clinical.role_capabilities WHERE role=p_role);
$$;

-- Same signature as migration 013, so the running API is unaffected. The only change is that it
-- now accepts every assignable role instead of a hardcoded five, ending the second role vocabulary.
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
  IF NOT clinical.assignable_role(p_role) THEN
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

-- Correct a staff member's name, email and role. The role is replaced rather than added to, so an
-- edit that demotes someone actually removes the old capabilities. Returns the previous values so
-- the audit entry can record what changed.
CREATE OR REPLACE FUNCTION clinical.platform_update_staff(
  p_organization_id uuid,
  p_user_id uuid,
  p_name text,
  p_email text,
  p_role text
)
RETURNS TABLE(previous_name text, previous_email text, previous_roles text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clinical
AS $$
DECLARE v_name text; v_email text; v_roles text[];
BEGIN
  IF NOT clinical.assignable_role(p_role) THEN
    RAISE EXCEPTION 'Staff role is invalid';
  END IF;
  IF length(trim(p_name)) < 2 THEN
    RAISE EXCEPTION 'Staff name is required';
  END IF;
  SELECT u.name,u.email INTO v_name,v_email FROM clinical.users u
   WHERE u.organization_id=p_organization_id AND u.id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff member not found';
  END IF;
  SELECT coalesce(array_agg(r.role ORDER BY r.role),'{}') INTO v_roles FROM clinical.user_roles r
   WHERE r.organization_id=p_organization_id AND r.user_id=p_user_id;
  UPDATE clinical.users SET name=trim(p_name),email=lower(trim(p_email))
   WHERE organization_id=p_organization_id AND id=p_user_id;
  DELETE FROM clinical.user_roles WHERE organization_id=p_organization_id AND user_id=p_user_id;
  INSERT INTO clinical.user_roles(organization_id,user_id,role,location_id)
  VALUES(p_organization_id,p_user_id,p_role,NULL);
  RETURN QUERY SELECT v_name,v_email,v_roles;
END;
$$;

-- The activity feed now merges clinic staff events with administrator events and says who acted.
-- Every column the previous version returned is kept, so the running API and frontend keep working
-- through the deploy. Patient identity is never returned: clinic events expose only the kind of
-- record touched (for example "patient"), never which one.
DROP FUNCTION IF EXISTS clinical.platform_activity();
CREATE FUNCTION clinical.platform_activity()
RETURNS TABLE(
  organization_name text,
  location_name text,
  action text,
  occurred_at timestamptz,
  source text,
  actor_name text,
  actor_role text,
  target_label text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clinical
AS $$
  SELECT * FROM (
    SELECT o.name, l.name, a.action, a.at, 'staff'::text,
           coalesce(u.name,'Staff member'), a.actor_role, a.subject_type
      FROM clinical.audit_log a
      JOIN clinical.organizations o ON o.id=a.organization_id
      LEFT JOIN clinical.locations l ON l.organization_id=a.organization_id AND l.id=a.location_id
      LEFT JOIN clinical.users u ON u.organization_id=a.organization_id AND u.id=a.actor_user_id
    UNION ALL
    SELECT coalesce(o.name,'Platform'), NULL, p.action, p.at, 'admin'::text,
           p.actor, 'platform administrator', p.target_label
      FROM clinical.platform_audit_log p
      LEFT JOIN clinical.organizations o ON o.id=p.organization_id
  ) events
  ORDER BY 4 DESC
  LIMIT 200;
$$;

REVOKE ALL ON FUNCTION clinical.platform_record_activity(text,text,uuid,text,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.assignable_role(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_update_staff(uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_activity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.platform_record_activity(text,text,uuid,text,uuid,text,jsonb) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.assignable_role(text) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_update_staff(uuid,uuid,text,text,text) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_activity() TO kh_request;
