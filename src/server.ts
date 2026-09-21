import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z, ZodError } from 'zod';
import { AccessError, scoped } from './context.js';
import { createAppointment, listAppointments } from './appointments.js';
import { createCareRecord, createPatient, listCareRecords, listPatients, readPatient } from './patients.js';
import { createPaymentRecord, listPayments } from './payments.js';
import { approveMySupportAccess, listSupportAccess, requestSupportAccess } from './support.js';
import type { TokenVerifier } from './auth.js';
import { staffVerifier, verifyStaffToken } from './auth.js';
import { productionRegistry, TenantPoolRegistry, type TenantConfig, type TenantRegistry } from './tenant-registry.js';

const requestScope=z.object({organizationId:z.string().uuid(),locationId:z.string().uuid()});
interface Platform { registry:TenantRegistry; pools:TenantPoolRegistry; verifierFor(tenant:TenantConfig):TokenVerifier; }

function send(response:ServerResponse,status:number,body:unknown){
  response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});
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

export function createHealthcareServer(platform:Platform):Server {
  return createServer(async(request,response)=>{
    try {
      if(request.method==='GET' && request.url==='/healthz') return send(response,200,{status:'ok'});
      const scope=requestScope.parse({organizationId:request.headers['x-kantage-organization'],locationId:request.headers['x-kantage-location']});
      const bearer=token(request);
      const tenant=await platform.registry.get(scope.organizationId);
      const claims=await verifyStaffToken(bearer,{userPoolId:tenant.staffUserPoolId,clientId:tenant.staffClientId},platform.verifierFor(tenant));
      const pool=await platform.pools.get(tenant);
      const requestScopeData={...scope,sub:claims.sub,ip:remoteIp(request),userAgent:String(request.headers['user-agent']??'').slice(0,256)};
      const path=(request.url??'/').split('?')[0] ?? '/';
      if(request.method==='GET' && path==='/v1/patients') return send(response,200,{patients:await scoped(pool,requestScopeData,listPatients)});
      if(request.method==='GET' && path==='/v1/appointments') return send(response,200,{appointments:await scoped(pool,requestScopeData,listAppointments)});
      if(request.method==='POST' && path==='/v1/appointments') {
        const payload=await body(request);
        return send(response,201,{appointment:await scoped(pool,requestScopeData,()=>createAppointment(payload))});
      }
      if(request.method==='GET' && path==='/v1/payments') return send(response,200,{payments:await scoped(pool,requestScopeData,listPayments)});
      if(request.method==='POST' && path==='/v1/payments') {
        const payload=await body(request);
        return send(response,201,{payment:await scoped(pool,requestScopeData,()=>createPaymentRecord(payload))});
      }
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
  const server=createHealthcareServer({registry:productionRegistry(),pools,verifierFor:tenant=>staffVerifier({userPoolId:tenant.staffUserPoolId,clientId:tenant.staffClientId})});
  server.listen(port,'0.0.0.0',()=>console.info(`Kantage Healthcare API listening on ${port}`));
  const stop=()=>server.close(()=>pools.close().finally(()=>process.exit(0)));
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
}
