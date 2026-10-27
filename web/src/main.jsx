import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Building2, CalendarDays, ChartColumn, ChevronDown, CreditCard, FileText, Home, KeyRound, LogOut, MapPin, Pencil, Search, ShieldCheck, Stethoscope, Trash2, Upload, UserCheck, Users, UserX } from 'lucide-react';
import { beginSignIn, claims, clearSession, finishSignIn, hasGroup, sessionExpired, signOut } from './auth.js';
import { actionLabel, apiBaseUrl, assignableRoleOptions, roleLabel, timezoneLabel, timezones } from './config.js';
import StaffPatientProfile from './StaffPatientProfile.jsx';
import './styles.css';

const portalHosts = {admin: 'admin.health.kantage.solutions', staff: 'staff.health.kantage.solutions', patient: 'patient.health.kantage.solutions'};
const apiUrl = apiBaseUrl();
const sessionExpiredMessage = 'Your session has expired. Sign in again to continue.';

// A 401, or a 403 on a token that has lapsed, means the session is over rather than that access was
// refused. Tell the app to return to sign in instead of reporting "Access denied".
function guardSession(response, session) {
  if (response.status === 401 || (response.status === 403 && sessionExpired(session))) {
    window.dispatchEvent(new Event('day-session-expired'));
    throw new Error(sessionExpiredMessage);
  }
}

function Brand() {
  return <div className="brand day-brand"><span className="mark day-mark" aria-hidden="true"><i /><b /><em /></span><span><strong>D.A.Y</strong><small>Health Systems</small></span></div>;
}

function portalRole() {
  if (window.location.hostname === portalHosts.admin || window.location.pathname === '/admin') return 'admin';
  if (window.location.hostname === portalHosts.patient || window.location.pathname.startsWith('/patient')) return 'patient';
  return 'staff';
}

function Login({ role, error }) {
  const [signInError, setSignInError] = useState('');
  const [starting, setStarting] = useState(false);
  const startSignIn = async () => {
    setSignInError('');
    setStarting(true);
    try { await beginSignIn(); }
    catch (event) { setSignInError(event.message); setStarting(false); }
  };
  const labels = {admin: 'D.A.Y administrator', staff: 'Clinic staff', patient: 'Patient'};
  const descriptions = {
    admin: 'Manage healthcare clients, clinic access, and platform operations.',
    staff: 'Open the clinic workspace for patients, appointments, and payments.',
    patient: 'View your appointments and documents, and request a visit at any of your dental office\'s clinics.',
  };
  return <div className={`workforce-login login-${role}`}><main className="workforce-login-card">
    <Brand />
    <span className="owner-kicker">{labels[role].toUpperCase()} PORTAL</span>
    <h1>{labels[role]} sign in</h1>
    <p>{descriptions[role]}</p>
    {(error || signInError) && <p className="login-error">{error || signInError}</p>}
    <button className="primary portal-sign-in" type="button" onClick={startSignIn} disabled={starting}>{starting ? 'Opening secure sign in…' : 'Continue to secure sign in'}</button>
    <p className="workforce-login-notice"><ShieldCheck size={16} /> Secure access is limited to this portal and your assigned role.</p>
  </main></div>;
}

async function loadCollection(path, session, workspace) {
  const response = await fetch(`${apiUrl}${path}`, {headers: {authorization: `Bearer ${session.access_token}`, 'x-kantage-organization': workspace.organizationId, 'x-kantage-location': workspace.locationId}});
  guardSession(response, session);
  if (!response.ok) throw new Error(response.status === 403 ? 'This account is not assigned to this clinic.' : 'Live clinic data could not be loaded.');
  return response.json();
}

async function portalRequest(path, session, options = {}, workspace) {
  const headers={authorization:`Bearer ${session.access_token}`,...(options.body?{'content-type':'application/json'}:{}),...(workspace?{'x-kantage-organization':workspace.organizationId,'x-kantage-location':workspace.locationId}:{})};
  const response=await fetch(`${apiUrl}${path}`,{...options,headers:{...headers,...options.headers}});
  guardSession(response, session);
  const data=await response.json().catch(()=>({}));
  // A reference lets support find the exact failure in the server log.
  if(!response.ok) throw new Error(`${data.error||'The request could not be completed.'}${data.requestId?` (reference ${data.requestId.slice(0,8)})`:''}`);
  return data;
}

async function loadWorkspaces(session) {
  const response = await fetch(`${apiUrl}/v1/session/workspaces`, {headers: {authorization: `Bearer ${session.access_token}`}});
  guardSession(response, session);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${payload.error || 'Your assigned clinics could not be loaded.'}${payload.requestId?` (reference ${payload.requestId.slice(0,8)})`:''}`);
  return payload.workspaces || [];
}

function PortalHeader({ title, subtitle, tone = 'clinic' }) {
  return <header className={`live-header ${tone}-header`}><Brand /><div><strong>{title}</strong><small>{subtitle}</small></div><button className="secondary" onClick={signOut}><LogOut size={16} /> Sign out</button></header>;
}

function PortalTabs({ items, active, onChange, tone = 'clinic' }) {
  return <nav className={`portal-tabs ${tone}-tabs`} aria-label="Portal sections">{items.map(({label, icon: Icon}) => <button key={label} className={active === label ? 'active' : ''} onClick={() => onChange(label)}><Icon size={17} />{label}</button>)}</nav>;
}

// The system ID is the organization's permanent slug: unique, lowercase, and
// URL safe. Deriving it from the name saves typing, and it stays editable
// because it cannot be changed later.
function systemIdFrom(name) {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

// Turns record counts into a sentence such as "1 patient and 3 appointments".
function keptSummary(records) {
  const parts = [['staff', 'staff account'], ['patients', 'patient record'], ['appointments', 'appointment'], ['clinicalRecords', 'clinical record'], ['documents', 'document'], ['billing', 'billing record'], ['bookingRequests', 'booking request'], ['activity', 'logged action']]
    .filter(([key]) => records[key] > 0)
    .map(([key, label]) => `${records[key]} ${label}${records[key] === 1 ? '' : 's'}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'records';
}

