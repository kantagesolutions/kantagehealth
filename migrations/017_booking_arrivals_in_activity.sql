-- Booking requests arriving from clinic websites now appear in the platform activity feed.
--
-- A public booking has no staff actor, so it never wrote to clinical.audit_log, and administrators
-- could not see bookings arrive. The feed now also reads clinical.booking_inquiries, taking only the
-- organization, the clinic and the time. Names, contact details, the type of care and the message are
-- never selected, so no patient detail can reach the admin portal through this view.
--
-- The result columns are unchanged from migration 015, so the API version still serving during the
-- deploy keeps working.
CREATE OR REPLACE FUNCTION clinical.platform_activity()
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
    UNION ALL
    SELECT o.name, l.name, 'bookings.received'::text, b.created_at, 'website'::text,
           'Public booking form', 'patient request', ''::text
      FROM clinical.booking_inquiries b
      JOIN clinical.organizations o ON o.id=b.organization_id
      LEFT JOIN clinical.locations l ON l.organization_id=b.organization_id AND l.id=b.location_id
  ) events
  ORDER BY 4 DESC
  LIMIT 200;
$$;
