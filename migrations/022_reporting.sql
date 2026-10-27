-- Reports across clinics: how each clinic is doing over a date range, as counts and totals only.
--
-- Per clinic: new patients, patients who moved in and out, appointments by status, booking requests and
-- how many were scheduled, and payments recorded. Never a patient: no name, contact detail, id or note
-- leaves these functions. Dates are read in each clinic's own timezone, so "today" at a clinic means
-- its local day.
--
-- Owners and clinic administrators see the clinics they are assigned to; auditors too. Platform
-- administrators see every organization.
--
-- Additive for the API version still serving during the deploy: a new capability, new functions, and
-- one more allowed audit action.

INSERT INTO clinical.capabilities(key,description) VALUES('reports.read','Read clinic reports: counts and totals, never individual patients')
ON CONFLICT (key) DO NOTHING;
INSERT INTO clinical.role_capabilities(role,capability_key) VALUES
  ('organization_owner','reports.read'),('owner','reports.read'),('clinic_administrator','reports.read'),('auditor','reports.read')
ON CONFLICT DO NOTHING;

-- The figures for each clinic of one organization, or of every organization when none is given. Only
-- called from the two functions below; never granted to the request role.
CREATE OR REPLACE FUNCTION clinical.report_figures(p_organization_id uuid, p_from date, p_to date)
RETURNS TABLE(
  organization_id uuid, organization_name text, location_id uuid, clinic_name text, clinic_status text,
  new_patients int, moved_in int, moved_out int, appointments jsonb,
  booking_requests int, booking_requests_scheduled int, booking_requests_from_portal int,
  payments int, payments_cents bigint
)
LANGUAGE sql STABLE SET search_path=pg_catalog,clinical AS $$
  SELECT o.id, o.name, l.id, l.name, l.status,
    -- A patient is new at the clinic they first joined: where their first move left from, or, if they
    -- never moved, their clinic now.
    (SELECT count(*)::int FROM clinical.patients p
      WHERE p.organization_id=l.organization_id
        AND coalesce((SELECT m.from_location_id FROM clinical.patient_moves m WHERE m.organization_id=p.organization_id AND m.patient_id=p.id ORDER BY m.moved_at,m.id LIMIT 1),p.location_id)=l.id
        AND (p.created_at AT TIME ZONE l.timezone)::date BETWEEN p_from AND p_to),
    (SELECT count(*)::int FROM clinical.patient_moves m WHERE m.organization_id=l.organization_id AND m.to_location_id=l.id AND (m.moved_at AT TIME ZONE l.timezone)::date BETWEEN p_from AND p_to),
    (SELECT count(*)::int FROM clinical.patient_moves m WHERE m.organization_id=l.organization_id AND m.from_location_id=l.id AND (m.moved_at AT TIME ZONE l.timezone)::date BETWEEN p_from AND p_to),
    -- Appointments booked for a time in the range. Requests without a time yet are counted as booking
    -- requests instead.
    coalesce((SELECT jsonb_object_agg(status,total) FROM (
      SELECT a.status,count(*)::int AS total FROM clinical.appointments a
      WHERE a.organization_id=l.organization_id AND a.location_id=l.id AND a.start_time IS NOT NULL AND (a.start_time AT TIME ZONE l.timezone)::date BETWEEN p_from AND p_to
      GROUP BY a.status) s),'{}'::jsonb),
    (SELECT count(*)::int FROM clinical.booking_inquiries b WHERE b.organization_id=l.organization_id AND b.location_id=l.id AND (b.created_at AT TIME ZONE l.timezone)::date BETWEEN p_from AND p_to),
    (SELECT count(*)::int FROM clinical.booking_inquiries b WHERE b.organization_id=l.organization_id AND b.location_id=l.id AND b.status='scheduled' AND (b.created_at AT TIME ZONE l.timezone)::date BETWEEN p_from AND p_to),
    (SELECT count(*)::int FROM clinical.booking_inquiries b WHERE b.organization_id=l.organization_id AND b.location_id=l.id AND b.source='patient_portal' AND (b.created_at AT TIME ZONE l.timezone)::date BETWEEN p_from AND p_to),
    (SELECT count(*)::int FROM clinical.payments y WHERE y.organization_id=l.organization_id AND y.location_id=l.id AND (y.created_at AT TIME ZONE l.timezone)::date BETWEEN p_from AND p_to),
    (SELECT coalesce(sum(y.amount_cents),0)::bigint FROM clinical.payments y WHERE y.organization_id=l.organization_id AND y.location_id=l.id AND (y.created_at AT TIME ZONE l.timezone)::date BETWEEN p_from AND p_to)
  FROM clinical.locations l JOIN clinical.organizations o ON o.id=l.organization_id
  WHERE p_organization_id IS NULL OR l.organization_id=p_organization_id
  ORDER BY o.name,l.name;
