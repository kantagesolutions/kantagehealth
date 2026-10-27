// A patient's chart follows them between the clinics of one organization, and only there. Reading follows
// the patient; writing stays with the clinic that gives the care. Runs against a real database as the
// restricted request role.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { listAppointments } from '../src/appointments.js';
import { scheduleBookingInquiry } from '../src/bookings.js';
import { query, scoped } from '../src/context.js';
import { listDocuments } from '../src/documents.js';
import { linkPatientToLocation, patientHistory } from '../src/patients.js';
import { listPayments } from '../src/payments.js';
import { createPatientPortalBooking, listBookingClinics } from '../src/public-booking.js';

const connectionString=process.env.TEST_DATABASE_URL ?? 'postgresql://venuscollective@127.0.0.1:55439/kantage_healthcare_test';
const appPool=new Pool({connectionString:connectionString.replace(/\/\/[^@]+@/,'//kh_test_request@'),max:4,idleTimeoutMillis:1_000});
const run=randomUUID().slice(0,8);
const orgId=randomUUID(), clinicA=randomUUID(), clinicB=randomUUID(), clinicC=randomUUID(), userA=randomUUID(), userB=randomUUID();
const otherOrg=randomUUID(), otherClinic=randomUUID(), otherUser=randomUUID();
const patId=randomUUID(), unaId=randomUUID(), zedId=randomUUID();
const patSub=`patient.${run}`;
const orgName=`Network ${run}`;
const keys={a:`clinic-a-${run}-booking-key`,b:`clinic-b-${run}-booking-key`,c:`clinic-c-${run}-booking-key`};
const tenant={organizationId:orgId,bookingClinics:[{key:keys.a,locationId:clinicA},{key:keys.b,locationId:clinicB},{key:keys.c,locationId:clinicC}]};
const at=(locationId:string,sub:string)=>({organizationId:orgId,locationId,sub,userAgent:'healthcare-test'});
const staffA=at(clinicA,`owner-a.${run}`), staffB=at(clinicB,`owner-b.${run}`);
const careAtA={appointment:randomUUID(),record:randomUUID(),document:randomUUID(),payment:randomUUID(),invoice:randomUUID()};

async function root<T>(work:(client:Client)=>Promise<T>):Promise<T>{ const client=new Client({connectionString}); await client.connect(); try { return await work(client); } finally { await client.end(); } }
const home=(id:string)=>root(async client=>(await client.query<{location_id:string}>('SELECT location_id FROM clinical.patients WHERE id=$1',[id])).rows[0]?.location_id);
const linkedTo=(id:string)=>root(async client=>(await client.query<{location_id:string}>('SELECT location_id FROM clinical.patient_locations WHERE patient_id=$1 ORDER BY location_id',[id])).rows.map(row=>row.location_id).sort());

