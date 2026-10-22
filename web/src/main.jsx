import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PatientClinicChooser, PatientPortal, patientClinics } from './portal-surfaces.jsx';
import './styles.css';

const portalHosts = {
  admin: 'admin.health.kantage.solutions',
  staff: 'staff.health.kantage.solutions',
  patient: 'patient.health.kantage.solutions',
};

function Brand() {
  return <div className="brand"><span className="mark" aria-hidden="true"><i /><b /></span><span>Kantage<br />Healthcare</span></div>;
}

function WorkforceLogin({ role }) {
  const label = role === 'admin' ? 'Kantage administrator' : 'Clinic staff';
  return <div className="workforce-login"><main className="workforce-login-card">
    <Brand />
    <span className="owner-kicker">{label.toUpperCase()} PORTAL</span>
    <h1>{label} sign in</h1>
    <p>This workspace is reserved for authorized {role === 'admin' ? 'Kantage administrators' : 'clinic team members'}.</p>
    <form onSubmit={event => event.preventDefault()}>
      <label>Email address<input type="email" autoComplete="username" disabled /></label>
      <label>Password<input type="password" autoComplete="current-password" disabled /></label>
      <button className="primary" type="submit" disabled>Sign in</button>
    </form>
    <p className="workforce-login-notice">Sign in is being connected to verified accounts. Access is unavailable until authentication is ready.</p>
  </main></div>;
}

function PortalRouter() {
  const [path, setPath] = useState(window.location.pathname);
  const host = window.location.hostname;
  const navigate = next => {
    if (host === portalHosts.admin || host === portalHosts.staff) return;
    if (host === portalHosts.patient && !next.startsWith('/patient')) return;
    window.history.pushState({}, '', next);
    setPath(next);
  };
  const normalized = path.replace(/\/+$/, '') || '/';
  const patientMatch = normalized.match(/^\/patient\/([a-z0-9-]+)$/);
  useEffect(() => {
    document.title = host === portalHosts.admin ? 'Kantage Healthcare Admin Sign In'
      : host === portalHosts.staff ? 'Kantage Healthcare Staff Sign In'
      : 'Kantage Healthcare Patient Portal';
  }, [host]);
  if (host === portalHosts.admin) return <WorkforceLogin role="admin" />;
  if (host === portalHosts.staff) return <WorkforceLogin role="staff" />;
  if (host === portalHosts.patient) return patientMatch && patientClinics[patientMatch[1]]
    ? <PatientPortal navigate={navigate} clinicSlug={patientMatch[1]} />
    : <PatientClinicChooser navigate={navigate} />;
  if (normalized === '/admin') return <WorkforceLogin role="admin" />;
  if (normalized === '/staff') return <WorkforceLogin role="staff" />;
  if (patientMatch && patientClinics[patientMatch[1]]) return <PatientPortal navigate={navigate} clinicSlug={patientMatch[1]} />;
  return <PatientClinicChooser navigate={navigate} />;
}

window.addEventListener('popstate', () => window.location.reload());
createRoot(document.getElementById('root')).render(<PortalRouter />);
