-- Providers may create and reschedule appointments within their assigned clinic.
INSERT INTO clinical.role_capabilities(role,capability_key) VALUES
  ('clinician','schedule.manage'),
  ('provider','schedule.manage')
ON CONFLICT DO NOTHING;
