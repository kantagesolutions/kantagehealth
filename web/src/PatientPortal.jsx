import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { Building2, CalendarDays, CalendarPlus, ChevronDown, Download, FileText, Home, LogOut, ShieldCheck } from 'lucide-react';
import { signOut } from './auth.js';
import { formatDay, plural, statusLabel } from './format.js';

const visitTypes = ['Checkup and cleaning', 'Tooth pain or emergency', 'Consultation', 'Follow-up visit'];
const timeOf = value => new Date(value).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
const dayOf = value => new Date(value).toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric'});

// A signed-in patient asks for a visit at whichever clinic suits them. Choosing another clinic makes it
// their clinic from then on; their history comes with them.
function PatientBooking({ request, onBooked }) {
  const [clinics, setClinics] = useState([]);
  const [form, setForm] = useState({clinic: '', appointmentType: visitTypes[0], preferredDate: '', preferredTime: '', message: ''});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const loadClinics = () => request('/v1/patient/clinics').then(result => {
    setClinics(result.clinics);
    const current = result.clinics.find(clinic => clinic.current) || result.clinics[0];
    if (current) setForm(value => ({...value, clinic: current.key}));
  }).catch(event => setError(event.message));
  useEffect(() => { loadClinics(); }, []);
  const chosen = clinics.find(clinic => clinic.key === form.clinic);
  const change = field => event => setForm(value => ({...value, [field]: event.target.value}));
  const submit = async event => {
    event.preventDefault(); setSending(true); setError(''); setNotice('');
    const optional = Object.fromEntries(['preferredDate', 'preferredTime', 'message'].filter(field => form[field].trim()).map(field => [field, form[field].trim()]));
    try {
      const result = await request('/v1/patient/appointments', {method: 'POST', body: JSON.stringify({clinic: form.clinic, appointmentType: form.appointmentType, ...optional})});
      setNotice(`Your request was sent to ${result.appointment.clinicName}. The office will contact you to confirm a time.`);
      setForm(value => ({...value, preferredDate: '', preferredTime: '', message: ''}));
      await Promise.all([loadClinics(), onBooked()]);
    } catch (event) { setError(event.message); }
    finally { setSending(false); }
  };
  return <>
    {error && <div className="live-error">{error}</div>}
    {notice && <div className="live-notice">{notice}</div>}
    {clinics.length > 0 && <form className="pp-form" onSubmit={submit}>
      <label>Clinic<select value={form.clinic} onChange={change('clinic')} required>{clinics.map(clinic => <option key={clinic.key} value={clinic.key}>{clinic.name}{clinic.current ? ' (your clinic)' : ''}</option>)}</select>{chosen?.address && <small>{chosen.address}</small>}</label>
      {chosen && !chosen.current && <p className="pp-note">{chosen.name} will become your clinic. Your appointments and records come with you.</p>}
      <label>Type of visit<select value={form.appointmentType} onChange={change('appointmentType')}>{visitTypes.map(type => <option key={type}>{type}</option>)}</select></label>
      <div className="pp-form-pair">
        <label>Preferred date<input type="date" value={form.preferredDate} min={new Date().toISOString().slice(0, 10)} onChange={change('preferredDate')} /></label>
        <label>Preferred time<input value={form.preferredTime} maxLength="60" placeholder="Mornings" onChange={change('preferredTime')} /></label>
      </div>
      <label>Anything the office should know<textarea value={form.message} maxLength="1000" rows="3" onChange={change('message')} /></label>
      <button className="pp-primary" disabled={sending || !form.clinic}>{sending ? 'Sending…' : 'Send request'}</button>
    </form>}
  </>;
}

// A calendar-page date, like the iPhone Calendar icon.
function DateTile({ value }) {
  if (!value) return <span className="pp-date-tile is-waiting" aria-hidden="true"><CalendarDays size={20} /></span>;
  const date = new Date(value);
  return <span className="pp-date-tile" aria-hidden="true"><small>{date.toLocaleDateString('en-US', {month: 'short'})}</small><strong>{date.getDate()}</strong></span>;
}