$$;
REVOKE ALL ON FUNCTION clinical.report_figures(uuid,date,date) FROM PUBLIC;

-- Staff reports: the clinics of the caller's organization that the caller holds reports.read for, from
-- a role or a direct grant. A grant with no clinic covers every clinic.
CREATE OR REPLACE FUNCTION clinical.clinic_reports(p_from date, p_to date)
RETURNS TABLE(
  location_id uuid, clinic_name text, clinic_status text,
  new_patients int, moved_in int, moved_out int, appointments jsonb,
  booking_requests int, booking_requests_scheduled int, booking_requests_from_portal int,
  payments int, payments_cents bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  WITH me AS (
    SELECT u.id FROM clinical.users u
    WHERE u.organization_id=clinical.org_id() AND u.cognito_sub=clinical.actor_sub() AND u.status='active'
  ), grants AS (
    SELECT r.location_id FROM clinical.user_roles r JOIN clinical.role_capabilities rc ON rc.role=r.role AND rc.capability_key='reports.read'
    WHERE r.organization_id=clinical.org_id() AND r.user_id IN (SELECT id FROM me)
    UNION ALL
    SELECT c.location_id FROM clinical.user_capabilities c
    WHERE c.organization_id=clinical.org_id() AND c.user_id IN (SELECT id FROM me) AND c.capability_key='reports.read'
  )
  SELECT f.location_id,f.clinic_name,f.clinic_status,f.new_patients,f.moved_in,f.moved_out,f.appointments,
         f.booking_requests,f.booking_requests_scheduled,f.booking_requests_from_portal,f.payments,f.payments_cents
  FROM clinical.report_figures(clinical.org_id(),p_from,p_to) f
  WHERE EXISTS(SELECT 1 FROM grants WHERE grants.location_id IS NULL)
     OR f.location_id IN (SELECT grants.location_id FROM grants);
$$;

-- Platform administrators: every clinic of every organization.
CREATE OR REPLACE FUNCTION clinical.platform_reports(p_from date, p_to date)
RETURNS TABLE(
  organization_id uuid, organization_name text, location_id uuid, clinic_name text, clinic_status text,
  new_patients int, moved_in int, moved_out int, appointments jsonb,
  booking_requests int, booking_requests_scheduled int, booking_requests_from_portal int,
  payments int, payments_cents bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT * FROM clinical.report_figures(NULL,p_from,p_to);
$$;

ALTER TABLE clinical.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE clinical.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN (
  'patients.list','patients.read','patients.create','patients.search','patients.link',
  'records.read','records.create','appointments.read','appointments.create','appointments.schedule',
  'bookings.read','bookings.match_confirmed','bookings.match_dismissed',
  'documents.read','documents.upload','payments.read','payments.create',
  'locations.read','support.requested','support.approved','support.list','portal.invite',
  'reports.read'
));

REVOKE ALL ON FUNCTION clinical.clinic_reports(date,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_reports(date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.clinic_reports(date,date) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_reports(date,date) TO kh_request;
