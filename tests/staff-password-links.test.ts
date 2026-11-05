import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { createPlatformStaff, issueStaffPasswordLink, readStaffPasswordLink, setStaffPassword } from '../src/platform-admin.js';
import { CognitoWorkforceAccountProvisioner, type WorkforceAccountProvisioner } from '../src/workforce-accounts.js';
import type { TenantConfig } from '../src/tenant-registry.js';

const connectionString=process.env.TEST_DATABASE_URL ?? 'postgresql://venuscollective@127.0.0.1:55439/kantage_healthcare_test';
// The link functions are SECURITY DEFINER and the public routes have no sign in, so everything runs as
// the restricted request role.
const appPool=new Pool({connectionString:connectionString.replace(/\/\/[^@]+@/,'//kh_test_request@'),max:4,idleTimeoutMillis:1_000});
const pools={get:async()=>appPool} as never;
const actor={username:'test.admin'};
const run=randomUUID().slice(0,8);
const orgId=randomUUID(), clinicId=randomUUID(), staffId=randomUUID(), otherOrg=randomUUID();
const username=`nel.${run}`;
const tenants=[{organizationId:orgId},{organizationId:otherOrg}] as TenantConfig[];

// Records which passwords were set for whom; rejects weak ones the way Cognito does.
function accounts(){
  const set:{username:string;password:string}[]=[];
  const provisioner:WorkforceAccountProvisioner={
    invite:async input=>({username:input.username.toLowerCase()}),
    setPassword:async(user,password)=>{ if(password.length<14) { const { AccessError }=await import('../src/context.js'); throw new AccessError(400,'weak'); } set.push({username:user,password}); },
  };
  return {set,provisioner};
}
async function root<T>(work:(client:Client)=>Promise<T>){ const client=new Client({connectionString}); await client.connect(); try { return await work(client); } finally { await client.end(); } }

before(async()=>{
  await root(async client=>{
    await client.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kh_test_request') THEN CREATE ROLE kh_test_request LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$");
    await client.query('GRANT kh_request TO kh_test_request');
    await client.query('INSERT INTO clinical.organizations(id,slug,name,status) VALUES($1,$2,$3,$4),($5,$6,$7,$4)',[orgId,`links-${run}`,'Link Test Org','active',otherOrg,`links-other-${run}`,'Other Org']);
    await client.query('INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status) VALUES($1,$2,$3,$4,$5,$6)',[clinicId,orgId,'Clinic','America/New_York','','active']);
    await client.query('INSERT INTO clinical.users(id,organization_id,cognito_sub,email,name,status) VALUES($1,$2,$3,$4,$5,$6)',[staffId,orgId,username,`${username}@example.test`,'Nel Example','active']);
    await client.query('INSERT INTO clinical.user_roles(organization_id,user_id,role) VALUES($1,$2,$3)',[orgId,staffId,'front_desk']);
  });
});
after(async()=>{ await appPool.end(); });

test('a password link lets the staff member choose a password once, and only once',async()=>{
  const {set,provisioner}=accounts();
  const {passwordLink}=await issueStaffPasswordLink(tenants[0]!,pools,actor,orgId,staffId);
  assert.match(passwordLink.token,new RegExp(`^${orgId}\\.`));
  assert.deepEqual(await readStaffPasswordLink(tenants,pools,{token:passwordLink.token}),{name:'Nel Example',username});
  // A password the identity service rejects leaves the link usable, so they can try again.
  await assert.rejects(setStaffPassword(tenants,pools,provisioner,{token:passwordLink.token,password:'short'}),/weak/);
  await setStaffPassword(tenants,pools,provisioner,{token:passwordLink.token,password:'A-long-enough-Passw0rd!'});
  assert.deepEqual(set,[{username,password:'A-long-enough-Passw0rd!'}]);
  await assert.rejects(setStaffPassword(tenants,pools,provisioner,{token:passwordLink.token,password:'Another-long-Passw0rd!'}),/expired or was already used/);
  assert.equal(set.length,1);
  const actions=await root(async client=>(await client.query<{actor:string;action:string}>("SELECT actor,action FROM clinical.platform_audit_log WHERE organization_id=$1 AND action LIKE 'staff.password%' ORDER BY id",[orgId])).rows);
  assert.deepEqual(actions,[{actor:'test.admin',action:'staff.password_link'},{actor:username,action:'staff.password_set'}]);
});

