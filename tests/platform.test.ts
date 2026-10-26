// Covers the modules behind the October 2026 outage and the administrator workflows built after it:
// the tenant registry, workforce invitations, staff workspace discovery and audited platform changes.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { createPlatformClient, deleteOrganization, deleteStaff, listPlatformActivity, organizationRecords, setOrganizationStatus, setUserStatus, staffRecords, updatePlatformStaff } from '../src/platform-admin.js';
import { createPublicBookingInquiry } from '../src/public-booking.js';
import { registrySecretIdFrom, TenantRegistry, type TenantConfig } from '../src/tenant-registry.js';
import { CognitoWorkforceAccountProvisioner } from '../src/workforce-accounts.js';
import { listStaffWorkspaces } from '../src/workspaces.js';

const connectionString=process.env.TEST_DATABASE_URL ?? 'postgresql://venuscollective@127.0.0.1:55439/kantage_healthcare_test';
// The platform functions are SECURITY DEFINER, so they are exercised as the restricted request role.
const appPool=new Pool({connectionString:connectionString.replace(/\/\/[^@]+@/,'//kh_test_request@'),max:4,idleTimeoutMillis:1_000});
const pools={get:async()=>appPool} as never;
const actor={username:'test.admin'};
const run=randomUUID().slice(0,8);
const orgId=randomUUID(), clinicA=randomUUID(), clinicB=randomUUID(), staffId=randomUUID();
const tenant={organizationId:orgId,databaseSecretArn:'arn:test:db',documentsBucket:'test-bucket',staffUserPoolId:'pool',staffClientId:'client',bookingClinics:[]} as TenantConfig;

function secretsClient(initial:{tenants:unknown[]}) {
  const sent:{name:string;input:Record<string,unknown>}[]=[];
  let stored=JSON.stringify(initial);
  return {
    sent,
    client:{send:async(command:{constructor:{name:string};input:Record<string,unknown>})=>{
      sent.push({name:command.constructor.name,input:command.input});
      if(command.constructor.name==='PutSecretValueCommand') { stored=String(command.input.SecretString); return {}; }
      return {SecretString:stored};
    }},
  };
}

function cognitoClient(existing:boolean) {
  const commands:string[]=[];
  return {
    commands,
    client:{send:async(command:{constructor:{name:string}})=>{
      const name=command.constructor.name; commands.push(name);
      if(name==='AdminCreateUserCommand' && existing) { const error=new Error('User account already exists'); error.name='UsernameExistsException'; throw error; }
      if(name==='AdminCreateUserCommand') return {User:{Username:'new.person'}};
      if(name==='AdminGetUserCommand') return {Username:'existing.person'};
      return {};
    }},
  };
}

before(async()=>{
  const root=new Client({connectionString}); await root.connect();
  try {
    await root.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kh_test_request') THEN CREATE ROLE kh_test_request LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$");
    await root.query('GRANT kh_request TO kh_test_request');
    await root.query('INSERT INTO clinical.organizations(id,slug,name,status) VALUES($1,$2,$3,$4)',[orgId,`platform-${run}`,'Platform Test Org','active']);
    await root.query('INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status) VALUES($1,$3,$4,$5,$6,$7),($2,$3,$8,$5,$6,$7)',[clinicA,clinicB,orgId,'Clinic A','America/New_York','','active','Clinic B']);
    await root.query('INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES($1,$2,$3,$4,$5,$6)',[staffId,orgId,`staff.${run}`,`staff.${run}@example.test`,'Original Name','active']);
    await root.query('INSERT INTO clinical.user_roles(organization_id,user_id,role) VALUES($1,$2,$3)',[orgId,staffId,'organization_owner']);
  } finally { await root.end(); }
});
after(async()=>{ await appPool.end(); });

