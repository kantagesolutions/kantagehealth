// The API runs as several tasks, each with its own TenantRegistry over one shared secret. A change one task
// makes must reach the others, and must never be undone by another task's older copy.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { TenantRegistry, type TenantConfig } from '../src/tenant-registry.js';

function sharedSecret(initial:TenantConfig[]){
  let value=JSON.stringify({tenants:initial}); let reads=0;
  return {
    reads:()=>reads,
    client:{send:async(command:unknown)=>{
      if(command instanceof GetSecretValueCommand){ reads+=1; return {SecretString:value}; }
      if(command instanceof PutSecretValueCommand){ value=command.input.SecretString!; return {}; }
      throw new Error('Unexpected command');
    }},
  };
}
// A clock each test moves by hand, standing in for the time between requests.
function clock(){ let now=1_000_000; return {now:()=>now,advance:(ms:number)=>{now+=ms;}}; }
const tenant=(n:number):TenantConfig=>({organizationId:`00000000-0000-4000-8000-00000000000${n}`,databaseSecretArn:'arn:db',documentsBucket:'docs-bucket',staffUserPoolId:'pool',staffClientId:'client',bookingClinics:[{key:`BookingKeyForTenant_${n}_000000`,locationId:`00000000-0000-4000-9000-00000000000${n}`,clinicName:`Clinic ${n}`,timezone:'America/New_York'}]});

test('an organization one task creates is found by another task',async()=>{
  const secret=sharedSecret([tenant(1)]);
  const time=clock(), taskA=new TenantRegistry(secret.client,'registry',time.now), taskB=new TenantRegistry(secret.client,'registry',time.now);
  await taskB.list();
  await taskA.add(tenant(2));
  // A lookup that misses re-reads once its copy is a second old.
  time.advance(1_000);
  assert.equal((await taskB.get(tenant(2).organizationId)).organizationId,tenant(2).organizationId);
  assert.equal((await taskB.findBooking(tenant(2).bookingClinics[0]!.key))?.clinic.clinicName,'Clinic 2');
});

test('a task with an older copy never undoes another task\'s change when it writes',async()=>{
  const secret=sharedSecret([tenant(1)]);
  const time=clock(), taskA=new TenantRegistry(secret.client,'registry',time.now), taskB=new TenantRegistry(secret.client,'registry',time.now);
  await taskB.list();
  await taskA.add(tenant(2));
  await taskB.add(tenant(3));
  const reader=new TenantRegistry(secret.client,'registry');
  assert.deepEqual((await reader.list()).map(item=>item.organizationId).sort(),[tenant(1),tenant(2),tenant(3)].map(item=>item.organizationId));
});

test('a clinic rename on one task reaches the other, so the booking page shows the new name',async()=>{
  const secret=sharedSecret([tenant(1)]);
  const time=clock(), taskA=new TenantRegistry(secret.client,'registry',time.now), taskB=new TenantRegistry(secret.client,'registry',time.now);
  await taskB.list();
  await taskA.updateBookingClinic(tenant(1).organizationId,tenant(1).bookingClinics[0]!.locationId,{clinicName:'Renamed',timezone:'America/Chicago'});
  // The link still resolves on the old copy, so the new name arrives when that copy expires.
  assert.equal((await taskB.findBooking(tenant(1).bookingClinics[0]!.key))?.clinic.clinicName,'Clinic 1');
  time.advance(30_000);
  assert.equal((await taskB.findBooking(tenant(1).bookingClinics[0]!.key))?.clinic.clinicName,'Renamed');
});

test('unknown booking links cannot make every request re-read the registry',async()=>{
  const secret=sharedSecret([tenant(1)]);
  const time=clock(), registry=new TenantRegistry(secret.client,'registry',time.now);
  await registry.list(); const before=secret.reads();
  // Fifty unknown links within one second, then fifty more in the next: one re-read each second at most.
  for(let i=0;i<50;i+=1) { assert.equal(await registry.findBooking(`UnknownBookingKey_${i}_000000`),undefined); assert.equal(await registry.find(`ffffffff-0000-4000-8000-${String(i).padStart(12,'0')}`),undefined); }
  time.advance(1_000);
  for(let i=0;i<50;i+=1) assert.equal(await registry.findBooking(`UnknownBookingKey_${i}_000000`),undefined);
  assert.equal(secret.reads()-before,1);
});

test('a failed read of the registry is tried again on the next request',async()=>{
  let fail=true;
  const secret=sharedSecret([tenant(1)]);
  const flaky={send:async(command:unknown)=>{ if(fail){ fail=false; throw new Error('Throttled'); } return secret.client.send(command); }};
  const registry=new TenantRegistry(flaky,'registry');
  await assert.rejects(registry.list(),/Throttled/);
  assert.equal((await registry.list()).length,1);
});
