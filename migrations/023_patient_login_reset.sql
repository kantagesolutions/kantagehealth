-- Staff can reset a patient's portal login. Each reset is audited like the invitation it replaces.
--
-- Additive for the API version still serving during the deploy: one more allowed audit action.

ALTER TABLE clinical.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE clinical.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN (
  'patients.list','patients.read','patients.create','patients.search','patients.link',
  'records.read','records.create','appointments.read','appointments.create','appointments.schedule',
  'bookings.read','bookings.match_confirmed','bookings.match_dismissed',
  'documents.read','documents.upload','payments.read','payments.create',
  'locations.read','support.requested','support.approved','support.list','portal.invite','portal.reset',
  'reports.read'
));