async function auditRows(organizationId:string) {
  const root=new Client({connectionString}); await root.connect();
  try { return (await root.query<{actor:string;action:string;target_label:string;metadata:Record<string,unknown>}>('SELECT actor,action,target_label,metadata FROM clinical.platform_audit_log WHERE organization_id=$1 ORDER BY id',[organizationId])).rows; }
  finally { await root.end(); }
}

test('the registry variable must name the secret, never contain it',()=>{
  const arn='arn:aws:secretsmanager:us-east-1:438064565992:secret:kantage-healthcare-production-tenant-registry-ysCuc8';
  assert.equal(registrySecretIdFrom(arn),arn);
  assert.equal(registrySecretIdFrom('kantage-healthcare-production-tenant-registry'),'kantage-healthcare-production-tenant-registry');
  // The production outage: ECS resolved the secret and handed the API its JSON contents.
  assert.throws(()=>registrySecretIdFrom('{"tenants":[{"organizationId":"92dccdff-7946-49de-a359-2ad9151c8b84"}]}'),/not its contents/);
  assert.throws(()=>registrySecretIdFrom(undefined),/is required/);
});

test('the registry asks Secrets Manager for the configured identifier',async()=>{
  const secrets=secretsClient({tenants:[]});
  await new TenantRegistry(secrets.client as never,'registry-id').list();
  assert.equal(secrets.sent[0]?.name,'GetSecretValueCommand');
  assert.equal(secrets.sent[0]?.input.SecretId,'registry-id');
});

test('the registry appends a new organization and refuses a duplicate',async()=>{
  const secrets=secretsClient({tenants:[]});
  const registry=new TenantRegistry(secrets.client as never,'registry-id');
  await registry.add(tenant);
  const written=JSON.parse(String(secrets.sent.find(item=>item.name==='PutSecretValueCommand')?.input.SecretString));
  assert.equal(written.tenants.length,1);
  assert.equal(written.tenants[0].organizationId,orgId);
  await assert.rejects(registry.add(tenant),/already connected/);
});

test('inviting a new staff member creates the account, which sends the invitation email',async()=>{
  const cognito=cognitoClient(false);
  const result=await new CognitoWorkforceAccountProvisioner(cognito.client as never,'pool').invite({username:'New.Person',email:'new@example.test',name:'New Person'});
  assert.equal(result.username,'new.person');
  assert.deepEqual(cognito.commands,['AdminCreateUserCommand','AdminAddUserToGroupCommand']);
});

test('inviting an existing staff member only adds the group and sends no email',async()=>{
  const cognito=cognitoClient(true);
  const result=await new CognitoWorkforceAccountProvisioner(cognito.client as never,'pool').invite({username:'existing.person',email:'e@example.test',name:'Existing Person'});
  assert.equal(result.username,'existing.person');
  // The create call fails as a duplicate, so Cognito never sends a new invitation.
  assert.deepEqual(cognito.commands,['AdminCreateUserCommand','AdminGetUserCommand','AdminAddUserToGroupCommand']);
});

test('a staff member with no clinic restriction sees every active clinic, matched by username',async()=>{
  const workspaces=await listStaffWorkspaces(appPool,orgId,[`staff.${run}`,'unrelated-sub']);
  assert.deepEqual(workspaces.map(item=>item.locationName).sort(),['Clinic A','Clinic B']);
  assert.deepEqual(await listStaffWorkspaces(appPool,orgId,['nobody-at-all']),[]);
});

test('editing staff replaces the role and records who changed what',async()=>{
  const result=await updatePlatformStaff(tenant,pools,actor,orgId,staffId,{name:'Edited Name',email:'Edited@Example.test',role:'front_desk'});
  assert.equal(result.email,'edited@example.test');
  const rows=await auditRows(orgId);
  const entry=rows.find(row=>row.action==='staff.update');
  assert.equal(entry?.actor,'test.admin');
  assert.equal(entry?.target_label,'Edited Name');
  assert.deepEqual((entry?.metadata.previous as {roles:string[]}).roles,['organization_owner']);
  assert.equal((entry?.metadata.next as {role:string}).role,'front_desk');
  // The old role is gone, not kept alongside the new one.
  const workspaces=await listStaffWorkspaces(appPool,orgId,[`staff.${run}`]);
  assert.deepEqual(workspaces[0]?.roles,['front_desk']);
});

