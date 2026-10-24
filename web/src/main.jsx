import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Building2, CalendarDays, CreditCard, Home, KeyRound, LogOut, ShieldCheck, Stethoscope, Users } from 'lucide-react';
import { beginSignIn, claims, finishSignIn, hasGroup, signOut } from './auth.js';
import './styles.css';

const portalHosts = {admin: 'admin.health.kantage.solutions', staff: 'staff.health.kantage.solutions', patient: 'patient.health.kantage.solutions'};
const dentalEms = {organizationId: '92dccdff-7946-49de-a359-2ad9151c8b84', locationId: '7f20f302-05c9-47de-b874-5cd806d72b9b', name: 'Express Dental Emergency Services', location: 'Baltimore, Maryland'};
const apiUrl = 'https://health.kantage.solutions';

function Brand() {
  return <div className="brand"><span className="mark" aria-hidden="true"><i /><b /></span><span>Kantage<br />Healthcare</span></div>;
}

function portalRole() {
  if (window.location.hostname === portalHosts.admin || window.location.pathname === '/admin') return 'admin';
  if (window.location.hostname === portalHosts.patient || window.location.pathname.startsWith('/patient')) return 'patient';
  return 'staff';
}

function Login({ role, error }) {
  const labels = {admin: 'Kantage administrator', staff: 'DentalEMS staff', patient: 'DentalEMS patient'};
  const descriptions = {
    admin: 'Manage healthcare clients, clinic access, and platform operations.',
    staff: 'Open the clinic workspace for patients, appointments, and payments.',
    patient: 'View your private DentalEMS account and appointment information.',
  };
  return <div className={`workforce-login login-${role}`}><main className="workforce-login-card">
    <Brand />
    <span className="owner-kicker">{labels[role].toUpperCase()} PORTAL</span>
    <h1>{labels[role]} sign in</h1>
    <p>{descriptions[role]}</p>
    {error && <p className="login-error">{error}</p>}
    <button className="primary portal-sign-in" type="button" onClick={beginSignIn}>Continue to secure sign in</button>
    <p className="workforce-login-notice"><ShieldCheck size={16} /> Secure access is limited to this portal and your assigned role.</p>
  </main></div>;
}

async function loadCollection(path, session) {
  const response = await fetch(`${apiUrl}${path}`, {headers: {authorization: `Bearer ${session.access_token}`, 'x-kantage-organization': dentalEms.organizationId, 'x-kantage-location': dentalEms.locationId}});
  if (!response.ok) throw new Error(response.status === 403 ? 'This account does not have access to DentalEMS.' : 'Live clinic data could not be loaded.');
  return response.json();
}

function PortalHeader({ title, subtitle, tone = 'clinic' }) {
  return <header className={`live-header ${tone}-header`}><Brand /><div><strong>{title}</strong><small>{subtitle}</small></div><button className="secondary" onClick={signOut}><LogOut size={16} /> Sign out</button></header>;
}

function PortalTabs({ items, active, onChange, tone = 'clinic' }) {
  return <nav className={`portal-tabs ${tone}-tabs`} aria-label="Portal sections">{items.map(({label, icon: Icon}) => <button key={label} className={active === label ? 'active' : ''} onClick={() => onChange(label)}><Icon size={17} />{label}</button>)}</nav>;
}

