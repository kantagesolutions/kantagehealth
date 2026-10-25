import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z, ZodError } from 'zod';
import { AccessError, scoped } from './context.js';
import { createAppointment, listAppointments } from './appointments.js';
import { createCareRecord, createPatient, linkPatientToLocation, listCareRecords, listPatients, readPatient, searchRoamingPatients } from './patients.js';
import { createPaymentRecord, listPayments } from './payments.js';
import { approveMySupportAccess, listSupportAccess, requestSupportAccess } from './support.js';
import type { StaffAuthConfig, TokenVerifier } from './auth.js';
import { staffVerifier, verifyStaffToken } from './auth.js';
import { productionRegistry, staffClientIds, TenantPoolRegistry, type TenantConfig, type TenantRegistry } from './tenant-registry.js';
import { createPublicBookingInquiry } from './public-booking.js';
import { listStaffWorkspaces } from './workspaces.js';
import { listBookingInquiries, scheduleBookingInquiry } from './bookings.js';
import { completeDocument, createDocumentUpload, listDocuments, patientDocumentObject } from './documents.js';
import { CognitoPatientAccountProvisioner, savePatientInvite, type PatientAccountProvisioner } from './patient-accounts.js';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPlatformClient, createPlatformStaff, listPlatformAccess, listPlatformClients, setOrganizationStatus, setUserStatus } from './platform-admin.js';
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
  response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","access-control-allow-origin":"*","access-control-allow-headers":"authorization,content-type,x-kantage-organization,x-kantage-location","access-control-allow-methods":"GET,POST,PATCH,OPTIONS"});
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
function allowBooking(ip:string,key:string){ const now=Date.now(), id=`${ip}:${key}`, current=bookingAttempts.get(id); if(!current || current.expiresAt<=now) { bookingAttempts.set(id,{count:1,expiresAt:now+60*60*1000}); return true; } if(current.count>=8) return false; current.count+=1; return true; }

