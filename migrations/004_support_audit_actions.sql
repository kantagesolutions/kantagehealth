ALTER TABLE clinical.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE clinical.audit_log ADD CONSTRAINT audit_log_action_check CHECK(action IN (
  'patients.list','patients.read','patients.create','records.read','records.create',
  'appointments.read','appointments.create','documents.read','documents.upload',
  'payments.read','payments.create','locations.read','support.requested','support.approved','support.list'
));
