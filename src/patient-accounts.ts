import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand, AdminResetUserPasswordCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { Pool } from 'pg';

export interface PatientInvite { organizationId:string; patientId:string; email?:string|null; phone:string; firstName:string; lastName:string; clinicName:string; textConsent:boolean; existingUsername?:string|null; }
export interface PatientInviteResult { username:string; sub:string; emailSent:boolean; textSent:boolean; }
// What a reset sent: a new invitation for an account never signed in to, or a reset code otherwise.
export type PatientLoginReset='invitation_resent'|'reset_code_sent';
export interface PatientAccountProvisioner { invite(input:PatientInvite):Promise<PatientInviteResult|undefined>; resetLogin(username:string):Promise<PatientLoginReset>; }

function subOf(attributes:{Name?:string;Value?:string}[]|undefined){ return attributes?.find(item=>item.Name==='sub')?.Value; }
const errorName=(error:unknown)=>error instanceof Error?error.name:'';

// A patient signs in as first.last, lowercase, without accents or punctuation: "María O'Neil" is
// maria.oneil. The next patient with the same name is maria.oneil2, then maria.oneil3.
export function patientUsernameBase(firstName:string,lastName:string):string {
  const part=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
  return [part(firstName),part(lastName)].filter(Boolean).join('.').slice(0,60)||'patient';
}
export function* patientUsernames(base:string):Generator<string> {
  yield base;
  for(let n=2;n<=999;n+=1) yield `${base}${n}`;
}

export class CognitoPatientAccountProvisioner implements PatientAccountProvisioner {
  // usernames: the pool signs patients in by username rather than email, so accounts are named after the
  // patient. The original patient pool can only take email addresses as usernames.
  constructor(private cognito=new CognitoIdentityProviderClient({}),private sns=new SNSClient({}),private userPoolId=process.env.PATIENT_USER_POOL_ID??process.env.STAFF_USER_POOL_ID??'',private options:{usernames:boolean}={usernames:false}){}
  async invite(input:PatientInvite){
    if(!this.userPoolId || !input.email) return undefined;
    const account=this.options.usernames?await this.namedAccount(input):await this.emailAccount(input);
    await this.cognito.send(new AdminAddUserToGroupCommand({UserPoolId:this.userPoolId,Username:account.username,GroupName:'dentalems_patient'}));
    let textSent=false;
    if(input.textConsent) {
      try {
        const signIn=this.options.usernames?` Your username is ${account.username}.`:'';
        await this.sns.send(new PublishCommand({PhoneNumber:input.phone,Message:`${input.clinicName}: your patient portal invitation was sent to ${input.email}.${signIn} Visit https://patient.health.kantage.solutions to activate it. Reply STOP to opt out.`}));
        textSent=true;
      } catch { textSent=false; }
    }
    return {...account,textSent};
  }

  // An account this patient already has is kept, and is not sent another unsolicited invitation: staff use
  // Reset login for that. Otherwise the first free username for their name is taken. Creating the account
  // is what claims the name, so two invitations at once cannot end up with the same one.
  private async namedAccount(input:PatientInvite){
    if(input.existingUsername) {
      try {
        const existing=await this.cognito.send(new AdminGetUserCommand({UserPoolId:this.userPoolId,Username:input.existingUsername}));
        const sub=subOf(existing.UserAttributes); if(!sub) throw new Error('Patient account identity was not returned');
        return {username:existing.Username??input.existingUsername,sub,emailSent:false};
      } catch(error) { if(errorName(error)!=='UserNotFoundException') throw error; }
    }
    for(const username of patientUsernames(patientUsernameBase(input.firstName,input.lastName))) {
      try {
        const created=await this.cognito.send(new AdminCreateUserCommand({UserPoolId:this.userPoolId,Username:username,UserAttributes:[{Name:'email',Value:input.email!.toLowerCase()},{Name:'email_verified',Value:'true'},{Name:'given_name',Value:input.firstName},{Name:'family_name',Value:input.lastName}],DesiredDeliveryMediums:['EMAIL']}));
        const sub=subOf(created.User?.Attributes); if(!sub) throw new Error('Patient account identity was not returned');
        return {username:created.User?.Username??username,sub,emailSent:true};
      } catch(error) { if(errorName(error)!=='UsernameExistsException') throw error; }
    }
    throw new Error('No username is free for this patient name');
  }

  async resetLogin(username:string):Promise<PatientLoginReset>{
    if(!this.userPoolId) throw new Error('Patient portal access is unavailable');
    const user=await this.cognito.send(new AdminGetUserCommand({UserPoolId:this.userPoolId,Username:username}));
    // Never signed in: the invitation is sent again with a new temporary password.
    if(user.UserStatus==='FORCE_CHANGE_PASSWORD') {
      await this.cognito.send(new AdminCreateUserCommand({UserPoolId:this.userPoolId,Username:username,MessageAction:'RESEND',DesiredDeliveryMediums:['EMAIL']}));
      return 'invitation_resent';
    }
    await this.cognito.send(new AdminResetUserPasswordCommand({UserPoolId:this.userPoolId,Username:username}));
    return 'reset_code_sent';
  }

  private async emailAccount(input:PatientInvite){
    let username=input.email!.toLowerCase();
    let sub:string|undefined;
    let emailSent=false;
    try {
      const created=await this.cognito.send(new AdminCreateUserCommand({UserPoolId:this.userPoolId,Username:username,UserAttributes:[{Name:'email',Value:username},{Name:'email_verified',Value:'true'},{Name:'given_name',Value:input.firstName}],DesiredDeliveryMediums:['EMAIL']}));
      username=created.User?.Username??username;
      sub=subOf(created.User?.Attributes);
      emailSent=true;
    } catch(error) {
      if(!(error instanceof Error) || error.name!=='UsernameExistsException') throw error;
      const existing=await this.cognito.send(new AdminGetUserCommand({UserPoolId:this.userPoolId,Username:username}));
      username=existing.Username??username;
      sub=subOf(existing.UserAttributes);
      // An existing account must not receive another unsolicited activation email.
      // Staff can tell the patient to use the normal password recovery flow instead.
      emailSent=false;
    }
    if(!sub) throw new Error('Patient account identity was not returned');
    return {username,sub,emailSent};
  }
}

export async function savePatientInvite(pool:Pool,input:PatientInvite,result:PatientInviteResult){
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org',$1,true)",[input.organizationId]);
    await client.query(`INSERT INTO clinical.patient_portal_accounts(organization_id,patient_id,cognito_sub,username,status,email_sent,text_sent,sms_consent)
      VALUES($1,$2,$3,$4,'invited',$5,$6,$7)
      ON CONFLICT(organization_id,patient_id) DO UPDATE SET cognito_sub=excluded.cognito_sub,username=excluded.username,status='invited',email_sent=excluded.email_sent,text_sent=excluded.text_sent,sms_consent=excluded.sms_consent,invited_at=now()`,
      [input.organizationId,input.patientId,result.sub,result.username,result.emailSent,result.textSent,input.textConsent]);
    await client.query(`UPDATE clinical.booking_inquiries SET activation_status=$1 WHERE organization_id=$2 AND patient_id=$3`,[result.emailSent?'invited':'partial',input.organizationId,input.patientId]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
  finally { client.release(); }
}
