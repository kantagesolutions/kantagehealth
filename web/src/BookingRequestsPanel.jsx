import { CalendarDays } from 'lucide-react';
import { availabilityEmail, availabilityText, requestedWindow } from './booking-preference.js';

export default function BookingRequestsPanel({requests, loading, scheduleId, scheduleTime, setScheduleId, setScheduleTime, onSchedule, onMatch, onOpenPatient}) {
  const selected = requests.find(item => item.id === scheduleId);
  return <article className="live-panel staff-requests-panel">
    <div className="panel-heading"><div><h2>Booking requests</h2><p>{requests.length} awaiting a response</p></div></div>
    {requests.length ? <div className="request-stack booking-stack">
      {requests.map(item => <div className="booking-request-row" key={item.id}>
        <CalendarDays aria-hidden="true" />
        <div className="booking-request-details">
          <strong>{item.first_name} {item.last_name}</strong>
          <span>{item.appointment_type}</span>
          <p className="booking-preference"><b>Preferred:</b> {requestedWindow(item)}</p>
          <small>Requested time is not confirmed. Check availability before scheduling.</small>
          {item.message && <small>Patient note: {item.message}</small>}
          <small>Contact by {item.preferred_contact || 'email'} · {item.phone}{item.email ? ` · ${item.email}` : ''}</small>
          {item.source === 'patient_portal' && <small className="booking-source">Requested from the patient portal</small>}
          {item.match_name && <span className="possible-match"><span>Possible returning patient: <strong>{item.match_name}</strong> at {item.match_clinic}, same {item.matched_on}.</span><span className="possible-match-actions"><button type="button" className="secondary" onClick={() => onMatch(item, true)}>Same patient</button><button type="button" className="secondary" onClick={() => onMatch(item, false)}>Different person</button></span></span>}
          <div className="booking-request-actions"><button className="secondary" type="button" onClick={() => onOpenPatient(item.patient_id)}>Open profile</button>{availabilityEmail(item) && <a className="secondary" href={availabilityEmail(item)}>Email available times</a>}{availabilityText(item) && <a className="secondary" href={availabilityText(item)}>Text available times</a>}{item.phone && <a className="secondary" href={`tel:${item.phone}`}>Call patient</a>}<button className="primary" type="button" onClick={() => {setScheduleId(item.id); setScheduleTime('');}}>Schedule</button></div>
        </div>
      </div>)}
    </div> : <div className="compact-empty"><CalendarDays /><span>{loading ? 'Loading booking requests…' : 'No booking requests awaiting a response.'}</span></div>}
    {selected && <form className="inline-schedule" onSubmit={onSchedule}><strong>Scheduling {selected.first_name} {selected.last_name}</strong><p>Preferred: {requestedWindow(selected)}</p><label>Confirmed appointment date and time<input type="datetime-local" value={scheduleTime} onChange={event => setScheduleTime(event.target.value)} required /></label><button className="primary">Confirm appointment</button><button type="button" className="secondary" onClick={() => setScheduleId('')}>Cancel</button></form>}
  </article>;
}