before(async()=>root(async client=>{
  await client.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kh_test_request') THEN CREATE ROLE kh_test_request LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$");
  await client.query('GRANT kh_request TO kh_test_request');
  await client.query("INSERT INTO clinical.organizations(id,slug,name,status) VALUES($1,$2,$3,'active'),($4,$5,'Another Org','active')",[orgId,`network-${run}`,orgName,otherOrg,`other-${run}`]);
  await client.query(`INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status) VALUES
    ($1,$4,'Clinic A','America/New_York','1 A Street','active'),($2,$4,'Clinic B','America/New_York','2 B Street','active'),
    ($3,$4,'Clinic C','America/New_York','3 C Street','inactive'),($5,$6,'Other Clinic','America/New_York','','active')`,[clinicA,clinicB,clinicC,orgId,otherClinic,otherOrg]);
  for(const [id,org,location,sub] of [[userA,orgId,clinicA,staffA.sub],[userB,orgId,clinicB,staffB.sub],[otherUser,otherOrg,otherClinic,`other.${run}`]]) {
    await client.query("INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES($1,$2,$3,$4,'Owner','active')",[id,org,sub,`${sub}@example.test`]);
    await client.query("INSERT INTO clinical.user_roles(organization_id,user_id,role,location_id) VALUES($1,$2,'owner',$3)",[org,id,location]);
  }
  for(const [id,org,location,first] of [[patId,orgId,clinicA,'Pat'],[unaId,orgId,clinicA,'Una'],[zedId,otherOrg,otherClinic,'Zed']]) {
    await client.query("INSERT INTO clinical.patients(id,organization_id,location_id,first_name,last_name,phone,email,status) VALUES($1,$2,$3,$4,'Test','4105550100',$5,'active')",[id,org,location,first,`${first.toLowerCase()}.${run}@example.test`]);
    await client.query('INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES($1,$2,$3)',[org,location,id]);
  }
  // Pat's care at clinic A, one of everything the chart holds.
  await client.query("INSERT INTO clinical.appointments(id,organization_id,location_id,patient_id,provider_user_id,service,start_time,duration_minutes,status) VALUES($1,$2,$3,$4,$5,'Root canal',now(),60,'completed')",[careAtA.appointment,orgId,clinicA,patId,userA]);
  await client.query("INSERT INTO clinical.care_records(id,organization_id,location_id,patient_id,record_type,note,provider_user_id) VALUES($1,$2,$3,$4,'treatment','Root canal, tooth 19',$5)",[careAtA.record,orgId,clinicA,patId,userA]);
  await client.query("INSERT INTO clinical.documents(id,organization_id,location_id,patient_id,object_key,name,status,content_type,size_bytes) VALUES($1,$2,$3,$4,$5,'X-ray.png','ready','image/png',1000)",[careAtA.document,orgId,clinicA,patId,`${orgId}/${clinicA}/${patId}/${careAtA.document}`]);
  await client.query("INSERT INTO clinical.payments(id,organization_id,location_id,patient_id,amount_cents,description) VALUES($1,$2,$3,$4,45000,'Root canal')",[careAtA.payment,orgId,clinicA,patId]);
  await client.query('INSERT INTO clinical.invoices(id,organization_id,location_id,patient_id,amount_cents,balance_cents) VALUES($1,$2,$3,$4,45000,0)',[careAtA.invoice,orgId,clinicA,patId]);
  // Another organization's patient, with care of their own.
  await client.query("INSERT INTO clinical.appointments(organization_id,location_id,patient_id,provider_user_id,service,start_time,duration_minutes,status) VALUES($1,$2,$3,$4,'Cleaning',now(),30,'confirmed')",[otherOrg,otherClinic,zedId,otherUser]);
  await client.query("INSERT INTO clinical.patient_portal_accounts(organization_id,patient_id,cognito_sub,username,status) VALUES($1,$2,$3,$4,'active')",[orgId,patId,patSub,`${patSub}@example.test`]);
}));
after(async()=>{ await appPool.end(); });

const chartRows=(locationScope:ReturnType<typeof at>,table:string,patientId:string)=>scoped(appPool,locationScope,async()=>(await query(`SELECT id FROM clinical.${table} WHERE patient_id=$1`,[patientId])).rowCount);

test('before a patient is linked, another clinic sees nothing of their chart',async()=>{
  await assert.rejects(scoped(appPool,staffB,()=>patientHistory(patId)),{status:404});
  for(const table of ['appointments','care_records','documents','payments','invoices']) assert.equal(await chartRows(staffB,table,patId),0,table);
});

test('once linked, clinic B reads the whole chart from clinic A, labelled with the clinic that gave the care',async()=>{
  await scoped(appPool,staffB,()=>linkPatientToLocation(patId));
  const history=await scoped(appPool,staffB,()=>patientHistory(patId));
  assert.deepEqual(history.appointments.map(item=>[item.id,item.clinic,item.here]),[[careAtA.appointment,'Clinic A',false]]);
  assert.deepEqual(history.records.map(item=>[item.id,item.clinic]),[[careAtA.record,'Clinic A']]);
  assert.deepEqual(history.documents.map(item=>item.id),[careAtA.document]);
  assert.deepEqual(history.payments.map(item=>item.id),[careAtA.payment]);
  assert.equal(await chartRows(staffB,'invoices',patId),1,'invoices follow too');
});

