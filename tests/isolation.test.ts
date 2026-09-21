import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { AccessError, scoped } from '../src/context.js';
import { createAppointment, listAppointments } from '../src/appointments.js';
import { createCareRecord, createPatient, listCareRecords, listPatients } from '../src/patients.js';
import { createPaymentRecord } from '../src/payments.js';
import { approveMySupportAccess, requestSupportAccess } from '../src/support.js';

const connectionString=process.env.TEST_DATABASE_URL ?? 'postgresql://venuscollective@127.0.0.1:55439/kantage_healthcare_test';
const run=`${randomUUID().slice(0,8)}`;
const orgA=randomUUID(), orgB=randomUUID(), locationA=randomUUID(), locationB=randomUUID();
const userA=randomUUID(), userB=randomUUID(), subA=`test-a-${run}`, subB=`test-b-${run}`;
const appConnectionString=connectionString.replace(/\/\/[^@]+@/,'//kh_test_request@');
const appPool=new Pool({connectionString:appConnectionString, max:4, idleTimeoutMillis:1_000});

const scopeA={organizationId:orgA,locationId:locationA,sub:subA,userAgent:'healthcare-test'};
const scopeB={organizationId:orgB,locationId:locationB,sub:subB,userAgent:'healthcare-test'};

before(async()=>{
  const root=new Client({connectionString});
  await root.connect();
  try {
    await root.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kh_test_request') THEN CREATE ROLE kh_test_request LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$");
    await root.query('GRANT kh_request TO kh_test_request');
    await root.query('INSERT INTO clinical.organizations(id,slug,name,status) VALUES ($1,$2,$3,$4),($5,$6,$7,$4)',[orgA,`org-a-${run}`,'Organization A','active',orgB,`org-b-${run}`,'Organization B']);
    await root.query('INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status) VALUES ($1,$2,$3,$4,$5,$6),($7,$8,$9,$4,$5,$6)',[locationA,orgA,'A Main','America/New_York','A','active',locationB,orgB,'B Main']);
    await root.query('INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES ($1,$2,$3,$4,$5,$6),($7,$8,$9,$10,$11,$6)',[userA,orgA,subA,`${subA}@example.test`,'Test A','active',userB,orgB,subB,`${subB}@example.test`,'Test B']);
    await root.query('INSERT INTO clinical.user_roles(organization_id,user_id,role) VALUES($1,$2,$3),($4,$5,$3)',[orgA,userA,'clinician',orgB,userB]);
  } finally { await root.end(); }
});

after(async()=>{ await appPool.end(); });

test('a tenant cannot read another tenant patient even with a direct table query',async()=>{
  const patient=await scoped(appPool,scopeA,()=>createPatient({firstName:'Alice',lastName:'Example',phone:'410-555-0101'}));
  const aRows=await scoped(appPool,scopeA,()=>listPatients());
  const bRows=await scoped(appPool,scopeB,()=>listPatients());
  assert.equal(aRows.some(row=>row.id===patient.id),true);
  assert.equal(bRows.some(row=>row.id===patient.id),false);
  const direct=await scoped(appPool,scopeB,async()=>{
    const {query}=await import('../src/context.js');
    return query<{id:string}>('SELECT id FROM clinical.patients WHERE id=$1',[patient.id]);
  });
  assert.equal(direct.rowCount,0);
});

test('clinical records require a clinician and generate an immutable audit entry',async()=>{
  const patient=await scoped(appPool,scopeA,()=>createPatient({firstName:'Riley',lastName:'Example',phone:'410-555-0102'}));
  const record=await scoped(appPool,scopeA,()=>createCareRecord(patient.id,{recordType:'note',note:'Synthetic test note.'}));
  assert.ok(record.id);
  const records=await scoped(appPool,scopeA,()=>listCareRecords(patient.id));
  assert.equal(records.length,1);

  const root=new Client({connectionString});
  await root.connect();
  try {
    const audit=await root.query<{action:string}>('SELECT action FROM clinical.audit_log WHERE subject_id=$1 ORDER BY id',[record.id]);
    assert.equal(audit.rows.at(-1)?.action,'records.create');
  } finally { await root.end(); }

  await assert.rejects(
    scoped(appPool,scopeA,async()=>{
      const {query}=await import('../src/context.js');
      return query('UPDATE clinical.audit_log SET action=$1 WHERE subject_id=$2',['patients.list',record.id]);
    }),
    /permission denied/i,
  );
});

test('appointments stay within the current organization and location',async()=>{
  const patient=await scoped(appPool,scopeA,()=>createPatient({firstName:'Casey',lastName:'Example',phone:'410-555-0103'}));
  const appointment=await scoped(appPool,scopeA,()=>createAppointment({patientId:patient.id,providerUserId:userA,service:'Exam',startTime:'2030-01-02T15:00:00.000Z',durationMinutes:30}));
  const aAppointments=await scoped(appPool,scopeA,listAppointments);
  const bAppointments=await scoped(appPool,scopeB,listAppointments);
  assert.equal(aAppointments.some(row=>row.id===appointment.id),true);
  assert.equal(bAppointments.some(row=>row.id===appointment.id),false);
});

test('a front-desk user cannot read clinical records',async()=>{
  const root=new Client({connectionString});
  const frontDeskId=randomUUID(), frontDeskSub=`front-desk-${run}`;
  await root.connect();
  try {
    await root.query('INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES($1,$2,$3,$4,$5,$6)',[frontDeskId,orgA,frontDeskSub,`${frontDeskSub}@example.test`,'Front Desk','active']);
    await root.query('INSERT INTO clinical.user_roles(organization_id,user_id,role,location_id) VALUES($1,$2,$3,$4)',[orgA,frontDeskId,'front_desk',locationA]);
  } finally { await root.end(); }
  await assert.rejects(
    scoped(appPool,{...scopeA,sub:frontDeskSub},()=>listCareRecords(randomUUID())),
    (error:unknown)=>error instanceof AccessError && error.status===403,
  );
});

test('support receives temporary operational access only through an audited session',async()=>{
  const root=new Client({connectionString});
  const supportUserId=randomUUID(), supportSub=`support-${run}`;
  await root.connect();
  try {
    await root.query('INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES($1,$2,$3,$4,$5,$6)',[supportUserId,orgA,supportSub,`${supportSub}@example.test`,'Kantage Support','active']);
    await root.query('INSERT INTO clinical.user_roles(organization_id,user_id,role,location_id) VALUES($1,$2,$3,$4)',[orgA,supportUserId,'kantage_support',locationA]);
    await root.query('INSERT INTO clinical.user_capabilities(organization_id,user_id,capability_key) VALUES($1,$2,$3)',[orgA,userA,'organization.manage']);
  } finally { await root.end(); }
  const patient=await scoped(appPool,scopeA,()=>createPatient({firstName:'Morgan',lastName:'Example',phone:'410-555-0111'}));
  const requested=await scoped(appPool,scopeA,()=>requestSupportAccess({supportUserSub:supportSub,reason:'Investigate a clinic billing configuration issue.',expiresInMinutes:30}));
  const supportScope={...scopeA,sub:supportSub};
  await scoped(appPool,supportScope,()=>approveMySupportAccess(requested.id));
  const payment=await scoped(appPool,supportScope,()=>createPaymentRecord({patientId:patient.id,amountCents:1000,description:'Synthetic support test'}));
  assert.ok(payment.id);
});
