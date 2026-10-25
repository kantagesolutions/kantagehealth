import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { Pool } from 'pg';

export interface PatientInvite { organizationId:string; patientId:string; email?:string|null; phone:string; firstName:string; clinicName:string; textConsent:boolean; }
export interface PatientInviteResult { username:string; sub:string; emailSent:boolean; textSent:boolean; }
export interface PatientAccountProvisioner { invite(input:PatientInvite):Promise<PatientInviteResult|undefined>; }

function subOf(attributes:{Name?:string;Value?:string}[]|undefined){ return attributes?.find(item=>item.Name==='sub')?.Value; }

export class CognitoPatientAccountProvisioner implements PatientAccountProvisioner {
  constructor(private cognito=new CognitoIdentityProviderClient({}),private sns=new SNSClient({}),private userPoolId=process.env.PATIENT_USER_POOL_ID??process.env.STAFF_USER_POOL_ID??''){}
  async invite(input:PatientInvite){
    if(!this.userPoolId || !input.email) return undefined;
    let username=input.email.toLowerCase();
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
    await this.cognito.send(new AdminAddUserToGroupCommand({UserPoolId:this.userPoolId,Username:username,GroupName:'dentalems_patient'}));
    let textSent=false;
    if(input.textConsent) {
      try {
        await this.sns.send(new PublishCommand({PhoneNumber:input.phone,Message:`${input.clinicName}: your patient portal invitation was sent to ${input.email}. Visit https://patient.health.kantage.solutions to activate it. Reply STOP to opt out.`}));
        textSent=true;
      } catch { textSent=false; }
    }
    return {username,sub,emailSent,textSent};
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
