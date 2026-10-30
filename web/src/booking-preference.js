export function requestedDay(value) {
  if (!value) return 'No preferred day supplied';
  const day = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'No preferred day supplied';
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return 'No preferred day supplied';
  return new Intl.DateTimeFormat('en-US', {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'}).format(date);
}

export function requestedWindow(inquiry) {
  return `${requestedDay(inquiry.preferred_date)} · ${inquiry.preferred_time || 'No preferred time supplied'}`;
}

// Opens an editable draft. Staff must add only times they have checked as available.
export function availabilityEmail(inquiry) {
  if (!inquiry.email) return null;
  const subject = 'Appointment availability';
  const body = 'Hello,\n\nThe following appointment times are available:\n\n[Add available dates and times here]\n\nPlease reply with the option that works best for you. Your appointment is not confirmed until our team confirms it.\n';
  return `mailto:${encodeURIComponent(inquiry.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function availabilityText(inquiry) {
  if (!inquiry.phone || !inquiry.sms_consent) return null;
  const body = 'Hello, we have appointment times available. Please reply to discuss a time that works for you. Your appointment is not confirmed until our team confirms it.';
  return `sms:${encodeURIComponent(inquiry.phone)}?body=${encodeURIComponent(body)}`;
}