test('editing staff rejects vendor support and invented roles',async()=>{
  await assert.rejects(updatePlatformStaff(tenant,pools,actor,orgId,staffId,{name:'Edited Name',email:'e@example.test',role:'kantage_support' as never}));
  await assert.rejects(updatePlatformStaff(tenant,pools,actor,orgId,staffId,{name:'Edited Name',email:'e@example.test',role:'made_up' as never}));
});

test('removing access is recorded against the administrator',async()=>{
  await setUserStatus(tenant,pools,actor,orgId,staffId,{status:'inactive'});
  const entry=(await auditRows(orgId)).find(row=>row.action==='staff.deactivate');
  assert.equal(entry?.actor,'test.admin');
  assert.equal(entry?.target_label,'Edited Name');
  await setUserStatus(tenant,pools,actor,orgId,staffId,{status:'active'});
});

test('an organization whose registry write fails is rolled back, leaving nothing behind',async()=>{
  const slug=`rollback-${run}`;
  const failingRegistry={list:async()=>[tenant],add:async()=>{ throw new Error('AccessDeniedException'); }};
  await assert.rejects(createPlatformClient(failingRegistry as never,pools,actor,{slug,name:'Rollback Org',clinicName:'Rollback Clinic'}),/AccessDenied/);
  const root=new Client({connectionString}); await root.connect();
  try {
    assert.equal((await root.query('SELECT 1 FROM clinical.organizations WHERE slug=$1',[slug])).rowCount,0);
    assert.equal((await root.query("SELECT 1 FROM clinical.platform_audit_log WHERE action='organizations.create' AND metadata->>'slug'=$1",[slug])).rowCount,0);
  } finally { await root.end(); }
});

test('a new organization and its audit entry are committed together',async()=>{
  const slug=`created-${run}`; let registered:TenantConfig|undefined;
  const registry={list:async()=>[tenant],add:async(entry:TenantConfig)=>{ registered=entry; }};
  const result=await createPlatformClient(registry as never,pools,actor,{slug,name:'Created Org',clinicName:'Created Clinic'});
  assert.equal(registered?.organizationId,result.organizationId);
  const entry=(await auditRows(result.organizationId)).find(row=>row.action==='organizations.create');
  assert.equal(entry?.actor,'test.admin');
  assert.equal(entry?.target_label,'Created Org');
});

// Lifecycle: deleting is permanent only when nothing must be kept; anything else is archived.

test('an empty organization is deleted permanently, its registry entry removed, and the deletion audited',async()=>{
  let removed:string|undefined;
  const registry={list:async()=>[tenant],add:async()=>undefined,remove:async(id:string)=>{ removed=id; }};
  const created=await createPlatformClient(registry as never,pools,actor,{slug:`empty-${run}`,name:'Empty Org',clinicName:'Empty Clinic'});
  assert.equal((await organizationRecords(tenant,pools,created.organizationId)).deletable,true);
  await deleteOrganization(registry as never,pools,actor,created.organizationId);
  assert.equal(removed,created.organizationId);
  const root=new Client({connectionString}); await root.connect();
  try {
    assert.equal((await root.query('SELECT 1 FROM clinical.organizations WHERE id=$1',[created.organizationId])).rowCount,0);
    // The creation entry survives with its reference cleared, and the deletion itself is recorded.
    const entries=(await root.query<{action:string;organization_id:string|null;target_label:string}>('SELECT action,organization_id,target_label FROM clinical.platform_audit_log WHERE target_id=$1 ORDER BY id',[created.organizationId])).rows;
    assert.deepEqual(entries.map(entry=>entry.action),['organizations.create','organizations.delete']);
    assert.ok(entries.every(entry=>entry.organization_id===null && entry.target_label==='Empty Org'));
  } finally { await root.end(); }
});

