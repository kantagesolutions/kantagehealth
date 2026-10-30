// One way of writing dates and statuses across the portals. Times are shown in the clinic's timezone
// when it is known, so a table and the calendar never disagree about when a visit is.
export const formatWhen = (value, timeZone) => value
  ? new Date(value).toLocaleString('en-US', {timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'})
  : 'Not scheduled';
export const formatDay = (value, timeZone) => value
  ? new Date(value).toLocaleDateString('en-US', {timeZone, month: 'short', day: 'numeric', year: 'numeric'})
  : 'Not scheduled';
export const statusLabel = status => {
  const text = String(status || '').replaceAll('_', ' ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
};
export const plural = (count, word) => `${count} ${word}${Number(count) === 1 ? '' : 's'}`;
