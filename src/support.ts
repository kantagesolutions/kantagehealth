import { z } from 'zod';
import { AccessError, audit, context, query, requireCapability } from './context.js';

const requestInput=z.object({supportUserSub:z.string().trim().min(1).max(255),reason:z.string().trim().min(10).max(1000),expiresInMinutes:z.number().int().min(15).max(480)}).strict();

export async function requestSupportAccess(input:unknown){
  const c=requireCapability('organization.manage');
  const value=requestInput.parse(input);
  const result=await query<{id:string}>('INSERT INTO clinical.support_access_sessions(organization_id,location_id,requested_by_user_id,support_user_sub,reason,expires_at) VALUES($1,$2,$3,$4,$5,now()+($6::text||\' minutes\')::interval) RETURNING id',[c.organizationId,c.locationId,c.userId,value.supportUserSub,value.reason,value.expiresInMinutes]);
  const id=result.rows[0]!.id;
  await audit('support.requested','support_access_session',id);
  return {id,status:'requested'};
}

export async function approveMySupportAccess(id:string){
  const c=requireCapability('support.break_glass');
  const result=await query<{id:string}>('UPDATE clinical.support_access_sessions SET status=\'approved\',starts_at=now() WHERE id=$1 AND support_user_sub=$2 AND status=\'requested\' AND expires_at>now() RETURNING id',[id,c.sub]);
  if(!result.rowCount) throw new AccessError(404,'Not found');
  await audit('support.approved','support_access_session',id);
  return {id,status:'approved'};
}

export async function listSupportAccess(){
  requireCapability('organization.manage','support.break_glass');
  const c=context();
  const result=await query('SELECT id,location_id,support_user_sub,reason,status,starts_at,expires_at,created_at FROM clinical.support_access_sessions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100',[c.organizationId]);
  await audit('support.list','support_access_session');
  return result.rows;
}