test('only a hash of the link is stored, and a new link cancels the earlier one',async()=>{
  const {set,provisioner}=accounts();
  const first=(await issueStaffPasswordLink(tenants[0]!,pools,actor,orgId,staffId)).passwordLink;
  const second=(await issueStaffPasswordLink(tenants[0]!,pools,actor,orgId,staffId)).passwordLink;
  const stored=await root(async client=>(await client.query<{token_hash:string}>('SELECT token_hash FROM clinical.staff_password_links WHERE user_id=$1',[staffId])).rows.map(row=>row.token_hash));
  assert.ok(stored.every(hash=>/^[0-9a-f]{64}$/.test(hash)));
  assert.ok(!stored.some(hash=>first.token.includes(hash)||second.token.includes(hash)));
  await assert.rejects(readStaffPasswordLink(tenants,pools,{token:first.token}),/expired or was already used/);
  await setStaffPassword(tenants,pools,provisioner,{token:second.token,password:'A-long-enough-Passw0rd!'});
  assert.equal(set.length,1);
});

test('a link stops working when it expires or the staff member is suspended',async()=>{
  const {provisioner}=accounts();
  const expiring=(await issueStaffPasswordLink(tenants[0]!,pools,actor,orgId,staffId)).passwordLink;
  await root(client=>client.query("UPDATE clinical.staff_password_links SET expires_at=now()-interval '1 minute' WHERE user_id=$1 AND used_at IS NULL",[staffId]));
  await assert.rejects(readStaffPasswordLink(tenants,pools,{token:expiring.token}),/expired/);
  const live=(await issueStaffPasswordLink(tenants[0]!,pools,actor,orgId,staffId)).passwordLink;
  await root(client=>client.query("UPDATE clinical.users SET status='inactive' WHERE id=$1",[staffId]));
  try {
    await assert.rejects(setStaffPassword(tenants,pools,provisioner,{token:live.token,password:'A-long-enough-Passw0rd!'}),/expired or was already used/);
    await assert.rejects(issueStaffPasswordLink(tenants[0]!,pools,actor,orgId,staffId),/Restore this staff member/);
  } finally { await root(client=>client.query("UPDATE clinical.users SET status='active' WHERE id=$1",[staffId])); }
});

test('a link cannot be replayed against another organization or guessed',async()=>{
  const {provisioner}=accounts();
  const {passwordLink}=await issueStaffPasswordLink(tenants[0]!,pools,actor,orgId,staffId);
  const secret=passwordLink.token.slice(37);
  await assert.rejects(readStaffPasswordLink(tenants,pools,{token:`${otherOrg}.${secret}`}),/expired or was already used/);
  await assert.rejects(setStaffPassword(tenants,pools,provisioner,{token:`${orgId}.${'A'.repeat(43)}`,password:'A-long-enough-Passw0rd!'}),/expired or was already used/);
  await assert.rejects(readStaffPasswordLink(tenants,pools,{token:'not-a-token'}));
});

test('the request role cannot read the links table directly',async()=>{
  await assert.rejects(appPool.query('SELECT * FROM clinical.staff_password_links'),/permission denied/);
});

test('inviting staff returns a password link and asks Cognito to send no temporary password',async()=>{
  const sent:{name:string;input:Record<string,unknown>}[]=[];
  const cognito={send:async(command:{constructor:{name:string};input:Record<string,unknown>})=>{ sent.push({name:command.constructor.name,input:command.input}); return command.constructor.name==='AdminCreateUserCommand'?{User:{Username:`new.${run}`}}:{}; }};
  const provisioner=new CognitoWorkforceAccountProvisioner(cognito as never,'pool');
  const staff=await createPlatformStaff(tenants,pools,provisioner,actor,{organizationId:orgId,username:`new.${run}`,email:`new.${run}@example.test`,name:'New Person',role:'front_desk'});
  const create=sent.find(item=>item.name==='AdminCreateUserCommand')!;
  assert.equal(create.input.MessageAction,'SUPPRESS');
  assert.deepEqual((create.input.UserAttributes as {Name:string;Value:string}[]).find(item=>item.Name==='email_verified'),{Name:'email_verified',Value:'true'});
  assert.ok(staff.passwordLink?.token);
  assert.deepEqual(await readStaffPasswordLink(tenants,pools,{token:staff.passwordLink!.token}),{name:'New Person',username:`new.${run}`});
  await provisioner.setPassword(`new.${run}`,'A-long-enough-Passw0rd!');
  const setCommand=sent.find(item=>item.name==='AdminSetUserPasswordCommand')!;
  assert.equal(setCommand.input.Permanent,true);
  assert.ok(sent.some(item=>item.name==='AdminUpdateUserAttributesCommand'));
});
