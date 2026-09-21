-- A capability can apply to every location in an organization. PostgreSQL
-- primary keys imply NOT NULL, so use a nullable location plus a unique index
-- that treats NULL as the organization-wide scope.
ALTER TABLE clinical.user_capabilities DROP CONSTRAINT IF EXISTS user_capabilities_pkey;
ALTER TABLE clinical.user_capabilities ALTER COLUMN location_id DROP NOT NULL;
CREATE UNIQUE INDEX user_capabilities_scope_unique ON clinical.user_capabilities(organization_id,user_id,coalesce(location_id,'00000000-0000-0000-0000-000000000000'::uuid),capability_key);
