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
const orgStatus=z.object({status:z.enum(['active','suspended','archived'])}).strict();
const userStatus=z.object({status:z.enum(['active','inactive','archived'])}).strict();
const orgStatusAction={active:'organizations.activate',suspended:'organizations.suspend',archived:'organizations.archive'} as const;
const userStatusAction={active:'staff.activate',inactive:'staff.deactivate',archived:'staff.archive'} as const;

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
      activity:{action:orgStatusAction[status],organizationId,targetType:'organization',targetId:organizationId,targetLabel:await organizationName(client,organizationId)},
    };
  });
}
const organizationInput=z.object({name:z.string().trim().min(2).max(160)}).strict();
// Corrects an organization's name. Its System ID is permanent and is not editable here.
export async function updateOrganization(tenant:TenantConfig,pools:TenantPoolRegistry,actor:PlatformActor,id:string,input:unknown){
  const {name}=organizationInput.parse(input); const organizationId=z.string().uuid().parse(id);
  return audited(await pools.get(tenant),actor,async client=>{
    const result=await client.query<{previous:string}>('SELECT clinical.platform_update_organization($1,$2) AS previous',[organizationId,name]);
    return {
      result:{organizationId,name},
      activity:{action:'organizations.update',organizationId,targetType:'organization',targetId:organizationId,targetLabel:name,metadata:{previous:{name:result.rows[0]?.previous},next:{name}}},
    };
  });
}
export async function setUserStatus(tenant:TenantConfig,pools:TenantPoolRegistry,actor:PlatformActor,organizationId:string,userId:string,input:unknown){
  const {status}=userStatus.parse(input); const org=z.string().uuid().parse(organizationId),user=z.string().uuid().parse(userId);
  return audited(await pools.get(tenant),actor,async client=>{
    const result=await client.query<{updated:boolean}>('SELECT clinical.platform_set_user_status($1,$2,$3) AS updated',[org,user,status]);
    return {
      result:{organizationId:org,userId:user,status,updated:Boolean(result.rows[0]?.updated)},
      activity:{action:userStatusAction[status],organizationId:org,targetType:'staff',targetId:user,targetLabel:await staffName(client,org,user)},
    };
  });
}
const newClient=z.object({slug:z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),name:z.string().trim().min(2).max(160),clinicName:z.string().trim().min(2).max(160),timezone:z.string().trim().min(2).max(100).default('America/New_York'),address:z.string().trim().max(300).default('')}).strict();
const newStaff=z.object({organizationId:z.string().uuid(),username:z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),email:z.string().email(),name:z.string().trim().min(2).max(160),role:z.enum(assignableRoles),locationId:z.string().uuid().optional()}).strict();
// locationId: one clinic, or null for every clinic in the organization. Left out, the current assignment
// is kept: an edit that never mentions a clinic must not widen anyone's access to every clinic.
const staffUpdate=z.object({name:z.string().trim().min(2).max(160),email:z.string().email(),role:z.enum(assignableRoles),locationId:z.string().uuid().nullable().optional()}).strict();

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
    const locationId=request.locationId!==undefined?request.locationId:(await client.query<{location_id:string|null}>('SELECT location_id FROM clinical.platform_access() WHERE organization_id=$1 AND user_id=$2',[org,user])).rows[0]?.location_id??null;
    const result=await client.query<{previous_name:string;previous_email:string;previous_roles:string[];previous_clinic:string}>('SELECT * FROM clinical.platform_update_staff_profile($1,$2,$3,$4,$5,$6)',[org,user,request.name,request.email,request.role,locationId]);
    const previous=result.rows[0]; if(!previous) throw new Error('Staff member not found');
    const clinic=locationId?(await client.query<{name:string}>('SELECT name FROM clinical.platform_clinics($1) WHERE location_id=$2',[org,locationId])).rows[0]?.name??'':'All clinics';
    return {
      result:{organizationId:org,userId:user,name:request.name,email:request.email.trim().toLowerCase(),role:request.role,locationId,clinic},
      activity:{action:'staff.update',organizationId:org,targetType:'staff',targetId:user,targetLabel:request.name,metadata:{
        previous:{name:previous.previous_name,email:previous.previous_email,roles:previous.previous_roles,clinic:previous.previous_clinic},
        next:{name:request.name,email:request.email.trim().toLowerCase(),role:request.role,clinic},
      }},
    };
  });
}

// What an organization or staff member holds that must be kept. The admin portal reads this before
// offering a delete: nothing to keep means delete permanently, anything kept means archive instead.
export interface OrganizationRecords { staff:number; patients:number; appointments:number; clinicalRecords:number; documents:number; billing:number; bookingRequests:number; activity:number; deletable:boolean; }
export async function organizationRecords(tenant:TenantConfig,pools:TenantPoolRegistry,id:string):Promise<OrganizationRecords>{
  const organizationId=z.string().uuid().parse(id);
  const result=await (await pools.get(tenant)).query<Record<string,string>>('SELECT * FROM clinical.platform_organization_records($1)',[organizationId]);
  const row=result.rows[0]??{};
  const counts={staff:Number(row.staff??0),patients:Number(row.patients??0),appointments:Number(row.appointments??0),clinicalRecords:Number(row.clinical_records??0),documents:Number(row.documents??0),billing:Number(row.billing??0),bookingRequests:Number(row.booking_requests??0),activity:Number(row.activity??0)};
  return {...counts,deletable:Object.values(counts).every(count=>count===0)};
}
export async function staffRecords(tenant:TenantConfig,pools:TenantPoolRegistry,organizationId:string,userId:string){
  const org=z.string().uuid().parse(organizationId),user=z.string().uuid().parse(userId);
  const result=await (await pools.get(tenant)).query<{activity:string}>('SELECT activity FROM clinical.platform_staff_records($1,$2)',[org,user]);
  const activity=Number(result.rows[0]?.activity??0);
  return {activity,deletable:activity===0};
}

