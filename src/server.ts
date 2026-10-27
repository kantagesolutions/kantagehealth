import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z, ZodError } from 'zod';
import { AccessError, scoped } from './context.js';
import { createAppointment, listAppointments } from './appointments.js';
import { createCareRecord, createPatient, linkPatientToLocation, listCareRecords, listPatients, patientHistory, patientPortalInvitation, readPatient, searchRoamingPatients } from './patients.js';
import { createPaymentRecord, listPayments } from './payments.js';
import { approveMySupportAccess, listSupportAccess, requestSupportAccess } from './support.js';
import type { StaffAuthConfig, TokenVerifier } from './auth.js';
import { staffVerifier, verifyStaffToken } from './auth.js';
import { productionRegistry, staffClientIds, TenantPoolRegistry, type TenantConfig, type TenantRegistry } from './tenant-registry.js';
import { createPatientPortalBooking, createPublicBookingInquiry, listBookingClinics } from './public-booking.js';
import { listStaffWorkspaces } from './workspaces.js';
import { clinicReports, platformReports } from './reports.js';
import { listBookingInquiries, resolveBookingMatch, scheduleBookingInquiry } from './bookings.js';
import { completeDocument, createDocumentUpload, listDocuments, patientDocumentObject } from './documents.js';
import { CognitoPatientAccountProvisioner, savePatientInvite, type PatientAccountProvisioner } from './patient-accounts.js';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assignableRoles, createClinic, createPlatformClient, createPlatformStaff, deleteOrganization, deleteStaff, listClinics, listPlatformAccess, listPlatformActivity, listPlatformClients, organizationRecords, setClinicStatus, setOrganizationStatus, setUserStatus, staffRecords, updateClinic, updateOrganization, updatePlatformStaff, type PlatformActor } from './platform-admin.js';
import { CognitoWorkforceAccountProvisioner, type WorkforceAccountProvisioner } from './workforce-accounts.js';

const requestScope=z.object({organizationId:z.string().uuid(),locationId:z.string().uuid()});
interface Platform { registry:TenantRegistry; pools:TenantPoolRegistry; verifierFor(tenant:TenantConfig):TokenVerifier; workforceAuth?:StaffAuthConfig; workforceVerifier?:TokenVerifier; patientAccounts?:PatientAccountProvisioner; workforceAccounts?:WorkforceAccountProvisioner; s3?:S3Client; }

function patientAuth(tenant:TenantConfig):StaffAuthConfig { return {userPoolId:tenant.staffUserPoolId,clientId:staffClientIds(tenant)}; }
function workforceAuth(platform:Platform,tenant:TenantConfig):StaffAuthConfig { return platform.workforceAuth??patientAuth(tenant); }
function workforceVerifier(platform:Platform,tenant:TenantConfig):TokenVerifier { return platform.workforceVerifier??platform.verifierFor(tenant); }
function workforceIdentities(claims:{sub:string;username?:string}):string[] {
  return [...new Set([claims.username,claims.sub].filter((value): value is string => Boolean(value)))];
}
function workforceIdentity(claims:{sub:string;username?:string}):string { return workforceIdentities(claims)[0]??claims.sub; }

