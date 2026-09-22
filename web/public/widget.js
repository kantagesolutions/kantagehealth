(() => {
  const script = document.currentScript;
  if (!script) return;
  const bookingUrl = script.dataset.kantageBooking;
  if (!bookingUrl) return;
  const selector = script.dataset.kantageSelector || 'a,button';
  const accepted = (script.dataset.kantageButtonText || 'Book Appointment|Schedule Now|Request an Appointment')
    .split('|').map(value => value.trim().toLowerCase()).filter(Boolean);
  document.querySelectorAll(selector).forEach(element => {
    const label = (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!accepted.includes(label)) return;
    element.setAttribute('data-kantage-booking-connected', 'true');
    if (element.tagName.toLowerCase() === 'a') {
      element.setAttribute('href', bookingUrl);
      return;
    }
    element.addEventListener('click', event => {
      event.preventDefault();
      window.location.assign(bookingUrl);
    });
  });
})();
