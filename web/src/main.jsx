import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Building2, CalendarDays, ChevronDown, CreditCard, FileText, Home, KeyRound, LogOut, MapPin, Search, ShieldCheck, Stethoscope, Upload, UserCheck, Users, UserX } from 'lucide-react';
import { beginSignIn, claims, finishSignIn, hasGroup, signOut } from './auth.js';
import './styles.css';

const portalHosts = {admin: 'admin.health.kantage.solutions', staff: 'staff.health.kantage.solutions', patient: 'patient.health.kantage.solutions'};
const dentalEms = {organizationId: '92dccdff-7946-49de-a359-2ad9151c8b84', locationId: '7f20f302-05c9-47de-b874-5cd806d72b9b', name: 'Express Dental Emergency Services', location: 'Baltimore, Maryland'};
const apiUrl = 'https://health.kantage.solutions';

function Brand() {
  return <div className="brand day-brand"><span className="mark day-mark" aria-hidden="true"><i /><b /><em /></span><span><strong>D.A.Y</strong><small>Health Systems</small></span></div>;
}

function portalRole() {
  if (window.location.hostname === portalHosts.admin || window.location.pathname === '/admin') return 'admin';
  if (window.location.hostname === portalHosts.patient || window.location.pathname.startsWith('/patient')) return 'patient';
  return 'staff';
}

