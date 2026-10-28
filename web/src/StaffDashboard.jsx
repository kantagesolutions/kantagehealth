import { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';

// Calendar days are written YYYY-MM-DD in the clinic's timezone, and counted as plain dates so that daylight
// saving changes never move a day.
const dayKey = (value, timeZone) => new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(value));
const asDate = key => new Date(`${key}T00:00:00Z`);
const addDays = (key, days) => { const date = asDate(key); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const dayLabel = (key, options) => asDate(key).toLocaleDateString('en-US', {timeZone: 'UTC', ...options});
const timeLabel = (value, timeZone) => new Date(value).toLocaleTimeString('en-US', {timeZone, hour: 'numeric', minute: '2-digit'});
const patientName = (patient, fallback = 'Patient') => patient ? `${patient.first_name} ${patient.last_name}` : fallback;
// Weeks start on Sunday, as on a US wall calendar.
const sundayOf = key => addDays(key, -asDate(key).getUTCDay());

// Two weeks of the clinic's schedule. Choosing a day lists every appointment booked for it.
export function TwoWeekSchedule({ request, timeZone, patientsById, onOpenPatient, refreshKey }) {
  const today = dayKey(Date.now(), timeZone);
  const [start, setStart] = useState(() => sundayOf(today));
  const [selected, setSelected] = useState(today);
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const days = useMemo(() => Array.from({length: 14}, (_, index) => addDays(start, index)), [start]);
  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    // A day either side covers every timezone; appointments are then placed on the clinic's own days.
    const from = `${addDays(start, -1)}T00:00:00.000Z`, to = `${addDays(start, 15)}T00:00:00.000Z`;
    request(`/v1/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then(result => { if (current) setAppointments(result.appointments || []); })
      .catch(event => { if (current) setError(event.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [start, timeZone, refreshKey]);
  const byDay = useMemo(() => {
    const grouped = new Map();
    for (const item of appointments) {
      if (!item.start_time) continue;
      const key = dayKey(item.start_time, timeZone);
      grouped.set(key, [...(grouped.get(key) || []), item]);
    }
    for (const list of grouped.values()) list.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
    return grouped;
  }, [appointments, timeZone]);
  // Paging keeps today selected when it is on screen, and otherwise selects the first day shown.
  const move = weeks => { const next = addDays(start, weeks * 7); setStart(next); setSelected(today >= next && today <= addDays(next, 13) ? today : next); };
  const goToday = () => { setStart(sundayOf(today)); setSelected(today); };
  const dayItems = byDay.get(selected) || [];
  const counted = days.reduce((sum, key) => sum + (byDay.get(key)?.length || 0), 0);
  return <article className="live-panel staff-schedule-panel two-week-schedule">
    <div className="panel-heading">
      <div><h2>Schedule</h2><p>{dayLabel(days[0], {month: 'short', day: 'numeric'})} to {dayLabel(days[13], {month: 'short', day: 'numeric', year: 'numeric'})} · {loading ? 'loading…' : `${counted} appointment${counted === 1 ? '' : 's'}`}</p></div>
      <div className="schedule-nav">
        <button type="button" className="secondary icon-only" onClick={() => move(-2)} aria-label="Previous two weeks"><ChevronLeft size={18} /></button>
        <button type="button" className="secondary" onClick={goToday} disabled={days.includes(today) && selected === today}>Today</button>
        <button type="button" className="secondary icon-only" onClick={() => move(2)} aria-label="Next two weeks"><ChevronRight size={18} /></button>
      </div>
    </div>
    {error && <div className="live-error">{error}</div>}
    <div className="calendar-weekdays" aria-hidden="true">{days.slice(0, 7).map(key => <span key={key}>{dayLabel(key, {weekday: 'short'})}</span>)}</div>
    <div className="calendar-days" role="group" aria-label="Choose a day">
      {days.map(key => {
        const count = byDay.get(key)?.length || 0;
        const date = asDate(key);
        return <button type="button" key={key}
          className={`calendar-day${key === today ? ' is-today' : ''}${key < today ? ' is-past' : ''}`}
          aria-pressed={key === selected} aria-current={key === today ? 'date' : undefined}
          aria-label={`${dayLabel(key, {weekday: 'long', month: 'long', day: 'numeric'})}, ${count ? `${count} appointment${count === 1 ? '' : 's'}` : 'no appointments'}`}
          onClick={() => setSelected(key)}>
          <span className="calendar-date">{date.getUTCDate() === 1 || key === days[0] ? dayLabel(key, {month: 'short', day: 'numeric'}) : date.getUTCDate()}</span>
          {count > 0 && <span className="calendar-count">{count}<span className="calendar-count-label"> appt{count === 1 ? '' : 's'}</span></span>}
        </button>;
      })}
    </div>
    <section className="calendar-day-detail" aria-live="polite">
      <h3>{selected === today ? 'Today, ' : ''}{dayLabel(selected, {weekday: 'long', month: 'long', day: 'numeric'})}</h3>
      {dayItems.length ? <div className="schedule-list">{dayItems.map(item => {
        const patient = patientsById.get(item.patient_id);
        return <div className="schedule-row" key={item.id}>
          <time dateTime={item.start_time}><strong>{timeLabel(item.start_time, timeZone)}</strong>{item.duration_minutes ? <small>{item.duration_minutes} min</small> : null}</time>
          <span className="schedule-dot" />
          <span className="schedule-detail"><strong>{item.service || 'Appointment'}</strong>{patient ? <button type="button" className="schedule-patient" onClick={() => onOpenPatient(patient)}>{patientName(patient)}</button> : <small>Patient</small>}</span>
          <span className={`schedule-status status-${item.status}`}>{item.status}</span>
        </div>;
      })}</div> : <div className="compact-empty"><CalendarDays /><span>{loading ? 'Loading the schedule…' : 'No appointments booked for this day.'}</span></div>}
    </section>
  </article>;
}

const checkEveryMs = 30_000, toastForMs = 8_000;

// Booking requests as they arrive: a notification for each new one, which then files itself into the
// Appointment requests button, where every waiting request can be scheduled.
export function AppointmentRequests({ request, requests, loaded, refresh, onSchedule, onResolve, onOpenPatient, timeZone }) {
  const known = useRef(null);
  // The latest functions, so the check below keeps one steady timer however often the page re-renders.
  const latest = useRef({request, refresh});
  latest.current = {request, refresh};
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const [arrivals, setArrivals] = useState([]);
  const [announcement, setAnnouncement] = useState('');
  const [scheduling, setScheduling] = useState(null);
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The requests already waiting when the page opens are not news. Anything that arrives later is.
  useEffect(() => {
    if (!loaded) return;
    if (!known.current) { known.current = new Set(requests.map(item => item.id)); return; }
    const fresh = requests.filter(item => !known.current.has(item.id));
    if (!fresh.length) return;
    fresh.forEach(item => known.current.add(item.id));
    setArrivals(current => [...fresh.map(item => ({...item, arrivedAt: Date.now()})), ...current].slice(0, 3));
    setAnnouncement(fresh.length === 1 ? `New booking request from ${fresh[0].first_name} ${fresh[0].last_name}.` : `${fresh.length} new booking requests.`);
  }, [requests, loaded]);
  // Checking costs one small request with no patient details; the list itself is only reloaded when
  // something new is waiting. A hidden tab does not check.
  useEffect(() => {
    if (!loaded) return undefined;
    const check = async () => {
      if (document.visibilityState !== 'visible' || !known.current) return;
      try {
        const {waiting} = await latest.current.request('/v1/booking-inquiries/waiting');
        if (waiting.some(item => !known.current.has(item.id))) await latest.current.refresh();
      } catch { /* The next check tries again. */ }
    };
    const timer = window.setInterval(check, checkEveryMs);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [loaded]);
  const dismiss = id => setArrivals(current => current.filter(item => item.id !== id));
  const openPanel = item => { setScheduling(item ? item.id : null); setError(''); panelRef.current?.showPopover?.(); };
  const closePanel = () => panelRef.current?.hidePopover?.();
  const schedule = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSchedule(scheduling, new Date(when).toISOString()); setScheduling(null); setWhen(''); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const resolve = async (item, samePatient) => {
    setBusy(true); setError('');
    try { await onResolve(item, samePatient); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return <>
    <button ref={buttonRef} type="button" className={`appointment-requests-button${requests.length ? ' has-requests' : ''}${arrivals.length ? ' is-receiving' : ''}`} onClick={() => openPanel(null)} aria-haspopup="dialog">
      <BellRing size={18} aria-hidden="true" /><span className="requests-button-label">Appointment requests</span>
      <span className="requests-count" aria-label={`${requests.length} waiting`}>{requests.length}</span>
    </button>
    <p className="visually-hidden" role="status">{announcement}</p>
    {arrivals.map((item, index) => <RequestToast key={item.id} item={item} index={index} target={buttonRef} onOpen={() => { dismiss(item.id); openPanel(item); }} onDone={() => dismiss(item.id)} />)}
    <dialog ref={panelRef} id="appointment-requests-panel" popover="auto" className="appointment-requests-panel" aria-labelledby="appointment-requests-title">
      <div className="requests-panel-head">
        <div><h2 id="appointment-requests-title">Appointment requests</h2><p>{requests.length ? `${requests.length} waiting to be scheduled` : 'Nothing waiting'}</p></div>
        <button type="button" className="icon-button" onClick={closePanel} aria-label="Close appointment requests"><X size={18} /></button>
      </div>
      {error && <div className="live-error">{error}</div>}
      <div className="request-stack booking-stack">
        {requests.map(item => <div key={item.id} className={scheduling === item.id ? 'is-scheduling' : ''}>
          <CalendarDays aria-hidden="true" />
          <span>
            <strong>{item.patient_id ? <button type="button" className="schedule-patient" onClick={() => { closePanel(); onOpenPatient({id: item.patient_id}); }}>{item.first_name} {item.last_name}</button> : `${item.first_name} ${item.last_name}`}</strong>
            <small>{item.appointment_type} · {item.preferred_date || 'Flexible'} {item.preferred_time}</small>
            <small>{item.phone} · received {new Date(item.created_at).toLocaleString('en-US', {timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})}</small>
            {item.source === 'patient_portal' && <small className="booking-source">Requested from the patient portal</small>}
            {item.match_name && <span className="possible-match"><span>Possible returning patient: <strong>{item.match_name}</strong> at {item.match_clinic}, same {item.matched_on}.</span><span className="possible-match-actions"><button type="button" className="secondary" disabled={busy} onClick={() => resolve(item, true)}>Same patient</button><button type="button" className="secondary" disabled={busy} onClick={() => resolve(item, false)}>Different person</button></span></span>}
            {scheduling === item.id && <form className="inline-schedule" onSubmit={schedule}>
              <label>Appointment date and time<input type="datetime-local" value={when} onChange={event => setWhen(event.target.value)} required autoFocus /></label>
              <button className="primary" disabled={busy}>{busy ? 'Confirming…' : 'Confirm appointment'}</button>
              <button type="button" className="secondary" onClick={() => setScheduling(null)}>Cancel</button>
            </form>}
          </span>
          {scheduling !== item.id && <button type="button" className="secondary" onClick={() => { setScheduling(item.id); setWhen(''); setError(''); }}>Schedule</button>}
        </div>)}
        {!requests.length && <div className="compact-empty"><CalendarDays /><span>No booking requests are waiting.</span></div>}
      </div>
    </dialog>
  </>;
}

// One new request, shown for a few seconds, then sent into the Appointment requests button.
function RequestToast({ item, index, target, onOpen, onDone }) {
  const ref = useRef(null);
  const [filing, setFiling] = useState(false);
  useEffect(() => {
    const toast = ref.current;
    toast?.showPopover?.();
    const timer = window.setTimeout(() => {
      const from = toast?.getBoundingClientRect(), to = target.current?.getBoundingClientRect();
      if (toast && from && to) {
        toast.style.setProperty('--file-x', `${to.left + to.width / 2 - (from.left + from.width / 2)}px`);
        toast.style.setProperty('--file-y', `${to.top + to.height / 2 - (from.top + from.height / 2)}px`);
      }
      setFiling(true);
    }, toastForMs);
    return () => window.clearTimeout(timer);
  }, []);
  const done = useRef(false);
  const finish = () => { if (done.current) return; done.current = true; ref.current?.hidePopover?.(); onDone(); };
  // Without the animation, as with reduced motion, there is no transition to wait for.
  useEffect(() => { if (!filing) return undefined; const timer = window.setTimeout(finish, 900); return () => window.clearTimeout(timer); }, [filing]);
  return <div ref={ref} popover="manual" role="status" className={`request-toast${filing ? ' is-filing' : ''}`} style={{'--toast-index': index}} onTransitionEnd={event => { if (filing && event.target === ref.current && event.propertyName === 'transform') finish(); }}>
    <BellRing size={18} aria-hidden="true" />
    <div><strong>New booking request</strong><span>{item.first_name} {item.last_name} · {item.appointment_type}</span><small>{item.preferred_date || 'Flexible date'}{item.preferred_time ? ` · ${item.preferred_time}` : ''}</small></div>
    <button type="button" className="secondary" onClick={onOpen}>View</button>
    <button type="button" className="icon-button" onClick={finish} aria-label="Dismiss notification"><X size={16} /></button>
  </div>;
}