test('clinic B still cannot write into clinic A\'s records',async()=>{
  await assert.rejects(scoped(appPool,staffB,()=>query("INSERT INTO clinical.care_records(organization_id,location_id,patient_id,record_type,note,provider_user_id) VALUES($1,$2,$3,'note','Written under clinic A by clinic B',$4)",[orgId,clinicA,patId,userB])),/row-level security/);
  const changed=await scoped(appPool,staffB,async()=>({
    appointments:(await query("UPDATE clinical.appointments SET status='cancelled' WHERE id=$1",[careAtA.appointment])).rowCount,
    records:(await query("UPDATE clinical.care_records SET note='altered' WHERE id=$1",[careAtA.record])).rowCount,
    documents:(await query("UPDATE clinical.documents SET name='altered' WHERE id=$1",[careAtA.document])).rowCount,
    payments:(await query("UPDATE clinical.payments SET status='void' WHERE id=$1",[careAtA.payment])).rowCount,
    invoices:(await query("UPDATE clinical.invoices SET status='void' WHERE id=$1",[careAtA.invoice])).rowCount,
  }));
  // The request role can never delete records at all, at any clinic.
  assert.deepEqual(changed,{appointments:0,records:0,documents:0,payments:0,invoices:0});
});

test('clinic B\'s schedule, payments and documents lists stay its own',async()=>{
  const lists=await scoped(appPool,staffB,async()=>({appointments:await listAppointments(),payments:await listPayments(),documents:await listDocuments()}));
  assert.equal(lists.appointments.length,0);
  assert.equal(lists.payments.length,0);
  assert.equal(lists.documents.length,0);
});

test('a patient never linked to clinic B stays invisible to it',async()=>{
  await assert.rejects(scoped(appPool,staffB,()=>patientHistory(unaId)),{status:404});
  assert.equal(await chartRows(staffB,'appointments',unaId),0);
});

test('a patient in another organization stays invisible, even by id',async()=>{
  await assert.rejects(scoped(appPool,staffB,()=>patientHistory(zedId)),{status:404});
  assert.equal(await chartRows(staffB,'appointments',zedId),0);
  await assert.rejects(scoped(appPool,staffB,()=>linkPatientToLocation(zedId)),{status:404});
});

test('patients choose among active clinics, identified by booking link and never by internal id',async()=>{
  const clinics=await listBookingClinics(appPool,orgId,tenant.bookingClinics.filter(clinic=>clinic.locationId!==clinicB));
  assert.deepEqual(clinics,[{key:keys.a,name:'Clinic A',address:'1 A Street',timezone:'America/New_York'}],'clinic B has no link here and clinic C is out of service');
  const all=await listBookingClinics(appPool,orgId,tenant.bookingClinics);
  assert.deepEqual(all.map(clinic=>clinic.name),['Clinic A','Clinic B']);
  assert.ok(!JSON.stringify(all).includes(clinicA),'no internal ids');
});

let unaBooking='';
test('a patient booking from the portal moves to the clinic they chose; earlier clinics keep their history',async()=>{
  // Una has only ever been seen at clinic A.
  await root(client=>client.query("INSERT INTO clinical.patient_portal_accounts(organization_id,patient_id,cognito_sub,username,status) VALUES($1,$2,$3,$4,'active')",[orgId,unaId,`una.${run}`,`una.${run}@example.test`]));
  const booking=await createPatientPortalBooking(appPool,tenant,`una.${run}`,{clinic:keys.b,appointmentType:'Cleaning',preferredContact:'email'},{userAgent:'healthcare-test'});
  assert.equal(booking?.clinicName,'Clinic B');
  unaBooking=booking!.id;
  assert.equal(await home(unaId),clinicB,'her profile moved');
  assert.deepEqual(await linkedTo(unaId),[clinicA,clinicB].sort(),'clinic A keeps its link');
  const moves=await root(async client=>(await client.query('SELECT from_location_id,to_location_id,reason FROM clinical.patient_moves WHERE patient_id=$1',[unaId])).rows);
  assert.deepEqual(moves,[{from_location_id:clinicA,to_location_id:clinicB,reason:'patient_portal_booking'}]);
  const request=await root(async client=>(await client.query('SELECT location_id,first_name,email,source,possible_match_patient_id FROM clinical.booking_inquiries WHERE id=$1',[booking!.id])).rows[0]);
  assert.deepEqual(request,{location_id:clinicB,first_name:'Una',email:`una.${run}@example.test`,source:'patient_portal',possible_match_patient_id:null},'the request carries her own record\'s details');
  // Clinic B now sees her, and clinic A still reads her chart, including the new request at clinic B.
  assert.equal((await scoped(appPool,staffB,()=>patientHistory(unaId))).appointments.length,1);
  const fromA=await scoped(appPool,staffA,()=>patientHistory(unaId));
  assert.deepEqual(fromA.appointments.map(item=>[item.clinic,item.status]),[['Clinic B','requested']]);
});

