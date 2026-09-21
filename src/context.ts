import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
export type Role='owner'|'clinician'|'front_desk'|'billing'|'auditor';
export class AccessError extends Error { constructor(public status:number, message='Access denied'){super(message);} }
export interface Scope { organizationId:string; locationId:string; sub:string; ip?:string; userAgent:string; }
interface Context extends Scope { client:PoolClient; userId:string; roles:Role[]; }
const storage=new AsyncLocalStorage<Context>();
export function context(){const ctx=storage.getStore(); if(!ctx) throw new AccessError(403); return ctx;}
export function query<T extends QueryResultRow>(sql:string,values:unknown[]=[]){return context().client.query<T>(sql,values);}
export function requireRole(...allowed:Role[]){const c=context(); if(!c.roles.some(r=>allowed.includes(r))) throw new AccessError(403); return c;}
export async function scoped<T>(pool:Pool, scope:Scope, work:()=>Promise<T>):Promise<T>{
 const client=await pool.connect();
 let transactionOpen=false;
 let releaseError:Error|undefined;
 try {
  await client.query('BEGIN');
  transactionOpen=true;
  await client.query("SELECT set_config('app.current_org',$1,true),set_config('app.current_location',$2,true),set_config('app.actor_sub',$3,true)",[scope.organizationId,scope.locationId,scope.sub]);
  const access=await client.query<{id:string;roles:Role[]}>(`SELECT u.id,array_agg(r.role) AS roles FROM clinical.users u JOIN clinical.user_roles r ON r.user_id=u.id AND r.organization_id=u.organization_id JOIN clinical.organizations o ON o.id=u.organization_id JOIN clinical.locations l ON l.organization_id=o.id AND l.id=$1 WHERE u.status='active' AND o.status='active' AND l.status='active' AND (r.location_id IS NULL OR r.location_id=l.id) GROUP BY u.id`,[scope.locationId]);
  const actor=access.rows[0]; if(!actor) throw new AccessError(403);
  const result=await storage.run({...scope,client,userId:actor.id,roles:actor.roles},work);
  await client.query('COMMIT');
  transactionOpen=false;
  return result;
 } catch(error) {
 if(transactionOpen) {
   try { await client.query('ROLLBACK'); }
   catch(rollbackError) { releaseError=rollbackError as Error; }
  }
  throw error;
 } finally { client.release(releaseError); }
}
export async function audit(action:string,subjectType:string,subjectId:string|null=null){
 const c=context();
 await query('INSERT INTO clinical.audit_log(organization_id,location_id,actor_user_id,actor_role,action,subject_type,subject_id,ip,user_agent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[c.organizationId,c.locationId,c.userId,c.roles.join(','),action,subjectType,subjectId,c.ip||null,c.userAgent.slice(0,256)]);
}
