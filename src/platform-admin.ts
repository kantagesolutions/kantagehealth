import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { TenantConfig, TenantPoolRegistry, TenantRegistry } from './tenant-registry.js';
import type { WorkforceAccountProvisioner } from './workforce-accounts.js';

// Every role defined in clinical.role_capabilities except vendor support, which is only ever granted
// through an audited support session. Mirrors clinical.assignable_role in migration 015.
export const assignableRoles=['organization_owner','owner','clinic_administrator','provider','clinician','hygienist_assistant','front_desk','billing_specialist','billing','auditor'] as const;

export interface PlatformActor { username:string; }
interface PlatformActivity { action:string; organizationId:string|null; targetType:'organization'|'clinic'|'staff'; targetId:string|null; targetLabel:string; metadata?:Record<string,unknown>; }

// Runs an administrator change and its audit entry in one transaction, so an action can never land
// without its record, and a failed record undoes the action.
async function audited<T>(pool:Pool,actor:PlatformActor,work:(client:PoolClient)=>Promise<{result:T;activity:PlatformActivity}>):Promise<T>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {result,activity}=await work(client);
    await client.query('SELECT clinical.platform_record_activity($1,$2,$3,$4,$5,$6,$7)',[actor.username,activity.action,activity.organizationId,activity.targetType,activity.targetId,activity.targetLabel,JSON.stringify(activity.metadata??{})]);
    await client.query('COMMIT');
    return result;
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally { client.release(); }
}

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
  const result=await (await pools.get(tenant)).query<{organization_name:string;location_name:string|null;action:string;occurred_at:string;source:'staff'|'admin';actor_name:string;actor_role:string;target_label:string}>('SELECT * FROM clinical.platform_activity()');
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

// Names for the audit trail come from the definer listing functions, because the request role
// cannot read these tables directly without a tenant scope.
async function organizationName(client:PoolClient,organizationId:string){
  const result=await client.query<{name:string}>('SELECT name FROM clinical.platform_clients() WHERE organization_id=$1',[organizationId]);
  return result.rows[0]?.name??'';
}
async function staffName(client:PoolClient,organizationId:string,userId:string){
  const result=await client.query<{name:string}>('SELECT name FROM clinical.platform_access() WHERE organization_id=$1 AND user_id=$2',[organizationId,userId]);
  return result.rows[0]?.name??'';
}

export async function setOrganizationStatus(tenant:TenantConfig,pools:TenantPoolRegistry,actor:PlatformActor,id:string,input:unknown){
  const {status}=orgStatus.parse(input); const organizationId=z.string().uuid().parse(id);
  return audited(await pools.get(tenant),actor,async client=>{
    const result=await client.query<{updated:boolean}>('SELECT clinical.platform_set_organization_status($1,$2) AS updated',[organizationId,status]);
    return {
      result:{organizationId,status,updated:Boolean(result.rows[0]?.updated)},
      activity:{action:status==='active'?'organizations.activate':'organizations.suspend',organizationId,targetType:'organization',targetId:organizationId,targetLabel:await organizationName(client,organizationId)},
    };
  });
}
export async function setUserStatus(tenant:TenantConfig,pools:TenantPoolRegistry,actor:PlatformActor,organizationId:string,userId:string,input:unknown){
  const {status}=userStatus.parse(input); const org=z.string().uuid().parse(organizationId),user=z.string().uuid().parse(userId);
  return audited(await pools.get(tenant),actor,async client=>{
    const result=await client.query<{updated:boolean}>('SELECT clinical.platform_set_user_status($1,$2,$3) AS updated',[org,user,status]);
    return {
      result:{organizationId:org,userId:user,status,updated:Boolean(result.rows[0]?.updated)},
      activity:{action:status==='active'?'staff.activate':'staff.deactivate',organizationId:org,targetType:'staff',targetId:user,targetLabel:await staffName(client,org,user)},
    };
  });
}
const newClient=z.object({slug:z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),name:z.string().trim().min(2).max(160),clinicName:z.string().trim().min(2).max(160),timezone:z.string().trim().min(2).max(100).default('America/New_York'),address:z.string().trim().max(300).default('')}).strict();
const newStaff=z.object({organizationId:z.string().uuid(),username:z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),email:z.string().email(),name:z.string().trim().min(2).max(160),role:z.enum(assignableRoles),locationId:z.string().uuid().optional()}).strict();
const staffUpdate=z.object({name:z.string().trim().min(2).max(160),email:z.string().email(),role:z.enum(assignableRoles)}).strict();