test('scheduling a booking request confirms this clinic\'s requested appointment, not one at another clinic',async()=>{
  // An older request of Una's at clinic A, with an id that sorts before any random one. It is new for each
  // run, so a database the tests ran against before still gets it.
  const atA=`00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
  await root(client=>client.query("INSERT INTO clinical.appointments(id,organization_id,location_id,patient_id,service,status) VALUES($1,$2,$3,$4,'Exam','requested')",[atA,orgId,clinicA,unaId]));
  await scoped(appPool,staffB,()=>scheduleBookingInquiry(unaBooking,{startTime:'2030-01-02T15:00:00Z',durationMinutes:30}));
  const rows=await root(async client=>(await client.query<{location_id:string;status:string}>('SELECT location_id,status FROM clinical.appointments WHERE patient_id=$1 AND organization_id=$2 ORDER BY location_id',[unaId,orgId])).rows);
  assert.deepEqual(rows.map(row=>[row.location_id===clinicA?'A':'B',row.status]).sort(),[['A','requested'],['B','confirmed']],'one appointment each, none left orphaned');
});

test('the portal refuses a clinic out of service, a clinic outside the organization, and an unknown patient',async()=>{
  await assert.rejects(createPatientPortalBooking(appPool,tenant,patSub,{clinic:keys.c,appointmentType:'Cleaning'},{userAgent:'healthcare-test'}),/not taking bookings/);
  assert.equal(await createPatientPortalBooking(appPool,tenant,patSub,{clinic:'some-other-network-booking-key',appointmentType:'Cleaning'},{userAgent:'healthcare-test'}),undefined);
  await assert.rejects(createPatientPortalBooking(appPool,tenant,`nobody.${run}`,{clinic:keys.b,appointmentType:'Cleaning'},{userAgent:'healthcare-test'}),/Patient profile not found/);
  assert.equal(await home(patId),clinicA,'nothing moved');
});

test('the activity feed says a booking came from the patient portal, and nothing about the patient',async()=>{
  const rows=await root(async client=>(await client.query("SELECT * FROM clinical.platform_activity() WHERE organization_name=$1 AND action='bookings.received'",[orgName])).rows);
  assert.deepEqual(rows.map(row=>[row.location_name,row.source,row.actor_name]),[['Clinic B','patient portal','Patient portal']]);
  assert.ok(!JSON.stringify(rows).includes('Una'));
});

// Last, because it adds a booking at clinic A that the tests above do not expect.
test('a request at the clinic a patient is already at is not a move',async()=>{
  await createPatientPortalBooking(appPool,tenant,patSub,{clinic:keys.a,appointmentType:'Follow-up'},{userAgent:'healthcare-test'});
  assert.equal(await home(patId),clinicA);
  assert.equal((await root(client=>client.query('SELECT 1 FROM clinical.patient_moves WHERE patient_id=$1',[patId]))).rowCount,0);
  // Only reports read the move log, and only as counts.
  await assert.rejects(scoped(appPool,staffB,()=>query('SELECT * FROM clinical.patient_moves')),/permission denied/);
});