function AdminPortal({ session }) {
  const identity = claims(session);
  const [active, setActive] = useState('Overview');
  const [platformStatus, setPlatformStatus] = useState('Checking');
  useEffect(() => { fetch(`${apiUrl}/healthz`).then(response => setPlatformStatus(response.ok ? 'Operational' : 'Needs attention')).catch(() => setPlatformStatus('Needs attention')); }, []);
  const tabs = [{label: 'Overview', icon: Home}, {label: 'Clients', icon: Building2}, {label: 'Access', icon: KeyRound}, {label: 'Audit', icon: Activity}];
  return <div className="live-portal admin-live-portal">
    <PortalHeader tone="admin" title="Kantage Healthcare Admin" subtitle={identity.email || 'Platform administrator'} />
    <PortalTabs tone="admin" items={tabs} active={active} onChange={setActive} />
    <main>
      <div className="admin-hero"><div><div className="live-kicker">PLATFORM CONTROL CENTER</div><h1>{active}</h1><p className="live-intro">Manage client organizations and platform access without opening routine patient records.</p></div><span className={`platform-health ${platformStatus === 'Operational' ? 'healthy' : ''}`}><i />{platformStatus}</span></div>
      {active === 'Overview' && <><section className="live-metrics admin-metrics"><article><Building2 /><strong>1</strong><span>Active client</span></article><article><Stethoscope /><strong>1</strong><span>Clinic location</span></article><article><ShieldCheck /><strong>{platformStatus === 'Operational' ? 'Online' : 'Check'}</strong><span>Platform status</span></article></section><section className="admin-grid"><article className="live-panel client-summary-card"><div className="client-monogram">DE</div><div><span className="card-eyebrow">ACTIVE CLIENT</span><h2>{dentalEms.name}</h2><p>{dentalEms.location}</p></div><span className="status"><i />Active</span></article><article className="live-panel admin-boundary-card"><ShieldCheck /><div><h2>Privacy boundary active</h2><p>Platform administration stays separate from daily clinic and patient work.</p></div></article></section></>}
      {active === 'Clients' && <section className="live-panel admin-section"><div className="panel-heading"><div><h2>Client organizations</h2><p>Organizations currently connected to Kantage Healthcare.</p></div></div><div className="admin-client-row"><div className="client-monogram">DE</div><div><strong>{dentalEms.name}</strong><small>{dentalEms.location} · 1 clinic</small></div><span className="status"><i />Active</span></div></section>}
      {active === 'Access' && <section className="live-panel admin-section admin-message"><KeyRound /><h2>Role controlled access</h2><p>Administrator, clinic staff, and patient accounts are assigned to separate portal groups. A user cannot move between portals without the matching role.</p></section>}
      {active === 'Audit' && <section className="live-panel admin-section admin-message"><Activity /><h2>Platform audit activity</h2><p>Administrative and support activity will appear here without exposing routine clinical records.</p></section>}
    </main>
  </div>;
}

