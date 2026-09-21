import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyStaffToken } from '../src/auth.js';

const config={userPoolId:'us-east-1_example',clientId:'staff-client'};

test('only a verified Cognito access token for this client is accepted',async()=>{
  const claims=await verifyStaffToken('test-token',config,{verify:async()=>({sub:'staff-1',token_use:'access',client_id:'staff-client'})});
  assert.equal(claims.sub,'staff-1');
  await assert.rejects(verifyStaffToken('test-token',config,{verify:async()=>({sub:'staff-1',token_use:'id',client_id:'staff-client'})}),/Unauthorized/);
  await assert.rejects(verifyStaffToken('test-token',config,{verify:async()=>({sub:'staff-1',token_use:'access',client_id:'another-client'})}),/Unauthorized/);
});