export function createHealthcareServer(platform:Platform):Server {
  return createServer(async(request,response)=>{
    try {
      if(request.method==='OPTIONS') return send(response,204,{});
      if(request.method==='GET' && request.url==='/healthz') return send(response,200,{status:'ok'});
      const path=(request.url??'/').split('?')[0] ?? '/';
      const publicBookingMatch=path.match(/^\/v1\/public\/booking\/([A-Za-z0-9_-]{20,128})(?:\/inquiries)?$/);
      if(publicBookingMatch?.[1]) {
        const resolved=await platform.registry.findBooking(publicBookingMatch[1]);
        if(!resolved) return send(response,404,{error:'Booking destination not found'});
        const target={organizationId:resolved.tenant.organizationId,locationId:resolved.clinic.locationId,clinicName:resolved.clinic.clinicName,timezone:resolved.clinic.timezone};
        if(request.method==='GET' && !path.endsWith('/inquiries')) return send(response,200,{clinic:{name:target.clinicName,timezone:target.timezone}});
        if(request.method==='POST' && path.endsWith('/inquiries')) {
          const ip=remoteIp(request)??'unknown';
          if(!allowBooking(ip,publicBookingMatch[1])) return send(response,429,{error:'Please try again later'});
          const pool=await platform.pools.get(resolved.tenant);
          const inquiry=await createPublicBookingInquiry(pool,target,await body(request),{ip:remoteIp(request),userAgent:String(request.headers['user-agent']??'')});
          if(platform.patientAccounts) {
            const invitation={organizationId:target.organizationId,patientId:inquiry.patientId,email:inquiry.patient.email,phone:inquiry.patient.phone,firstName:inquiry.patient.firstName,clinicName:target.clinicName,textConsent:inquiry.patient.textConsent};
            try { const invited=await platform.patientAccounts.invite(invitation); if(invited) await savePatientInvite(pool,invitation,invited); }
            catch(error) { console.error('Patient portal invitation failed',error instanceof Error?error.name:'UnknownError'); }
          }
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
      if(request.method==='GET' && path==='/v1/patient/home') {
        const bearer=token(request);
        for(const tenant of await platform.registry.list()) {
          try {
            const claims=await verifyStaffToken(bearer,patientAuth(tenant),platform.verifierFor(tenant));
            const groups=(claims as Record<string,unknown>)['cognito:groups'];
            if(!Array.isArray(groups) || !groups.includes('dentalems_patient')) throw new AccessError(403);
            const pool=await platform.pools.get(tenant);
            const result=await pool.query<{home:unknown}>('SELECT clinical.patient_portal_home($1,$2) AS home',[tenant.organizationId,claims.sub]);
            if(result.rows[0]?.home) return send(response,200,result.rows[0].home);
          } catch(error) { if(error instanceof AccessError) throw error; if(error instanceof Error && error.message==='Unauthorized') continue; throw error; }
        }
        throw new AccessError(404,'Patient profile not found');
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
        const bearer=token(request); const tenants=await platform.registry.list(); let accepted=false;
        for(const tenant of tenants){
          try {
            const claims=await verifyStaffToken(bearer,workforceAuth(platform,tenant),workforceVerifier(platform,tenant));
            const groups=(claims as Record<string,unknown>)['cognito:groups'];
            if(Array.isArray(groups)&&groups.includes('platform_admin')) { accepted=true; break; }
          } catch(error) { if(error instanceof Error&&error.message==='Unauthorized') continue; throw error; }
        }
        if(!accepted) throw new AccessError(403);
        if(request.method==='GET'&&path==='/v1/admin/clients') return send(response,200,{clients:await listPlatformClients(tenants,platform.pools)});
        if(request.method==='GET'&&path==='/v1/admin/access') return send(response,200,{users:await listPlatformAccess(tenants,platform.pools)});
        if(request.method==='POST'&&path==='/v1/admin/clients') return send(response,201,{client:await createPlatformClient(platform.registry,platform.pools,await body(request))});
        if(request.method==='POST'&&path==='/v1/admin/staff') {
          if(!platform.workforceAccounts) throw new Error('Workforce onboarding is unavailable');
          return send(response,201,{staff:await createPlatformStaff(tenants,platform.pools,platform.workforceAccounts,await body(request))});
        }
        const orgMatch=path.match(/^\/v1\/admin\/clients\/([0-9a-f-]{36})$/i);
        if(request.method==='PATCH'&&orgMatch?.[1]) {
          const tenant=tenants.find(item=>item.organizationId===orgMatch[1])??tenants[0]; if(!tenant) throw new AccessError(404);
          return send(response,200,{client:await setOrganizationStatus(tenant,platform.pools,orgMatch[1],await body(request))});
        }
        const userMatch=path.match(/^\/v1\/admin\/access\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i);
        if(request.method==='PATCH'&&userMatch?.[1]&&userMatch[2]) {
          const tenant=tenants.find(item=>item.organizationId===userMatch[1])??tenants[0]; if(!tenant) throw new AccessError(404);
          return send(response,200,{user:await setUserStatus(tenant,platform.pools,userMatch[1],userMatch[2],await body(request))});
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
      if(request.method==='GET' && path==='/v1/patients/search') {
        const search=new URL(request.url??'/',`http://${request.headers.host??'localhost'}`).searchParams.get('q')??'';
        return send(response,200,{patients:await scoped(pool,requestScopeData,()=>searchRoamingPatients(search))});
      }
      if(request.method==='GET' && path==='/v1/appointments') return send(response,200,{appointments:await scoped(pool,requestScopeData,listAppointments)});
      if(request.method==='GET' && path==='/v1/booking-inquiries') return send(response,200,{inquiries:await scoped(pool,requestScopeData,listBookingInquiries)});
      const bookingScheduleMatch=path.match(/^\/v1\/booking-inquiries\/([0-9a-f-]{36})\/schedule$/i);
      if(bookingScheduleMatch?.[1] && request.method==='POST') {
        const payload=await body(request);
        return send(response,200,{appointment:await scoped(pool,requestScopeData,()=>scheduleBookingInquiry(bookingScheduleMatch[1]!,payload))});
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
      return send(response,503,{error:'Service unavailable'});
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
