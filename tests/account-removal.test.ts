import assert from 'node:assert/strict';
import test from 'node:test';
import { CognitoIdentityRemover } from '../src/account-removal.js';

function fakeIdentity(sub:string,groups:string[]=[]){
  const calls:string[]=[];
  const client={send:async(command:{constructor:{name:string}})=>{
    const name=command.constructor.name; calls.push(name);
    if(name==='AdminGetUserCommand') return {Username:'example.user',UserAttributes:[{Name:'sub',Value:sub}]};
    if(name==='AdminListGroupsForUserCommand') return {Groups:groups.map(GroupName=>({GroupName}))};
    return {};
  }};
  return {client,calls};
}

test('patient identity removal requires the exact stored Cognito subject',async()=>{
  const fake=fakeIdentity('real-sub');
  const remover=new CognitoIdentityRemover(fake.client as never,['patient-pool'],'staff-pool');
  await assert.rejects(remover.removePatient('example.user','other-sub'),/different identity/);
  assert.deepEqual(fake.calls,['AdminGetUserCommand']);
  await remover.removePatient('example.user','real-sub');
  assert.deepEqual(fake.calls.slice(1),['AdminGetUserCommand','AdminDeleteUserCommand']);
});

test('platform administrators cannot be removed through staff cleanup',async()=>{
  const fake=fakeIdentity('staff-sub',['platform_admin']);
  const remover=new CognitoIdentityRemover(fake.client as never,['patient-pool'],'staff-pool');
  await assert.rejects(remover.removeStaff('example.user'),/Platform administrator/);
  assert.equal(fake.calls.includes('AdminDeleteUserCommand'),false);
});

test('ordinary staff identity can be removed',async()=>{
  const fake=fakeIdentity('staff-sub',['dentalems_staff']);
  const remover=new CognitoIdentityRemover(fake.client as never,['patient-pool'],'staff-pool');
  await remover.removeStaff('example.user');
  assert.deepEqual(fake.calls,['AdminGetUserCommand','AdminListGroupsForUserCommand','AdminDeleteUserCommand']);
});