function VisitRow({ item }) {
  return <li className="pp-row"><DateTile value={item.startTime} /><span className="pp-row-text"><strong>{item.service}</strong><small>{item.startTime ? `${dayOf(item.startTime)} · ${timeOf(item.startTime)}` : 'Waiting for the office to choose a time'}{item.clinic ? ` · ${item.clinic}` : ''}</small></span><span className={`pp-pill status-${item.status}`}>{statusLabel(item.status)}</span></li>;
}

// The patient portal as a phone app: a deck of cards, like Wallet, and a dock that opens each card.
// Opening a card lifts it to the top and drops the others into a pile below it.
export default function PatientPortal({ session, identity, request }) {
  const [home, setHome] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [downloading, setDownloading] = useState('');
  const loadHome = () => request('/v1/patient/home').then(setHome).catch(event => setError(event.message));
  useEffect(() => { loadHome(); }, [session]);
  const choose = next => {
    const target = open === next ? null : next;
    const apply = () => { setOpen(target); window.scrollTo({top: 0}); };
    // The cards morph to their new places where the browser can; otherwise they simply move.
    if (document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(() => flushSync(apply));
    else apply();
  };
  const downloadDocument = async item => {
    setDownloading(item.id); setError('');
    try { const result = await request(`/v1/patient/documents/${item.id}/download`); window.location.assign(result.downloadUrl); }
    catch (event) { setError(event.message); }
    finally { setDownloading(''); }
  };
  const appointments = home?.appointments || [];
  const documents = home?.documents || [];
  const now = Date.now();
  const upcoming = appointments.filter(item => item.startTime && new Date(item.startTime) >= now && item.status !== 'cancelled').sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const waiting = appointments.filter(item => !item.startTime && item.status !== 'cancelled');
  const past = appointments.filter(item => item.startTime && (new Date(item.startTime) < now || item.status === 'cancelled')).sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  const next = upcoming[0];
  const organizationName = home?.organization?.name || 'Your dental office';
  const clinicName = home?.clinic?.name;
  const firstName = home?.patient?.firstName;

  // Back to front: the next visit is the card on top of the deck.
  const cards = [
    {key: 'clinic', label: 'My clinic', icon: Building2, summary: clinicName || '',
      body: <p className="pp-card-lead">{clinicName || organizationName}<small>{organizationName}</small></p>,
      detail: <><p>Your appointments and documents follow you to every {organizationName} clinic, and you can ask for a visit at any of them.</p><p className="pp-safe"><ShieldCheck size={18} />Your access is private. This account cannot open staff or administrator records.</p><button type="button" className="pp-secondary" onClick={signOut}><LogOut size={16} />Sign out</button></>},
    {key: 'documents', label: 'Documents', icon: FileText, summary: home ? plural(documents.length, 'document') : '',
      body: <p className="pp-card-lead">{documents[0]?.name || 'Nothing shared yet'}<small>{documents[0] ? `Shared ${formatDay(documents[0].createdAt)}` : 'Your office will share forms and records here'}</small></p>,
      detail: documents.length ? <ul className="pp-list">{documents.map(item => <li className="pp-row" key={item.id}><span className="pp-date-tile is-file" aria-hidden="true"><FileText size={20} /></span><span className="pp-row-text"><strong>{item.name}</strong><small>Shared {formatDay(item.createdAt)}</small></span><button type="button" className="pp-icon-button" onClick={() => downloadDocument(item)} disabled={downloading === item.id} aria-label={`Download ${item.name}`}><Download size={18} /></button></li>)}</ul> : <p>No documents have been shared yet.</p>},
    {key: 'book', label: 'Request a visit', icon: CalendarPlus, summary: waiting.length ? `${waiting.length} waiting` : '',
      body: <p className="pp-card-lead">Ask for a time<small>At {clinicName || 'your clinic'} or any clinic in the network</small></p>,
      detail: home && <PatientBooking request={request} onBooked={loadHome} />},
    {key: 'visits', label: 'Next visit', icon: CalendarDays, summary: next ? dayOf(next.startTime) : '',
      body: next
        ? <div className="pp-next"><strong>{dayOf(next.startTime)}</strong><span>{timeOf(next.startTime)}</span><small>{next.service}{next.clinic ? ` · ${next.clinic}` : ''}</small></div>
        : <p className="pp-card-lead">{home ? 'No visit booked' : 'Loading…'}<small>{waiting.length ? `${plural(waiting.length, 'request')} waiting for the office to choose a time` : 'Request one from the dock below'}</small></p>,
      detail: appointments.length ? <>
        {upcoming.length > 0 && <><h3>Upcoming</h3><ul className="pp-list">{upcoming.map(item => <VisitRow key={item.id} item={item} />)}</ul></>}
        {waiting.length > 0 && <><h3>Waiting for a time</h3><ul className="pp-list">{waiting.map(item => <VisitRow key={item.id} item={item} />)}</ul></>}
        {past.length > 0 && <><h3>Past</h3><ul className="pp-list">{past.map(item => <VisitRow key={item.id} item={item} />)}</ul></>}
      </> : <p>No appointments yet.</p>},
  ];
  const dock = [{key: null, label: 'Home', icon: Home}, {key: 'visits', label: 'Visits', icon: CalendarDays}, {key: 'book', label: 'Book', icon: CalendarPlus}, {key: 'documents', label: 'Documents', icon: FileText}, {key: 'clinic', label: 'Clinic', icon: Building2}];
  const today = new Date().toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric'});

  return <div className="pp">
    <header className="pp-header">
      <div><small>{today}</small><h1>{firstName ? `Hi, ${firstName}` : 'Welcome'}</h1><span>{organizationName}{identity ? ` · ${identity}` : ''}</span></div>
      <button type="button" className="pp-avatar" onClick={() => choose('clinic')} aria-label="My clinic and sign out">{(firstName || '?')[0]}</button>
    </header>
    {error && <div className="live-error pp-error">{error}</div>}
    <main className="pp-deck" data-open={open || undefined}>
      {cards.map((card, index) => {
        const Icon = card.icon;
        const isOpen = open === card.key;
        return <section key={card.key} className={`pp-card pp-card-${card.key}${isOpen ? ' is-open' : ''}`} style={{'--depth': cards.length - 1 - index, viewTransitionName: `pp-card-${card.key}`}} aria-labelledby={`pp-${card.key}-title`}>
          <button type="button" className="pp-card-head" aria-expanded={isOpen} aria-controls={`pp-${card.key}-detail`} onClick={() => choose(card.key)}>
            <span className="pp-card-icon"><Icon size={18} /></span><span id={`pp-${card.key}-title`} className="pp-card-title">{card.label}</span>
            {isOpen ? <span className="pp-done">Done</span> : card.summary && <span className="pp-card-summary">{card.summary}</span>}
            <ChevronDown size={18} className="pp-chevron" aria-hidden="true" />
          </button>
          <div className="pp-card-body">{card.body}</div>
          {isOpen && <div className="pp-sheet" id={`pp-${card.key}-detail`}>{card.detail}</div>}
        </section>;
      })}
    </main>
    <nav className="pp-dock" aria-label="Patient portal">
      {dock.map(({key, label, icon: Icon}) => <button type="button" key={label} className={`pp-dock-item pp-dock-${key || 'home'}`} aria-current={open === key ? 'page' : undefined} onClick={() => key === null ? (open && choose(open)) : choose(key)}>
        <span className="pp-dock-icon"><Icon size={22} /></span><span className="pp-dock-label">{label}</span>
      </button>)}
    </nav>
  </div>;
}
