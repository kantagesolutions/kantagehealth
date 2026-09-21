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
