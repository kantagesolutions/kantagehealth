// The staff schedule calendar and live booking requests. Runs against a real database as the restricted
// request role.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { listAppointments } from '../src/appointments.js';
import { listWaitingBookingIds } from '../src/bookings.js';
import { scoped } from '../src/context.js';

const connectionString=process.env.TEST_DATABASE_URL ?? 'postgresql://venuscollective@127.0.0.1:55439/kantage_healthcare_test';
const appPool=new Pool({connectionString:connectionString.replace(/\/\/[^@]+@/,'//kh_test_request@'),max:4,idleTimeoutMillis:1_000});
const run=randomUUID().slice(0,8);
const orgId=randomUUID(), clinic=randomUUID(), otherClinic=randomUUID(), staff=randomUUID(), patient=randomUUID();
const scope={organizationId:orgId,locationId:clinic,sub:`desk.${run}`,userAgent:'healthcare-test'};
const ids={inRange:randomUUID(),edge:randomUUID(),before:randomUUID(),after:randomUUID(),elsewhere:randomUUID(),requested:randomUUID()};
const bookings={waiting:randomUUID(),scheduled:randomUUID()};

async function root<T>(work:(client:Client)=>Promise<T>):Promise<T>{ const client=new Client({connectionString}); await client.connect(); try { return await work(client); } finally { await client.end(); } }
const audited=()=>root(async client=>(await client.query<{action:string}>('SELECT action FROM clinical.audit_log WHERE actor_user_id=$1 ORDER BY id',[staff])).rows.map(row=>row.action));

before(async()=>root(async client=>{
  await client.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kh_test_request') THEN CREATE ROLE kh_test_request LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$");
  await client.query('GRANT kh_request TO kh_test_request');
  await client.query("INSERT INTO clinical.organizations(id,slug,name,status) VALUES($1,$2,'Schedule Org','active')",[orgId,`schedule-${run}`]);
  await client.query("INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status) VALUES($1,$3,'Clinic','America/New_York','','active'),($2,$3,'Other','America/New_York','','active')",[clinic,otherClinic,orgId]);
  await client.query("INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES($1,$2,$3,$4,'Front Desk','active')",[staff,orgId,scope.sub,`${scope.sub}@example.test`]);
  await client.query("INSERT INTO clinical.user_roles(organization_id,user_id,role,location_id) VALUES($1,$2,'front_desk',$3)",[orgId,staff,clinic]);
  await client.query("INSERT INTO clinical.patients(id,organization_id,location_id,first_name,last_name,phone,email,status) VALUES($1,$2,$3,'Sched','Patient','4105550100','sched@example.test','active')",[patient,orgId,clinic]);
  await client.query('INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES($1,$2,$4),($1,$3,$4)',[orgId,clinic,otherClinic,patient]);
  for(const [id,location,start] of [[ids.inRange,clinic,'2026-11-03T15:00:00Z'],[ids.edge,clinic,'2026-11-02T05:00:00Z'],[ids.before,clinic,'2026-11-02T04:59:59Z'],[ids.after,clinic,'2026-11-16T05:00:00Z'],[ids.elsewhere,otherClinic,'2026-11-04T15:00:00Z']] as const)
    await client.query("INSERT INTO clinical.appointments(id,organization_id,location_id,patient_id,service,start_time,duration_minutes,status) VALUES($1,$2,$3,$4,'Cleaning',$5,30,'confirmed')",[id,orgId,location,patient,start]);
  await client.query("INSERT INTO clinical.appointments(id,organization_id,location_id,patient_id,service,status) VALUES($1,$2,$3,$4,'Exam','requested')",[ids.requested,orgId,clinic,patient]);
  for(const [id,status] of [[bookings.waiting,'new'],[bookings.scheduled,'scheduled']] as const)
    await client.query("INSERT INTO clinical.booking_inquiries(id,organization_id,location_id,patient_id,first_name,last_name,phone,email,appointment_type,status) VALUES($1,$2,$3,$4,'Sched','Patient','4105550100','sched@example.test','Cleaning',$5)",[id,orgId,clinic,patient,status]);
}));
after(async()=>{ await appPool.end(); });

// Two weeks from midnight on Monday 2 November in New York (05:00 UTC) to midnight on Monday 16 November.
const fortnight={from:'2026-11-02T05:00:00.000Z',to:'2026-11-16T05:00:00.000Z'};

test('the calendar gets this clinic\'s appointments booked inside the two weeks it shows, and nothing else',async()=>{
  const rows=await scoped(appPool,scope,()=>listAppointments(fortnight)) as {id:string}[];
  assert.deepEqual(rows.map(row=>row.id),[ids.edge,ids.inRange],'from is inclusive, to is exclusive; other clinics and unscheduled requests are left out');
});

test('without a range the appointment list is unchanged',async()=>{
  const rows=await scoped(appPool,scope,()=>listAppointments()) as {id:string}[];
  assert.ok(rows.some(row=>row.id===ids.requested) && rows.some(row=>row.id===ids.before) && !rows.some(row=>row.id===ids.elsewhere));
});

test('a range must run forwards, cover at most two months, and give both ends',async()=>{
  await assert.rejects(scoped(appPool,scope,()=>listAppointments({from:fortnight.to,to:fortnight.from})));
  await assert.rejects(scoped(appPool,scope,()=>listAppointments({from:'2026-01-01T00:00:00Z',to:'2026-06-01T00:00:00Z'})));
  await assert.rejects(scoped(appPool,scope,()=>listAppointments({from:fortnight.from,to:null})));
});

test('checking for new booking requests returns waiting ids only, nothing about the patient, and is not audited',async()=>{
  const before=await audited();
  const waiting=await scoped(appPool,scope,listWaitingBookingIds);
  assert.deepEqual(waiting.map(row=>row.id),[bookings.waiting]);
  assert.deepEqual(Object.keys(waiting[0]!).sort(),['created_at','id']);
  assert.deepEqual(await audited(),before);
});
