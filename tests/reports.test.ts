// Reports give counts and totals per clinic, to the people allowed to see them, and never a patient.
// Runs against a real database as the restricted request role, with known figures for March 2026.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { scoped } from '../src/context.js';
import { clinicReports, platformReports } from '../src/reports.js';

const connectionString=process.env.TEST_DATABASE_URL ?? 'postgresql://venuscollective@127.0.0.1:55439/kantage_healthcare_test';
const appPool=new Pool({connectionString:connectionString.replace(/\/\/[^@]+@/,'//kh_test_request@'),max:4,idleTimeoutMillis:1_000});
const run=randomUUID().slice(0,8);
const orgId=randomUUID(), clinicA=randomUUID(), clinicB=randomUUID(), otherOrg=randomUUID(), otherClinic=randomUUID();
const people={owner:randomUUID(),clinicAdmin:randomUUID(),auditor:randomUUID(),frontDesk:randomUUID()};
const sub=(name:string)=>`${name}.${run}`;
const at=(locationId:string,name:string)=>({organizationId:orgId,locationId,sub:sub(name),userAgent:'healthcare-test'});
const march=new URLSearchParams({from:'2026-03-01',to:'2026-03-31'});
const patientNames=[`Reportpatient${run}`,`Movedpatient${run}`,`Oldpatient${run}`];

async function root<T>(work:(client:Client)=>Promise<T>):Promise<T>{ const client=new Client({connectionString}); await client.connect(); try { return await work(client); } finally { await client.end(); } }

before(async()=>root(async client=>{
  await client.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kh_test_request') THEN CREATE ROLE kh_test_request LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$");
  await client.query('GRANT kh_request TO kh_test_request');
  await client.query("INSERT INTO clinical.organizations(id,slug,name,status) VALUES($1,$2,'Report Network','active'),($3,$4,'Other Network','active')",[orgId,`report-${run}`,otherOrg,`report-other-${run}`]);
  // Clinic B keeps Pacific time, so its days end three hours after clinic A's.
  await client.query(`INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status) VALUES
    ($1,$3,'Report Clinic A','America/New_York','','active'),($2,$3,'Report Clinic B','America/Los_Angeles','','active'),($4,$5,'Other Clinic','America/New_York','','active')`,[clinicA,clinicB,orgId,otherClinic,otherOrg]);
  for(const [name,role,location] of [['owner','organization_owner',null],['clinicAdmin','clinic_administrator',clinicA],['auditor','auditor',clinicB],['frontDesk','front_desk',clinicA]] as const) {
    const id=people[name];
    await client.query("INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES($1,$2,$3,$4,$5,'active')",[id,orgId,sub(name),`${sub(name)}@example.test`,name]);
    await client.query('INSERT INTO clinical.user_roles(organization_id,user_id,role,location_id) VALUES($1,$2,$3,$4)',[orgId,id,role,location]);
  }
  const patient=async(location:string,first:string,created:string)=>{
    const id=randomUUID();
    await client.query("INSERT INTO clinical.patients(id,organization_id,location_id,first_name,last_name,phone,email,status,created_at) VALUES($1,$2,$3,$4,'Test','4105550100',$5,'active',$6)",[id,orgId,location,first,`${first.toLowerCase()}@example.test`,created]);
    await client.query('INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES($1,$2,$3)',[orgId,location,id]);
    return id;
  };
  // Two patients join clinic A in March; one of them then moves to B. A third joined B last year.
  const stays=await patient(clinicA,patientNames[0]!,'2026-03-05T15:00:00Z');
  const moves=await patient(clinicB,patientNames[1]!,'2026-03-06T15:00:00Z');
  await client.query('INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES($1,$2,$3)',[orgId,clinicA,moves]);
  await client.query("INSERT INTO clinical.patient_moves(organization_id,patient_id,from_location_id,to_location_id,reason,moved_at) VALUES($1,$2,$3,$4,'patient_portal_booking','2026-03-20T15:00:00Z')",[orgId,moves,clinicA,clinicB]);
  await patient(clinicB,patientNames[2]!,'2025-06-01T15:00:00Z');
  const appointment=(status:string,start:string|null)=>client.query('INSERT INTO clinical.appointments(organization_id,location_id,patient_id,service,start_time,duration_minutes,status) VALUES($1,$2,$3,$4,$5,$6,$7)',[orgId,clinicA,stays,'Cleaning',start,start?30:null,status]);
  await appointment('confirmed','2026-03-10T14:00:00Z'); await appointment('confirmed','2026-03-11T14:00:00Z'); await appointment('completed','2026-03-02T14:00:00Z');
  await appointment('confirmed','2026-04-02T14:00:00Z'); // after the range
  await appointment('requested',null); // a request without a time yet: counted as a booking request
  const booking=(status:string,source:string,created:string)=>client.query("INSERT INTO clinical.booking_inquiries(organization_id,location_id,patient_id,first_name,last_name,phone,email,appointment_type,status,source,created_at) VALUES($1,$2,$3,'Report','Test','4105550100',NULL,'Cleaning',$4,$5,$6)",[orgId,clinicA,stays,status,source,created]);
  await booking('scheduled','website','2026-03-03T15:00:00Z'); await booking('new','patient_portal','2026-03-04T15:00:00Z'); await booking('new','website','2026-03-30T15:00:00Z');
  const payment=(location:string,patientId:string,cents:number,created:string)=>client.query("INSERT INTO clinical.payments(organization_id,location_id,patient_id,amount_cents,description,created_at) VALUES($1,$2,$3,$4,'Visit',$5)",[orgId,location,patientId,cents,created]);
  await payment(clinicA,stays,45000,'2026-03-10T15:00:00Z'); await payment(clinicA,stays,12000,'2026-03-12T15:00:00Z'); await payment(clinicA,stays,99900,'2026-02-27T15:00:00Z');
  // 06:00 UTC on 1 March is still 28 February in Los Angeles, so clinic B's March has no payments.
  await payment(clinicB,moves,5000,'2026-03-01T06:00:00Z');
}));
after(async()=>{ await appPool.end(); });