function StaffPortal({ session }) {
  const [active, setActive] = useState('Dashboard');
  const [data, setData] = useState({patients: [], appointments: [], payments: []});
  const [error, setError] = useState('');
  const identity = claims(session);
  useEffect(() => { Promise.all([loadCollection('/v1/patients', session), loadCollection('/v1/appointments', session), loadCollection('/v1/payments', session)]).then(([patients, appointments, payments]) => setData({patients: patients.patients, appointments: appointments.appointments, payments: payments.payments})).catch(event => setError(event.message)); }, [session]);
  const patientsById = useMemo(() => new Map(data.patients.map(patient => [patient.id, patient])), [data.patients]);
  const requested = data.appointments.filter(item => item.status === 'requested');
  const tabs = [{label: 'Dashboard', icon: Home}, {label: 'Patients', icon: Users}, {label: 'Appointments', icon: CalendarDays}, {label: 'Payments', icon: CreditCard}];
  const patientTable = <div className="responsive-table"><table><thead><tr><th>Patient</th><th>Phone</th><th>Email</th><th>Status</th></tr></thead><tbody>{data.patients.map(patient => <tr key={patient.id}><td><strong>{patient.first_name} {patient.last_name}</strong></td><td>{patient.phone}</td><td>{patient.email || 'Not provided'}</td><td><span className="status"><i />{patient.status}</span></td></tr>)}{!data.patients.length && !error && <tr><td colSpan="4">No patient records yet.</td></tr>}</tbody></table></div>;
  const appointmentTable = <div className="responsive-table"><table><thead><tr><th>Patient</th><th>Service</th><th>Date</th><th>Status</th></tr></thead><tbody>{data.appointments.map(appointment => { const patient = patientsById.get(appointment.patient_id); return <tr key={appointment.id}><td>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient'}</td><td>{appointment.service}</td><td>{appointment.start_time ? new Date(appointment.start_time).toLocaleString() : 'Requested'}</td><td>{appointment.status}</td></tr>; })}{!data.appointments.length && !error && <tr><td colSpan="4">No appointment records yet.</td></tr>}</tbody></table></div>;
  const paymentTable = <div className="responsive-table"><table><thead><tr><th>Patient</th><th>Amount</th><th>Description</th><th>Status</th></tr></thead><tbody>{data.payments.map(payment => { const patient = patientsById.get(payment.patient_id); const amount = Number(payment.amount_cents || 0) / 100; return <tr key={payment.id}><td>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient'}</td><td>{amount.toLocaleString('en-US', {style: 'currency', currency: 'USD'})}</td><td>{payment.description || payment.care_code || 'Payment'}</td><td>{payment.status}</td></tr>; })}{!data.payments.length && !error && <tr><td colSpan="4">No payment records yet.</td></tr>}</tbody></table></div>;
  return <div className="live-portal staff-live-portal">
    <PortalHeader title="DentalEMS Staff Portal" subtitle={identity.email || dentalEms.name} />
    <PortalTabs items={tabs} active={active} onChange={setActive} />
    <main><div className="live-kicker">{dentalEms.name.toUpperCase()} · CLINIC WORKSPACE</div><h1>{active === 'Dashboard' ? 'Clinic command center' : active}</h1><p className="live-intro">Manage the clinic’s live patient, appointment, and payment activity.</p>{error && <div className="live-error">{error}</div>}
      {active === 'Dashboard' && <><section className="live-metrics"><article><Users /><strong>{data.patients.length}</strong><span>Patients</span></article><article><CalendarDays /><strong>{data.appointments.length}</strong><span>Appointments</span></article><article><Stethoscope /><strong>{requested.length}</strong><span>Booking requests</span></article></section><section className="staff-dashboard-grid"><article className="live-panel"><div className="panel-heading"><div><h2>New booking requests</h2><p>Requests submitted through the DentalEMS website.</p></div></div>{requested.length ? <div className="request-stack">{requested.slice(0, 4).map(item => { const patient = patientsById.get(item.patient_id); return <div key={item.id}><CalendarDays /><span><strong>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient request'}</strong><small>{item.service}</small></span><b>{item.status}</b></div>; })}</div> : <div className="compact-empty"><CalendarDays /><span>No new booking requests.</span></div>}</article><article className="live-panel staff-clinic-card"><div className="patient-clinic-badge">ED</div><span className="card-eyebrow">YOUR CLINIC</span><h2>{dentalEms.name}</h2><p>{dentalEms.location}</p><div className="status"><i />Connected</div></article></section></>}
      {active === 'Patients' && <section className="live-panel"><div className="panel-heading"><div><h2>Patient directory</h2><p>Profiles created by staff or the appointment request form.</p></div></div>{patientTable}</section>}
      {active === 'Appointments' && <section className="live-panel"><div className="panel-heading"><div><h2>Appointment activity</h2><p>Requested, confirmed, and completed visits.</p></div></div>{appointmentTable}</section>}
      {active === 'Payments' && <section className="live-panel"><div className="panel-heading"><div><h2>Payment activity</h2><p>Clinic payment records and current statuses.</p></div></div>{paymentTable}</section>}
    </main>
  </div>;
}

function PatientHome({ session }) {
  const identity = claims(session);
  return <div className="live-portal patient-live-portal"><PortalHeader title="DentalEMS Patient Portal" subtitle={identity.email || dentalEms.name} /><main className="patient-home-live"><div className="patient-clinic-badge">ED</div><div className="live-kicker">{dentalEms.name.toUpperCase()}</div><h1>Welcome to your patient portal</h1><p>Your secure account is active. Online appointment history and patient specific records will appear here after the clinic verifies your profile.</p><section className="patient-safe-card"><ShieldCheck /><div><strong>Your access is private</strong><span>This account cannot open staff or administrator records.</span></div></section></main></div>;
}

function App() {
  const role = portalRole();
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { finishSignIn().then(value => setSession(value)).catch(event => setError(event.message)).finally(() => setReady(true)); }, []);
  useEffect(() => { document.title = `${role === 'admin' ? 'Admin' : role === 'staff' ? 'Staff' : 'Patient'} Login | Kantage Healthcare`; }, [role]);
  if (!ready) return <div className="portal-loading">Loading secure portal…</div>;
  if (!session) return <Login role={role} error={error} />;
  const authorized = role === 'admin' ? hasGroup(session, 'platform_admin') : role === 'staff' ? hasGroup(session, 'dentalems_staff') : hasGroup(session, 'dentalems_patient');
  if (!authorized) return <div className={`workforce-login login-${role}`}><main className="workforce-login-card"><Brand /><h1>Access not assigned</h1><p>This account is valid, but it is not assigned to this portal.</p><button className="primary portal-sign-in" onClick={signOut}>Sign out</button></main></div>;
  if (role === 'admin') return <AdminPortal session={session} />;
  if (role === 'patient') return <PatientHome session={session} />;
  return <StaffPortal session={session} />;
}

createRoot(document.getElementById('root')).render(<App />);
