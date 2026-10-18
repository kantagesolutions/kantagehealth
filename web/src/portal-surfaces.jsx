import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Building2,
  CalendarDays,
  Check,
  ChevronRight,
  CreditCard,
  FileText,
  Headset,
  Home,
  LockKeyhole,
  MapPin,
  MessageSquare,
  Plus,
  ShieldCheck,
  Stethoscope,
  UserCog,
  Users,
} from 'lucide-react';

const patientNavigation = [
  ['Home', Home],
  ['My appointments', CalendarDays],
  ['Documents', FileText],
  ['Billing', CreditCard],
  ['Messages', MessageSquare],
  ['Profile', UserCog],
];

export const patientClinics = {
  'express-dental': {
    name: 'Express Dental',
    location: 'Baltimore, Maryland',
    address: '1111 Park Avenue, Suite L-109, Baltimore, MD 21201',
    phone: '410-708-3232',
    phoneHref: '+14107083232',
    initials: 'ED',
  },
  'innovation-dental': {
    name: 'Innovation Dental',
    location: 'Baltimore, Maryland',
    address: 'Baltimore, MD',
    initials: 'ID',
  },
  'the-dental-loft': {
    name: 'The Dental Loft at Perry Hall',
    location: 'Perry Hall, Maryland',
    address: 'Perry Hall, MD',
    initials: 'DL',
  },
};

function PortalBrand({ compact = false }) {
  return (
    <div className={compact ? 'portal-brand compact' : 'portal-brand'}>
      <span className="portal-brand-mark" aria-hidden="true"><i /><b /></span>
      <span><strong>Kantage</strong><small>Healthcare</small></span>
    </div>
  );
}

const portalOptions = [
  {
    path: '/admin',
    title: 'Kantage Admin',
    description: 'Manage client organizations, onboarding, subscriptions, platform health, and support.',
    audience: 'Kantage platform owners',
    Icon: ShieldCheck,
    tone: 'navy',
  },
  {
    path: '/staff',
    title: 'Clinic Staff',
    description: 'Open your organization, choose a clinic, and manage daily patient operations.',
    audience: 'Owners, office teams, and providers',
    Icon: Stethoscope,
    tone: 'green',
  },
  {
    path: '/patient',
    title: 'Patient Portal',
    description: 'Request appointments, review visits, exchange documents, and contact your care team.',
    audience: 'Patients and authorized caregivers',
    Icon: Users,
    tone: 'blue',
  },
];

export function PortalEntry({ navigate }) {
  return (
    <div className="portal-entry">
      <header className="portal-entry-header">
        <PortalBrand />
        <span><LockKeyhole size={17} /> Secure healthcare access</span>
      </header>
      <main className="portal-entry-main">
        <section className="portal-entry-copy">
          <h1>Choose your portal</h1>
          <p>Select the workspace that matches your role. Each portal keeps its tools and information separated.</p>
        </section>
        <section className="portal-option-list" aria-label="Healthcare portals">
          {portalOptions.map(({ path, title, description, audience, Icon, tone }) => (
            <button className={`portal-option ${tone}`} key={path} onClick={() => navigate(path)}>
              <span className="portal-option-icon"><Icon size={25} /></span>
              <span className="portal-option-copy">
                <strong>{title}</strong>
                <span>{description}</span>
                <small>{audience}</small>
              </span>
              <ArrowRight size={20} />
            </button>
          ))}
        </section>
        <p className="portal-entry-help"><Headset size={17} /> Need help finding your portal? Contact your Kantage Healthcare administrator.</p>
      </main>
      <footer className="portal-entry-footer">
        <span>Protected healthcare operations</span>
        <span>Privacy · Accessibility · Support</span>
      </footer>
    </div>
  );
}