export async function createPlatformClient(registry:TenantRegistry,pools:TenantPoolRegistry,actor:PlatformActor,input:unknown){
  const request=newClient.parse(input); const [template]=await registry.list();
  if(!template) throw new Error('No configured platform database is available');
  return audited(await pools.get(template),actor,async client=>{
    const result=await client.query<{organization_id:string;location_id:string;organization_name:string;clinic_name:string}>(
      'SELECT * FROM clinical.platform_create_organization($1,$2,$3,$4,$5)',[request.slug,request.name,request.clinicName,request.timezone,request.address],
    );
    const created=result.rows[0]; if(!created) throw new Error('Organization could not be created');
    const tenant:TenantConfig={organizationId:created.organization_id,databaseSecretArn:template.databaseSecretArn,documentsBucket:template.documentsBucket,staffUserPoolId:template.staffUserPoolId,staffClientId:template.staffClientId,staffClientIds:template.staffClientIds,bookingClinics:[{key:randomBytes(32).toString('base64url'),locationId:created.location_id,clinicName:created.clinic_name,timezone:request.timezone}]};
    // The registry write happens before commit: if it fails, the organization is rolled back rather
    // than left in the database where the platform cannot see it.
    await registry.add(tenant);
    return {
      result:{organizationId:created.organization_id,locationId:created.location_id,name:created.organization_name,clinicName:created.clinic_name,bookingUrl:`/v1/public/booking/${tenant.bookingClinics[0]!.key}`},
      activity:{action:'organizations.create',organizationId:created.organization_id,targetType:'organization',targetId:created.organization_id,targetLabel:created.organization_name,metadata:{slug:request.slug,firstClinic:created.clinic_name}},
    };
  });
}

export async function createPlatformStaff(tenants:TenantConfig[],pools:TenantPoolRegistry,accounts:WorkforceAccountProvisioner,actor:PlatformActor,input:unknown){
  const request=newStaff.parse(input); const tenant=tenants.find(item=>item.organizationId===request.organizationId); if(!tenant) throw new Error('Organization is not connected');
  const account=await accounts.invite({username:request.username,email:request.email,name:request.name});
  return audited(await pools.get(tenant),actor,async client=>{
    const result=await client.query<{user_id:string}>('SELECT * FROM clinical.platform_create_staff($1,$2,$3,$4,$5,$6)',[request.organizationId,account.username,request.email,request.name,request.role,request.locationId??null]);
    const userId=result.rows[0]?.user_id??null;
    return {
      result:{userId,username:account.username},
      activity:{action:'staff.invite',organizationId:request.organizationId,targetType:'staff',targetId:userId,targetLabel:account.username,metadata:{role:request.role}},
    };
  });
}

export async function updatePlatformStaff(tenant:TenantConfig,pools:TenantPoolRegistry,actor:PlatformActor,organizationId:string,userId:string,input:unknown){
  const request=staffUpdate.parse(input); const org=z.string().uuid().parse(organizationId),user=z.string().uuid().parse(userId);
  return audited(await pools.get(tenant),actor,async client=>{
    const result=await client.query<{previous_name:string;previous_email:string;previous_roles:string[]}>('SELECT * FROM clinical.platform_update_staff($1,$2,$3,$4,$5)',[org,user,request.name,request.email,request.role]);
    const previous=result.rows[0]; if(!previous) throw new Error('Staff member not found');
    return {
      result:{organizationId:org,userId:user,name:request.name,email:request.email.trim().toLowerCase(),role:request.role},
      activity:{action:'staff.update',organizationId:org,targetType:'staff',targetId:user,targetLabel:request.name,metadata:{
        previous:{name:previous.previous_name,email:previous.previous_email,roles:previous.previous_roles},
        next:{name:request.name,email:request.email.trim().toLowerCase(),role:request.role},
      }},
    };
  });
}
