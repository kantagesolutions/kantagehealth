import { z } from 'zod';
import type { TenantConfig, TenantPoolRegistry } from './tenant-registry.js';

export async function listPlatformClients(tenants:TenantConfig[],pools:TenantPoolRegistry){
  const rows:unknown[]=[]; const seen=new Set<string>();
  for(const tenant of tenants){
    const result=await (await pools.get(tenant)).query('SELECT * FROM clinical.platform_clients()');
    for(const row of result.rows as {organization_id:string}[]) if(!seen.has(row.organization_id)){seen.add(row.organization_id);rows.push(row);}
  }
  return rows;
}
export async function listPlatformAccess(tenants:TenantConfig[],pools:TenantPoolRegistry){
  const rows:unknown[]=[]; const seen=new Set<string>();
  for(const tenant of tenants){
    const result=await (await pools.get(tenant)).query('SELECT * FROM clinical.platform_access()');
    for(const row of result.rows as {organization_id:string;user_id:string}[]){const key=`${row.organization_id}:${row.user_id}`;if(!seen.has(key)){seen.add(key);rows.push(row);}}
  }
  return rows;
}
const orgStatus=z.object({status:z.enum(['active','suspended'])}).strict();
const userStatus=z.object({status:z.enum(['active','inactive'])}).strict();
export async function setOrganizationStatus(tenant:TenantConfig,pools:TenantPoolRegistry,id:string,input:unknown){
  const {status}=orgStatus.parse(input); const organizationId=z.string().uuid().parse(id);
  const result=await (await pools.get(tenant)).query<{updated:boolean}>('SELECT clinical.platform_set_organization_status($1,$2) AS updated',[organizationId,status]);
  return {organizationId,status,updated:Boolean(result.rows[0]?.updated)};
}
export async function setUserStatus(tenant:TenantConfig,pools:TenantPoolRegistry,organizationId:string,userId:string,input:unknown){
  const {status}=userStatus.parse(input); const org=z.string().uuid().parse(organizationId),user=z.string().uuid().parse(userId);
  const result=await (await pools.get(tenant)).query<{updated:boolean}>('SELECT clinical.platform_set_user_status($1,$2,$3) AS updated',[org,user,status]);
  return {organizationId:org,userId:user,status,updated:Boolean(result.rows[0]?.updated)};
}
