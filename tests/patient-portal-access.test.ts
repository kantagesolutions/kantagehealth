// Staff enable and reset a patient's portal login. Runs against a real database as the restricted role.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { scoped } from '../src/context.js';
import { createHealthcareServer } from '../src/server.js';
import { patientPortalInvitation, patientPortalReset, readPatient } from '../src/patients.js';

const connectionString=process.env.TEST_DATABASE_URL ?? 'postgresql://venuscollective@127.0.0.1:55439/kantage_healthcare_test';
const appPool=new Pool({connectionString:connectionString.replace(/\/\/[^@]+@/,'//kh_test_request@'),max:4,idleTimeoutMillis:1_000});
const run=randomUUID().slice(0,8);
const orgId=randomUUID(), clinic=randomUUID(), staff=randomUUID(), withAccount=randomUUID(), withoutAccount=randomUUID();
const scope={organizationId:orgId,locationId:clinic,sub:`desk.${run}`,userAgent:'healthcare-test'};

async function root<T>(work:(client:Client)=>Promise<T>):Promise<T>{ const client=new Client({connectionString}); await client.connect(); try { return await work(client); } finally { await client.end(); } }

before(async()=>root(async client=>{
  await client.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kh_test_request') THEN CREATE ROLE kh_test_request LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$");
  await client.query('GRANT kh_request TO kh_test_request');
  await client.query("INSERT INTO clinical.organizations(id,slug,name,status) VALUES($1,$2,'Portal Org','active')",[orgId,`portal-${run}`]);
  await client.query("INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status) VALUES($1,$2,'Portal Clinic','America/New_York','','active')",[clinic,orgId]);
  await client.query("INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES($1,$2,$3,$4,'Front Desk','active')",[staff,orgId,scope.sub,`${scope.sub}@example.test`]);
  await client.query("INSERT INTO clinical.user_roles(organization_id,user_id,role,location_id) VALUES($1,$2,'front_desk',$3)",[orgId,staff,clinic]);
  for(const [id,first] of [[withAccount,'Ibrahim'],[withoutAccount,'Amara']]) {
    await client.query("INSERT INTO clinical.patients(id,organization_id,location_id,first_name,last_name,phone,email,status) VALUES($1,$2,$3,$4,'Barry','4105550100',$5,'active')",[id,orgId,clinic,first,`${first.toLowerCase()}.${run}@example.test`]);
    await client.query('INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES($1,$2,$3)',[orgId,clinic,id]);
  }
  await client.query("INSERT INTO clinical.patient_portal_accounts(organization_id,patient_id,cognito_sub,username,status) VALUES($1,$2,$3,$4,'invited')",[orgId,withAccount,`sub-${run}`,`ibrahim.barry.${run}`]);
}));
after(async()=>{ await appPool.end(); });

test('an invitation carries the patient\'s full name and the username they already have, if any',async()=>{
  const existing=await scoped(appPool,scope,()=>patientPortalInvitation(withAccount));
  assert.equal(existing.firstName,'Ibrahim'); assert.equal(existing.lastName,'Barry');
  assert.equal(existing.existingUsername,`ibrahim.barry.${run}`);
  assert.equal((await scoped(appPool,scope,()=>patientPortalInvitation(withoutAccount))).existingUsername,null);
});

test('staff see a patient\'s portal username on their profile',async()=>{
  const profile=await scoped(appPool,scope,()=>readPatient(withAccount)) as {portal_username:string;portal_status:string};
  assert.deepEqual([profile.portal_username,profile.portal_status],[`ibrahim.barry.${run}`,'invited']);
});

test('reset login needs portal access first, names the account to reset, and is audited',async()=>{
  await assert.rejects(scoped(appPool,scope,()=>patientPortalReset(withoutAccount)),{status:400});
  assert.deepEqual(await scoped(appPool,scope,()=>patientPortalReset(withAccount)),{patientId:withAccount,username:`ibrahim.barry.${run}`});
  const entries=await root(async client=>(await client.query("SELECT actor_user_id FROM clinical.audit_log WHERE action='portal.reset' AND subject_id=$1",[withAccount])).rows);
  assert.deepEqual(entries,[{actor_user_id:staff}]);
});

test('a disabled portal account cannot be reset',async()=>{
  await root(client=>client.query("UPDATE clinical.patient_portal_accounts SET status='disabled' WHERE patient_id=$1",[withAccount]));
  await assert.rejects(scoped(appPool,scope,()=>patientPortalReset(withAccount)),{status:400});
});

// Through the server, as staff would: the old account is gone from the patient pool, so reset login makes
// a named one and records it.
test('reset login for an account the patient pool no longer has creates one under the patient\'s name',async()=>{
  const named=`ibrahim.barry.${run}`;
  await root(client=>client.query("UPDATE clinical.patient_portal_accounts SET status='invited',username=$2 WHERE patient_id=$1",[withAccount,`ibrahim.${run}@example.test`]));
  const invited:{lastName:string;existingUsername:unknown}[]=[];
  const tenant={organizationId:orgId,staffUserPoolId:'pool',staffClientId:'client',bookingClinics:[]};
  const server=createHealthcareServer({
    registry:{get:async()=>tenant,list:async()=>[tenant]},
    pools:{get:async()=>appPool},
    verifierFor:()=>({verify:async()=>{ throw new Error('not a patient request'); }}),
    workforceAuth:{userPoolId:'workforce',clientId:'workforce-client'},
    workforceVerifier:{verify:async()=>({sub:'s',username:scope.sub,token_use:'access',client_id:'workforce-client'})},
    patientAccounts:{
      resetLogin:async()=>{ throw Object.assign(new Error('User does not exist.'),{name:'UserNotFoundException'}); },
      invite:async(input:{lastName:string;existingUsername:unknown})=>{ invited.push(input); return {username:named,sub:`named-${run}`,emailSent:true,textSent:false}; },
    },
  } as never);
  await new Promise<void>((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  try {
    const address=server.address(); if(!address || typeof address==='string') throw new Error('No test server address');
    const response=await fetch(`http://127.0.0.1:${address.port}/v1/patients/${withAccount}/portal-reset`,{method:'POST',headers:{authorization:'Bearer staff','x-kantage-organization':orgId,'x-kantage-location':clinic}});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{portalReset:{username:named,delivery:'new_account'}});
    assert.deepEqual(invited.map(input=>[input.lastName,input.existingUsername]),[['Barry',null]]);
    assert.deepEqual((await root(client=>client.query('SELECT username,cognito_sub FROM clinical.patient_portal_accounts WHERE patient_id=$1',[withAccount]))).rows,[{username:named,cognito_sub:`named-${run}`}]);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
