import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealthcareServer } from '../src/server.js';

test('health endpoint has no data and clinical endpoints fail closed without a token',async()=>{
  const server=createHealthcareServer({} as never);
  await new Promise<void>((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  try {
    const address=server.address();
    if(!address || typeof address==='string') throw new Error('No test server address');
    const health=await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(health.status,200);
    assert.deepEqual(await health.json(),{status:'ok'});
    const clinical=await fetch(`http://127.0.0.1:${address.port}/v1/patients`,{headers:{'x-kantage-organization':'00000000-0000-4000-8000-000000000001','x-kantage-location':'00000000-0000-4000-8000-000000000002'}});
    assert.equal(clinical.status,401);
    assert.equal(clinical.headers.get('cache-control'),'no-store');
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

test('public booking lookup exposes only the selected clinic and no tenant identifiers',async()=>{
  const bookingKey='ExampleBookingKey_123456789';
  const server=createHealthcareServer({
    registry:{findBooking:async(key:string)=>key===bookingKey?{tenant:{organizationId:'00000000-0000-4000-8000-000000000001'},clinic:{locationId:'00000000-0000-4000-8000-000000000002',clinicName:'Example Dental',timezone:'America/New_York'}}:undefined},
  } as never);
  await new Promise<void>((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  try {
    const address=server.address(); if(!address || typeof address==='string') throw new Error('No test server address');
    const response=await fetch(`http://127.0.0.1:${address.port}/v1/public/booking/${bookingKey}`);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{clinic:{name:'Example Dental',timezone:'America/New_York'}});
    const unknown=await fetch(`http://127.0.0.1:${address.port}/v1/public/booking/AnotherBookingKey_123456789`);
    assert.equal(unknown.status,404);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

test('an authenticated employee discovers only assigned clinic workspaces',async()=>{
  const tenant={organizationId:'00000000-0000-4000-8000-000000000001',staffUserPoolId:'us-east-1_example',staffClientId:'staff-client'};
  const mockPool={query:async(_sql:string,params:unknown[])=>{
    assert.deepEqual(params,[tenant.organizationId,['employee-1','employee-subject']]);
    return {rows:[{
      organization_id:tenant.organizationId,
      organization_name:'Example Health Group',
      staff_name:'Alex Morgan',
      location_id:'00000000-0000-4000-8000-000000000002',
      location_name:'Downtown Clinic',
      location_address:'100 Main Street',
      timezone:'America/New_York',
      roles:['front_desk'],
    }]};
  }};
  const server=createHealthcareServer({
    registry:{list:async()=>[tenant]},
    pools:{get:async()=>mockPool},
    verifierFor:()=>({verify:async()=>{throw new Error('Patient verifier must not authenticate workforce requests');}}),
    workforceAuth:{userPoolId:'us-east-1_workforce',clientId:'workforce-client'},
    workforceVerifier:{verify:async()=>({sub:'employee-subject',username:'employee-1',token_use:'access',client_id:'workforce-client'})},
  } as never);
  await new Promise<void>((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  try {
    const address=server.address(); if(!address || typeof address==='string') throw new Error('No test server address');
    const response=await fetch(`http://127.0.0.1:${address.port}/v1/session/workspaces`,{headers:{authorization:'Bearer test-token'}});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{workspaces:[{
      organizationId:tenant.organizationId,
      organizationName:'Example Health Group',
      staffName:'Alex Morgan',
      locationId:'00000000-0000-4000-8000-000000000002',
      locationName:'Downtown Clinic',
      locationAddress:'100 Main Street',
      timezone:'America/New_York',
      roles:['front_desk'],
    }]});
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

test('staff, patient, and admin endpoints reject a valid token without the required portal role',async()=>{
  const tenant={organizationId:'00000000-0000-4000-8000-000000000001',staffUserPoolId:'us-east-1_example',staffClientId:'portal-client'};
  const server=createHealthcareServer({registry:{list:async()=>[tenant]},pools:{},verifierFor:()=>({verify:async()=>({sub:'wrong-role',token_use:'access',client_id:'portal-client','cognito:groups':['unrelated']})})} as never);
  await new Promise<void>((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  try {
    const address=server.address();if(!address||typeof address==='string')throw new Error('No address');
    for(const path of ['/v1/patient/home','/v1/patient/clinics','/v1/admin/clients']){
      const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{headers:{authorization:'Bearer token'}});
      assert.equal(response.status,403);
    }
    const booking=await fetch(`http://127.0.0.1:${address.port}/v1/patient/appointments`,{method:'POST',headers:{authorization:'Bearer token','content-type':'application/json'},body:JSON.stringify({clinic:'ExampleBookingKey_123456789',appointmentType:'Cleaning'})});
    assert.equal(booking.status,403);
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('clinic choices are identified by booking link only, and the patient portal never sees internal clinic ids',async()=>{
  const north='00000000-0000-4000-8000-000000000002', south='00000000-0000-4000-8000-000000000003', unlinked='00000000-0000-4000-8000-000000000004';
  const tenant={organizationId:'00000000-0000-4000-8000-000000000001',staffUserPoolId:'us-east-1_example',staffClientId:'portal-client',bookingClinics:[{key:'NorthBookingKey_123456789',locationId:north,clinicName:'North',timezone:'America/New_York'},{key:'SouthBookingKey_123456789',locationId:south,clinicName:'South',timezone:'America/New_York'}]};
  const mockPool={query:async(sql:string)=>{
    if(sql.includes('booking_clinics')) return {rows:[north,south,unlinked].map((id,index)=>({location_id:id,name:['North','South','No booking link'][index],address:`${index+1} Example Street`,timezone:'America/New_York'}))};
    if(sql.includes('patient_portal_home')) return {rows:[{home:{patient:{firstName:'Jordan'},clinic:{id:south,name:'South'},appointments:[],documents:[]}}]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const server=createHealthcareServer({
    registry:{findBooking:async(key:string)=>key==='NorthBookingKey_123456789'?{tenant,clinic:tenant.bookingClinics[0]}:undefined,list:async()=>[tenant]},
    pools:{get:async()=>mockPool},
    verifierFor:()=>({verify:async()=>({sub:'patient-1',token_use:'access',client_id:'portal-client','cognito:groups':['dentalems_patient']})}),
  } as never);
  await new Promise<void>((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  try {
    const address=server.address(); if(!address || typeof address==='string') throw new Error('No test server address');
    const url=(path:string)=>`http://127.0.0.1:${address.port}${path}`;
    const publicList=await (await fetch(url('/v1/public/booking/NorthBookingKey_123456789/clinics'))).json() as {clinics:unknown[]};
    assert.deepEqual(publicList.clinics,[{key:'NorthBookingKey_123456789',name:'North',address:'1 Example Street',timezone:'America/New_York'},{key:'SouthBookingKey_123456789',name:'South',address:'2 Example Street',timezone:'America/New_York'}],'a clinic without a booking link is not offered');
    const portalList=await (await fetch(url('/v1/patient/clinics'),{headers:{authorization:'Bearer token'}})).json() as {clinics:{name:string;current:boolean}[]};
    assert.deepEqual(portalList.clinics.map(clinic=>[clinic.name,clinic.current]),[['North',false],['South',true]]);
    const home=await (await fetch(url('/v1/patient/home'),{headers:{authorization:'Bearer token'}})).json();
    assert.deepEqual(home.clinic,{name:'South'});
    for(const body of [publicList,portalList,home]) for(const id of [north,south,unlinked]) assert.ok(!JSON.stringify(body).includes(id));
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

test('once the patient username pool is configured, patient sign-ins are checked against it and not the organization\'s pool',async()=>{
  const tenant={organizationId:'00000000-0000-4000-8000-000000000001',staffUserPoolId:'original-pool',staffClientId:'original-client',bookingClinics:[]};
  const verified:string[]=[];
  const server=createHealthcareServer({
    registry:{list:async()=>[tenant]},
    pools:{get:async()=>({query:async()=>({rows:[{home:{patient:{firstName:'Jamie'},clinic:{id:'x',name:'Clinic'},appointments:[],documents:[]}}]})})},
    verifierFor:()=>({verify:async()=>{ verified.push('original'); return {sub:'p',token_use:'access',client_id:'original-client','cognito:groups':['dentalems_patient']}; }}),
    patientAuth:{userPoolId:'patients-pool',clientId:'patient-portal-client'},
    patientVerifier:{verify:async()=>{ verified.push('patients'); return {sub:'p',token_use:'access',client_id:'patient-portal-client','cognito:groups':['dentalems_patient']}; }},
  } as never);
  await new Promise<void>((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  try {
    const address=server.address(); if(!address || typeof address==='string') throw new Error('No test server address');
    const response=await fetch(`http://127.0.0.1:${address.port}/v1/patient/home`,{headers:{authorization:'Bearer token'}});
    assert.equal(response.status,200);
    assert.deepEqual(verified,['patients']);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