function AdminPortal({ session }) {
  const identity = claims(session);
  const [active, setActive] = useState('Clients');
  const [platformStatus, setPlatformStatus] = useState('Checking');
  const [clients,setClients]=useState([]); const [users,setUsers]=useState([]); const [activity,setActivity]=useState([]); const [error,setError]=useState('');
  const [clientForm,setClientForm]=useState({name:'',slug:'',clinicName:'',timezone:'America/New_York',address:''});
  const [staffForm,setStaffForm]=useState({organizationId:'',locationId:'',name:'',username:'',email:'',role:'front_desk'});
  const [creatingClient,setCreatingClient]=useState(false); const [creatingStaff,setCreatingStaff]=useState(false); const [notice,setNotice]=useState(''); const [loadingData,setLoadingData]=useState(true);
  const [showClientForm,setShowClientForm]=useState(false); const [clientSearch,setClientSearch]=useState(''); const [slugEdited,setSlugEdited]=useState(false);
  const refresh=()=>Promise.all([portalRequest('/v1/admin/clients',session),portalRequest('/v1/admin/access',session),portalRequest('/v1/admin/activity',session)]).then(([a,b,c])=>{setClients(a.clients||[]);setUsers(b.users||[]);setActivity(c.activity||[]);}).catch(event=>setError(event.message)).finally(()=>setLoadingData(false));
  useEffect(() => { fetch(`${apiUrl}/healthz`).then(response => setPlatformStatus(response.ok ? 'Operational' : 'Needs attention')).catch(() => setPlatformStatus('Needs attention')); refresh(); }, []);
  const clientPath=client=>`/v1/admin/clients/${client.organization_id}`;
  const staffPath=user=>`/v1/admin/access/${user.organization_id}/${user.user_id}`;
  const changeStatus=async(path,status,message)=>{setError('');setNotice('');try{await portalRequest(path,session,{method:'PATCH',body:JSON.stringify({status})});setNotice(message);await refresh();}catch(event){setError(event.message);}};
  // Deleting starts by asking the server what must be kept. With nothing to keep the admin can delete
  // permanently; otherwise the only option offered is archiving, which keeps every record.
  const [removal,setRemoval]=useState(null); const [showArchived,setShowArchived]=useState(false);
  const startRemoval=async(kind,target)=>{setError('');setNotice('');setEditing(null);setRemoval({kind,target,loading:true});try{const {records}=await portalRequest(`${kind==='organization'?clientPath(target):staffPath(target)}/records`,session);setRemoval({kind,target,records,loading:false});}catch(event){setRemoval(null);setError(event.message);}};
  const confirmRemoval=async()=>{const {kind,target,records}=removal;const path=kind==='organization'?clientPath(target):staffPath(target);setRemoval(current=>({...current,working:true}));try{
    if(records.deletable){await portalRequest(path,session,{method:'DELETE'});setNotice(`${target.name} was deleted permanently.`);}
    else{await portalRequest(path,session,{method:'PATCH',body:JSON.stringify({status:'archived'})});setNotice(`${target.name} was archived. Every record is kept, and it can be restored.`);}
    setRemoval(null);await refresh();
  }catch(event){setRemoval(current=>current&&{...current,working:false});setError(event.message);}};
  useEffect(()=>{ if(removal) document.querySelector('.removal-panel')?.scrollIntoView({block:'center',behavior:'smooth'}); },[removal?.kind,removal?.target?.organization_id,removal?.target?.user_id,removal?.loading]);
  const archivedClients=clients.filter(client=>client.status==='archived').length;
  const archivedStaff=users.filter(user=>user.status==='archived').length;
  const visibleUsers=users.filter(user=>showArchived||user.status!=='archived');
  const removalPanel=kind=>removal&&removal.kind===kind&&<section className="live-panel removal-panel" role="alertdialog" aria-labelledby="removal-title" aria-describedby="removal-detail">
    {removal.loading
      ? <p id="removal-detail">Checking what {removal.target.name} holds…</p>
      : removal.records.deletable
        ? <><h2 id="removal-title">Delete {removal.target.name} permanently?</h2><p id="removal-detail">{kind==='organization'?'It has no patients, records, staff or activity, so it can be removed completely, along with its clinics and booking links.':'They have never acted in the system, so their account can be removed completely.'} This cannot be undone. The audit trail will still show that it existed and who deleted it.</p><div className="staff-edit-actions"><button className="primary danger" disabled={removal.working} onClick={confirmRemoval}>{removal.working?'Deleting…':'Delete permanently'}</button><button type="button" className="secondary" onClick={()=>setRemoval(null)}>Cancel</button></div></>
        : <><h2 id="removal-title">{removal.target.name} can’t be deleted</h2><p id="removal-detail">{kind==='organization'?`It holds ${keptSummary(removal.records)}, which must be kept.`:`Their ${removal.records.activity} logged action${removal.records.activity===1?'':'s'} must stay in the audit trail.`} You can archive {kind==='organization'?'it':'them'} instead: hidden from these lists, all access cut, every record kept, and restorable at any time.</p><div className="staff-edit-actions"><button className="primary" disabled={removal.working} onClick={confirmRemoval}>{removal.working?'Archiving…':'Archive instead'}</button><button type="button" className="secondary" onClick={()=>setRemoval(null)}>Cancel</button></div></>}
  </section>;
  const archiveToggle=count=>count>0&&<label className="archive-toggle"><input type="checkbox" checked={showArchived} onChange={event=>setShowArchived(event.target.checked)} /> Show archived ({count})</label>;
  const createClient=async event=>{event.preventDefault();setCreatingClient(true);setError('');setNotice('');try{const result=await portalRequest('/v1/admin/clients',session,{method:'POST',body:JSON.stringify(clientForm)});setNotice(`${result.client.name} and its first clinic are ready to onboard staff.`);setClientForm({name:'',slug:'',clinicName:'',timezone:'America/New_York',address:''});setShowClientForm(false);await refresh();}catch(event){setError(event.message);}finally{setCreatingClient(false);}};
  const createStaff=async event=>{event.preventDefault();setCreatingStaff(true);setError('');setNotice('');try{const result=await portalRequest('/v1/admin/staff',session,{method:'POST',body:JSON.stringify({...staffForm,locationId:staffForm.locationId||undefined})});setNotice(`${result.staff.username} was invited. They can sign in at the Staff portal after activating their account.`);setStaffForm({organizationId:'',locationId:'',name:'',username:'',email:'',role:'front_desk'});await refresh();}catch(event){setError(event.message);}finally{setCreatingStaff(false);}};
  const [editing,setEditing]=useState(null); const [savingStaff,setSavingStaff]=useState(false); const [activityFilter,setActivityFilter]=useState('all');
  // Existing accounts carry one role; editing replaces it, so a demotion really removes the old access.
  const startEdit=user=>{setError('');setNotice('');setEditing({organization_id:user.organization_id,user_id:user.user_id,name:user.name,email:user.email,role:(user.roles||[])[0]||'front_desk',location_id:user.location_id||''});loadClinics(user.organization_id);};
  const saveStaff=async event=>{event.preventDefault();setSavingStaff(true);setError('');setNotice('');try{await portalRequest(`/v1/admin/access/${editing.organization_id}/${editing.user_id}/profile`,session,{method:'PATCH',body:JSON.stringify({name:editing.name,email:editing.email,role:editing.role,locationId:editing.location_id||null})});setNotice(`${editing.name} was updated.`);setEditing(null);await refresh();}catch(event){setError(event.message);}finally{setSavingStaff(false);}};
  // Each organization's clinics, loaded when an administrator opens it or picks it in a form.
  const [clinicsByOrg,setClinicsByOrg]=useState({}); const [openOrg,setOpenOrg]=useState(null);
  const blankClinic={name:'',address:'',timezone:'America/New_York'};
  const [clinicForm,setClinicForm]=useState(blankClinic); const [editingClinic,setEditingClinic]=useState(null); const [savingClinic,setSavingClinic]=useState(false);
  const loadClinics=async organizationId=>{if(!organizationId)return [];try{const {clinics:list}=await portalRequest(`/v1/admin/clients/${organizationId}/clinics`,session);setClinicsByOrg(current=>({...current,[organizationId]:list||[]}));return list||[];}catch(event){setError(event.message);return [];}};
  // An organization's own details: its name. The System ID is permanent and shown for reference only.
  const [editingOrg,setEditingOrg]=useState(null); const [savingOrg,setSavingOrg]=useState(false);
  const saveOrg=async event=>{event.preventDefault();setSavingOrg(true);setError('');setNotice('');try{const {client}=await portalRequest(`/v1/admin/clients/${openOrg}/profile`,session,{method:'PATCH',body:JSON.stringify({name:editingOrg.name})});setNotice(`The organization is now named ${client.name}.`);setEditingOrg(null);await refresh();}catch(event){setError(event.message);}finally{setSavingOrg(false);}};
  const toggleOrg=async client=>{setEditingClinic(null);setEditingOrg(null);setClinicForm(blankClinic);if(openOrg===client.organization_id){setOpenOrg(null);return;}setOpenOrg(client.organization_id);await loadClinics(client.organization_id);};
  const addClinic=async event=>{event.preventDefault();setSavingClinic(true);setError('');setNotice('');try{const {clinic}=await portalRequest(`/v1/admin/clients/${openOrg}/clinics`,session,{method:'POST',body:JSON.stringify(clinicForm)});setNotice(`${clinic.name} was added with its own booking link, and can take bookings now.`);setClinicForm(blankClinic);await loadClinics(openOrg);await refresh();}catch(event){setError(event.message);}finally{setSavingClinic(false);}};
  const saveClinic=async event=>{event.preventDefault();setSavingClinic(true);setError('');setNotice('');try{await portalRequest(`/v1/admin/clients/${openOrg}/clinics/${editingClinic.location_id}`,session,{method:'PATCH',body:JSON.stringify({name:editingClinic.name,address:editingClinic.address,timezone:editingClinic.timezone})});setNotice(`${editingClinic.name} was updated.`);setEditingClinic(null);await loadClinics(openOrg);}catch(event){setError(event.message);}finally{setSavingClinic(false);}};
  const setClinicActive=async(clinic,status)=>{setError('');setNotice('');try{await portalRequest(`/v1/admin/clients/${openOrg}/clinics/${clinic.location_id}`,session,{method:'PATCH',body:JSON.stringify({status})});setNotice(status==='active'?`${clinic.name} is back in service.`:`${clinic.name} was taken out of service and takes no bookings until it is reactivated.`);await loadClinics(openOrg);await refresh();}catch(event){setError(event.message);}};
  const timezoneSelect=(value,onChange)=><select value={value} onChange={onChange}>{timezones.map(([zone,label])=><option key={zone} value={zone}>{label}</option>)}</select>;
  const clinicOptions=organizationId=>(clinicsByOrg[organizationId]||[]).filter(clinic=>clinic.status==='active').map(clinic=><option key={clinic.location_id} value={clinic.location_id}>{clinic.name}</option>);
  const orgPanel=()=>{
    const client=clients.find(item=>item.organization_id===openOrg); if(!client) return null;
    const clinics=clinicsByOrg[openOrg]; const orgStaff=users.filter(user=>user.organization_id===openOrg&&user.status!=='archived');
    const hasOwner=orgStaff.some(user=>(user.roles||[]).some(role=>role==='organization_owner'||role==='owner'));
    const activeClinics=(clinics||[]).filter(clinic=>clinic.status==='active').length;
    return <section className="live-panel org-panel" aria-label={`${client.name} network`}>
      <div className="panel-heading"><div><span className="card-eyebrow">ORGANIZATION</span><h2>{client.name}</h2><p>{activeClinics} clinic{activeClinics===1?'':'s'} in service · {orgStaff.length} staff</p></div><div className="org-panel-actions">{!editingOrg&&<button type="button" className="secondary" onClick={()=>{setError('');setNotice('');setEditingOrg({name:client.name});}}><Pencil size={15}/> Edit details</button>}<button type="button" className="secondary" onClick={()=>{setEditingOrg(null);setOpenOrg(null);}}>Close</button></div></div>
      {editingOrg&&<form className="admin-onboarding-form org-edit" onSubmit={saveOrg}><label>Organization name<input value={editingOrg.name} onChange={event=>setEditingOrg(current=>({...current,name:event.target.value}))} required minLength="2" maxLength="160" autoFocus /></label><label>System ID<input value={client.slug} readOnly aria-readonly="true" /><small className="field-hint">Permanent. It identifies the organization and cannot be changed.</small></label><div className="staff-edit-actions"><button className="primary" disabled={savingOrg}>{savingOrg?'Saving…':'Save details'}</button><button type="button" className="secondary" onClick={()=>setEditingOrg(null)}>Cancel</button></div></form>}
      <ol className="onboarding-checklist" aria-label="Onboarding">
        <li data-done={activeClinics>1}>Add every clinic in the network</li>
        <li data-done={hasOwner}>Invite the owner as Organization owner</li>
        <li data-done={orgStaff.length>(hasOwner?1:0)}>Invite their staff and assign each a clinic</li>
      </ol>
      <h3>Clinics</h3>
      {!clinics?<p className="directory-empty">Loading clinics…</p>:<div className="clinic-list">{clinics.map(clinic=>editingClinic?.location_id===clinic.location_id
        ?<form key={clinic.location_id} className="admin-onboarding-form clinic-edit" onSubmit={saveClinic}><label>Clinic name<input value={editingClinic.name} onChange={event=>setEditingClinic(current=>({...current,name:event.target.value}))} required minLength="2" /></label><label>Address<input value={editingClinic.address} onChange={event=>setEditingClinic(current=>({...current,address:event.target.value}))} /></label><label>Timezone{timezoneSelect(editingClinic.timezone,event=>setEditingClinic(current=>({...current,timezone:event.target.value})))}</label><div className="staff-edit-actions"><button className="primary" disabled={savingClinic}>{savingClinic?'Saving…':'Save clinic'}</button><button type="button" className="secondary" onClick={()=>setEditingClinic(null)}>Cancel</button></div></form>
        :<div className="clinic-row" key={clinic.location_id}><div><strong>{clinic.name}</strong><small>{clinic.address||'No address yet'} · {timezoneLabel(clinic.timezone)}</small><small>{clinic.staff_count} staff · {clinic.patient_count} patients</small></div><span className="status" data-status={clinic.status==='active'?'active':'inactive'}><i />{clinic.status==='active'?'In service':'Out of service'}</span><div className="row-actions"><button type="button" className="secondary" onClick={()=>setEditingClinic({...clinic})}><Pencil size={15}/> Edit</button>{clinic.status==='active'?<button type="button" className="secondary" onClick={()=>setClinicActive(clinic,'inactive')}>Take out of service</button>:<button type="button" className="secondary" onClick={()=>setClinicActive(clinic,'active')}>Return to service</button>}</div></div>)}</div>}
      <form className="admin-onboarding-form add-clinic" onSubmit={addClinic}><label>New clinic<input value={clinicForm.name} onChange={event=>setClinicForm(current=>({...current,name:event.target.value}))} placeholder="Clinic name" required minLength="2" /></label><label>Address<input value={clinicForm.address} onChange={event=>setClinicForm(current=>({...current,address:event.target.value}))} placeholder="Street, city" /></label><label>Timezone{timezoneSelect(clinicForm.timezone,event=>setClinicForm(current=>({...current,timezone:event.target.value})))}</label><button className="primary" disabled={savingClinic}>{savingClinic?'Adding…':'Add clinic'}</button></form>
    </section>;
  };
  const visibleActivity=activity.filter(item=>activityFilter==='all'||item.source===activityFilter);
  const tabs = [{label: 'Overview', icon: Home}, {label: 'Clients', icon: Building2}, {label: 'Access', icon: KeyRound}, {label: 'Reports', icon: ChartColumn}, {label: 'Audit', icon: Activity}];
  const filteredClients = clients.filter(client=>(showArchived||client.status!=='archived')&&client.name.toLowerCase().includes(clientSearch.trim().toLowerCase()));
  return <div className="live-portal admin-live-portal">
    <PortalHeader tone="admin" title="D.A.Y Health Systems Admin" subtitle={identity.email || 'Platform administrator'} />
    <PortalTabs tone="admin" items={tabs} active={active} onChange={setActive} />
    <main>
      <div className="admin-hero"><div><div className="live-kicker">ADMIN</div><h1>{active === 'Clients' ? 'Organization directory' : active}</h1><p className="live-intro">Manage organizations, their clinics, and staff access across D.A.Y Health Systems.</p></div>{active === 'Clients' ? <button className="primary" type="button" onClick={()=>setShowClientForm(value=>!value)}>{showClientForm?'Close form':'+ Add organization'}</button> : <span className={`platform-health ${platformStatus === 'Operational' ? 'healthy' : ''}`}><i />{platformStatus}</span>}</div>{error&&<div className="live-error">{error}</div>}{notice&&<div className="live-notice">{notice}</div>}
      {active === 'Overview' && <><section className="live-metrics admin-metrics"><article><Building2 /><strong>{clients.filter(item=>item.status==='active').length}</strong><span>Active clients</span></article><article><Users /><strong>{users.filter(item=>item.status==='active').length}</strong><span>Active staff</span></article><article><ShieldCheck /><strong>{platformStatus === 'Operational' ? 'Online' : 'Check'}</strong><span>Platform status</span></article></section><section className="admin-grid"><article className="live-panel client-summary-card"><div><span className="card-eyebrow">NETWORKS</span><h2>{clients.filter(item=>item.status!=='archived').length} organizations</h2><p>{clients.filter(item=>item.status!=='archived').slice(0,4).map(item=>`${item.name} (${item.clinic_count} clinic${Number(item.clinic_count)===1?'':'s'})`).join(', ')||'None yet'}</p></div></article><article className="live-panel admin-boundary-card"><ShieldCheck /><div><h2>Privacy boundary active</h2><p>Platform administration stays separate from daily clinic and patient work.</p></div></article></section></>}
      {active === 'Clients' && <>
        <section className="live-metrics directory-metrics" aria-label="Platform totals">
          <article><Building2 /><strong>{clients.length-archivedClients}</strong><span>Organizations</span></article>
          <article><MapPin /><strong>{clients.filter(client=>client.status!=='archived').reduce((total, client)=>total + Number(client.clinic_count || 0),0)}</strong><span>Clinics</span></article>
          <article><Users /><strong>{users.filter(user=>user.status==='active').length}</strong><span>Active staff</span></article>
          <article><ShieldCheck /><strong>{platformStatus === 'Operational' ? 'Online' : 'Check'}</strong><span>Platform status</span></article>
        </section>
        {showClientForm && <section className="live-panel admin-create-panel"><div className="panel-heading"><div><h2>New organization</h2><p>Add the organization and its first clinic.</p></div></div><form className="admin-onboarding-form" onSubmit={createClient}><label>Organization name<input value={clientForm.name} onChange={event=>setClientForm(current=>({...current,name:event.target.value,...(slugEdited?{}:{slug:systemIdFrom(event.target.value)})}))} required /></label><label>System ID<input value={clientForm.slug} onChange={event=>{setSlugEdited(true);setClientForm(current=>({...current,slug:event.target.value.toLowerCase().replace(/[^a-z0-9-]/g,'')}));}} placeholder="example-health" required /><small className="field-hint">Filled in from the name. It is permanent and must be unique, so change it now if you want something else.</small></label><label>First clinic<input value={clientForm.clinicName} onChange={event=>setClientForm(current=>({...current,clinicName:event.target.value}))} required /></label><label>Address<input value={clientForm.address} onChange={event=>setClientForm(current=>({...current,address:event.target.value}))} /></label><button className="primary" disabled={creatingClient}>{creatingClient?'Creating…':'Onboard organization'}</button></form></section>}
        {removalPanel('organization')}{openOrg&&orgPanel()}<section className="live-panel admin-section directory-panel"><div className="directory-tools"><label className="directory-search"><Search size={19}/><input aria-label="Search organizations" placeholder="Search organizations" value={clientSearch} onChange={event=>setClientSearch(event.target.value)} /></label><span className="directory-meta">{archiveToggle(archivedClients)}<span>{clients.length-archivedClients} organizations</span></span></div><div className="directory-head"><span>Organization</span><span>Clinics</span><span>Staff</span><span>Patients</span><span>Status</span><span>Action</span></div><div className="admin-list">{filteredClients.map(client=><div className="admin-client-row" key={client.organization_id}><div className="client-monogram">{client.name.split(/\s+/).map(word=>word[0]).join('').slice(0,2)}</div><div className="directory-name"><button type="button" className="org-link" aria-expanded={openOrg===client.organization_id} onClick={()=>toggleOrg(client)}>{client.name}</button><small>{client.organization_id}</small><small className="directory-mobile-counts">{client.clinic_count} clinics · {client.staff_count} staff · {client.patient_count} patients</small></div><span>{client.clinic_count}</span><span>{client.staff_count}</span><span>{client.patient_count}</span><span className="status" data-status={client.status}><i />{client.status}</span><div className="row-actions">{client.status==='active'?<button className="secondary" onClick={()=>changeStatus(clientPath(client),'suspended',`${client.name} was suspended. Its staff cannot open it and it takes no bookings until it is restored.`)}><UserX size={16}/> Suspend</button>:<button className="secondary" onClick={()=>changeStatus(clientPath(client),'active',`${client.name} was restored.`)}><UserCheck size={16}/> Restore</button>}<button className="secondary danger" onClick={()=>startRemoval('organization',client)}><Trash2 size={16}/> Delete</button></div></div>)}{filteredClients.length===0 && <p className="directory-empty">{loadingData ? 'Loading organizations…' : clients.length ? 'No organizations match your search.' : 'No organizations have been added yet.'}</p>}</div></section>
      </>}
      {active === 'Access' && <section className="live-panel admin-section"><div className="panel-heading"><div><h2>Staff access</h2><p>Invite staff, assign a role, or remove access for each client employee.</p></div></div><form className="admin-onboarding-form" onSubmit={createStaff}><label>Organization<select value={staffForm.organizationId} onChange={event=>{const organizationId=event.target.value;setStaffForm(current=>({...current,organizationId,locationId:''}));loadClinics(organizationId);}} required><option value="">Choose organization</option>{clients.filter(client=>client.status==='active').map(client=><option key={client.organization_id} value={client.organization_id}>{client.name}</option>)}</select></label><label>Clinic<select value={staffForm.locationId} onChange={event=>setStaffForm(current=>({...current,locationId:event.target.value}))} disabled={!staffForm.organizationId}><option value="">All clinics</option>{clinicOptions(staffForm.organizationId)}</select></label><label>Staff name<input value={staffForm.name} onChange={event=>setStaffForm(current=>({...current,name:event.target.value}))} required /></label><label>Username<input value={staffForm.username} onChange={event=>setStaffForm(current=>({...current,username:event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g,'')}))} required /></label><label>Recovery email<input type="email" value={staffForm.email} onChange={event=>setStaffForm(current=>({...current,email:event.target.value}))} required /></label><label>Role<select value={staffForm.role} onChange={event=>setStaffForm(current=>({...current,role:event.target.value}))}>{assignableRoleOptions.map(role=><option key={role} value={role}>{roleLabel(role)}</option>)}</select></label><button className="primary" disabled={creatingStaff}>{creatingStaff?'Inviting…':'Invite staff member'}</button></form>
        {editing && <form className="staff-edit-panel" onSubmit={saveStaff}><div className="panel-heading"><div><h2>Edit {editing.name}</h2><p>Changing the role replaces it, so lowering someone's role removes the access they had.</p></div></div><div className="admin-onboarding-form"><label>Staff name<input value={editing.name} onChange={event=>setEditing(current=>({...current,name:event.target.value}))} required minLength="2" /></label><label>Contact email<input type="email" value={editing.email} onChange={event=>setEditing(current=>({...current,email:event.target.value}))} required /><small className="field-hint">Shown in the portals. Does not change the address they sign in with or reset their password from.</small></label><label>Role<select value={editing.role} onChange={event=>setEditing(current=>({...current,role:event.target.value}))}>{[...new Set([...assignableRoleOptions,editing.role])].map(role=><option key={role} value={role}>{roleLabel(role)}</option>)}</select></label><label>Clinic<select value={editing.location_id} onChange={event=>setEditing(current=>({...current,location_id:event.target.value}))}><option value="">All clinics</option>{clinicOptions(editing.organization_id)}</select></label><div className="staff-edit-actions"><button className="primary" disabled={savingStaff}>{savingStaff?'Saving…':'Save changes'}</button><button type="button" className="secondary" onClick={()=>setEditing(null)}>Cancel</button></div></div></form>}
        {removalPanel('staff')}{archiveToggle(archivedStaff)}<div className="admin-list">{visibleUsers.map(user=><div className="admin-client-row" key={`${user.organization_id}:${user.user_id}`}><div className="client-monogram">{user.name.split(/\s+/).map(word=>word[0]).join('').slice(0,2)}</div><div><strong>{user.name}</strong><small>{user.email} · {(user.roles||[]).map(roleLabel).join(', ')} · {user.organization_name}{user.clinic_name?` · ${user.clinic_name}`:''}</small></div><span className="status" data-status={user.status}><i />{user.status}</span><div className="row-actions">{user.status!=='archived'&&<button className="secondary" onClick={()=>startEdit(user)}><Pencil size={15}/> Edit</button>}{user.status==='active'?<button className="secondary" onClick={()=>changeStatus(staffPath(user),'inactive',`${user.name} was suspended and can no longer open the clinic.`)}><UserX size={16}/> Suspend</button>:<button className="secondary" onClick={()=>changeStatus(staffPath(user),'active',`${user.name} was restored.`)}><UserCheck size={16}/> Restore</button>}<button className="secondary danger" onClick={()=>startRemoval('staff',user)}><Trash2 size={16}/> Delete</button></div></div>)}{!visibleUsers.length && <p className="directory-empty">{loadingData ? 'Loading staff access…' : users.length ? 'Every staff member is archived. Show archived to see them.' : 'No staff members have been invited yet.'}</p>}</div></section>}
      {active === 'Reports' && <ReportsPanel showOrganization load={range => portalRequest(`/v1/admin/reports?${reportQuery(range)}`, session)} />}
      {active === 'Audit' && <section className="live-panel admin-section"><div className="panel-heading"><div><h2>Platform activity</h2><p>Everything administrators and staff do, and every booking request that arrives, newest first. Patient names and clinical content are intentionally excluded.</p></div><div className="activity-filter" role="group" aria-label="Show activity from">{[['all','All'],['admin','Administrators'],['staff','Staff'],['website','Bookings']].map(([value,label])=><button key={value} type="button" className={activityFilter===value?'active':''} aria-pressed={activityFilter===value} onClick={()=>setActivityFilter(value)}>{label}</button>)}</div></div><div className="responsive-table"><table><thead><tr><th>When</th><th>Who</th><th>Activity</th><th>Organization</th><th>Clinic</th></tr></thead><tbody>{visibleActivity.map((item,index)=><tr key={`${item.occurred_at}:${index}`}><td><time dateTime={item.occurred_at} title={new Date(item.occurred_at).toLocaleString()}>{new Date(item.occurred_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time></td><td><strong>{item.actor_name||'Unknown'}</strong><small>{item.source==='admin'?'Platform administrator':item.source==='website'?'Patient request':(item.actor_role||'').split(',').filter(Boolean).map(roleLabel).join(', ')}</small></td><td>{actionLabel(item.action)}{item.source==='admin'&&item.target_label?<small>{item.target_label}</small>:null}</td><td>{item.organization_name}</td><td>{item.location_name||(item.source==='admin'?'':'Organization wide')}</td></tr>)}{!visibleActivity.length&&<tr><td colSpan="5">{loadingData ? 'Loading platform activity…' : activity.length ? 'No activity matches this filter.' : 'No activity has been recorded yet.'}</td></tr>}</tbody></table></div></section>}
    </main>
  </div>;
}

export function StaffPortal({ session }) {
  const [active, setActive] = useState('Dashboard');
  const [data, setData] = useState({patients: [], appointments: [], payments: [], inquiries: [], documents: []});
  const [workspaces, setWorkspaces] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [patientSearch, setPatientSearch] = useState('');
  const [directorySearch, setDirectorySearch] = useState('');
  const [patientMatches, setPatientMatches] = useState([]);
  const [searchingPatients, setSearchingPatients] = useState(false);
  const [error, setError] = useState('');
  const [loadingClinic,setLoadingClinic]=useState(true);
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
    setSelectedPatient(null);
    setLoadingClinic(true);
    Promise.all([loadCollection('/v1/patients', session, workspace),loadCollection('/v1/appointments',session,workspace),loadCollection('/v1/payments',session,workspace),loadCollection('/v1/booking-inquiries',session,workspace),loadCollection('/v1/documents',session,workspace)]).then(([patients,appointments,payments,inquiries,documents]) => setData({patients:patients.patients,appointments:appointments.appointments,payments:payments.payments,inquiries:inquiries.inquiries,documents:documents.documents})).catch(event => setError(event.message)).finally(() => setLoadingClinic(false));
  }, [session, workspace]);
  const patientsById = useMemo(() => new Map(data.patients.map(patient => [patient.id, patient])), [data.patients]);
  const requested = data.inquiries.filter(item => item.status === 'new');
  const tabs = [{label:'Dashboard',icon:Home},{label:'Patients',icon:Users},{label:'Appointments',icon:CalendarDays},{label:'Documents',icon:FileText},{label:'Payments',icon:CreditCard},...(workspace?.roles?.some(role=>reportRoles.includes(role))?[{label:'Reports',icon:ChartColumn}]:[])];
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
  const openPatient=async patient=>{setActive('Patients');setLoadingPatient(true);setError('');setNotice('');try{const [result,chart]=await Promise.all([loadCollection(`/v1/patients/${patient.id}`,session,workspace),loadCollection(`/v1/patients/${patient.id}/history`,session,workspace)]);setSelectedPatient({...result.patient,history:chart.history});}catch(event){setError(event.message);}finally{setLoadingPatient(false);}};
  // A booking that only partly matched an existing patient waits for staff to say whether it is them.
  const resolveMatch=async(item,samePatient)=>{setError('');setNotice('');try{await portalRequest(`/v1/booking-inquiries/${item.id}/match`,session,{method:'POST',body:JSON.stringify({samePatient})},workspace);setNotice(samePatient?`The booking was added to ${item.match_name}'s record.`:`${item.first_name} ${item.last_name} was kept as a separate patient.`);await refreshClinic();}catch(event){setError(event.message);}};
  // A new invitation for a patient who never signed in, or a password reset code for one who has.
  const resetPortalLogin=async()=>{if(!selectedPatient)return;setEnablingPortal(true);setError('');setNotice('');try{const {portalReset}=await portalRequest(`/v1/patients/${selectedPatient.id}/portal-reset`,session,{method:'POST'},workspace);setNotice(portalReset.delivery==='reset_code_sent'?`A password reset code was emailed. They sign in as ${portalReset.username} and enter the code to choose a new password.`:`${portalReset.delivery==='new_account'?'A new portal account was created and an invitation':'A new invitation'} with a temporary password was emailed. Their username is ${portalReset.username}.`);setSelectedPatient(current=>({...current,portal_username:portalReset.username}));}catch(event){setError(event.message);}finally{setEnablingPortal(false);}};
  const enablePatientPortal=async()=>{if(!selectedPatient)return;setEnablingPortal(true);setError('');setNotice('');try{const result=await portalRequest(`/v1/patients/${selectedPatient.id}/portal-access`,session,{method:'POST'},workspace);setSelectedPatient(current=>({...current,portal_status:'invited',portal_email_sent:result.portalAccess.emailSent,portal_text_sent:result.portalAccess.textSent,portal_username:result.portalAccess.username}));setNotice(result.portalAccess.emailSent?`Portal invitation emailed. Their username is ${result.portalAccess.username}.`:`Portal access is enabled. Their username is ${result.portalAccess.username}; use Reset login if they need a new password.`);await refreshClinic();}catch(event){setError(event.message);}finally{setEnablingPortal(false);}};
  const visiblePatients = data.patients.filter(patient => `${patient.first_name} ${patient.last_name} ${patient.phone} ${patient.email || ''}`.toLowerCase().includes(directorySearch.trim().toLowerCase()));
  const appointmentTable = <div className="responsive-table"><table><thead><tr><th>Patient</th><th>Service</th><th>Date</th><th>Status</th></tr></thead><tbody>{data.appointments.map(appointment => { const patient = patientsById.get(appointment.patient_id); return <tr key={appointment.id}><td>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient'}</td><td>{appointment.service}</td><td>{appointment.start_time ? new Date(appointment.start_time).toLocaleString() : 'Requested'}</td><td>{appointment.status}</td></tr>; })}{!data.appointments.length && !error && <tr><td colSpan="4">{loadingClinic ? 'Loading appointment records…' : 'No appointment records yet.'}</td></tr>}</tbody></table></div>;
  const paymentTable = <div className="responsive-table"><table><thead><tr><th>Patient</th><th>Amount</th><th>Description</th><th>Status</th></tr></thead><tbody>{data.payments.map(payment => { const patient = patientsById.get(payment.patient_id); const amount = Number(payment.amount_cents || 0) / 100; return <tr key={payment.id}><td>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient'}</td><td>{amount.toLocaleString('en-US', {style: 'currency', currency: 'USD'})}</td><td>{payment.description || payment.care_code || 'Payment'}</td><td>{payment.status}</td></tr>; })}{!data.payments.length && !error && <tr><td colSpan="4">{loadingClinic ? 'Loading payment records…' : 'No payment records yet.'}</td></tr>}</tbody></table></div>;
  if (loadingWorkspaces) return <div className="portal-loading">Loading assigned clinics…</div>;
  // A failed load and a genuinely empty assignment are different problems with different fixes, so they
  // get different screens. Only the second means an administrator needs to assign a clinic.
  if (!workspace) return error
    ? <div className="workforce-login login-staff"><main className="workforce-login-card"><Brand /><h1>Your clinics could not be loaded</h1><p>Your sign in worked, but the clinic list did not load. This is usually temporary.</p><p className="login-error">{error}</p><button className="primary portal-sign-in" onClick={() => window.location.reload()}>Try again</button><button className="secondary portal-sign-in" onClick={signOut}>Sign out</button></main></div>
    : <div className="workforce-login login-staff"><main className="workforce-login-card"><Brand /><h1>No clinic assigned</h1><p>Your employee account is active, but a clinic administrator has not assigned it to a practice.</p><button className="primary portal-sign-in" onClick={signOut}>Sign out</button></main></div>;
  const patientDirectory = <section className="live-panel patient-directory-panel"><div className="panel-heading"><div><h2>Patient directory</h2><p>Profiles assigned to {workspace.locationName}. Select a name to open the full profile.</p></div><span>{visiblePatients.length} shown</span></div><label className="patient-directory-search"><Search size={17}/><input aria-label="Filter clinic patients" value={directorySearch} onChange={event => setDirectorySearch(event.target.value)} placeholder="Search name, phone, or email"/></label><div className="patient-directory-list">{visiblePatients.map(patient => <article key={patient.id}><span className="patient-directory-avatar" aria-hidden="true">{patient.first_name[0]}{patient.last_name[0]}</span><div><button type="button" className="patient-directory-name" onClick={() => openPatient(patient)}>{patient.first_name} {patient.last_name}</button><small>{patient.email || 'No email supplied'} · {patient.phone}</small></div><span className="status"><i />{patient.portal_status?.replace('_', ' ') || 'Not enabled'}</span><button type="button" className="secondary" onClick={() => openPatient(patient)}>Open profile</button></article>)}{!visiblePatients.length && <p className="directory-empty">{loadingClinic ? 'Loading patient records…' : data.patients.length ? 'No patients match your search.' : 'No patient records yet.'}</p>}</div></section>;
  const selectWorkspace = event => setWorkspace(workspaces.find(item => item.locationId === event.target.value) || workspace);
  const employeeName = workspace.staffName || identity['cognito:username'] || identity.email || 'Staff member';
  const clinicInitials = workspace.locationName.split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase();
  const scheduleItems = [...data.appointments].filter(item=>item.start_time).sort((a,b)=>new Date(a.start_time)-new Date(b.start_time)).slice(0,8);
  return <div className="live-portal staff-live-portal">
    <aside className="staff-sidebar"><div className="staff-sidebar-brand"><Brand /><span>STAFF PORTAL</span></div><nav aria-label="Staff navigation">{tabs.map(({label, icon: Icon}) => <button type="button" key={label} className={active === label ? 'active' : ''} onClick={() => { setActive(label); if (label === 'Patients') setSelectedPatient(null); }}><Icon size={19}/>{label}</button>)}</nav><div className="staff-sidebar-user"><strong>{employeeName}</strong><small>{workspace.locationName}</small><button type="button" onClick={signOut}>Sign out</button></div></aside>
    <div className="staff-work-area"><header className="staff-topbar"><form className="patient-directory-search staff-top-search" onSubmit={event => {event.preventDefault(); setSelectedPatient(null); setActive('Patients');}}><Search size={17}/><input aria-label="Search clinic patients" placeholder="Search patients by name, phone, or email" value={directorySearch} onChange={event => setDirectorySearch(event.target.value)}/><button type="submit" className="staff-search-submit">Search</button></form><div className="staff-location"><MapPin size={18}/><strong>{workspace.locationName}</strong>{workspaces.length > 1 && <label><span>Switch clinic</span><select value={workspace.locationId} onChange={selectWorkspace}>{workspaces.map(item => <option key={`${item.organizationId}:${item.locationId}`} value={item.locationId}>{item.locationName}</option>)}</select><ChevronDown size={17} /></label>}</div></header>
    <main>{!(active === 'Patients' && selectedPatient) && <div className="staff-heading"><div><div className="live-kicker">CLINIC STAFF</div><h1>{active === 'Dashboard' ? `Today at ${workspace.locationName}` : active}</h1><p className="live-intro">{active === 'Dashboard' ? new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}) : `Manage ${workspace.locationName} patient and clinic activity.`}</p></div><div className="staff-location"><MapPin size={19}/><strong>{workspace.locationName}</strong>{workspaces.length > 1 && <label><span>Switch clinic</span><select value={workspace.locationId} onChange={selectWorkspace}>{workspaces.map(item => <option key={`${item.organizationId}:${item.locationId}`} value={item.locationId}>{item.locationName}</option>)}</select><ChevronDown size={17} /></label>}</div></div>}{error && <div className="live-error">{error}</div>}{notice&&<div className="live-notice">{notice}</div>}
      {active === 'Dashboard' && <><form className="staff-search-panel" onSubmit={searchFromDashboard}><Search size={20}/><input aria-label="Search patients" placeholder="Search patients by name, phone, or email" value={patientSearch} onChange={event=>setPatientSearch(event.target.value)} minLength="3" required/><button className="primary" type="submit">Search patients</button></form><section className="staff-dashboard-grid"><article className="live-panel staff-schedule-panel"><div className="panel-heading"><div><h2>Schedule</h2><p>{scheduleItems.length} upcoming appointments</p></div><button className="quiet-link" type="button" onClick={()=>setActive('Appointments')}>View all</button></div>{scheduleItems.length ? <div className="schedule-list">{scheduleItems.map(item=>{const patient=patientsById.get(item.patient_id);const when=new Date(item.start_time);return <div className="schedule-row" key={item.id}><time dateTime={item.start_time}>{when.toLocaleDateString('en-US',{month:'short',day:'numeric'})}<strong>{when.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</strong></time><span className="schedule-dot"/><span className="schedule-detail"><strong>{item.service || 'Appointment'}</strong><small>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient'}</small></span><span className="schedule-status">{item.status}</span></div>})}</div> : <div className="compact-empty"><CalendarDays /><span>{loadingClinic ? 'Loading the schedule…' : 'No upcoming appointments.'}</span></div>}</article><div className="staff-side-column"><article className="live-panel staff-requests-panel"><div className="panel-heading"><div><h2>Booking requests</h2><p>{requested.length} new</p></div></div>{requested.length ? <div className="request-stack booking-stack">{requested.slice(0,6).map(item => <div key={item.id}><CalendarDays /><span><strong>{item.first_name} {item.last_name}</strong><small>{item.appointment_type} · {item.preferred_date||'Flexible'} {item.preferred_time}</small><small>{item.phone} · portal {item.activation_status}</small>{item.source==='patient_portal'&&<small className="booking-source">Requested from the patient portal</small>}{item.match_name&&<span className="possible-match"><span>Possible returning patient: <strong>{item.match_name}</strong> at {item.match_clinic}, same {item.matched_on}.</span><span className="possible-match-actions"><button type="button" className="secondary" onClick={()=>resolveMatch(item,true)}>Same patient</button><button type="button" className="secondary" onClick={()=>resolveMatch(item,false)}>Different person</button></span></span>}</span><button className="secondary" onClick={()=>setScheduleId(item.id)}>Schedule</button></div>)}</div> : <div className="compact-empty"><CalendarDays /><span>{loadingClinic ? 'Loading booking requests…' : 'No new booking requests.'}</span></div>}{scheduleId&&<form className="inline-schedule" onSubmit={scheduleRequest}><label>Appointment date and time<input type="datetime-local" value={scheduleTime} onChange={event=>setScheduleTime(event.target.value)} required/></label><button className="primary">Confirm appointment</button><button type="button" className="secondary" onClick={()=>setScheduleId('')}>Cancel</button></form>}</article><article className="live-panel staff-actions-panel"><h2>Quick actions</h2><div className="staff-actions"><button type="button" onClick={()=>setActive('Appointments')}><CalendarDays/><span>Appointments</span></button><button type="button" onClick={()=>setActive('Patients')}><Users/><span>Patients</span></button><button type="button" onClick={()=>setActive('Documents')}><FileText/><span>Documents</span></button><button type="button" onClick={()=>setActive('Payments')}><CreditCard/><span>Payments</span></button></div></article></div></section></>}
      {active === 'Patients' && (selectedPatient
        ? <StaffPatientProfile patient={selectedPatient} workspace={workspace} request={(path, options) => portalRequest(path, session, options, workspace)} onBack={() => setSelectedPatient(null)} onRefresh={async () => { await refreshClinic(); await openPatient(selectedPatient); }} onEnablePortal={enablePatientPortal} onResetPortal={resetPortalLogin} enablingPortal={enablingPortal} Chart={PatientChart}/>
        : loadingPatient ? <div className="portal-loading compact-loading">Loading patient profile…</div>
        : <><section className="live-panel patient-roaming-panel"><div className="panel-heading"><div><h2>Find a patient in your organization</h2><p>Search before creating another record. A match can be added to this clinic.</p></div></div><form onSubmit={findPatient}><input aria-label="Search organization patients" value={patientSearch} onChange={event => setPatientSearch(event.target.value)} placeholder="Name, phone, or exact email" minLength="3" /><button className="primary" type="submit" disabled={searchingPatients}>{searchingPatients ? 'Searching…' : 'Search organization'}</button></form>{patientMatches.length > 0 && <div className="roaming-results">{patientMatches.map(patient => <article key={patient.patient_id}><div><strong>{patient.first_name} {patient.last_name}</strong><small>{patient.phone} · {patient.email || 'No email'}</small></div><button className="secondary" type="button" onClick={() => linkPatient(patient)}>Add to this clinic</button></article>)}</div>}{patientSearch.length >= 3 && !searchingPatients && !patientMatches.length && <p className="search-hint">No unlinked patient matches are displayed.</p>}</section>{patientDirectory}</>)}
      {active === 'Appointments' && <section className="live-panel"><div className="panel-heading"><div><h2>Appointment activity</h2><p>Requested, confirmed, and completed visits.</p></div></div>{appointmentTable}</section>}
      {active === 'Documents' && <section className="live-panel"><div className="panel-heading"><div><h2>Patient documents</h2><p>Upload a PDF or image to a patient’s secure portal.</p></div></div><form className="document-upload" onSubmit={uploadDocument}><label>Patient<select value={uploadPatient} onChange={event=>setUploadPatient(event.target.value)} required><option value="">Choose a patient</option>{data.patients.map(patient=><option key={patient.id} value={patient.id}>{patient.first_name} {patient.last_name}</option>)}</select></label><label>Document<input name="document" type="file" accept="application/pdf,image/jpeg,image/png" required/></label><button className="primary" disabled={uploading}><Upload size={16}/>{uploading?'Uploading…':'Send to patient portal'}</button></form><div className="responsive-table"><table><thead><tr><th>Patient</th><th>Document</th><th>Status</th><th>Added</th></tr></thead><tbody>{data.documents.map(document=>{const patient=patientsById.get(document.patient_id);return <tr key={document.id}><td>{patient?`${patient.first_name} ${patient.last_name}`:'Patient'}</td><td>{document.name}</td><td>{document.status}</td><td>{new Date(document.created_at).toLocaleDateString()}</td></tr>})}{!data.documents.length&&<tr><td colSpan="4">{loadingClinic ? 'Loading documents…' : 'No documents have been shared.'}</td></tr>}</tbody></table></div></section>}
      {active === 'Reports' && <ReportsPanel key={workspace.locationId} load={range => portalRequest(`/v1/reports?${reportQuery(range)}`, session, {}, workspace)} />}
      {active === 'Payments' && <section className="live-panel"><div className="panel-heading"><div><h2>Payment activity</h2><p>Clinic payment records and current statuses.</p></div></div>{paymentTable}</section>}
    </main></div>
  </div>;
}

// Roles that hold reports.read; the API enforces it, this only decides whether to show the tab.
const reportRoles = ['organization_owner', 'owner', 'clinic_administrator', 'auditor'];
const isoDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function presetRange(kind) {
  const today = new Date(), year = today.getFullYear(), month = today.getMonth();
  if (kind === 'month') return {from: isoDay(new Date(year, month, 1)), to: isoDay(today)};
  if (kind === 'lastMonth') return {from: isoDay(new Date(year, month - 1, 1)), to: isoDay(new Date(year, month, 0))};
  return {from: isoDay(new Date(year, month, today.getDate() - (kind === '90' ? 89 : 29))), to: isoDay(today)};
}
const rangePresets = [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['month', 'This month'], ['lastMonth', 'Last month']];
const money = cents => (Number(cents || 0) / 100).toLocaleString('en-US', {style: 'currency', currency: 'USD'});
function appointmentSummary(counts) {
  const parts = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).map(([status, count]) => `${count} ${status.replaceAll('_', ' ')}`);
  return parts.length ? parts.join(', ') : 'None';
}

// How each clinic is doing over a date range: counts and totals only, never a patient.
function ReportsPanel({ load, showOrganization = false }) {
  const [range, setRange] = useState(() => presetRange('30'));
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    load(range).then(result => { if (current) setReport(result.report); }).catch(event => { if (current) setError(event.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [range.from, range.to]);
  const clinics = report?.clinics || [];
  const total = key => clinics.reduce((sum, row) => sum + Number(row[key] || 0), 0);
  const allAppointments = clinics.reduce((sum, row) => { for (const [status, count] of Object.entries(row.appointments || {})) sum[status] = (sum[status] || 0) + count; return sum; }, {});
  const cells = row => <>
    <td>{row.new_patients}</td><td>{row.moved_in}</td><td>{row.moved_out}</td>
    <td>{row.booking_requests}<small>{row.booking_requests_scheduled} scheduled · {row.booking_requests_from_portal} from the portal</small></td>
    <td>{appointmentSummary(row.appointments)}</td>
    <td>{money(row.payments_cents)}<small>{row.payments} payment{row.payments === 1 ? '' : 's'}</small></td>
  </>;
  return <section className="live-panel reports-panel">
    <div className="panel-heading"><div><h2>Clinic reports</h2><p>Counts and totals for each clinic. Individual patients never appear here.</p></div></div>
    <div className="report-range">
      <label>From<input type="date" value={range.from} max={range.to} onChange={event => event.target.value && setRange(value => ({...value, from: event.target.value}))} /></label>
      <label>To<input type="date" value={range.to} min={range.from} onChange={event => event.target.value && setRange(value => ({...value, to: event.target.value}))} /></label>
      <div className="report-presets" role="group" aria-label="Quick ranges">{rangePresets.map(([kind, label]) => { const preset = presetRange(kind); const selected = preset.from === range.from && preset.to === range.to; return <button key={kind} type="button" className={selected ? 'secondary selected' : 'secondary'} aria-pressed={selected} onClick={() => setRange(preset)}>{label}</button>; })}</div>
    </div>
    {error && <div className="live-error">{error}</div>}
    <div className="responsive-table"><table className="report-table"><thead><tr>{showOrganization && <th>Organization</th>}<th>Clinic</th><th>New patients</th><th>Moved in</th><th>Moved out</th><th>Booking requests</th><th>Appointments</th><th>Payments</th></tr></thead>
      <tbody>
        {clinics.map(row => <tr key={row.location_id}>{showOrganization && <td>{row.organization_name}</td>}<td><strong>{row.clinic_name}</strong>{row.clinic_status !== 'active' && <small>Out of service</small>}</td>{cells(row)}</tr>)}
        {clinics.length > 1 && <tr className="report-total">{showOrganization && <td />}<td><strong>All clinics</strong></td>{cells({new_patients: total('new_patients'), moved_in: total('moved_in'), moved_out: total('moved_out'), booking_requests: total('booking_requests'), booking_requests_scheduled: total('booking_requests_scheduled'), booking_requests_from_portal: total('booking_requests_from_portal'), appointments: allAppointments, payments: total('payments'), payments_cents: total('payments_cents')})}</tr>}
        {!clinics.length && <tr><td colSpan={showOrganization ? 8 : 7}>{loading ? 'Loading reports…' : error ? 'Reports could not be loaded.' : 'No clinics to report on.'}</td></tr>}
      </tbody></table></div>
    {clinics.length > 0 && <p className="report-note">Moves count patients who chose another clinic in the network. Appointments are those booked for a time in this range; requests still waiting for a time are counted under booking requests. Days follow each clinic's own timezone.</p>}
  </section>;
}
const reportQuery = range => `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;

function initialsOf(name) { return (name || '').split(/\s+/).filter(Boolean).map(word => word[0]).join('').slice(0, 2).toUpperCase(); }
const dateOf = value => value ? new Date(value).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}) : 'Not yet scheduled';

// A patient's care from every clinic in the organization, newest first, each labelled with the clinic
// that gave it. Staff add to it only under their own clinic.
function PatientChart({ history }) {
  if (!history) return null;
  const recordKinds = {note: 'Note', treatment: 'Treatment', follow_up: 'Follow-up'};
  const entries = [
    ...history.appointments.map(item => ({id: item.id, kind: 'Appointment', title: item.service, detail: item.status, when: item.start_time, clinic: item.clinic, here: item.here})),
    ...history.records.map(item => ({id: item.id, kind: recordKinds[item.record_type] || 'Record', title: item.note, detail: '', when: item.occurred_at, clinic: item.clinic, here: item.here})),
    ...history.documents.map(item => ({id: item.id, kind: 'Document', title: item.name, detail: item.status, when: item.created_at, clinic: item.clinic, here: item.here})),
    ...history.payments.map(item => ({id: item.id, kind: 'Payment', title: item.description, detail: `${(Number(item.amount_cents || 0) / 100).toLocaleString('en-US', {style: 'currency', currency: 'USD'})} · ${item.status}`, when: item.created_at, clinic: item.clinic, here: item.here})),
  ].sort((a, b) => (b.when ? new Date(b.when) : Infinity) - (a.when ? new Date(a.when) : Infinity));
  const elsewhere = new Set(entries.filter(entry => !entry.here).map(entry => entry.clinic));
  return <div className="patient-chart">
    <h3>Care across the network</h3>
    <p>{elsewhere.size ? `Includes care from ${[...elsewhere].join(', ')}. Anything you add is recorded under this clinic.` : 'Everything this patient has had at any clinic in the organization appears here.'}</p>
    {entries.length ? <div className="chart-list">{entries.map(entry => <div className="chart-row" key={`${entry.kind}-${entry.id}`}>
      <span className="chart-kind">{entry.kind}</span>
      <span className="chart-detail"><strong>{entry.title}</strong><small>{[entry.detail, dateOf(entry.when)].filter(Boolean).join(' · ')}</small></span>
      <span className={`chart-clinic${entry.here ? ' here' : ''}`}>{entry.here ? 'This clinic' : entry.clinic}</span>
    </div>)}</div> : <p className="search-hint">No care has been recorded for this patient yet.</p>}
  </div>;
}

const visitTypes = ['Checkup and cleaning', 'Tooth pain or emergency', 'Consultation', 'Follow-up visit'];

// A signed-in patient asks for a visit at whichever clinic suits them. Choosing another clinic makes it
// their clinic from then on; their history comes with them.
function PatientBooking({ session, onBooked }) {
  const [clinics, setClinics] = useState([]);
  const [form, setForm] = useState({clinic: '', appointmentType: visitTypes[0], preferredDate: '', preferredTime: '', message: ''});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const loadClinics = () => portalRequest('/v1/patient/clinics', session).then(result => {
    setClinics(result.clinics);
    const current = result.clinics.find(clinic => clinic.current) || result.clinics[0];
    if (current) setForm(value => ({...value, clinic: current.key}));
  }).catch(event => setError(event.message));
  useEffect(() => { loadClinics(); }, [session]);
  const chosen = clinics.find(clinic => clinic.key === form.clinic);
  const change = field => event => setForm(value => ({...value, [field]: event.target.value}));
  const submit = async event => {
    event.preventDefault(); setSending(true); setError(''); setNotice('');
    const optional = Object.fromEntries(['preferredDate', 'preferredTime', 'message'].filter(field => form[field].trim()).map(field => [field, form[field].trim()]));
    try {
      const result = await portalRequest('/v1/patient/appointments', session, {method: 'POST', body: JSON.stringify({clinic: form.clinic, appointmentType: form.appointmentType, ...optional})});
      setNotice(`Your request was sent to ${result.appointment.clinicName}. The office will contact you to confirm a time.`);
      setForm(value => ({...value, preferredDate: '', preferredTime: '', message: ''}));
      await Promise.all([loadClinics(), onBooked()]);
    } catch (event) { setError(event.message); }
    finally { setSending(false); }
  };
  return <section className="live-panel patient-booking-panel">
    <CalendarDays /><h2>Request an appointment</h2>
    {error && <div className="live-error">{error}</div>}
    {notice && <div className="live-notice">{notice}</div>}
    {clinics.length > 0 && <form onSubmit={submit}>
      <label className="wide">Clinic<select value={form.clinic} onChange={change('clinic')} required>{clinics.map(clinic => <option key={clinic.key} value={clinic.key}>{clinic.name}{clinic.current ? ' (your clinic)' : ''}</option>)}</select>{chosen?.address && <small>{chosen.address}</small>}</label>
      {chosen && !chosen.current && <p className="wide booking-move-note">{chosen.name} will become your clinic. Your appointments and records come with you.</p>}
      <label>Type of visit<select value={form.appointmentType} onChange={change('appointmentType')}>{visitTypes.map(type => <option key={type}>{type}</option>)}</select></label>
      <label>Preferred date<input type="date" value={form.preferredDate} min={new Date().toISOString().slice(0, 10)} onChange={change('preferredDate')} /></label>
      <label className="wide">Preferred time<input value={form.preferredTime} maxLength="60" placeholder="For example, weekday mornings" onChange={change('preferredTime')} /></label>
      <label className="wide">Anything the office should know<textarea value={form.message} maxLength="1000" rows="3" onChange={change('message')} /></label>
      <button className="primary wide" disabled={sending || !form.clinic}>{sending ? 'Sending…' : 'Send request'}</button>
    </form>}
  </section>;
}

function PatientHome({ session }) {
  const identity = claims(session);
  const [home,setHome]=useState(null);const [error,setError]=useState('');const [downloading,setDownloading]=useState('');
  const loadHome=()=>portalRequest('/v1/patient/home',session).then(setHome).catch(event=>setError(event.message));
  useEffect(()=>{loadHome();},[session]);
  const downloadDocument=async item=>{setDownloading(item.id);setError('');try{const result=await portalRequest(`/v1/patient/documents/${item.id}/download`,session);window.location.assign(result.downloadUrl);}catch(event){setError(event.message);}finally{setDownloading('');}};
  const organizationName=home?.organization?.name; const clinicName=home?.clinic?.name;
  return <div className="live-portal patient-live-portal"><PortalHeader title={organizationName?`${organizationName} Patient Portal`:'Patient Portal'} subtitle={identity.email || clinicName || ''} /><main className="patient-home-live"><div className="patient-clinic-badge">{initialsOf(clinicName || organizationName) || <Stethoscope size={22} />}</div>{clinicName&&<div className="live-kicker">{clinicName.toUpperCase()}</div>}<h1>{home?.patient?`Welcome, ${home.patient.firstName}`:'Welcome to your patient portal'}</h1><p>Your appointments and documents from {organizationName || 'your dental office'} are kept together here, from every clinic you visit.</p>{error&&<div className="live-error">{error}</div>}<section className="patient-portal-grid"><article className="live-panel"><CalendarDays/><h2>Appointments</h2>{home?.appointments?.length?home.appointments.map(item=><div className="patient-item" key={item.id}><strong>{item.service}</strong><span>{item.startTime?new Date(item.startTime).toLocaleString():'Waiting for the office to schedule'} · {item.status}{item.clinic?` · ${item.clinic}`:''}</span></div>):<p>No appointments are available yet.</p>}</article><article className="live-panel"><FileText/><h2>Documents</h2>{home?.documents?.length?home.documents.map(item=><div className="patient-item patient-document-item" key={item.id}><span><strong>{item.name}</strong><small>Shared {new Date(item.createdAt).toLocaleDateString()}</small></span><button className="secondary" type="button" onClick={()=>downloadDocument(item)} disabled={downloading===item.id}>{downloading===item.id?'Preparing…':'Download'}</button></div>):<p>No documents have been shared yet.</p>}</article></section>{home&&<PatientBooking session={session} onBooked={loadHome} />}<section className="patient-safe-card"><ShieldCheck /><div><strong>Your access is private</strong><span>This account cannot open staff or administrator records.</span></div></section></main></div>;
}

function App() {
  const role = portalRole();
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const endExpiredSession = () => { clearSession(); setSession(null); setError(sessionExpiredMessage); };
  useEffect(() => {
    finishSignIn().then(value => {
      // A session restored from an earlier visit may already have lapsed.
      if (value && sessionExpired(value)) { clearSession(); setError(sessionExpiredMessage); return; }
      setSession(value);
    }).catch(event => setError(event.message)).finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!session) return undefined;
    window.addEventListener('day-session-expired', endExpiredSession);
    // Also notice expiry while the page sits idle, before the next request would fail.
    const timer = window.setInterval(() => { if (sessionExpired(session)) endExpiredSession(); }, 60_000);
    return () => { window.removeEventListener('day-session-expired', endExpiredSession); window.clearInterval(timer); };
  }, [session]);
  useEffect(() => { document.title = `${role === 'admin' ? 'Admin' : role === 'staff' ? 'Staff' : 'Patient'} ${session ? 'Portal' : 'Login'} | D.A.Y Health Systems`; }, [role, session]);
  if (!ready) return <div className="portal-loading">Loading secure portal…</div>;
  if (!session) return <Login role={role} error={error} />;
  const authorized = role === 'admin' ? hasGroup(session, 'platform_admin') : role === 'staff' ? hasGroup(session,'dentalems_staff') : hasGroup(session, 'dentalems_patient');
  if (!authorized) return <div className={`workforce-login login-${role}`}><main className="workforce-login-card"><Brand /><h1>Access not assigned</h1><p>This account is valid, but it is not assigned to this portal.</p><button className="primary portal-sign-in" onClick={signOut}>Sign out</button></main></div>;
  if (role === 'admin') return <AdminPortal session={session} />;
  if (role === 'patient') return <PatientHome session={session} />;
  return <StaffPortal session={session} />;
}

if (typeof document !== 'undefined') createRoot(document.getElementById('root')).render(<App />);
