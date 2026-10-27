import { useEffect, useState } from 'react';
import { ArrowLeft, CalendarDays, CreditCard, FileText, HeartPulse, KeyRound, Pencil, Upload, Phone, Mail, Building2 } from 'lucide-react';

const tabs = ['Overview', 'Appointments', 'Documents', 'Care notes', 'Payments', 'Portal access'];
const formatDate = value => value ? new Date(value).toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'short'}) : 'Not scheduled';
const dollars = cents => (Number(cents || 0) / 100).toLocaleString('en-US', {style: 'currency', currency: 'USD'});
const nameOf = patient => `${patient.first_name} ${patient.last_name}`;

export default function StaffPatientProfile({patient, workspace, request, onBack, onRefresh, onEnablePortal, onResetPortal, enablingPortal, Chart}) {
  const [tab, setTab] = useState('Overview');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [contact, setContact] = useState({firstName: patient.first_name, lastName: patient.last_name, phone: patient.phone, email: patient.email || ''});
  const history = patient.history || {appointments: [], documents: [], records: [], payments: []};
  const canManage = workspace.roles?.some(role => ['owner', 'organization_owner', 'clinic_administrator', 'front_desk', 'clinician', 'provider'].includes(role));
  const canSchedule = workspace.roles?.some(role => ['owner', 'organization_owner', 'clinic_administrator', 'front_desk'].includes(role));
  const canWriteCare = workspace.roles?.some(role => ['owner', 'organization_owner', 'clinic_administrator', 'clinician', 'provider', 'hygienist_assistant'].includes(role));
  const canManagePayments = workspace.roles?.some(role => ['owner', 'organization_owner', 'clinic_administrator', 'billing', 'billing_specialist'].includes(role));
  const canUpload = workspace.roles?.some(role => ['owner', 'organization_owner', 'clinic_administrator', 'front_desk', 'hygienist_assistant'].includes(role));
  const portalActive = ['active', 'invited'].includes(patient.portal_status);

  useEffect(() => {
    setTab('Overview'); setEditing(false); setError(''); setNotice('');
  }, [patient.id]);
  useEffect(() => {
    setContact({firstName: patient.first_name, lastName: patient.last_name, phone: patient.phone, email: patient.email || ''});
  }, [patient.first_name, patient.last_name, patient.phone, patient.email]);

  async function run(label, action, success) {
    setBusy(label); setError(''); setNotice('');
    try { await action(); await onRefresh(); setNotice(success); }
    catch (event) { setError(event.message || 'This action could not be completed.'); }
    finally { setBusy(''); }
  }

  const saveContact = event => {
    event.preventDefault();
    run('contact', async () => {
      await request(`/v1/patients/${patient.id}`, {method: 'PATCH', body: JSON.stringify(contact)});
      setEditing(false);
    }, 'Patient contact details saved.');
  };
  const createAppointment = event => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const start = new Date(String(fields.get('startTime')));
    if (Number.isNaN(start.getTime())) return setError('Choose a valid appointment date and time.');
    run('appointment', async () => {
      await request('/v1/appointments', {method: 'POST', body: JSON.stringify({patientId: patient.id, service: String(fields.get('service')).trim(), startTime: start.toISOString(), durationMinutes: Number(fields.get('durationMinutes'))})});
      form.reset();
    }, 'Appointment added to this clinic’s schedule.');
  };
  const uploadDocument = event => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.document.files?.[0];
    if (!file) return;
    run('document', async () => {
      const created = await request('/v1/documents/uploads', {method: 'POST', body: JSON.stringify({patientId: patient.id, name: file.name, contentType: file.type, sizeBytes: file.size, documentKind: 'uploaded_record'})});
      const uploaded = await fetch(created.document.uploadUrl, {method: 'PUT', headers: {'content-type': file.type}, body: file});
      if (!uploaded.ok) throw new Error('The document upload did not finish. Try again.');
      await request(`/v1/documents/${created.document.id}/complete`, {method: 'POST'});
      form.reset();
    }, 'Document shared with the patient portal.');
  };
  const addCareNote = event => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    run('note', async () => {
      await request(`/v1/patients/${patient.id}/records`, {method: 'POST', body: JSON.stringify({recordType: String(fields.get('recordType')), note: String(fields.get('note')).trim()})});
      form.reset();
    }, 'Care note saved to this clinic’s chart.');
  };
  const addPayment = event => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const amountCents = Math.round(Number(fields.get('amount')) * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) return setError('Enter a valid amount.');
    run('payment', async () => {
      await request('/v1/payments', {method: 'POST', body: JSON.stringify({patientId: patient.id, amountCents, description: String(fields.get('description')).trim()})});
      form.reset();
    }, 'Payment record created. This does not charge the patient.');
  };

  const upcoming = history.appointments.filter(item => item.start_time && new Date(item.start_time) >= new Date() && item.status !== 'cancelled').sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0];
  return <div className="staff-patient-workspace">
    <div className="patient-breadcrumb">Patients <span>/</span> {nameOf(patient)}</div>
    <button type="button" className="patient-back-link" onClick={onBack}><ArrowLeft size={17}/> Back to patients</button>
    <section className="patient-profile-header">
      <div className="patient-profile-identity"><span className="patient-profile-avatar" aria-hidden="true">{patient.first_name[0]}{patient.last_name[0]}</span><div><div className="patient-title-line"><h2>{nameOf(patient)}</h2><span className="patient-portal-badge">{patient.portal_status?.replace('_', ' ') || 'Not enabled'}</span></div><p>Patient ID: {patient.id.slice(0, 8)} · {workspace.locationName}</p></div></div>
      <div className="profile-header-actions">{canSchedule && <button className="primary" type="button" onClick={() => setTab('Appointments')}><CalendarDays size={16}/> Schedule appointment</button>}{canUpload && <button className="secondary" type="button" onClick={() => setTab('Documents')}><FileText size={16}/> Send document</button>}{canManage && <button className="secondary" type="button" onClick={() => {setEditing(value => !value); setError('');}}><Pencil size={15}/> {editing ? 'Cancel edit' : 'Edit details'}</button>}</div>
      {editing && <form className="patient-profile-edit" onSubmit={saveContact}><label>First name<input required maxLength="80" value={contact.firstName} onChange={event => setContact(value => ({...value, firstName: event.target.value}))}/></label><label>Last name<input required maxLength="80" value={contact.lastName} onChange={event => setContact(value => ({...value, lastName: event.target.value}))}/></label><label>Phone<input required minLength="7" maxLength="30" value={contact.phone} onChange={event => setContact(value => ({...value, phone: event.target.value}))}/></label><label>Email<input type="email" value={contact.email} readOnly={portalActive} onChange={event => setContact(value => ({...value, email: event.target.value}))}/>{portalActive && <small>Portal recovery email must be changed by an administrator.</small>}</label><button className="primary" disabled={!!busy}>{busy === 'contact' ? 'Saving…' : 'Save details'}</button></form>}
    </section>
    <nav className="patient-profile-tabs" aria-label="Patient profile sections">{tabs.map(item => <button type="button" key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => {setTab(item); setError(''); setNotice('');}}>{item}</button>)}</nav>
    {error && <p role="alert" className="live-error">{error}</p>}{notice && <p role="status" className="live-notice">{notice}</p>}
    {tab === 'Overview' && <div className="patient-overview"><div className="patient-profile-grid"><section className="patient-overview-column"><div className="patient-section-title"><h3>Contact information</h3>{canManage && <button type="button" className="patient-inline-link" onClick={() => setEditing(true)}><Pencil size={15}/> Edit</button>}</div><div className="patient-contact"><p><Phone size={17}/>{patient.phone}</p><p><Mail size={17}/>{patient.email || 'No email supplied'}</p><p><Building2 size={17}/>{workspace.locationName}</p></div><div className="patient-section-title"><h3>Upcoming appointment</h3><button type="button" className="patient-inline-link" onClick={() => setTab('Appointments')}>View all</button></div>{upcoming ? <div className="profile-feature"><CalendarDays/><div><strong>{upcoming.service}</strong><span>{formatDate(upcoming.start_time)} · {upcoming.clinic}</span></div><span className="patient-portal-badge">{upcoming.status}</span></div> : <p>No upcoming visit. Open Appointments to schedule one.</p>}<div className="patient-section-title"><h3>Portal access</h3><button type="button" className="patient-inline-link" onClick={() => setTab('Portal access')}>Manage</button></div><p>{patient.portal_username ? `Username: ${patient.portal_username}` : 'No portal username yet.'}</p></section><section className="patient-overview-column patient-activity-column"><h3>Recent activity</h3><Chart history={history}/></section></div></div>}
    {tab === 'Appointments' && <section className="live-panel patient-profile-section"><div className="panel-heading"><div><h3>Appointments</h3><p>Visits from every clinic in this organization.</p></div></div>{canSchedule && <form className="patient-profile-form" onSubmit={createAppointment}><label>Service<input name="service" required maxLength="160" placeholder="Visit type"/></label><label>Date and time<input name="startTime" type="datetime-local" required/></label><label>Minutes<input name="durationMinutes" type="number" min="5" max="480" defaultValue="30" required/></label><button className="primary" disabled={!!busy}>{busy === 'appointment' ? 'Scheduling…' : 'Schedule visit'}</button></form>}<div className="patient-profile-list">{history.appointments.map(item => <article key={item.id}><CalendarDays/><div><strong>{item.service}</strong><small>{formatDate(item.start_time)} · {item.clinic}</small></div><span>{item.status}</span></article>)}{!history.appointments.length && <p>No appointments yet.</p>}</div></section>}
    {tab === 'Documents' && <section className="live-panel patient-profile-section"><div className="panel-heading"><div><h3>Documents</h3><p>Documents follow this patient across clinics.</p></div></div>{canUpload && <form className="patient-profile-form" onSubmit={uploadDocument}><label className="patient-file-field">PDF or image<input name="document" type="file" accept="application/pdf,image/jpeg,image/png" required/></label><button className="primary" disabled={!!busy}><Upload size={16}/>{busy === 'document' ? 'Uploading…' : 'Send document'}</button></form>}<div className="patient-profile-list">{history.documents.map(item => <article key={item.id}><FileText/><div><strong>{item.name}</strong><small>{formatDate(item.created_at)} · {item.clinic}</small></div><span>{item.status}</span></article>)}{!history.documents.length && <p>No documents yet.</p>}</div></section>}
    {tab === 'Care notes' && <section className="live-panel patient-profile-section"><div className="panel-heading"><div><h3>Care notes</h3><p>Clinical entries are visible only to authorized staff.</p></div></div>{canWriteCare && <form className="patient-profile-form patient-note-form" onSubmit={addCareNote}><label>Entry type<select name="recordType"><option value="note">Note</option><option value="treatment">Treatment</option><option value="follow_up">Follow up</option></select></label><label>Note<textarea name="note" rows="4" maxLength="10000" required placeholder="Record care provided at this clinic"/></label><button className="primary" disabled={!!busy}>{busy === 'note' ? 'Saving…' : 'Save care note'}</button></form>}<div className="patient-profile-list">{history.records.map(item => <article key={item.id}><HeartPulse/><div><strong>{item.record_type.replace('_', ' ')}</strong><p>{item.note}</p><small>{formatDate(item.occurred_at)} · {item.clinic}</small></div></article>)}{!history.records.length && <p>No care notes available to this role.</p>}</div></section>}
    {tab === 'Payments' && <section className="live-panel patient-profile-section"><div className="panel-heading"><div><h3>Payments</h3><p>Payment records from the clinics this patient has visited.</p></div></div>{canManagePayments && <form className="patient-profile-form" onSubmit={addPayment}><label>Description<input name="description" required maxLength="500" placeholder="What this amount is for"/></label><label>Amount<input name="amount" type="number" min="0" max="1000000" step="0.01" required/></label><button className="primary" disabled={!!busy}>{busy === 'payment' ? 'Saving…' : 'Add payment record'}</button><small>This records an amount due. It does not charge a card.</small></form>}<div className="patient-profile-list">{history.payments.map(item => <article key={item.id}><CreditCard/><div><strong>{item.description}</strong><small>{formatDate(item.created_at)} · {item.clinic}</small></div><span>{dollars(item.amount_cents)} · {item.status}</span></article>)}{!history.payments.length && <p>No payment records available to this role.</p>}</div></section>}
    {tab === 'Portal access' && <section className="live-panel patient-profile-section"><div className="panel-heading"><div><h3>Patient portal</h3><p>Invite the patient or reset their login from this profile.</p></div></div><div className="profile-feature"><KeyRound/><div><strong>{patient.portal_status?.replace('_', ' ') || 'Not enabled'}</strong><span>{patient.portal_username ? `Username: ${patient.portal_username}` : 'No username assigned'}</span></div></div>{!patient.email && <p>Add an email address to the profile before enabling portal access.</p>}{canManage && (portalActive ? <button className="secondary" type="button" onClick={onResetPortal} disabled={enablingPortal}>{enablingPortal ? 'Sending…' : 'Reset login'}</button> : <button className="primary" type="button" onClick={onEnablePortal} disabled={enablingPortal || !patient.email}>{enablingPortal ? 'Enabling…' : 'Enable patient portal'}</button>)}</section>}
  </div>;
}
