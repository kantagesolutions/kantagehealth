import assert from 'node:assert/strict';
import test from 'node:test';
import { CognitoPatientAccountProvisioner } from '../src/patient-accounts.js';

function fakeCognito() {
  const commands:string[]=[];
  return {
    commands,
    client:{send:async(command:unknown)=>{
      const name=(command as {constructor:{name:string}}).constructor.name;
      commands.push(name);
      if(name==='AdminCreateUserCommand') return {User:{Username:'patient@example.com',Attributes:[{Name:'sub',Value:'patient-sub'}]}};
      return {};
    }},
  };
}

const invitation={organizationId:'00000000-0000-4000-8000-000000000001',patientId:'00000000-0000-4000-8000-000000000002',email:'patient@example.com',phone:'+14435550100',firstName:'Jamie',clinicName:'Example Dental'};

test('patient portal invitation does not text without explicit consent',async()=>{
  const cognito=fakeCognito();let texts=0;
  const provisioner=new CognitoPatientAccountProvisioner(cognito.client as never,{send:async()=>{texts+=1;return {};}} as never,'us-east-1_test');
  const result=await provisioner.invite({...invitation,textConsent:false});
  assert.equal(result?.emailSent,true);
  assert.equal(result?.textSent,false);
  assert.equal(texts,0);
  assert.deepEqual(cognito.commands,['AdminCreateUserCommand','AdminAddUserToGroupCommand']);
});

test('patient portal invitation sends one text after explicit consent',async()=>{
  const cognito=fakeCognito();let texts=0;
  const provisioner=new CognitoPatientAccountProvisioner(cognito.client as never,{send:async()=>{texts+=1;return {};}} as never,'us-east-1_test');
  const result=await provisioner.invite({...invitation,textConsent:true});
  assert.equal(result?.textSent,true);
  assert.equal(texts,1);
});