type Clinic={clinic_name:string;[key:string]:unknown};
const byName=(clinics:Clinic[])=>Object.fromEntries(clinics.map(({clinic_name,location_id:_location,clinic_status:_status,...figures})=>[clinic_name,figures]));

test('an organization owner sees every clinic, with the figures for the range',async()=>{
  const report=await scoped(appPool,at(clinicA,'owner'),()=>clinicReports(march));
  assert.deepEqual(byName(report.clinics as Clinic[]),{
    'Report Clinic A':{new_patients:2,moved_in:0,moved_out:1,appointments:{confirmed:2,completed:1},booking_requests:3,booking_requests_scheduled:1,booking_requests_from_portal:1,payments:2,payments_cents:57000},
    'Report Clinic B':{new_patients:0,moved_in:1,moved_out:0,appointments:{},booking_requests:0,booking_requests_scheduled:0,booking_requests_from_portal:0,payments:0,payments_cents:0},
  });
});

test('a clinic administrator or auditor sees only the clinics they are assigned to',async()=>{
  const clinicAdmin=await scoped(appPool,at(clinicA,'clinicAdmin'),()=>clinicReports(march));
  assert.deepEqual(clinicAdmin.clinics.map(row=>row.clinic_name),['Report Clinic A']);
  const auditor=await scoped(appPool,at(clinicB,'auditor'),()=>clinicReports(march));
  assert.deepEqual(auditor.clinics.map(row=>row.clinic_name),['Report Clinic B']);
});

test('staff without reports.read are refused, and nothing is audited for them',async()=>{
  await assert.rejects(scoped(appPool,at(clinicA,'frontDesk'),()=>clinicReports(march)),{status:403});
  const reads=await root(async client=>(await client.query("SELECT actor_user_id FROM clinical.audit_log WHERE organization_id=$1 AND action='reports.read'",[orgId])).rows.map(row=>row.actor_user_id));
  assert.ok(!reads.includes(people.frontDesk));
  assert.ok(reads.includes(people.owner),'a report that was read is audited');
});

test('reports never contain a patient',async()=>{
  const patientIds=await root(async client=>(await client.query('SELECT id,email FROM clinical.patients WHERE organization_id=$1',[orgId])).rows);
  const staff=JSON.stringify(await scoped(appPool,at(clinicA,'owner'),()=>clinicReports(march)));
  const platform=JSON.stringify(await platformReports([{organizationId:orgId}] as never,{get:async()=>appPool} as never,march));
  for(const body of [staff,platform]) for(const value of [...patientNames,...patientIds.flatMap(row=>[row.id,row.email])]) assert.ok(!body.includes(value),`found ${value}`);
});

test('platform administrators see every organization\'s clinics',async()=>{
  const report=await platformReports([{organizationId:orgId}] as never,{get:async()=>appPool} as never,march);
  const names=new Set(report.clinics.map(row=>row.clinic_name));
  for(const name of ['Report Clinic A','Report Clinic B','Other Clinic']) assert.ok(names.has(name as string),name);
});

test('a range must run forwards and cover at most a year',async()=>{
  const owner=at(clinicA,'owner');
  await assert.rejects(scoped(appPool,owner,()=>clinicReports(new URLSearchParams({from:'2026-03-31',to:'2026-03-01'}))),{status:400});
  await assert.rejects(scoped(appPool,owner,()=>clinicReports(new URLSearchParams({from:'2025-01-01',to:'2026-03-01'}))),{status:400});
  await assert.rejects(scoped(appPool,owner,()=>clinicReports(new URLSearchParams({from:'March',to:'2026-03-01'}))));
  assert.equal((await scoped(appPool,owner,()=>clinicReports(new URLSearchParams({from:'2026-03-10',to:'2026-03-10'})))).clinics.length,2,'a single day is a range');
});
