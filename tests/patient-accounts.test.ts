import assert from 'node:assert/strict';
import test from 'node:test';
import { CognitoPatientAccountProvisioner, patientUsernameBase } from '../src/patient-accounts.js';

// A patient pool holding the given usernames. Creating one that exists fails as Cognito does.
function fakeCognito(existing:Record<string,string>={}) {
  const commands:{name:string;input:Record<string,unknown>}[]=[];
  const users=new Map(Object.entries(existing));
  const fail=(name:string)=>Object.assign(new Error(name),{name});
  return {
    commands, users,
    client:{send:async(command:{constructor:{name:string};input:Record<string,unknown>})=>{
      const name=command.constructor.name, input=command.input, username=String(input.Username);
      commands.push({name,input});
      if(name==='AdminCreateUserCommand') {
        if(input.MessageAction==='RESEND') return {};
        if(users.has(username)) throw fail('UsernameExistsException');
        users.set(username,'FORCE_CHANGE_PASSWORD');
        return {User:{Username:username,Attributes:[{Name:'sub',Value:`sub-${username}`}]}};
      }
      if(name==='AdminGetUserCommand') {
        if(!users.has(username)) throw fail('UserNotFoundException');
        return {Username:username,UserStatus:users.get(username),UserAttributes:[{Name:'sub',Value:`sub-${username}`}]};
      }
      return {};
    }},
  };
}
const noTexts={send:async()=>{ throw new Error('no text expected'); }};
const invitation={organizationId:'00000000-0000-4000-8000-000000000001',patientId:'00000000-0000-4000-8000-000000000002',email:'patient@example.com',phone:'+14435550100',firstName:'Jamie',lastName:'Rivera',clinicName:'Example Dental'};
const named=(cognito:ReturnType<typeof fakeCognito>,sns:unknown=noTexts)=>new CognitoPatientAccountProvisioner(cognito.client as never,sns as never,'us-east-1_test',{usernames:true});

test('a username is the patient\'s first and last name, lowercase, without accents or punctuation',()=>{
  assert.equal(patientUsernameBase('Ibrahim','Barry'),'ibrahim.barry');
  assert.equal(patientUsernameBase('María José',"O'Neil-Smith"),'mariajose.oneilsmith');
  assert.equal(patientUsernameBase('  Zoë ','Ångström'),'zoe.angstrom');
  assert.equal(patientUsernameBase('李','王'),'patient','a name with no Latin letters still gets a valid username');
});

test('a new patient gets their name as username, the account is created with their email, and they join the patient group',async()=>{
  const cognito=fakeCognito();
  const result=await named(cognito).invite({...invitation,firstName:'Ibrahim',lastName:'Barry',textConsent:false});
  assert.deepEqual(result,{username:'ibrahim.barry',sub:'sub-ibrahim.barry',emailSent:true,textSent:false});
  const create=cognito.commands.find(command=>command.name==='AdminCreateUserCommand');
  assert.deepEqual(create?.input.UserAttributes,[{Name:'email',Value:'patient@example.com'},{Name:'email_verified',Value:'true'},{Name:'given_name',Value:'Ibrahim'},{Name:'family_name',Value:'Barry'}]);
  assert.equal(cognito.commands.at(-1)?.name,'AdminAddUserToGroupCommand');
  assert.equal(cognito.commands.at(-1)?.input.GroupName,'dentalems_patient');
});

test('a second patient with the same name gets ibrahim.barry2, and a third ibrahim.barry3',async()=>{
  const cognito=fakeCognito({'ibrahim.barry':'CONFIRMED'});
  assert.equal((await named(cognito).invite({...invitation,firstName:'Ibrahim',lastName:'Barry',textConsent:false}))?.username,'ibrahim.barry2');
  assert.equal((await named(cognito).invite({...invitation,patientId:'00000000-0000-4000-8000-000000000003',firstName:'IBRAHIM',lastName:'barry',textConsent:false}))?.username,'ibrahim.barry3');
});

test('enabling access again keeps the patient\'s account and sends no unsolicited invitation',async()=>{
  const cognito=fakeCognito({'jamie.rivera':'CONFIRMED'});
  const result=await named(cognito).invite({...invitation,existingUsername:'jamie.rivera',textConsent:false});
  assert.deepEqual(result,{username:'jamie.rivera',sub:'sub-jamie.rivera',emailSent:false,textSent:false});
  assert.ok(!cognito.commands.some(command=>command.name==='AdminCreateUserCommand'));
});

test('an account from the original email pool is replaced by a named one',async()=>{
  const cognito=fakeCognito();
  const result=await named(cognito).invite({...invitation,existingUsername:'patient@example.com',textConsent:false});
  assert.equal(result?.username,'jamie.rivera');
  assert.equal(result?.emailSent,true);
});

test('the text after consent gives the patient their username',async()=>{
  const sent:string[]=[];
  await named(fakeCognito(),{send:async(command:{input:{Message:string}})=>{ sent.push(command.input.Message); return {}; }}).invite({...invitation,textConsent:true});
  assert.equal(sent.length,1);
  assert.match(sent[0]!,/Your username is jamie\.rivera\./);
});

test('reset login resends the invitation to a patient who never signed in, and sends a reset code otherwise',async()=>{
  const cognito=fakeCognito({'new.patient':'FORCE_CHANGE_PASSWORD','active.patient':'CONFIRMED'});
  const provisioner=named(cognito);
  assert.equal(await provisioner.resetLogin('new.patient'),'invitation_resent');
  assert.deepEqual(cognito.commands.at(-1),{name:'AdminCreateUserCommand',input:{UserPoolId:'us-east-1_test',Username:'new.patient',MessageAction:'RESEND',DesiredDeliveryMediums:['EMAIL']}});
  assert.equal(await provisioner.resetLogin('active.patient'),'reset_code_sent');
  assert.equal(cognito.commands.at(-1)?.name,'AdminResetUserPasswordCommand');
  await assert.rejects(provisioner.resetLogin('nobody'),{name:'UserNotFoundException'});
});

// The original pool: usernames are email addresses, as before.
test('in the original pool the email is the username and an existing account is not invited again',async()=>{
  const cognito=fakeCognito({'patient@example.com':'CONFIRMED'});
  const provisioner=new CognitoPatientAccountProvisioner(cognito.client as never,noTexts as never,'us-east-1_test');
  const result=await provisioner.invite({...invitation,textConsent:false});
  assert.deepEqual(result,{username:'patient@example.com',sub:'sub-patient@example.com',emailSent:false,textSent:false});
  const fresh=fakeCognito();
  assert.equal((await new CognitoPatientAccountProvisioner(fresh.client as never,noTexts as never,'us-east-1_test').invite({...invitation,textConsent:false}))?.username,'patient@example.com');
});

test('patient portal invitation sends one text after explicit consent, and none without it',async()=>{
  let texts=0; const sns={send:async()=>{texts+=1;return {};}};
  const provisioner=new CognitoPatientAccountProvisioner(fakeCognito().client as never,sns as never,'us-east-1_test');
  assert.equal((await provisioner.invite({...invitation,textConsent:false}))?.textSent,false);
  assert.equal(texts,0);
  const again=new CognitoPatientAccountProvisioner(fakeCognito().client as never,sns as never,'us-east-1_test');
  assert.equal((await again.invite({...invitation,textConsent:true}))?.textSent,true);
  assert.equal(texts,1);
});
