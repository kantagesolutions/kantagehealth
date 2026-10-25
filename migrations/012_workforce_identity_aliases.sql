-- Workforce access tokens may identify a user by Cognito username or immutable
-- subject depending on the hosted UI flow.  Accept both aliases when resolving
-- the employee record, while returning only locations already assigned to them.
CREATE OR REPLACE FUNCTION clinical.staff_workspaces(p_organization_id uuid, p_actor_aliases text[])
RETURNS TABLE(
  organization_id uuid,
  organization_name text,
  staff_name text,
  location_id uuid,
  location_name text,
  location_address text,
  timezone text,
  roles text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clinical
AS $$
  SELECT
    o.id,
    o.name,
    u.name,
    l.id,
    l.name,
    l.address,
    l.timezone,
    array_agg(DISTINCT r.role ORDER BY r.role)
  FROM clinical.users u
  JOIN clinical.organizations o
    ON o.id = u.organization_id
   AND o.status = 'active'
  JOIN clinical.user_roles r
    ON r.organization_id = u.organization_id
   AND r.user_id = u.id
  JOIN clinical.locations l
    ON l.organization_id = u.organization_id
   AND l.status = 'active'
   AND (r.location_id IS NULL OR r.location_id = l.id)
  WHERE u.organization_id = p_organization_id
    AND u.status = 'active'
    AND u.cognito_sub = ANY(p_actor_aliases)
  GROUP BY o.id, o.name, u.name, l.id, l.name, l.address, l.timezone
  ORDER BY l.name;
$$;

REVOKE ALL ON FUNCTION clinical.staff_workspaces(uuid,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.staff_workspaces(uuid,text[]) TO kh_request;
