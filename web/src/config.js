// The API a portal talks to. Deployed portals get it from runtime-config.js, written at container
// start. When that is unset, deployed portals fall back to production and anything else, such as a
// laptop, falls back to a local API, so development never reaches live patient data by accident.
export function apiBaseUrl() {
  const configured = (window.__DAY_AUTH_CONFIG__ || {}).apiUrl;
  if (configured && !configured.includes('${')) return configured.replace(/\/$/, '');
  return window.location.hostname.endsWith('.kantage.solutions') ? 'https://health.kantage.solutions' : 'http://localhost:3000';
}

// Labels for every role in clinical.role_capabilities. The first group is what admins assign today;
// the rest are older names for the same permissions, still valid on existing accounts.
export const roleLabels = {
  organization_owner: 'Organization owner',
  clinic_administrator: 'Clinic administrator',
  provider: 'Provider',
  hygienist_assistant: 'Hygienist or assistant',
  front_desk: 'Front desk',
  billing_specialist: 'Billing',
  auditor: 'Auditor',
  owner: 'Owner',
  clinician: 'Clinician',
  billing: 'Billing',
};
export const assignableRoleOptions = ['organization_owner', 'clinic_administrator', 'provider', 'hygienist_assistant', 'front_desk', 'billing_specialist', 'auditor'];

export function roleLabel(role) {
  return roleLabels[role] || role.replaceAll('_', ' ');
}

// Plain-language wording for audit actions, so the activity feed reads as sentences.
const actionLabels = {
  'organizations.create': 'Added organization',
  'organizations.suspend': 'Suspended organization',
  'organizations.activate': 'Reactivated organization',
  'organizations.archive': 'Archived organization',
  'organizations.delete': 'Deleted organization',
  'clinics.create': 'Added clinic',
  'staff.invite': 'Invited staff member',
  'staff.update': 'Edited staff member',
  'staff.deactivate': 'Suspended staff member',
  'staff.activate': 'Restored staff member',
  'staff.archive': 'Archived staff member',
  'staff.delete': 'Deleted staff member',
  'patients.list': 'Viewed patient list',
  'patients.read': 'Opened a patient profile',
  'patients.create': 'Added a patient',
  'patients.search': 'Searched patients',
  'patients.link': 'Linked a patient to a clinic',
  'records.read': 'Viewed clinical records',
  'records.create': 'Added a clinical record',
  'appointments.read': 'Viewed appointments',
  'appointments.create': 'Booked an appointment',
  'appointments.schedule': 'Scheduled a booking request',
  'bookings.read': 'Viewed booking requests',
  'bookings.received': 'Booking request received',
  'documents.read': 'Viewed documents',
  'documents.upload': 'Uploaded a document',
  'payments.read': 'Viewed payments',
  'payments.create': 'Recorded a payment',
  'locations.read': 'Opened the clinic workspace',
  'support.requested': 'Requested support access',
  'support.approved': 'Approved support access',
  'support.list': 'Viewed support access',
  'portal.invite': 'Enabled patient portal access',
};
export function actionLabel(action) {
  return actionLabels[action] || action.replaceAll('.', ' ');
}