function Login({ role, error }) {
  const labels = {admin: 'D.A.Y administrator', staff: 'DentalEMS staff', patient: 'DentalEMS patient'};
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

async function loadCollection(path, session, workspace) {
  const response = await fetch(`${apiUrl}${path}`, {headers: {authorization: `Bearer ${session.access_token}`, 'x-kantage-organization': workspace.organizationId, 'x-kantage-location': workspace.locationId}});
  if (!response.ok) throw new Error(response.status === 403 ? 'This account is not assigned to this clinic.' : 'Live clinic data could not be loaded.');
  return response.json();
}

async function portalRequest(path, session, options = {}, workspace) {
  const headers={authorization:`Bearer ${session.access_token}`,...(options.body?{'content-type':'application/json'}:{}),...(workspace?{'x-kantage-organization':workspace.organizationId,'x-kantage-location':workspace.locationId}:{})};
  const response=await fetch(`${apiUrl}${path}`,{...options,headers:{...headers,...options.headers}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||'The request could not be completed.');
  return data;
}

async function loadWorkspaces(session) {
  const response = await fetch(`${apiUrl}/v1/session/workspaces`, {headers: {authorization: `Bearer ${session.access_token}`}});
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Your assigned clinics could not be loaded.');
  return payload.workspaces || [];
}

function PortalHeader({ title, subtitle, tone = 'clinic' }) {
  return <header className={`live-header ${tone}-header`}><Brand /><div><strong>{title}</strong><small>{subtitle}</small></div><button className="secondary" onClick={signOut}><LogOut size={16} /> Sign out</button></header>;
}

function PortalTabs({ items, active, onChange, tone = 'clinic' }) {
  return <nav className={`portal-tabs ${tone}-tabs`} aria-label="Portal sections">{items.map(({label, icon: Icon}) => <button key={label} className={active === label ? 'active' : ''} onClick={() => onChange(label)}><Icon size={17} />{label}</button>)}</nav>;
}

function AdminPortal({ session }) {
  const identity = claims(session);
  const [active, setActive] = useState('Clients');
  const [platformStatus, setPlatformStatus] = useState('Checking');
  const [clients,setClients]=useState([]); const [users,setUsers]=useState([]); const [activity,setActivity]=useState([]); const [error,setError]=useState('');
  const [clientForm,setClientForm]=useState({name:'',slug:'',clinicName:'',timezone:'America/New_York',address:''});
  const [staffForm,setStaffForm]=useState({organizationId:'',name:'',username:'',email:'',role:'front_desk'});
  const [creatingClient,setCreatingClient]=useState(false); const [creatingStaff,setCreatingStaff]=useState(false); const [notice,setNotice]=useState('');
  const [showClientForm,setShowClientForm]=useState(false); const [clientSearch,setClientSearch]=useState('');
  const refresh=()=>Promise.all([portalRequest('/v1/admin/clients',session),portalRequest('/v1/admin/access',session),portalRequest('/v1/admin/activity',session)]).then(([a,b,c])=>{setClients(a.clients||[]);setUsers(b.users||[]);setActivity(c.activity||[]);}).catch(event=>setError(event.message));
  useEffect(() => { fetch(`${apiUrl}/healthz`).then(response => setPlatformStatus(response.ok ? 'Operational' : 'Needs attention')).catch(() => setPlatformStatus('Needs attention')); refresh(); }, []);
  const setClientStatus=async client=>{setError('');try{await portalRequest(`/v1/admin/clients/${client.organization_id}`,session,{method:'PATCH',body:JSON.stringify({status:client.status==='active'?'suspended':'active'})});await refresh();}catch(event){setError(event.message);}};
  const setAccess=async user=>{setError('');try{await portalRequest(`/v1/admin/access/${user.organization_id}/${user.user_id}`,session,{method:'PATCH',body:JSON.stringify({status:user.status==='active'?'inactive':'active'})});await refresh();}catch(event){setError(event.message);}};
  const createClient=async event=>{event.preventDefault();setCreatingClient(true);setError('');setNotice('');try{const result=await portalRequest('/v1/admin/clients',session,{method:'POST',body:JSON.stringify(clientForm)});setNotice(`${result.client.name} and its first clinic are ready to onboard staff.`);setClientForm({name:'',slug:'',clinicName:'',timezone:'America/New_York',address:''});setShowClientForm(false);await refresh();}catch(event){setError(event.message);}finally{setCreatingClient(false);}};
  const createStaff=async event=>{event.preventDefault();setCreatingStaff(true);setError('');setNotice('');try{const result=await portalRequest('/v1/admin/staff',session,{method:'POST',body:JSON.stringify(staffForm)});setNotice(`${result.staff.username} was invited. They can sign in at the Staff portal after activating their account.`);setStaffForm({organizationId:'',name:'',username:'',email:'',role:'front_desk'});await refresh();}catch(event){setError(event.message);}finally{setCreatingStaff(false);}};
  const tabs = [{label: 'Overview', icon: Home}, {label: 'Clients', icon: Building2}, {label: 'Access', icon: KeyRound}, {label: 'Audit', icon: Activity}];
  const filteredClients = clients.filter(client=>client.name.toLowerCase().includes(clientSearch.trim().toLowerCase()));
  return <div className="live-portal admin-live-portal">
    <PortalHeader tone="admin" title="D.A.Y Health Systems Admin" subtitle={identity.email || 'Platform administrator'} />
    <PortalTabs tone="admin" items={tabs} active={active} onChange={setActive} />
    <main>
      <div className="admin-hero"><div><div className="live-kicker">ADMIN</div><h1>{active === 'Clients' ? 'Organization directory' : active}</h1><p className="live-intro">Manage organizations, their clinics, and staff access across D.A.Y Health Systems.</p></div>{active === 'Clients' ? <button className="primary" type="button" onClick={()=>setShowClientForm(value=>!value)}>{showClientForm?'Close form':'+ Add organization'}</button> : <span className={`platform-health ${platformStatus === 'Operational' ? 'healthy' : ''}`}><i />{platformStatus}</span>}</div>{error&&<div className="live-error">{error}</div>}{notice&&<div className="live-notice">{notice}</div>}
      {active === 'Overview' && <><section className="live-metrics admin-metrics"><article><Building2 /><strong>{clients.filter(item=>item.status==='active').length}</strong><span>Active clients</span></article><article><Users /><strong>{users.filter(item=>item.status==='active').length}</strong><span>Active staff</span></article><article><ShieldCheck /><strong>{platformStatus === 'Operational' ? 'Online' : 'Check'}</strong><span>Platform status</span></article></section><section className="admin-grid"><article className="live-panel client-summary-card"><div className="client-monogram">DE</div><div><span className="card-eyebrow">CONNECTED CLIENT</span><h2>{clients[0]?.name||dentalEms.name}</h2><p>{clients[0]?.patient_count||0} patients · {clients[0]?.staff_count||0} staff</p></div><span className="status"><i />{clients[0]?.status||'Loading'}</span></article><article className="live-panel admin-boundary-card"><ShieldCheck /><div><h2>Privacy boundary active</h2><p>Platform administration stays separate from daily clinic and patient work.</p></div></article></section></>}
      {active === 'Clients' && <>
        <section className="live-metrics directory-metrics" aria-label="Platform totals">
          <article><Building2 /><strong>{clients.length}</strong><span>Organizations</span></article>
          <article><MapPin /><strong>{clients.reduce((total, client)=>total + Number(client.clinic_count || 0),0)}</strong><span>Clinics</span></article>
          <article><Users /><strong>{users.filter(user=>user.status==='active').length}</strong><span>Active staff</span></article>
          <article><ShieldCheck /><strong>{platformStatus === 'Operational' ? 'Online' : 'Check'}</strong><span>Platform status</span></article>
        </section>
        {showClientForm && <section className="live-panel admin-create-panel"><div className="panel-heading"><div><h2>New organization</h2><p>Add the organization and its first clinic.</p></div></div><form className="admin-onboarding-form" onSubmit={createClient}><label>Organization name<input value={clientForm.name} onChange={event=>setClientForm(current=>({...current,name:event.target.value}))} required /></label><label>System ID<input value={clientForm.slug} onChange={event=>setClientForm(current=>({...current,slug:event.target.value.toLowerCase().replace(/[^a-z0-9-]/g,'')}))} placeholder="example-health" required /></label><label>First clinic<input value={clientForm.clinicName} onChange={event=>setClientForm(current=>({...current,clinicName:event.target.value}))} required /></label><label>Address<input value={clientForm.address} onChange={event=>setClientForm(current=>({...current,address:event.target.value}))} /></label><button className="primary" disabled={creatingClient}>{creatingClient?'Creating…':'Onboard organization'}</button></form></section>}
        <section className="live-panel admin-section directory-panel"><div className="directory-tools"><label className="directory-search"><Search size={19}/><input aria-label="Search organizations" placeholder="Search organizations" value={clientSearch} onChange={event=>setClientSearch(event.target.value)} /></label><span>{clients.length} organizations</span></div><div className="directory-head"><span>Organization</span><span>Clinics</span><span>Staff</span><span>Patients</span><span>Status</span><span>Action</span></div><div className="admin-list">{filteredClients.map(client=><div className="admin-client-row" key={client.organization_id}><div className="client-monogram">{client.name.split(/\s+/).map(word=>word[0]).join('').slice(0,2)}</div><div className="directory-name"><strong>{client.name}</strong><small>{client.organization_id}</small><small className="directory-mobile-counts">{client.clinic_count} clinics · {client.staff_count} staff · {client.patient_count} patients</small></div><span>{client.clinic_count}</span><span>{client.staff_count}</span><span>{client.patient_count}</span><span className="status"><i />{client.status}</span><button className="secondary" onClick={()=>setClientStatus(client)}>{client.status==='active'?<UserX size={16}/>:<UserCheck size={16}/>} {client.status==='active'?'Suspend':'Activate'}</button></div>)}{filteredClients.length===0 && <p className="directory-empty">{clients.length ? 'No organizations match your search.' : 'No organizations have been added yet.'}</p>}</div></section>
      </>}
      {active === 'Access' && <section className="live-panel admin-section"><div className="panel-heading"><div><h2>Staff access</h2><p>Invite staff, assign a role, or remove access for each client employee.</p></div></div><form className="admin-onboarding-form" onSubmit={createStaff}><label>Organization<select value={staffForm.organizationId} onChange={event=>setStaffForm(current=>({...current,organizationId:event.target.value}))} required><option value="">Choose organization</option>{clients.filter(client=>client.status==='active').map(client=><option key={client.organization_id} value={client.organization_id}>{client.name}</option>)}</select></label><label>Staff name<input value={staffForm.name} onChange={event=>setStaffForm(current=>({...current,name:event.target.value}))} required /></label><label>Username<input value={staffForm.username} onChange={event=>setStaffForm(current=>({...current,username:event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g,'')}))} required /></label><label>Recovery email<input type="email" value={staffForm.email} onChange={event=>setStaffForm(current=>({...current,email:event.target.value}))} required /></label><label>Role<select value={staffForm.role} onChange={event=>setStaffForm(current=>({...current,role:event.target.value}))}><option value="front_desk">Front desk</option><option value="clinician">Clinician</option><option value="billing">Billing</option><option value="auditor">Auditor</option><option value="owner">Organization owner</option></select></label><button className="primary" disabled={creatingStaff}>{creatingStaff?'Inviting…':'Invite staff member'}</button></form><div className="admin-list">{users.map(user=><div className="admin-client-row" key={user.user_id}><div className="client-monogram">{user.name.split(/\s+/).map(word=>word[0]).join('').slice(0,2)}</div><div><strong>{user.name}</strong><small>{user.email} · {(user.roles||[]).join(', ')}</small></div><span className="status"><i />{user.status}</span><button className="secondary" onClick={()=>setAccess(user)}>{user.status==='active'?'Remove access':'Restore access'}</button></div>)}</div></section>}
      {active === 'Audit' && <section className="live-panel admin-section"><div className="panel-heading"><div><h2>Platform activity</h2><p>Recent operational events across connected organizations. Patient names and clinical content are intentionally excluded.</p></div></div><div className="responsive-table"><table><thead><tr><th>Organization</th><th>Clinic</th><th>Activity</th><th>When</th></tr></thead><tbody>{activity.map((item,index)=><tr key={`${item.occurred_at}:${index}`}><td>{item.organization_name}</td><td>{item.location_name||'Organization wide'}</td><td>{item.action.replaceAll('.',' ')}</td><td>{new Date(item.occurred_at).toLocaleString()}</td></tr>)}{!activity.length&&<tr><td colSpan="4">No activity has been recorded yet.</td></tr>}</tbody></table></div></section>}
    </main>
  </div>;
}

function StaffPortal({ session }) {
  const [active, setActive] = useState('Dashboard');
  const [data, setData] = useState({patients: [], appointments: [], payments: [], inquiries: [], documents: []});
  const [workspaces, setWorkspaces] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [patientSearch, setPatientSearch] = useState('');
  const [patientMatches, setPatientMatches] = useState([]);
  const [searchingPatients, setSearchingPatients] = useState(false);
  const [error, setError] = useState('');
  const [scheduleId,setScheduleId]=useState(''); const [scheduleTime,setScheduleTime]=useState(''); const [uploadPatient,setUploadPatient]=useState(''); const [uploading,setUploading]=useState(false); const [selectedPatient,setSelectedPatient]=useState(null); const [loadingPatient,setLoadingPatient]=useState(false); const [enablingPortal,setEnablingPortal]=useState(false); const [notice,setNotice]=useState('');
  const identity = claims(session);
  useEffect(() => {
    loadWorkspaces(session).then(items => {
      setWorkspaces(items);
      const saved = localStorage.getItem('kantage-health-staff-workspace');
      setWorkspace(items.find(item => item.locationId === saved) || items[0] || null);
    }).catch(event => setError(event.message)).finally(() => setLoadingWorkspaces(false));
  }, [session]);
  useEffect(() => {
    if (!workspace) return;
    localStorage.setItem('kantage-health-staff-workspace', workspace.locationId);
    setError('');
    setData({patients: [], appointments: [], payments: [], inquiries: [], documents: []});
    Promise.all([loadCollection('/v1/patients', session, workspace),loadCollection('/v1/appointments',session,workspace),loadCollection('/v1/payments',session,workspace),loadCollection('/v1/booking-inquiries',session,workspace),loadCollection('/v1/documents',session,workspace)]).then(([patients,appointments,payments,inquiries,documents]) => setData({patients:patients.patients,appointments:appointments.appointments,payments:payments.payments,inquiries:inquiries.inquiries,documents:documents.documents})).catch(event => setError(event.message));
  }, [session, workspace]);
  const patientsById = useMemo(() => new Map(data.patients.map(patient => [patient.id, patient])), [data.patients]);
  const requested = data.inquiries.filter(item => item.status === 'new');
  const tabs = [{label:'Dashboard',icon:Home},{label:'Patients',icon:Users},{label:'Appointments',icon:CalendarDays},{label:'Documents',icon:FileText},{label:'Payments',icon:CreditCard}];
  const refreshClinic=async()=>{const [patients,appointments,payments,inquiries,documents]=await Promise.all([loadCollection('/v1/patients',session,workspace),loadCollection('/v1/appointments',session,workspace),loadCollection('/v1/payments',session,workspace),loadCollection('/v1/booking-inquiries',session,workspace),loadCollection('/v1/documents',session,workspace)]);setData({patients:patients.patients,appointments:appointments.appointments,payments:payments.payments,inquiries:inquiries.inquiries,documents:documents.documents});};
  const scheduleRequest=async event=>{event.preventDefault();setError('');try{await portalRequest(`/v1/booking-inquiries/${scheduleId}/schedule`,session,{method:'POST',body:JSON.stringify({startTime:new Date(scheduleTime).toISOString(),durationMinutes:30})},workspace);setScheduleId('');setScheduleTime('');await refreshClinic();}catch(event){setError(event.message);}};
  const uploadDocument=async event=>{event.preventDefault();const file=event.currentTarget.elements.document.files?.[0];if(!file||!uploadPatient)return;setUploading(true);setError('');try{const created=await portalRequest('/v1/documents/uploads',session,{method:'POST',body:JSON.stringify({patientId:uploadPatient,name:file.name,contentType:file.type,sizeBytes:file.size,documentKind:'uploaded_record'})},workspace);const uploaded=await fetch(created.document.uploadUrl,{method:'PUT',headers:{'content-type':file.type},body:file});if(!uploaded.ok)throw new Error('The file could not be uploaded.');await portalRequest(`/v1/documents/${created.document.id}/complete`,session,{method:'POST'},workspace);event.currentTarget.reset();await refreshClinic();}catch(event){setError(event.message);}finally{setUploading(false);}};
  const findPatient = async event => {
    event.preventDefault();
    if (patientSearch.trim().length < 3) return;
    setSearchingPatients(true);
    setError('');
    try {
      const result = await loadCollection(`/v1/patients/search?q=${encodeURIComponent(patientSearch.trim())}`, session, workspace);
      setPatientMatches(result.patients || []);
    } catch (event) { setError(event.message); }
    finally { setSearchingPatients(false); }
  };
  const searchFromDashboard = async event => { await findPatient(event); setActive('Patients'); };
  const linkPatient = async patient => {
    setError('');
    const response = await fetch(`${apiUrl}/v1/patients/${patient.patient_id}/link`, {method: 'POST', headers: {authorization: `Bearer ${session.access_token}`, 'x-kantage-organization': workspace.organizationId, 'x-kantage-location': workspace.locationId}});
    if (!response.ok) return setError('The patient could not be added to this clinic.');
    setPatientMatches(items => items.filter(item => item.patient_id !== patient.patient_id));
    const refreshed = await loadCollection('/v1/patients', session, workspace);
    setData(current => ({...current, patients: refreshed.patients}));
  };
  const openPatient=async patient=>{setLoadingPatient(true);setError('');setNotice('');try{const result=await loadCollection(`/v1/patients/${patient.id}`,session,workspace);setSelectedPatient(result.patient);}catch(event){setError(event.message);}finally{setLoadingPatient(false);}};
  const enablePatientPortal=async()=>{if(!selectedPatient)return;setEnablingPortal(true);setError('');setNotice('');try{const result=await portalRequest(`/v1/patients/${selectedPatient.id}/portal-access`,session,{method:'POST'},workspace);setSelectedPatient(current=>({...current,portal_status:'invited',portal_email_sent:result.portalAccess.emailSent,portal_text_sent:result.portalAccess.textSent}));setNotice(result.portalAccess.emailSent?'Portal activation email sent.':'Portal access is enabled. The patient can use password recovery if they already have an account.');await refreshClinic();}catch(event){setError(event.message);}finally{setEnablingPortal(false);}};
  const patientTable = <div className="responsive-table"><table><thead><tr><th>Patient</th><th>Phone</th><th>Portal</th><th>Profile</th></tr></thead><tbody>{data.patients.map(patient => <tr key={patient.id}><td><strong>{patient.first_name} {patient.last_name}</strong><small>{patient.email || 'No email supplied'}</small></td><td>{patient.phone}</td><td><span className="status"><i />{patient.portal_status?.replace('_',' ') || 'Not enabled'}</span></td><td><button className="secondary" type="button" onClick={()=>openPatient(patient)}>Open profile</button></td></tr>)}{!data.patients.length && !error && <tr><td colSpan="4">No patient records yet.</td></tr>}</tbody></table></div>;
  const appointmentTable = <div className="responsive-table"><table><thead><tr><th>Patient</th><th>Service</th><th>Date</th><th>Status</th></tr></thead><tbody>{data.appointments.map(appointment => { const patient = patientsById.get(appointment.patient_id); return <tr key={appointment.id}><td>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient'}</td><td>{appointment.service}</td><td>{appointment.start_time ? new Date(appointment.start_time).toLocaleString() : 'Requested'}</td><td>{appointment.status}</td></tr>; })}{!data.appointments.length && !error && <tr><td colSpan="4">No appointment records yet.</td></tr>}</tbody></table></div>;
  const paymentTable = <div className="responsive-table"><table><thead><tr><th>Patient</th><th>Amount</th><th>Description</th><th>Status</th></tr></thead><tbody>{data.payments.map(payment => { const patient = patientsById.get(payment.patient_id); const amount = Number(payment.amount_cents || 0) / 100; return <tr key={payment.id}><td>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient'}</td><td>{amount.toLocaleString('en-US', {style: 'currency', currency: 'USD'})}</td><td>{payment.description || payment.care_code || 'Payment'}</td><td>{payment.status}</td></tr>; })}{!data.payments.length && !error && <tr><td colSpan="4">No payment records yet.</td></tr>}</tbody></table></div>;
  if (loadingWorkspaces) return <div className="portal-loading">Loading assigned clinics…</div>;
  if (!workspace) return <div className="workforce-login login-staff"><main className="workforce-login-card"><Brand /><h1>No clinic assigned</h1><p>Your employee account is active, but a clinic administrator has not assigned it to a practice.</p>{error && <p className="login-error">{error}</p>}<button className="primary portal-sign-in" onClick={signOut}>Sign out</button></main></div>;
  const selectWorkspace = event => setWorkspace(workspaces.find(item => item.locationId === event.target.value) || workspace);
  const employeeName = workspace.staffName || identity['cognito:username'] || identity.email || 'Staff member';
  const clinicInitials = workspace.locationName.split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase();
  const scheduleItems = [...data.appointments].filter(item=>item.start_time).sort((a,b)=>new Date(a.start_time)-new Date(b.start_time)).slice(0,8);
  return <div className="live-portal staff-live-portal">
    <PortalHeader title={`${workspace.organizationName} Staff Portal`} subtitle={employeeName} />
    <PortalTabs items={tabs} active={active} onChange={setActive} />
    <main><div className="staff-heading"><div><div className="live-kicker">CLINIC STAFF</div><h1>{active === 'Dashboard' ? `Today at ${workspace.locationName}` : active}</h1><p className="live-intro">{active === 'Dashboard' ? new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}) : `Manage ${workspace.locationName} patient and clinic activity.`}</p></div><div className="staff-location"><MapPin size={19}/><strong>{workspace.locationName}</strong>{workspaces.length > 1 && <label><span>Switch clinic</span><select value={workspace.locationId} onChange={selectWorkspace}>{workspaces.map(item => <option key={`${item.organizationId}:${item.locationId}`} value={item.locationId}>{item.locationName}</option>)}</select><ChevronDown size={17} /></label>}</div></div>{error && <div className="live-error">{error}</div>}{notice&&<div className="live-notice">{notice}</div>}
      {active === 'Dashboard' && <><form className="staff-search-panel" onSubmit={searchFromDashboard}><Search size={20}/><input aria-label="Search patients" placeholder="Search patients by name, phone, or email" value={patientSearch} onChange={event=>setPatientSearch(event.target.value)} minLength="3" required/><button className="primary" type="submit">Search patients</button></form><section className="staff-dashboard-grid"><article className="live-panel staff-schedule-panel"><div className="panel-heading"><div><h2>Schedule</h2><p>{scheduleItems.length} upcoming appointments</p></div><button className="quiet-link" type="button" onClick={()=>setActive('Appointments')}>View all</button></div>{scheduleItems.length ? <div className="schedule-list">{scheduleItems.map(item=>{const patient=patientsById.get(item.patient_id);const when=new Date(item.start_time);return <div className="schedule-row" key={item.id}><time dateTime={item.start_time}>{when.toLocaleDateString('en-US',{month:'short',day:'numeric'})}<strong>{when.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</strong></time><span className="schedule-dot"/><span className="schedule-detail"><strong>{item.service || 'Appointment'}</strong><small>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient'}</small></span><span className="schedule-status">{item.status}</span></div>})}</div> : <div className="compact-empty"><CalendarDays /><span>No upcoming appointments.</span></div>}</article><div className="staff-side-column"><article className="live-panel staff-requests-panel"><div className="panel-heading"><div><h2>Booking requests</h2><p>{requested.length} new</p></div></div>{requested.length ? <div className="request-stack booking-stack">{requested.slice(0,6).map(item => <div key={item.id}><CalendarDays /><span><strong>{item.first_name} {item.last_name}</strong><small>{item.appointment_type} · {item.preferred_date||'Flexible'} {item.preferred_time}</small><small>{item.phone} · portal {item.activation_status}</small></span><button className="secondary" onClick={()=>setScheduleId(item.id)}>Schedule</button></div>)}</div> : <div className="compact-empty"><CalendarDays /><span>No new booking requests.</span></div>}{scheduleId&&<form className="inline-schedule" onSubmit={scheduleRequest}><label>Appointment date and time<input type="datetime-local" value={scheduleTime} onChange={event=>setScheduleTime(event.target.value)} required/></label><button className="primary">Confirm appointment</button><button type="button" className="secondary" onClick={()=>setScheduleId('')}>Cancel</button></form>}</article><article className="live-panel staff-actions-panel"><h2>Quick actions</h2><div className="staff-actions"><button type="button" onClick={()=>setActive('Appointments')}><CalendarDays/><span>Appointments</span></button><button type="button" onClick={()=>setActive('Patients')}><Users/><span>Patients</span></button><button type="button" onClick={()=>setActive('Documents')}><FileText/><span>Documents</span></button><button type="button" onClick={()=>setActive('Payments')}><CreditCard/><span>Payments</span></button></div></article></div></section></>}
      {active === 'Patients' && <>{selectedPatient&&<section className="live-panel patient-profile-panel"><div className="panel-heading"><div><span className="card-eyebrow">PATIENT PROFILE</span><h2>{selectedPatient.first_name} {selectedPatient.last_name}</h2><p>{selectedPatient.phone} · {selectedPatient.email || 'No email supplied'}</p></div><button className="secondary" type="button" onClick={()=>setSelectedPatient(null)}>Close profile</button></div><div className="profile-actions"><div><strong>Portal access</strong><span className="status"><i />{selectedPatient.portal_status?.replace('_',' ') || 'Not enabled'}</span><small>{selectedPatient.portal_email_sent?'Activation email sent. A patient who already has an account can use password recovery.':'Enable access to send an activation email.'}</small></div><button className="primary" type="button" onClick={enablePatientPortal} disabled={enablingPortal||!selectedPatient.email}>{enablingPortal?'Enabling…':selectedPatient.portal_status==='active'||selectedPatient.portal_status==='invited'?'Review portal access':'Enable patient portal'}</button></div>{!selectedPatient.email&&<p className="search-hint">Add a patient email before enabling portal access.</p>}</section>}{loadingPatient&&<div className="portal-loading compact-loading">Loading patient profile…</div>}<section className="live-panel patient-roaming-panel"><div className="panel-heading"><div><h2>Find an existing patient</h2><p>Search this organization before creating another profile. Adding a match makes the same patient available at this clinic.</p></div></div><form onSubmit={findPatient}><input aria-label="Search patients" value={patientSearch} onChange={event => setPatientSearch(event.target.value)} placeholder="Name, phone, or exact email" minLength="3" /><button className="primary" type="submit" disabled={searchingPatients}>{searchingPatients ? 'Searching…' : 'Search organization'}</button></form>{patientMatches.length > 0 && <div className="roaming-results">{patientMatches.map(patient => <article key={patient.patient_id}><div><strong>{patient.first_name} {patient.last_name}</strong><small>{patient.phone} · {patient.email || 'No email'}</small></div><button className="secondary" type="button" onClick={() => linkPatient(patient)}>Add to this clinic</button></article>)}</div>}{patientSearch.length >= 3 && !searchingPatients && !patientMatches.length && <p className="search-hint">No unlinked patient matches are displayed.</p>}</section><section className="live-panel"><div className="panel-heading"><div><h2>Patient directory</h2><p>Profiles assigned to {workspace.locationName}.</p></div></div>{patientTable}</section></>}
      {active === 'Appointments' && <section className="live-panel"><div className="panel-heading"><div><h2>Appointment activity</h2><p>Requested, confirmed, and completed visits.</p></div></div>{appointmentTable}</section>}
      {active === 'Documents' && <section className="live-panel"><div className="panel-heading"><div><h2>Patient documents</h2><p>Upload a PDF or image to a patient’s secure portal.</p></div></div><form className="document-upload" onSubmit={uploadDocument}><label>Patient<select value={uploadPatient} onChange={event=>setUploadPatient(event.target.value)} required><option value="">Choose a patient</option>{data.patients.map(patient=><option key={patient.id} value={patient.id}>{patient.first_name} {patient.last_name}</option>)}</select></label><label>Document<input name="document" type="file" accept="application/pdf,image/jpeg,image/png" required/></label><button className="primary" disabled={uploading}><Upload size={16}/>{uploading?'Uploading…':'Send to patient portal'}</button></form><div className="responsive-table"><table><thead><tr><th>Patient</th><th>Document</th><th>Status</th><th>Added</th></tr></thead><tbody>{data.documents.map(document=>{const patient=patientsById.get(document.patient_id);return <tr key={document.id}><td>{patient?`${patient.first_name} ${patient.last_name}`:'Patient'}</td><td>{document.name}</td><td>{document.status}</td><td>{new Date(document.created_at).toLocaleDateString()}</td></tr>})}{!data.documents.length&&<tr><td colSpan="4">No documents have been shared.</td></tr>}</tbody></table></div></section>}
      {active === 'Payments' && <section className="live-panel"><div className="panel-heading"><div><h2>Payment activity</h2><p>Clinic payment records and current statuses.</p></div></div>{paymentTable}</section>}
    </main>
  </div>;
}

function PatientHome({ session }) {
  const identity = claims(session);
  const [home,setHome]=useState(null);const [error,setError]=useState('');const [downloading,setDownloading]=useState('');
  useEffect(()=>{portalRequest('/v1/patient/home',session).then(setHome).catch(event=>setError(event.message));},[session]);
  const downloadDocument=async item=>{setDownloading(item.id);setError('');try{const result=await portalRequest(`/v1/patient/documents/${item.id}/download`,session);window.location.assign(result.downloadUrl);}catch(event){setError(event.message);}finally{setDownloading('');}};
  return <div className="live-portal patient-live-portal"><PortalHeader title="DentalEMS Patient Portal" subtitle={identity.email || dentalEms.name} /><main className="patient-home-live"><div className="patient-clinic-badge">ED</div><div className="live-kicker">{dentalEms.name.toUpperCase()}</div><h1>{home?.patient?`Welcome, ${home.patient.firstName}`:'Welcome to your patient portal'}</h1><p>Your appointment updates and documents from DentalEMS are kept together here.</p>{error&&<div className="live-error">{error}</div>}<section className="patient-portal-grid"><article className="live-panel"><CalendarDays/><h2>Appointments</h2>{home?.appointments?.length?home.appointments.map(item=><div className="patient-item" key={item.id}><strong>{item.service}</strong><span>{item.startTime?new Date(item.startTime).toLocaleString():'Waiting for the office to schedule'} · {item.status}</span></div>):<p>No appointments are available yet.</p>}</article><article className="live-panel"><FileText/><h2>Documents</h2>{home?.documents?.length?home.documents.map(item=><div className="patient-item patient-document-item" key={item.id}><span><strong>{item.name}</strong><small>Shared {new Date(item.createdAt).toLocaleDateString()}</small></span><button className="secondary" type="button" onClick={()=>downloadDocument(item)} disabled={downloading===item.id}>{downloading===item.id?'Preparing…':'Download'}</button></div>):<p>No documents have been shared yet.</p>}</article></section><section className="patient-safe-card"><ShieldCheck /><div><strong>Your access is private</strong><span>This account cannot open staff or administrator records.</span></div></section></main></div>;
}

function App() {
  const role = portalRole();
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { finishSignIn().then(value => setSession(value)).catch(event => setError(event.message)).finally(() => setReady(true)); }, []);
  useEffect(() => { document.title = `${role === 'admin' ? 'Admin' : role === 'staff' ? 'Staff' : 'Patient'} ${session ? 'Portal' : 'Login'} | D.A.Y Health Systems`; }, [role, session]);
  if (!ready) return <div className="portal-loading">Loading secure portal…</div>;
  if (!session) return <Login role={role} error={error} />;
  const authorized = role === 'admin' ? hasGroup(session, 'platform_admin') : role === 'staff' ? hasGroup(session,'dentalems_staff') : hasGroup(session, 'dentalems_patient');
  if (!authorized) return <div className={`workforce-login login-${role}`}><main className="workforce-login-card"><Brand /><h1>Access not assigned</h1><p>This account is valid, but it is not assigned to this portal.</p><button className="primary portal-sign-in" onClick={signOut}>Sign out</button></main></div>;
  if (role === 'admin') return <AdminPortal session={session} />;
  if (role === 'patient') return <PatientHome session={session} />;
  return <StaffPortal session={session} />;
}

createRoot(document.getElementById('root')).render(<App />);