function send(response:ServerResponse,status:number,body:unknown){
  response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","access-control-allow-origin":"*","access-control-allow-headers":"authorization,content-type,x-kantage-organization,x-kantage-location","access-control-allow-methods":"GET,POST,PATCH,DELETE,OPTIONS"});
  response.end(JSON.stringify(body));
}
function token(request:IncomingMessage){
  const value=request.headers.authorization;
  if(!value?.startsWith('Bearer ')) throw new AccessError(401,'Unauthorized');
  return value.slice(7);
}
async function body(request:IncomingMessage):Promise<unknown>{
  const chunks:Buffer[]=[]; let size=0;
  for await(const chunk of request){
    const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); size+=value.length;
    if(size>1_000_000) throw new AccessError(413,'Request too large');
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AccessError(400,'Invalid JSON'); }
}
function remoteIp(request:IncomingMessage){ return request.socket.remoteAddress?.slice(0,64); }
const bookingAttempts=new Map<string,{count:number;expiresAt:number}>();
// The organization a signed-in patient belongs to, and their portal home. Every organization shares the
// patient sign-in, so the token is tried against each until one holds a portal account for it.
interface PatientHome { clinic?:{id?:string}; [key:string]:unknown; }
async function patientAccount(platform:Platform,bearer:string){
  for(const tenant of await platform.registry.list()) {
    try {
      const claims=await verifyStaffToken(bearer,patientAuth(tenant),platform.verifierFor(tenant));
      const groups=(claims as Record<string,unknown>)['cognito:groups'];
      if(!Array.isArray(groups) || !groups.includes('dentalems_patient')) throw new AccessError(403);
      const pool=await platform.pools.get(tenant);
      const result=await pool.query<{home:PatientHome|null}>('SELECT clinical.patient_portal_home($1,$2) AS home',[tenant.organizationId,claims.sub]);
      const home=result.rows[0]?.home;
      if(home) return {tenant,pool,sub:claims.sub,home};
    } catch(error) { if(error instanceof AccessError) throw error; if(error instanceof Error && error.message==='Unauthorized') continue; throw error; }
  }
  throw new AccessError(404,'Patient profile not found');
}
// The portal shows the patient's clinic by name; its internal id stays on the server.
function withoutClinicId(home:PatientHome){ const {id:_id,...clinic}=home.clinic??{}; return {...home,clinic}; }
function allowBooking(ip:string,key:string){ const now=Date.now(), id=`${ip}:${key}`, current=bookingAttempts.get(id); if(!current || current.expiresAt<=now) { bookingAttempts.set(id,{count:1,expiresAt:now+60*60*1000}); return true; } if(current.count>=8) return false; current.count+=1; return true; }

