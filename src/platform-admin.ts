import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { TenantConfig, TenantPoolRegistry, TenantRegistry } from './tenant-registry.js';
import type { WorkforceAccountProvisioner } from './workforce-accounts.js';

export async function listPlatformClients(tenants:TenantConfig[],pools:TenantPoolRegistry){
  const rows:unknown[]=[]; const seen=new Set<string>();
  for(const tenant of tenants){
    const result=await (await pools.get(tenant)).query('SELECT * FROM clinical.platform_clients()');
    for(const row of result.rows as {organization_id:string}[]) if(!seen.has(row.organization_id)){seen.add(row.organization_id);rows.push(row);}
  }
  return rows;
}
export async function listPlatformActivity(tenants:TenantConfig[],pools:TenantPoolRegistry){
  const [tenant]=tenants; if(!tenant) return [];
  const result=await (await pools.get(tenant)).query<{organization_name:string;location_name:string|null;action:string;occurred_at:string}>('SELECT * FROM clinical.platform_activity()');
  return result.rows;
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
const newClient=z.object({slug:z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),name:z.string().trim().min(2).max(160),clinicName:z.string().trim().min(2).max(160),timezone:z.string().trim().min(2).max(100).default('America/New_York'),address:z.string().trim().max(300).default('')}).strict();
const newStaff=z.object({organizationId:z.string().uuid(),username:z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),email:z.string().email(),name:z.string().trim().min(2).max(160),role:z.enum(['owner','clinician','front_desk','billing','auditor']),locationId:z.string().uuid().optional()}).strict();

export async function createPlatformClient(registry:TenantRegistry,pools:TenantPoolRegistry,input:unknown){
  const request=newClient.parse(input); const [template]=await registry.list();
  if(!template) throw new Error('No configured platform database is available');
  const result=await (await pools.get(template)).query<{organization_id:string;location_id:string;organization_name:string;clinic_name:string}>(
    'SELECT * FROM clinical.platform_create_organization($1,$2,$3,$4,$5)',[request.slug,request.name,request.clinicName,request.timezone,request.address],
  );
  const created=result.rows[0]; if(!created) throw new Error('Organization could not be created');
  const tenant:TenantConfig={organizationId:created.organization_id,databaseSecretArn:template.databaseSecretArn,documentsBucket:template.documentsBucket,staffUserPoolId:template.staffUserPoolId,staffClientId:template.staffClientId,staffClientIds:template.staffClientIds,bookingClinics:[{key:randomBytes(32).toString('base64url'),locationId:created.location_id,clinicName:created.clinic_name,timezone:request.timezone}]};
  await registry.add(tenant);
  return {organizationId:created.organization_id,locationId:created.location_id,name:created.organization_name,clinicName:created.clinic_name,bookingUrl:`/v1/public/booking/${tenant.bookingClinics[0]!.key}`};
}

export async function createPlatformStaff(tenants:TenantConfig[],pools:TenantPoolRegistry,accounts:WorkforceAccountProvisioner,input:unknown){
  const request=newStaff.parse(input); const tenant=tenants.find(item=>item.organizationId===request.organizationId); if(!tenant) throw new Error('Organization is not connected');
  const account=await accounts.invite({username:request.username,email:request.email,name:request.name});
  const result=await (await pools.get(tenant)).query<{user_id:string}>('SELECT * FROM clinical.platform_create_staff($1,$2,$3,$4,$5,$6)',[request.organizationId,account.username,request.email,request.name,request.role,request.locationId??null]);
  return {userId:result.rows[0]?.user_id,username:account.username};
}
