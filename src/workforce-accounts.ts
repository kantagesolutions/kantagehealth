import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand, AdminSetUserPasswordCommand, AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { AccessError } from './context.js';

export interface WorkforceInvite { username:string; email:string; name:string; }
export interface WorkforceInviteResult { username:string; }
export interface WorkforceAccountProvisioner {
  invite(input:WorkforceInvite):Promise<WorkforceInviteResult>;
  setPassword(username:string,password:string):Promise<void>;
}

export class CognitoWorkforceAccountProvisioner implements WorkforceAccountProvisioner {
  constructor(private readonly cognito=new CognitoIdentityProviderClient({}),private readonly userPoolId=process.env.WORKFORCE_USER_POOL_ID??'') {}
  async invite(input:WorkforceInvite):Promise<WorkforceInviteResult> {
    if(!this.userPoolId) throw new Error('Workforce identity service is unavailable');
    const username=input.username.trim().toLowerCase();
    try {
      const created=await this.cognito.send(new AdminCreateUserCommand({
        UserPoolId:this.userPoolId,
        Username:username,
        // The email is verified so the person can reset a forgotten password later. Cognito sends nothing:
        // the administrator hands over a one-time link where the person chooses their own password.
        UserAttributes:[{Name:'email',Value:input.email.trim().toLowerCase()},{Name:'email_verified',Value:'true'},{Name:'name',Value:input.name.trim()}],
        MessageAction:'SUPPRESS',
      }));
      await this.cognito.send(new AdminAddUserToGroupCommand({UserPoolId:this.userPoolId,Username:created.User?.Username??username,GroupName:'dentalems_staff'}));
      return {username:created.User?.Username??username};
    } catch(error) {
      if(!(error instanceof Error) || error.name!=='UsernameExistsException') throw error;
      const existing=await this.cognito.send(new AdminGetUserCommand({UserPoolId:this.userPoolId,Username:username}));
      await this.cognito.send(new AdminAddUserToGroupCommand({UserPoolId:this.userPoolId,Username:existing.Username??username,GroupName:'dentalems_staff'}));
      return {username:existing.Username??username};
    }
  }
  // Sets the password the person chose as permanent, so their first sign in needs no temporary one.
  async setPassword(username:string,password:string):Promise<void> {
    if(!this.userPoolId) throw new Error('Workforce identity service is unavailable');
    try {
      await this.cognito.send(new AdminSetUserPasswordCommand({UserPoolId:this.userPoolId,Username:username,Password:password,Permanent:true}));
    } catch(error) {
      if(error instanceof Error && error.name==='InvalidPasswordException') throw new AccessError(400,'Choose a password of at least 14 characters with upper and lower case letters, a number and a symbol.');
      throw error;
    }
    // Accounts invited before links existed may have an unverified email, which blocks password resets.
    await this.cognito.send(new AdminUpdateUserAttributesCommand({UserPoolId:this.userPoolId,Username:username,UserAttributes:[{Name:'email_verified',Value:'true'}]}));
  }
}