// Permanent deletion. The database refuses if anything must be kept, and the organization is removed
// from the tenant registry before commit, so a registry failure leaves everything in place.
export async function deleteOrganization(registry:TenantRegistry,pools:TenantPoolRegistry,actor:PlatformActor,id:string){
  const organizationId=z.string().uuid().parse(id); const [template]=await registry.list();
  if(!template) throw new Error('No configured platform database is available');
  return audited(await pools.get(template),actor,async client=>{
    const result=await client.query<{name:string}>('SELECT clinical.platform_delete_organization($1) AS name',[organizationId]);
    const name=result.rows[0]?.name??'';
    await registry.remove(organizationId);
    // The organization no longer exists, so the entry cannot reference it. Its id and name are kept in
    // the target fields, which have no foreign key, and its earlier entries had their reference cleared.
    return {result:{organizationId,deleted:true},activity:{action:'organizations.delete',organizationId:null,targetType:'organization',targetId:organizationId,targetLabel:name}};
  });
}
export async function deleteStaff(tenant:TenantConfig,pools:TenantPoolRegistry,actor:PlatformActor,organizationId:string,userId:string){
  const org=z.string().uuid().parse(organizationId),user=z.string().uuid().parse(userId);
  return audited(await pools.get(tenant),actor,async client=>{
    const result=await client.query<{name:string}>('SELECT clinical.platform_delete_staff($1,$2) AS name',[org,user]);
    return {result:{organizationId:org,userId:user,deleted:true},activity:{action:'staff.delete',organizationId:org,targetType:'staff',targetId:user,targetLabel:result.rows[0]?.name??''}};
  });
}

// A dental network: one organization, many clinics. Each clinic gets its own booking link in the tenant
// registry, written before commit so a registry failure leaves the clinic uncreated.
const clinicInput=z.object({name:z.string().trim().min(2).max(160),timezone:z.string().trim().min(2).max(100).default('America/New_York'),address:z.string().trim().max(300).default('')}).strict();
const clinicStatus=z.object({status:z.enum(['active','inactive'])}).strict();
export async function listClinics(tenant:TenantConfig,pools:TenantPoolRegistry,organizationId:string){
  const org=z.string().uuid().parse(organizationId);
  const result=await (await pools.get(tenant)).query('SELECT * FROM clinical.platform_clinics($1)',[org]);
  return result.rows;
}
export async function createClinic(registry:TenantRegistry,pools:TenantPoolRegistry,actor:PlatformActor,organizationId:string,input:unknown){
  const org=z.string().uuid().parse(organizationId); const request=clinicInput.parse(input);
  const tenant=(await registry.list()).find(item=>item.organizationId===org); if(!tenant) throw new Error('Organization is not connected');
  return audited(await pools.get(tenant),actor,async client=>{
    const result=await client.query<{location_id:string;clinic_name:string}>('SELECT * FROM clinical.platform_create_location($1,$2,$3,$4)',[org,request.name,request.timezone,request.address]);
    const created=result.rows[0]; if(!created) throw new Error('Clinic could not be created');
    const key=randomBytes(32).toString('base64url');
    await registry.addBookingClinic(org,{key,locationId:created.location_id,clinicName:created.clinic_name,timezone:request.timezone});
    return {
      result:{organizationId:org,locationId:created.location_id,name:created.clinic_name,bookingUrl:`/v1/public/booking/${key}`},
      activity:{action:'clinics.create',organizationId:org,targetType:'clinic',targetId:created.location_id,targetLabel:created.clinic_name},
    };
  });
}
export async function updateClinic(registry:TenantRegistry,pools:TenantPoolRegistry,actor:PlatformActor,organizationId:string,locationId:string,input:unknown){
  const org=z.string().uuid().parse(organizationId),loc=z.string().uuid().parse(locationId); const request=clinicInput.parse(input);
  const tenant=(await registry.list()).find(item=>item.organizationId===org); if(!tenant) throw new Error('Organization is not connected');
  return audited(await pools.get(tenant),actor,async client=>{
    const result=await client.query<{previous_name:string;previous_timezone:string;previous_address:string}>('SELECT * FROM clinical.platform_update_location($1,$2,$3,$4,$5)',[org,loc,request.name,request.timezone,request.address]);
    const previous=result.rows[0]; if(!previous) throw new Error('Clinic not found');
    // Keep the public booking page in step with the new name and timezone.
    if(tenant.bookingClinics.some(item=>item.locationId===loc)) await registry.updateBookingClinic(org,loc,{clinicName:request.name,timezone:request.timezone});
    return {
      result:{organizationId:org,locationId:loc,...request},
      activity:{action:'clinics.update',organizationId:org,targetType:'clinic',targetId:loc,targetLabel:request.name,metadata:{previous:{name:previous.previous_name,timezone:previous.previous_timezone,address:previous.previous_address},next:request}},
    };
  });
}
export async function setClinicStatus(tenant:TenantConfig,pools:TenantPoolRegistry,actor:PlatformActor,organizationId:string,locationId:string,input:unknown){
  const org=z.string().uuid().parse(organizationId),loc=z.string().uuid().parse(locationId); const {status}=clinicStatus.parse(input);
  return audited(await pools.get(tenant),actor,async client=>{
    const result=await client.query<{name:string}>('SELECT clinical.platform_set_location_status($1,$2,$3) AS name',[org,loc,status]);
    return {result:{organizationId:org,locationId:loc,status},activity:{action:status==='active'?'clinics.activate':'clinics.deactivate',organizationId:org,targetType:'clinic',targetId:loc,targetLabel:result.rows[0]?.name??''}};
  });
}
