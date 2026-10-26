// An anonymous booking must never be able to change an existing patient, and must not merge different
// people who share contact details. Runs against a real database as the restricted request role.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { listBookingInquiries, resolveBookingMatch } from '../src/bookings.js';
import { scoped } from '../src/context.js';
import { createPublicBookingInquiry } from '../src/public-booking.js';

const connectionString=process.env.TEST_DATABASE_URL ?? 'postgresql://venuscollective@127.0.0.1:55439/kantage_healthcare_test';
const appPool=new Pool({connectionString:connectionString.replace(/\/\/[^@]+@/,'//kh_test_request@'),max:4,idleTimeoutMillis:1_000});
const run=randomUUID().slice(0,8);
const orgId=randomUUID(), clinicA=randomUUID(), clinicB=randomUUID(), aliceId=randomUUID(), staffId=randomUUID();
const staffSub=`desk.${run}`;
const alice={firstName:'Alice',lastName:'Rivera',email:`alice.${run}@example.test`,phone:'410-555-0101'};
const target={organizationId:orgId,locationId:clinicA,clinicName:'Clinic A',timezone:'America/New_York'};
const staffScope={organizationId:orgId,locationId:clinicA,sub:staffSub,userAgent:'healthcare-test'};

async function root<T>(work:(client:Client)=>Promise<T>):Promise<T>{ const client=new Client({connectionString}); await client.connect(); try { return await work(client); } finally { await client.end(); } }
const book=(details:{firstName:string;lastName:string;email:string;phone:string})=>createPublicBookingInquiry(appPool,target,{...details,appointmentType:'Preventive care',preferredContact:'email'},{userAgent:'healthcare-test'});
const patient=(id:string)=>root(async client=>(await client.query<{first_name:string;last_name:string;email:string;phone:string}>('SELECT first_name,last_name,email,phone FROM clinical.patients WHERE id=$1',[id])).rows[0]);
const inquiry=(id:string)=>root(async client=>(await client.query<{patient_id:string;possible_match_patient_id:string|null}>('SELECT patient_id,possible_match_patient_id FROM clinical.booking_inquiries WHERE id=$1',[id])).rows[0]);

before(async()=>root(async client=>{
  await client.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kh_test_request') THEN CREATE ROLE kh_test_request LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$");
  await client.query('GRANT kh_request TO kh_test_request');
  await client.query('INSERT INTO clinical.organizations(id,slug,name,status) VALUES($1,$2,$3,$4)',[orgId,`identity-${run}`,'Identity Org','active']);
  await client.query("INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status) VALUES($1,$3,'Clinic A','America/New_York','','active'),($2,$3,'Clinic B','America/New_York','','active')",[clinicA,clinicB,orgId]);
  await client.query("INSERT INTO clinical.patients(id,organization_id,location_id,first_name,last_name,phone,email,allergies,insurance,status) VALUES($1,$2,$3,$4,$5,$6,$7,'','','active')",[aliceId,orgId,clinicB,alice.firstName,alice.lastName,alice.phone,alice.email]);
  await client.query('INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES($1,$2,$3,$4,$5,$6)',[staffId,orgId,staffSub,`${staffSub}@example.test`,'Front Desk','active']);
  await client.query("INSERT INTO clinical.user_roles(organization_id,user_id,role) VALUES($1,$2,'front_desk')",[orgId,staffId]);
}));
after(async()=>{ await appPool.end(); });

test('the takeover attack: a booking with a known patient\'s phone and another email changes nothing about that patient',async()=>{
  const booking=await book({firstName:'Mallory',lastName:'Mole',phone:alice.phone,email:`attacker.${run}@example.test`});
  assert.deepEqual(await patient(aliceId),{first_name:'Alice',last_name:'Rivera',email:alice.email,phone:alice.phone});
  assert.notEqual(booking.patientId,aliceId,'the attacker gets a separate record');
  assert.equal((await inquiry(booking.id))?.possible_match_patient_id,aliceId,'flagged for staff as a possible match');
});

test('a family member who shares the email and phone gets their own record, matched to the real patient and not the attacker',async()=>{
  // Runs after the takeover test, so a record carrying Alice's phone already exists. The possible match
  // must still be Alice: staff confirming it would otherwise merge this person into the attacker's record.
  const booking=await book({firstName:'Sam',lastName:'Rivera',email:alice.email,phone:alice.phone});
  assert.notEqual(booking.patientId,aliceId,'not merged into the parent\'s chart');
  assert.equal((await inquiry(booking.id))?.possible_match_patient_id,aliceId);
});

test('a returning patient matching name, email and phone is recognised and left unchanged',async()=>{
  const booking=await book({firstName:'  alice ',lastName:'RIVERA',email:alice.email.toUpperCase(),phone:'(410) 555 0101'});
  assert.equal(booking.patientId,aliceId);
  assert.equal((await inquiry(booking.id))?.possible_match_patient_id,null);
  // The submitted formatting is kept on the booking request, never written over the patient.
  assert.deepEqual(await patient(aliceId),{first_name:'Alice',last_name:'Rivera',email:alice.email,phone:alice.phone});
});

test('staff see who a booking might be, at which clinic, and which detail matched',async()=>{
  const booking=await book({firstName:'Allison',lastName:'Rivera',email:alice.email,phone:'410-555-0999'});
  const rows=await scoped(appPool,staffScope,listBookingInquiries) as {id:string;match_name:string;match_clinic:string;matched_on:string}[];
  const row=rows.find(item=>item.id===booking.id);
  assert.equal(row?.match_name,'Alice Rivera');
  assert.equal(row?.match_clinic,'Clinic B','the match lives at another clinic, still in this organization');
  assert.equal(row?.matched_on,'email');
});

test('confirming the same patient merges the booking into them and leaves nothing orphaned',async()=>{
  const booking=await book({firstName:'Alicia',lastName:'Rivera',email:alice.email,phone:alice.phone});
  const duplicate=booking.patientId;
  await scoped(appPool,staffScope,()=>resolveBookingMatch(booking.id,{samePatient:true}));
  assert.deepEqual(await inquiry(booking.id),{patient_id:aliceId,possible_match_patient_id:null});
  await root(async client=>{
    assert.equal((await client.query('SELECT 1 FROM clinical.patients WHERE id=$1',[duplicate])).rowCount,0,'the duplicate record is gone');
    assert.equal((await client.query('SELECT 1 FROM clinical.appointments WHERE patient_id=$1',[duplicate])).rowCount,0,'its requested appointment moved');
    assert.equal((await client.query('SELECT 1 FROM clinical.patient_locations WHERE patient_id=$1',[duplicate])).rowCount,0);
    assert.equal((await client.query('SELECT 1 FROM clinical.patient_locations WHERE patient_id=$1 AND location_id=$2',[aliceId,clinicA])).rowCount,1,'Alice is now linked to this clinic');
    assert.equal((await client.query("SELECT 1 FROM clinical.audit_log WHERE action='bookings.match_confirmed' AND subject_id=$1",[booking.id])).rowCount,1);
  });
  assert.deepEqual(await patient(aliceId),{first_name:'Alice',last_name:'Rivera',email:alice.email,phone:alice.phone},'still unchanged');
});

test('marking a different person keeps both records and clears the flag',async()=>{
  const booking=await book({firstName:'Riley',lastName:'Rivera',email:alice.email,phone:alice.phone});
  await scoped(appPool,staffScope,()=>resolveBookingMatch(booking.id,{samePatient:false}));
  assert.deepEqual(await inquiry(booking.id),{patient_id:booking.patientId,possible_match_patient_id:null});
  assert.ok(await patient(booking.patientId));
});