export function PatientClinicChooser({ navigate }) {
  return (
    <div className="patient-access-screen">
      <header><button onClick={() => navigate('/')}><ArrowLeft size={18} /> All portals</button><PortalBrand /></header>
      <main className="patient-access-card clinic-chooser-card">
        <div className="patient-access-icon"><Stethoscope size={27} /></div>
        <h1>Choose your dental office</h1>
        <p>Select your clinic to continue to its patient login.</p>
        <div className="patient-clinic-choices">
          {Object.entries(patientClinics).map(([slug, clinic]) => (
            <button key={slug} onClick={() => navigate(`/patient/${slug}`)}>
              <span>{clinic.initials}</span>
              <span><strong>{clinic.name}</strong><small>{clinic.location}</small></span>
              <ChevronRight size={19} />
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}

function PatientLogin({ clinic, navigate, onSignIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="patient-access-screen">
      <header><button onClick={() => navigate('/patient')}><ArrowLeft size={18} /> Change clinic</button><PortalBrand /></header>
      <main className="patient-access-card">
        <div className="patient-clinic-badge">{clinic.initials}</div>
        <span className="patient-access-practice">{clinic.name}</span>
        <h1>Patient login</h1>
        <p>Sign in to manage appointments, documents, billing, and messages for this office.</p>
        <form onSubmit={(event) => { event.preventDefault(); onSignIn(); }}>
          <label>Email address<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <div className="patient-login-options"><label><input type="checkbox" /> Keep me signed in</label><button type="button">Forgot password?</button></div>
          <button className="primary">Sign in</button>
        </form>
        <div className="patient-login-help"><ShieldCheck size={17} /><span>Your portal session is private and specific to {clinic.name}.</span></div>
        <p className="patient-new-account">New patient? <button type="button">Create an account</button></p>
      </main>
    </div>
  );
}

function PatientSidebar({ active, setActive, navigate, clinic }) {
  return (
    <aside className="patient-sidebar">
      <PortalBrand compact />
      <div className="patient-identity">
        <span>JW</span>
        <div><strong>Jordan Williams</strong><small>Patient portal</small></div>
      </div>
      <nav aria-label="Patient portal">
        {patientNavigation.map(([label, Icon]) => (
          <button key={label} className={active === label ? 'active' : ''} onClick={() => setActive(label)}>
            <Icon size={19} /><span>{label}</span>
          </button>
        ))}
      </nav>
      <button className="patient-exit" onClick={() => navigate(`/patient/${Object.entries(patientClinics).find(([, item]) => item === clinic)?.[0] ?? ''}`)}><ArrowLeft size={17} /> Sign out</button>
    </aside>
  );
}

function AppointmentRequest({ clinic, onClose, onCreate }) {
  const [visitType, setVisitType] = useState('New patient exam');
  const [preferredDate, setPreferredDate] = useState('2026-10-22');
  return (
    <div className="overlay">
      <form className="dialog patient-request-dialog" onSubmit={(event) => {
        event.preventDefault();
        onCreate({ clinic: clinic.name, visitType, preferredDate, status: 'Request received' });
      }}>
        <div className="dialog-head">
          <div><h2>Request an appointment</h2><p>Your clinic will review availability before confirming the visit.</p></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="patient-request-clinic"><span>Dental office</span><strong>{clinic.name}</strong></div>
        <label>Visit type<select value={visitType} onChange={(event) => setVisitType(event.target.value)}><option>New patient exam</option><option>Cleaning and exam</option><option>Treatment consultation</option><option>Emergency visit</option></select></label>
        <label>Preferred date<input type="date" min="2026-10-18" value={preferredDate} onChange={(event) => setPreferredDate(event.target.value)} /></label>
        <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary">Send request</button></div>
      </form>
    </div>
  );
}

function PatientHome({ appointments, openRequest, setActive, clinic }) {
  const nextAppointment = appointments.find((item) => item.status === 'Confirmed');
  return (
    <>
      <section className="patient-welcome">
        <div><h1>Good morning, Jordan</h1><p>Your care information and next steps are together in one private place.</p></div>
        <button className="primary" onClick={openRequest}><Plus size={18} /> Request appointment</button>
      </section>
      <section className="patient-next-visit">
        <div className="patient-date"><strong>20</strong><span>OCT</span></div>
        <div className="patient-visit-copy"><span>Upcoming appointment</span><h2>{nextAppointment?.visitType}</h2><p><MapPin size={16} /> {nextAppointment?.clinic} · 9:30 AM</p></div>
        <span className="patient-confirmed"><Check size={15} /> Confirmed</span>
        <button className="secondary" onClick={() => setActive('My appointments')}>View details</button>
      </section>
      <section className="patient-home-grid">
        <article className="patient-panel patient-actions-panel">
          <h2>What would you like to do?</h2>
          <button onClick={openRequest}><CalendarDays size={20} /><span><strong>Request a visit</strong><small>Choose your visit type and preferred date</small></span><ChevronRight /></button>
          <button onClick={() => setActive('Documents')}><FileText size={20} /><span><strong>View documents</strong><small>Forms and care documents</small></span><ChevronRight /></button>
          <button onClick={() => setActive('Messages')}><MessageSquare size={20} /><span><strong>Message the office</strong><small>Ask a non-urgent question</small></span><ChevronRight /></button>
        </article>
        <article className="patient-panel patient-care-team">
          <h2>Your care location</h2>
          <div className="patient-clinic-mark"><Building2 size={25} /></div>
          <strong>{clinic.name}</strong>
          <p>{clinic.address}</p>
          {clinic.phone ? <a href={`tel:${clinic.phoneHref}`}>{clinic.phone}</a> : <span>{clinic.location}</span>}
        </article>
      </section>
    </>
  );
}

function PatientAppointments({ appointments, openRequest }) {
  return (
    <section className="patient-panel patient-list-page">
      <div className="patient-section-heading"><div><h1>My appointments</h1><p>Track confirmed visits and requests awaiting clinic review.</p></div><button className="primary" onClick={openRequest}><Plus size={17} /> Request appointment</button></div>
      <div className="patient-appointment-list">
        {appointments.map((item) => (
          <article key={`${item.clinic}-${item.preferredDate}-${item.visitType}`}>
            <CalendarDays size={21} />
            <div><strong>{item.visitType}</strong><span>{item.clinic}</span><small>{item.preferredDate === '2026-10-20' ? 'Tuesday, October 20 · 9:30 AM' : `Preferred date · ${item.preferredDate}`}</small></div>
            <span className={item.status === 'Confirmed' ? 'patient-confirmed' : 'patient-pending'}>{item.status}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function PatientDocuments() {
  const [notice, setNotice] = useState('');
  const documents = ['New patient registration', 'Privacy practices acknowledgment', 'Treatment estimate'];
  return (
    <section className="patient-panel patient-list-page">
      <div className="patient-section-heading"><div><h1>Documents</h1><p>Review documents shared with you by your care team.</p></div></div>
      {notice ? <p className="success-notice"><BadgeCheck size={18} />{notice}</p> : null}
      <div className="patient-document-list">{documents.map((name, index) => <button key={name} onClick={() => setNotice(`${name} opened securely.`)}><FileText size={20} /><span><strong>{name}</strong><small>{index === 2 ? 'Added October 12, 2026' : 'Completed September 8, 2026'}</small></span><span>{index === 2 ? 'Review' : 'View'}</span></button>)}</div>
    </section>
  );
}

function PatientBilling({ clinic }) {
  return (
    <section className="patient-panel patient-list-page">
      <div className="patient-section-heading"><div><h1>Billing</h1><p>See balances and payment history from participating clinics.</p></div></div>
      <div className="patient-balance"><span>Current balance</span><strong>$0.00</strong><small>No payment is due.</small><BadgeCheck size={28} /></div>
      <h2 className="patient-subheading">Recent activity</h2>
      <div className="patient-payment-row"><CreditCard size={20} /><span><strong>Office payment</strong><small>{clinic.name} · September 8, 2026</small></span><strong>$85.00</strong></div>
    </section>
  );
}

function PatientMessages({ clinic }) {
  const [messages, setMessages] = useState([{ id: 1, sender: clinic.name, body: 'Your appointment for October 20 at 9:30 AM is confirmed.', time: 'Oct 16 · 2:14 PM' }]);
  const [draft, setDraft] = useState('');
  return (
    <section className="patient-panel patient-list-page patient-messages">
      <div className="patient-section-heading"><div><h1>Messages</h1><p>Contact the office for non-urgent questions.</p></div></div>
      <div className="patient-thread">{messages.map((message) => <article className={message.sender === 'You' ? 'mine' : ''} key={message.id}><strong>{message.sender}</strong><p>{message.body}</p><small>{message.time}</small></article>)}</div>
      <form onSubmit={(event) => { event.preventDefault(); if (!draft.trim()) return; setMessages((current) => [...current, { id: Date.now(), sender: 'You', body: draft.trim(), time: 'Just now' }]); setDraft(''); }}><label htmlFor="patient-message">Message</label><textarea id="patient-message" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a non-urgent message" /><button className="primary">Send message</button></form>
    </section>
  );
}

function PatientProfile() {
  const [saved, setSaved] = useState(false);
  return (
    <section className="patient-panel patient-list-page">
      <div className="patient-section-heading"><div><h1>Profile</h1><p>Keep your contact details and communication preferences current.</p></div></div>
      <form className="patient-profile-form" onSubmit={(event) => { event.preventDefault(); setSaved(true); }}>
        <label>Full name<input defaultValue="Jordan Williams" /></label>
        <label>Mobile phone<input defaultValue="410-555-0138" /></label>
        <label>Email<input type="email" defaultValue="jordan@example.com" /></label>
        <label>Preferred contact<select defaultValue="Text message"><option>Text message</option><option>Phone call</option><option>Email</option></select></label>
        <button className="primary">Save profile</button>
      </form>
      {saved ? <p className="success-notice"><BadgeCheck size={18} />Profile changes saved.</p> : null}
    </section>
  );
}

export function PatientPortal({ navigate, clinicSlug }) {
  const clinic = patientClinics[clinicSlug] ?? patientClinics['express-dental'];
  const [signedIn, setSignedIn] = useState(false);
  const [active, setActive] = useState('Home');
  const [showRequest, setShowRequest] = useState(false);
  const [appointments, setAppointments] = useState([
    { clinic: clinic.name, visitType: 'Cleaning and exam', preferredDate: '2026-10-20', status: 'Confirmed' },
  ]);
  const content = useMemo(() => {
    if (active === 'Home') return <PatientHome appointments={appointments} openRequest={() => setShowRequest(true)} setActive={setActive} clinic={clinic} />;
    if (active === 'My appointments') return <PatientAppointments appointments={appointments} openRequest={() => setShowRequest(true)} />;
    if (active === 'Documents') return <PatientDocuments />;
    if (active === 'Billing') return <PatientBilling clinic={clinic} />;
    if (active === 'Messages') return <PatientMessages clinic={clinic} />;
    return <PatientProfile />;
  }, [active, appointments, clinic]);
  if (!signedIn) return <PatientLogin clinic={clinic} navigate={navigate} onSignIn={() => setSignedIn(true)} />;
  return (
    <div className="patient-shell">
      <PatientSidebar active={active} setActive={setActive} navigate={navigate} clinic={clinic} />
      <div className="patient-page">
        <header><div><span>Patient Portal</span><strong>{clinic.name}</strong></div><button onClick={() => setActive('Profile')}>JW</button></header>
        <main>{content}</main>
        <nav className="patient-mobile-nav" aria-label="Patient portal mobile navigation">{patientNavigation.slice(0, 5).map(([label, Icon]) => <button key={label} className={active === label ? 'active' : ''} onClick={() => setActive(label)}><Icon size={19} /><span>{label === 'My appointments' ? 'Visits' : label}</span></button>)}</nav>
      </div>
      {showRequest ? <AppointmentRequest clinic={clinic} onClose={() => setShowRequest(false)} onCreate={(appointment) => { setAppointments((current) => [...current, appointment]); setShowRequest(false); setActive('My appointments'); }} /> : null}
    </div>
  );
}