export function createHealthcareServer(platform:Platform):Server {
  return createServer(async(request,response)=>{
    try {
      if(request.method==='OPTIONS') return send(response,204,{});
      if(request.method==='GET' && request.url==='/healthz') return send(response,200,{status:'ok'});
      const path=(request.url??'/').split('?')[0] ?? '/';
      const publicBookingMatch=path.match(/^\/v1\/public\/booking\/([A-Za-z0-9_-]{20,128})(?:\/(inquiries|clinics))?$/);
      if(publicBookingMatch?.[1]) {
        const resolved=await platform.registry.findBooking(publicBookingMatch[1]);
        if(!resolved) return send(response,404,{error:'Booking destination not found'});
        const target={organizationId:resolved.tenant.organizationId,locationId:resolved.clinic.locationId,clinicName:resolved.clinic.clinicName,timezone:resolved.clinic.timezone};
        if(request.method==='GET' && !publicBookingMatch[2]) return send(response,200,{clinic:{name:target.clinicName,timezone:target.timezone}});
        // Every clinic in this booking link's network, so a website can let the patient choose.
        if(request.method==='GET' && publicBookingMatch[2]==='clinics') {
          const pool=await platform.pools.get(resolved.tenant);
          return send(response,200,{clinics:await listBookingClinics(pool,resolved.tenant.organizationId,resolved.tenant.bookingClinics)});
        }
        if(request.method==='POST' && publicBookingMatch[2]==='inquiries') {
          const ip=remoteIp(request)??'unknown';
          if(!allowBooking(ip,publicBookingMatch[1])) return send(response,429,{error:'Please try again later'});
          const pool=await platform.pools.get(resolved.tenant);
          const inquiry=await createPublicBookingInquiry(pool,target,await body(request),{ip:remoteIp(request),userAgent:String(request.headers['user-agent']??'')});
          return send(response,201,{inquiry:{id:inquiry.id,patientId:inquiry.patientId}});
        }
        return send(response,405,{error:'Method not allowed'});
      }
      if(request.method==='GET' && path==='/v1/session/workspaces') {
        const bearer=token(request);
        const workspaces=[];
        let tokenAccepted=false;
        for(const tenant of await platform.registry.list()) {
          try {
            const claims=await verifyStaffToken(bearer,workforceAuth(platform,tenant),workforceVerifier(platform,tenant));
            tokenAccepted=true;
            const pool=await platform.pools.get(tenant);
            workspaces.push(...await listStaffWorkspaces(pool,tenant.organizationId,workforceIdentities(claims)));
          } catch(error) {
            if(error instanceof Error && error.message==='Unauthorized') continue;
            throw error;
          }
        }
        if(!tokenAccepted) throw new AccessError(401,'Unauthorized');
        return send(response,200,{workspaces});
      }
      if(request.method==='GET' && path==='/v1/patient/home') return send(response,200,withoutClinicId((await patientAccount(platform,token(request))).home));
      if(request.method==='GET' && path==='/v1/patient/clinics') {
        const account=await patientAccount(platform,token(request));
        const current=account.tenant.bookingClinics.find(clinic=>clinic.locationId===account.home.clinic?.id)?.key;
        const clinics=await listBookingClinics(account.pool,account.tenant.organizationId,account.tenant.bookingClinics);
        return send(response,200,{clinics:clinics.map(clinic=>({...clinic,current:clinic.key===current}))});
      }
      if(request.method==='POST' && path==='/v1/patient/appointments') {
        const account=await patientAccount(platform,token(request));
        if(!allowBooking(`patient:${account.sub}`,'portal')) return send(response,429,{error:'Please try again later'});
        const booking=await createPatientPortalBooking(account.pool,account.tenant,account.sub,await body(request),{ip:remoteIp(request),userAgent:String(request.headers['user-agent']??'')});
        if(!booking) return send(response,404,{error:'Clinic not found'});
        return send(response,201,{appointment:booking});
      }
      const patientDocumentMatch=path.match(/^\/v1\/patient\/documents\/([0-9a-f-]{36})\/download$/i);
      if(request.method==='GET' && patientDocumentMatch?.[1]) {
        if(!platform.s3) throw new Error('Document storage unavailable');
        const bearer=token(request);
        for(const tenant of await platform.registry.list()) {
          try {
            const claims=await verifyStaffToken(bearer,patientAuth(tenant),platform.verifierFor(tenant));
            const groups=(claims as Record<string,unknown>)['cognito:groups'];
            if(!Array.isArray(groups) || !groups.includes('dentalems_patient')) throw new AccessError(403);
            const pool=await platform.pools.get(tenant);
            const document=await patientDocumentObject((sql,values)=>pool.query(sql,values),tenant.organizationId,claims.sub,patientDocumentMatch[1]);
            if(!document) continue;
            const downloadUrl=await getSignedUrl(platform.s3,new GetObjectCommand({Bucket:tenant.documentsBucket,Key:document.object_key,ResponseContentType:document.content_type,ResponseContentDisposition:`attachment; filename="${document.name.replace(/["\\]/g,'_')}"`}),{expiresIn:300});
            return send(response,200,{downloadUrl});
          } catch(error) { if(error instanceof AccessError) throw error; if(error instanceof Error && error.message==='Unauthorized') continue; throw error; }
        }
        throw new AccessError(404,'Document not found');
      }
      if(path.startsWith('/v1/admin/')) {
        const bearer=token(request); let tenants=await platform.registry.list(); let accepted=false;
        let actor:PlatformActor|undefined;
        for(const tenant of tenants){
          try {
            const claims=await verifyStaffToken(bearer,workforceAuth(platform,tenant),workforceVerifier(platform,tenant));
            const groups=(claims as Record<string,unknown>)['cognito:groups'];
            // Keep the verified identity: every administrator change is recorded against it.
            if(Array.isArray(groups)&&groups.includes('platform_admin')) { actor={username:workforceIdentity(claims)}; break; }
          } catch(error) { if(error instanceof Error&&error.message==='Unauthorized') continue; throw error; }
        }
        if(!actor) throw new AccessError(403);
        // Administrators act on what other API tasks may have just changed, such as an organization created a
        // moment ago, so their requests read the registry as it is now.
        tenants=await platform.registry.refresh();
        if(request.method==='GET'&&path==='/v1/admin/clients') return send(response,200,{clients:await listPlatformClients(tenants,platform.pools)});
        if(request.method==='GET'&&path==='/v1/admin/access') return send(response,200,{users:await listPlatformAccess(tenants,platform.pools)});
        if(request.method==='GET'&&path==='/v1/admin/activity') return send(response,200,{activity:await listPlatformActivity(tenants,platform.pools)});
        if(request.method==='GET'&&path==='/v1/admin/roles') return send(response,200,{roles:assignableRoles});
        if(request.method==='GET'&&path==='/v1/admin/reports') return send(response,200,{report:await platformReports(tenants,platform.pools,new URL(request.url??'/','http://localhost').searchParams)});
        if(request.method==='POST'&&path==='/v1/admin/clients') return send(response,201,{client:await createPlatformClient(platform.registry,platform.pools,actor,await body(request))});
        if(request.method==='POST'&&path==='/v1/admin/staff') {
          if(!platform.workforceAccounts) throw new Error('Workforce onboarding is unavailable');
          return send(response,201,{staff:await createPlatformStaff(tenants,platform.pools,platform.workforceAccounts,actor,await body(request))});
        }
        const orgMatch=path.match(/^\/v1\/admin\/clients\/([0-9a-f-]{36})$/i);
        if(request.method==='PATCH'&&orgMatch?.[1]) {
          const tenant=tenants.find(item=>item.organizationId===orgMatch[1])??tenants[0]; if(!tenant) throw new AccessError(404);
          return send(response,200,{client:await setOrganizationStatus(tenant,platform.pools,actor,orgMatch[1],await body(request))});
        }
        if(request.method==='DELETE'&&orgMatch?.[1]) return send(response,200,{client:await deleteOrganization(platform.registry,platform.pools,actor,orgMatch[1])});
        // Editing has its own path so the status route keeps its meaning for the version still serving while a
        // deploy rolls out.
        const orgProfileMatch=path.match(/^\/v1\/admin\/clients\/([0-9a-f-]{36})\/profile$/i);
        if(request.method==='PATCH'&&orgProfileMatch?.[1]) {
          const tenant=tenants.find(item=>item.organizationId===orgProfileMatch[1]); if(!tenant) throw new AccessError(404,'Organization is not connected');
          return send(response,200,{client:await updateOrganization(tenant,platform.pools,actor,orgProfileMatch[1],await body(request))});
        }
        const orgRecordsMatch=path.match(/^\/v1\/admin\/clients\/([0-9a-f-]{36})\/records$/i);
        if(request.method==='GET'&&orgRecordsMatch?.[1]) {
          const tenant=tenants.find(item=>item.organizationId===orgRecordsMatch[1])??tenants[0]; if(!tenant) throw new AccessError(404);
          return send(response,200,{records:await organizationRecords(tenant,platform.pools,orgRecordsMatch[1])});
        }
        // Clinics in an organization's network.
        const clinicsMatch=path.match(/^\/v1\/admin\/clients\/([0-9a-f-]{36})\/clinics$/i);
        if(clinicsMatch?.[1]) {
          const tenant=tenants.find(item=>item.organizationId===clinicsMatch[1]); if(!tenant) throw new AccessError(404,'Organization is not connected');
          if(request.method==='GET') return send(response,200,{clinics:await listClinics(tenant,platform.pools,clinicsMatch[1])});
          if(request.method==='POST') return send(response,201,{clinic:await createClinic(platform.registry,platform.pools,actor,clinicsMatch[1],await body(request))});
        }
        const clinicMatch=path.match(/^\/v1\/admin\/clients\/([0-9a-f-]{36})\/clinics\/([0-9a-f-]{36})$/i);
        if(request.method==='PATCH'&&clinicMatch?.[1]&&clinicMatch[2]) {
          const tenant=tenants.find(item=>item.organizationId===clinicMatch[1]); if(!tenant) throw new AccessError(404,'Organization is not connected');
          const payload=await body(request) as Record<string,unknown>;
          // A status change and an edit of the clinic's details are separate actions with separate audit entries.
          if(payload&&typeof payload==='object'&&'status' in payload) return send(response,200,{clinic:await setClinicStatus(tenant,platform.pools,actor,clinicMatch[1],clinicMatch[2],payload)});
          return send(response,200,{clinic:await updateClinic(platform.registry,platform.pools,actor,clinicMatch[1],clinicMatch[2],payload)});
        }
        const staffRecordsMatch=path.match(/^\/v1\/admin\/access\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/records$/i);
        if(request.method==='GET'&&staffRecordsMatch?.[1]&&staffRecordsMatch[2]) {
          const tenant=tenants.find(item=>item.organizationId===staffRecordsMatch[1])??tenants[0]; if(!tenant) throw new AccessError(404);
          return send(response,200,{records:await staffRecords(tenant,platform.pools,staffRecordsMatch[1],staffRecordsMatch[2])});
        }
        // Editing has its own path so the status route keeps its meaning for the version still serving
        // while a deploy rolls out.
        const profileMatch=path.match(/^\/v1\/admin\/access\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/profile$/i);
        if(request.method==='PATCH'&&profileMatch?.[1]&&profileMatch[2]) {
          const tenant=tenants.find(item=>item.organizationId===profileMatch[1])??tenants[0]; if(!tenant) throw new AccessError(404);
          return send(response,200,{user:await updatePlatformStaff(tenant,platform.pools,actor,profileMatch[1],profileMatch[2],await body(request))});
        }
        const userMatch=path.match(/^\/v1\/admin\/access\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i);
        if(request.method==='PATCH'&&userMatch?.[1]&&userMatch[2]) {
          const tenant=tenants.find(item=>item.organizationId===userMatch[1])??tenants[0]; if(!tenant) throw new AccessError(404);
          return send(response,200,{user:await setUserStatus(tenant,platform.pools,actor,userMatch[1],userMatch[2],await body(request))});
        }
        if(request.method==='DELETE'&&userMatch?.[1]&&userMatch[2]) {
          const tenant=tenants.find(item=>item.organizationId===userMatch[1])??tenants[0]; if(!tenant) throw new AccessError(404);
          return send(response,200,{user:await deleteStaff(tenant,platform.pools,actor,userMatch[1],userMatch[2])});
        }
        return send(response,404,{error:'Not found'});
      }
      const scope=requestScope.parse({organizationId:request.headers['x-kantage-organization'],locationId:request.headers['x-kantage-location']});
      const bearer=token(request);
      const tenant=await platform.registry.get(scope.organizationId);
      const claims=await verifyStaffToken(bearer,workforceAuth(platform,tenant),workforceVerifier(platform,tenant));
      const pool=await platform.pools.get(tenant);
      const requestScopeData={...scope,sub:workforceIdentity(claims),ip:remoteIp(request),userAgent:String(request.headers['user-agent']??'').slice(0,256)};
      if(request.method==='GET' && path==='/v1/patients') return send(response,200,{patients:await scoped(pool,requestScopeData,listPatients)});
      const patientMatch=path.match(/^\/v1\/patients\/([0-9a-f-]{36})$/i);
      if(request.method==='GET' && patientMatch?.[1]) return send(response,200,{patient:await scoped(pool,requestScopeData,()=>readPatient(patientMatch[1]!))});
      const portalAccessMatch=path.match(/^\/v1\/patients\/([0-9a-f-]{36})\/portal-access$/i);
      if(request.method==='POST' && portalAccessMatch?.[1]) {
        if(!platform.patientAccounts) throw new Error('Patient portal access is unavailable');
        const enabled=await scoped(pool,requestScopeData,async()=>{
          const invitation=await patientPortalInvitation(portalAccessMatch[1]!);
          const result=await platform.patientAccounts!.invite(invitation);
          if(!result) throw new AccessError(400,'Patient email is required before portal access can be enabled');
          await savePatientInvite(pool,invitation,result);
          return {emailSent:result.emailSent,textSent:result.textSent};
        });
        return send(response,200,{portalAccess:enabled});
      }
      if(request.method==='GET' && path==='/v1/patients/search') {
        const search=new URL(request.url??'/',`http://${request.headers.host??'localhost'}`).searchParams.get('q')??'';
        return send(response,200,{patients:await scoped(pool,requestScopeData,()=>searchRoamingPatients(search))});
      }
      if(request.method==='GET' && path==='/v1/appointments') return send(response,200,{appointments:await scoped(pool,requestScopeData,listAppointments)});
      if(request.method==='GET' && path==='/v1/reports') return send(response,200,{report:await scoped(pool,requestScopeData,()=>clinicReports(new URL(request.url??'/','http://localhost').searchParams))});
      if(request.method==='GET' && path==='/v1/booking-inquiries') return send(response,200,{inquiries:await scoped(pool,requestScopeData,listBookingInquiries)});
      const bookingScheduleMatch=path.match(/^\/v1\/booking-inquiries\/([0-9a-f-]{36})\/schedule$/i);
      if(bookingScheduleMatch?.[1] && request.method==='POST') {
        const payload=await body(request);
        return send(response,200,{appointment:await scoped(pool,requestScopeData,()=>scheduleBookingInquiry(bookingScheduleMatch[1]!,payload))});
      }
      const bookingMatchMatch=path.match(/^\/v1\/booking-inquiries\/([0-9a-f-]{36})\/match$/i);
      if(bookingMatchMatch?.[1] && request.method==='POST') {
        const payload=await body(request);
        return send(response,200,{booking:await scoped(pool,requestScopeData,()=>resolveBookingMatch(bookingMatchMatch[1]!,payload))});
      }
      if(request.method==='POST' && path==='/v1/appointments') {
        const payload=await body(request);
        return send(response,201,{appointment:await scoped(pool,requestScopeData,()=>createAppointment(payload))});
      }
      if(request.method==='GET' && path==='/v1/payments') return send(response,200,{payments:await scoped(pool,requestScopeData,listPayments)});
      if(request.method==='POST' && path==='/v1/payments') {
        const payload=await body(request);
        return send(response,201,{payment:await scoped(pool,requestScopeData,()=>createPaymentRecord(payload))});
      }
      if(request.method==='GET' && path==='/v1/documents') {
        const patientId=new URL(request.url??'/',`http://${request.headers.host??'localhost'}`).searchParams.get('patientId')??undefined;
        return send(response,200,{documents:await scoped(pool,requestScopeData,()=>listDocuments(patientId))});
      }
      if(request.method==='POST' && path==='/v1/documents/uploads') {
        const payload=await body(request);
        const document=await scoped(pool,requestScopeData,()=>createDocumentUpload(payload));
        if(!platform.s3) throw new Error('Document storage unavailable');
        const uploadUrl=await getSignedUrl(platform.s3,new PutObjectCommand({Bucket:tenant.documentsBucket,Key:document.objectKey,ContentType:document.contentType}),{expiresIn:600});
        return send(response,201,{document:{id:document.id,uploadUrl}});
      }
      const completeMatch=path.match(/^\/v1\/documents\/([0-9a-f-]{36})\/complete$/i);
      if(completeMatch?.[1] && request.method==='POST') return send(response,200,{document:await scoped(pool,requestScopeData,()=>completeDocument(completeMatch[1]!))});
      if(request.method==='GET' && path==='/v1/support-access') return send(response,200,{sessions:await scoped(pool,requestScopeData,listSupportAccess)});
      if(request.method==='POST' && path==='/v1/support-access') {
        const payload=await body(request);
        return send(response,201,{session:await scoped(pool,requestScopeData,()=>requestSupportAccess(payload))});
      }
      const supportMatch=path.match(/^\/v1\/support-access\/([0-9a-f-]{36})\/approve$/i);
      if(supportMatch?.[1] && request.method==='POST') return send(response,200,{session:await scoped(pool,requestScopeData,()=>approveMySupportAccess(supportMatch[1]!))});
      if(request.method==='POST' && path==='/v1/patients') {
        const payload=await body(request);
        return send(response,201,{patient:await scoped(pool,requestScopeData,()=>createPatient(payload))});
      }
      const match=path.match(/^\/v1\/patients\/([0-9a-f-]{36})(?:\/(records))?$/i);
      const historyMatch=path.match(/^\/v1\/patients\/([0-9a-f-]{36})\/history$/i);
      if(historyMatch?.[1] && request.method==='GET') return send(response,200,{history:await scoped(pool,requestScopeData,()=>patientHistory(historyMatch[1]!))});
      const linkMatch=path.match(/^\/v1\/patients\/([0-9a-f-]{36})\/link$/i);
      if(linkMatch?.[1] && request.method==='POST') return send(response,200,{patient:await scoped(pool,requestScopeData,()=>linkPatientToLocation(linkMatch[1]!))});
      if(match?.[1] && !match[2] && request.method==='GET') return send(response,200,{patient:await scoped(pool,requestScopeData,()=>readPatient(match[1]!))});
      if(match?.[1] && match[2]==='records' && request.method==='GET') return send(response,200,{records:await scoped(pool,requestScopeData,()=>listCareRecords(match[1]!))});
      if(match?.[1] && match[2]==='records' && request.method==='POST') {
        const payload=await body(request);
        return send(response,201,{record:await scoped(pool,requestScopeData,()=>createCareRecord(match[1]!,payload))});
      }
      return send(response,404,{error:'Not found'});
    } catch(error) {
      if(error instanceof ZodError) return send(response,400,{error:'Invalid request'});
      if(error instanceof AccessError) return send(response,error.status,{error:error.message});
      if(error instanceof Error && error.message==='Unauthorized') return send(response,401,{error:'Unauthorized'});
      // Messages raised by our own SQL functions are fixed strings written for people, never data.
      const databaseCode=(error as {code?:unknown}).code;
      if(databaseCode==='P0001' && error instanceof Error) return send(response,400,{error:error.message});
      if(databaseCode==='23505') return send(response,409,{error:'That already exists.'});
      // Anything else is unexpected. Record the real cause so it can be found, and hand back an id that
      // ties the user's report to the log line. Only the method and query-free path are logged: query
      // strings and bodies can carry patient details.
      const requestId=randomUUID();
      console.error(JSON.stringify({level:'error',requestId,method:request.method,path:(request.url??'/').split('?')[0],error:error instanceof Error?{name:error.name,message:error.message,code:databaseCode,stack:error.stack}:String(error)}));
      return send(response,503,{error:'Service unavailable',requestId});
    }
  });
}

if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const port=Number.parseInt(process.env.PORT??'3000',10);
  if(!Number.isInteger(port) || port<1 || port>65_535) throw new Error('PORT must be a valid TCP port');
  const secrets=new SecretsManagerClient({});
  const pools=new TenantPoolRegistry(secrets);
  const workforceAuthConfig={userPoolId:process.env.WORKFORCE_USER_POOL_ID??'',clientId:process.env.WORKFORCE_PORTAL_CLIENT_ID??''};
  if(!workforceAuthConfig.userPoolId||!workforceAuthConfig.clientId) throw new Error('Workforce authentication is not configured');
  const server=createHealthcareServer({registry:productionRegistry(),pools,verifierFor:tenant=>staffVerifier(patientAuth(tenant)),workforceAuth:workforceAuthConfig,workforceVerifier:staffVerifier(workforceAuthConfig),patientAccounts:new CognitoPatientAccountProvisioner(),workforceAccounts:new CognitoWorkforceAccountProvisioner(),s3:new S3Client({})});
  server.listen(port,'0.0.0.0',()=>console.info(`D.A.Y Health Systems API listening on ${port}`));
  const stop=()=>server.close(()=>pools.close().finally(()=>process.exit(0)));
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
}
