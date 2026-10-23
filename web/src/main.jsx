import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CalendarDays, LogOut, ShieldCheck, Stethoscope, Users } from 'lucide-react';
import { beginSignIn, claims, finishSignIn, hasGroup, signOut } from './auth.js';
import './styles.css';

const portalHosts = {
  admin: 'admin.health.kantage.solutions',
  staff: 'staff.health.kantage.solutions',
  patient: 'patient.health.kantage.solutions',
};
const dentalEms = {
  organizationId: '92dccdff-7946-49de-a359-2ad9151c8b84',
  locationId: '7f20f302-05c9-47de-b874-5cd806d72b9b',
  name: 'Express Dental Emergency Services',
};
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
  const labels = {admin: 'Kantage administrator', staff: 'Clinic staff', patient: 'Patient'};
  const label = labels[role];
  return <div className="workforce-login"><main className="workforce-login-card">
    <Brand />
    <span className="owner-kicker">{label.toUpperCase()} PORTAL</span>
    <h1>{label} sign in</h1>
    <p>{role === 'patient' ? `Secure access for ${dentalEms.name} patients.` : `This workspace is reserved for authorized ${role === 'admin' ? 'Kantage administrators' : 'DentalEMS team members'}.`}</p>
    {error && <p className="login-error">{error}</p>}
    <button className="primary portal-sign-in" type="button" onClick={beginSignIn}>Continue to secure sign in</button>
    <p className="workforce-login-notice"><ShieldCheck size={16} /> Passwords and multifactor authentication are handled by AWS Cognito.</p>
  </main></div>;
}

async function loadCollection(path, session) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      authorization: `Bearer ${session.access_token}`,
      'x-kantage-organization': dentalEms.organizationId,
      'x-kantage-location': dentalEms.locationId,
    },
  });
  if (!response.ok) throw new Error(response.status === 403 ? 'This account does not have access to DentalEMS.' : 'Live clinic data could not be loaded.');
  return response.json();
}

function PortalHeader({ title, subtitle }) {
  return <header className="live-header"><Brand /><div><strong>{title}</strong><small>{subtitle}</small></div><button className="secondary" onClick={signOut}><LogOut size={16} /> Sign out</button></header>;
}

function WorkforcePortal({ role, session }) {
  const [data, setData] = useState({patients: [], appointments: [], payments: []});
  const [error, setError] = useState('');
  const identity = claims(session);
  useEffect(() => {
    Promise.all([
      loadCollection('/v1/patients', session),
      loadCollection('/v1/appointments', session),
      loadCollection('/v1/payments', session),
    ]).then(([patients, appointments, payments]) => setData({patients: patients.patients, appointments: appointments.appointments, payments: payments.payments})).catch(event => setError(event.message));
  }, [session]);
  const patientsById = useMemo(() => new Map(data.patients.map(patient => [patient.id, patient])), [data.patients]);
  return <div className="live-portal">
    <PortalHeader title={role === 'admin' ? 'Kantage Healthcare Admin' : 'DentalEMS Staff Portal'} subtitle={identity.email || dentalEms.name} />
    <main>
      <div className="live-kicker">{role === 'admin' ? 'PLATFORM ADMINISTRATION' : dentalEms.name.toUpperCase()}</div>
      <h1>{role === 'admin' ? 'Healthcare operations' : 'Clinic command center'}</h1>
      <p className="live-intro">Live records for the DentalEMS clinic. Test and submitted booking requests appear here automatically.</p>
      {error && <div className="live-error">{error}</div>}
      <section className="live-metrics">
        <article><Users /><strong>{data.patients.length}</strong><span>Patients</span></article>
        <article><CalendarDays /><strong>{data.appointments.length}</strong><span>Appointments</span></article>
        <article><Stethoscope /><strong>{data.appointments.filter(item => item.status === 'requested').length}</strong><span>Booking requests</span></article>
      </section>
      <section className="live-panel">
        <div className="panel-heading"><div><h2>Recent patients</h2><p>Records created by staff or the DentalEMS appointment form.</p></div></div>
        <div className="responsive-table"><table><thead><tr><th>Patient</th><th>Phone</th><th>Email</th><th>Status</th></tr></thead><tbody>
          {data.patients.map(patient => <tr key={patient.id}><td><strong>{patient.first_name} {patient.last_name}</strong></td><td>{patient.phone}</td><td>{patient.email || '—'}</td><td><span className="status"><i />{patient.status}</span></td></tr>)}
          {!data.patients.length && !error && <tr><td colSpan="4">No patient records yet.</td></tr>}
        </tbody></table></div>
      </section>
      <section className="live-panel">
        <div className="panel-heading"><div><h2>Appointment activity</h2><p>Current appointment and inquiry records.</p></div></div>
        <div className="responsive-table"><table><thead><tr><th>Patient</th><th>Service</th><th>Date</th><th>Status</th></tr></thead><tbody>
          {data.appointments.map(appointment => { const patient = patientsById.get(appointment.patient_id); return <tr key={appointment.id}><td>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient'}</td><td>{appointment.service}</td><td>{appointment.start_time ? new Date(appointment.start_time).toLocaleString() : 'Requested'}</td><td>{appointment.status}</td></tr>; })}
          {!data.appointments.length && !error && <tr><td colSpan="4">No appointment records yet.</td></tr>}
        </tbody></table></div>
      </section>
    </main>
  </div>;
}

function PatientHome({ session }) {
  const identity = claims(session);
  return <div className="live-portal patient-live-portal">
    <PortalHeader title="DentalEMS Patient Portal" subtitle={identity.email || dentalEms.name} />
    <main className="patient-home-live"><div className="patient-clinic-badge">ED</div><div className="live-kicker">{dentalEms.name.toUpperCase()}</div><h1>Welcome to your patient portal</h1><p>Your secure account is active. Online appointment history and patient-specific records will appear here after the clinic verifies your profile.</p><section className="patient-safe-card"><ShieldCheck /><div><strong>Your access is private</strong><span>This account cannot open staff or administrator records.</span></div></section></main>
  </div>;
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
  if (!authorized) return <div className="workforce-login"><main className="workforce-login-card"><Brand /><h1>Access not assigned</h1><p>This account is valid, but it is not assigned to this portal.</p><button className="primary portal-sign-in" onClick={signOut}>Sign out</button></main></div>;
  return role === 'patient' ? <PatientHome session={session} /> : <WorkforcePortal role={role} session={session} />;
}

createRoot(document.getElementById('root')).render(<App />);