test('an organization with records cannot be deleted, keeps its registry entry, and can be archived and restored',async()=>{
  let removed=false;
  const registry={list:async()=>[tenant],remove:async()=>{ removed=true; }};
  // The fixture organization has staff, so it must be kept.
  assert.equal((await organizationRecords(tenant,pools,orgId)).deletable,false);
  await assert.rejects(deleteOrganization(registry as never,pools,actor,orgId),/must be kept/);
  assert.equal(removed,false);
  await setOrganizationStatus(tenant,pools,actor,orgId,{status:'archived'});
  assert.equal((await auditRows(orgId)).at(-1)?.action,'organizations.archive');
  await setOrganizationStatus(tenant,pools,actor,orgId,{status:'active'});
  assert.equal((await auditRows(orgId)).at(-1)?.action,'organizations.activate');
});

test('a staff member who never acted is deleted; one with activity can only be archived',async()=>{
  const root=new Client({connectionString}); await root.connect();
  const idle=randomUUID(), busy=randomUUID();
  try {
    await root.query('INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES($1,$3,$4,$5,$6,$7),($2,$3,$8,$9,$10,$7)',[idle,busy,orgId,`idle.${run}`,`idle.${run}@example.test`,'Idle Person','active',`busy.${run}`,`busy.${run}@example.test`,'Busy Person']);
    await root.query('INSERT INTO clinical.user_roles(organization_id,user_id,role) VALUES($1,$2,$3),($1,$4,$3)',[orgId,idle,'front_desk',busy]);
    await root.query('INSERT INTO clinical.audit_log(organization_id,location_id,actor_user_id,actor_role,action,subject_type) VALUES($1,$2,$3,$4,$5,$6)',[orgId,clinicA,busy,'front_desk','patients.read','patient']);
  } finally { await root.end(); }
  assert.equal((await staffRecords(tenant,pools,orgId,idle)).deletable,true);
  assert.equal((await staffRecords(tenant,pools,orgId,busy)).deletable,false);
  await deleteStaff(tenant,pools,actor,orgId,idle);
  await assert.rejects(deleteStaff(tenant,pools,actor,orgId,busy),/must be kept/);
  const check=new Client({connectionString}); await check.connect();
  try {
    assert.equal((await check.query('SELECT 1 FROM clinical.users WHERE id=$1',[idle])).rowCount,0);
    assert.equal((await check.query('SELECT 1 FROM clinical.audit_log WHERE actor_user_id=$1',[busy])).rowCount,1);
  } finally { await check.end(); }
  assert.ok((await auditRows(orgId)).some(row=>row.action==='staff.delete' && row.target_label==='Idle Person'));
});

test('a website booking appears in the activity feed without any patient detail',async()=>{
  const patient={firstName:'Zephyrine',lastName:'Quillfeather',phone:'410-555-0177',email:`zephyrine.${run}@example.test`,message:`Distinctive note ${run} about a cracked molar`};
  await createPublicBookingInquiry(appPool,{organizationId:orgId,locationId:clinicA,clinicName:'Clinic A',timezone:'America/New_York'},{...patient,appointmentType:'Emergency dentistry',preferredContact:'email'},{userAgent:'healthcare-test'});
  const activity=await listPlatformActivity([tenant],pools);
  const arrival=activity.find(row=>row.action==='bookings.received' && row.organization_name==='Platform Test Org');
  assert.ok(arrival,'booking arrival is in the feed');
  assert.equal(arrival?.source,'website');
  assert.equal(arrival?.location_name,'Clinic A');
  // Nothing identifying, nor the type of care or the message, may appear anywhere in the feed.
  const everything=JSON.stringify(activity);
  for(const detail of [patient.firstName,patient.lastName,patient.phone,patient.email,patient.message,'cracked molar','Emergency dentistry']) {
    assert.equal(everything.includes(detail),false,`feed must not contain "${detail}"`);
  }
});
