import { ArrowLeft, ChevronRight, ShieldCheck, Stethoscope } from 'lucide-react';

export const patientClinics = {
  'express-dental': {
    name: 'Express Dental Emergency Services',
    location: 'Baltimore, Maryland',
    initials: 'ED',
  },
};

function PortalBrand() {
  return <div className="portal-brand"><span className="portal-brand-mark" aria-hidden="true"><i /><b /></span><span><strong>Kantage</strong><small>Healthcare</small></span></div>;
}

export function PatientClinicChooser({ navigate }) {
  return <div className="patient-access-screen">
    <header><PortalBrand /></header>
    <main className="patient-access-card clinic-chooser-card">
      <div className="patient-access-icon"><Stethoscope size={27} /></div>
      <h1>Choose your dental office</h1>
      <p>Select your clinic to continue to its patient login.</p>
      <div className="patient-clinic-choices">
        {Object.entries(patientClinics).map(([slug, clinic]) => <button key={slug} onClick={() => navigate(`/patient/${slug}`)}>
          <span>{clinic.initials}</span>
          <span><strong>{clinic.name}</strong><small>{clinic.location}</small></span>
          <ChevronRight size={19} />
        </button>)}
      </div>
    </main>
  </div>;
}

export function PatientPortal({ navigate, clinicSlug }) {
  const clinic = patientClinics[clinicSlug];
  return <div className="patient-access-screen">
    <header><button onClick={() => navigate('/patient')}><ArrowLeft size={18} /> Change clinic</button><PortalBrand /></header>
    <main className="patient-access-card">
      <div className="patient-clinic-badge">{clinic.initials}</div>
      <span className="patient-access-practice">{clinic.name}</span>
      <h1>Patient login</h1>
      <p>Sign in to manage appointments and messages for this office.</p>
      <form onSubmit={event => event.preventDefault()}>
        <label>Email address<input type="email" autoComplete="username" disabled /></label>
        <label>Password<input type="password" autoComplete="current-password" disabled /></label>
        <button className="primary" disabled>Sign in</button>
      </form>
      <div className="patient-login-help"><ShieldCheck size={17} /><span>Access will open when verified patient accounts are connected for {clinic.name}.</span></div>
    </main>
  </div>;
}
