-- Authorized clinic staff can locate an organization patient and explicitly
-- link that existing profile to their current clinic. No automatic merging is
-- performed.
CREATE OR REPLACE FUNCTION clinical.search_roaming_patients(
  p_organization_id uuid,
  p_location_id uuid,
  p_search text
)
RETURNS TABLE(patient_id uuid, first_name text, last_name text, phone text, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, clinical
AS $$
  SELECT p.id,p.first_name,p.last_name,p.phone,p.email
  FROM clinical.patients p
  WHERE p.organization_id = p_organization_id
    AND p_organization_id = clinical.org_id()
    AND p_location_id = clinical.location_id()
    AND NOT EXISTS (
      SELECT 1 FROM clinical.patient_locations pl
      WHERE pl.organization_id=p.organization_id
        AND pl.location_id=p_location_id
        AND pl.patient_id=p.id
    )
    AND (
      concat_ws(' ',p.first_name,p.last_name) ILIKE '%'||trim(p_search)||'%'
      OR regexp_replace(p.phone,'[^0-9]','','g') = regexp_replace(p_search,'[^0-9]','','g')
      OR (p.email IS NOT NULL AND lower(p.email)=lower(trim(p_search)))
    )
  ORDER BY p.last_name,p.first_name
  LIMIT 20;
$$;

CREATE OR REPLACE FUNCTION clinical.link_patient_to_location(
  p_organization_id uuid,
  p_location_id uuid,
  p_patient_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, clinical
AS $$
BEGIN
  IF p_organization_id IS DISTINCT FROM clinical.org_id()
     OR p_location_id IS DISTINCT FROM clinical.location_id()
     OR NOT EXISTS (
       SELECT 1 FROM clinical.patients p
       WHERE p.organization_id=p_organization_id AND p.id=p_patient_id
     ) THEN
    RETURN false;
  END IF;
  INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id)
  VALUES(p_organization_id,p_location_id,p_patient_id)
  ON CONFLICT DO NOTHING;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION clinical.search_roaming_patients(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.link_patient_to_location(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.search_roaming_patients(uuid,uuid,text) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.link_patient_to_location(uuid,uuid,uuid) TO kh_request;

ALTER TABLE clinical.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE clinical.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN (
  'patients.list','patients.read','patients.create','patients.search','patients.link',
  'records.read','records.create','appointments.read','appointments.create',
  'documents.read','documents.upload','payments.read','payments.create',
  'locations.read','support.requested','support.approved','support.list'
));
