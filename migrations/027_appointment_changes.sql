-- Staff appointment changes stay in the clinical audit trail. Appointments are cancelled by
-- status, never deleted, so the patient's history remains complete.
ALTER TABLE clinical.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE clinical.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN (
  'patients.list','patients.read','patients.create','patients.update','patients.search','patients.link',
  'records.read','records.create','appointments.read','appointments.create','appointments.schedule',
  'appointments.update','appointments.cancel',
  'bookings.read','bookings.match_confirmed','bookings.match_dismissed',
  'documents.read','documents.upload','payments.read','payments.create',
  'locations.read','support.requested','support.approved','support.list','portal.invite','portal.reset',
  'reports.read'
));
