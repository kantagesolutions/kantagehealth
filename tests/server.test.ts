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
