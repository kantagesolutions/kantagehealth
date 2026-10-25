import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

export interface WorkforceInvite { username:string; email:string; name:string; }
export interface WorkforceInviteResult { username:string; }
export interface WorkforceAccountProvisioner { invite(input:WorkforceInvite):Promise<WorkforceInviteResult>; }

export class CognitoWorkforceAccountProvisioner implements WorkforceAccountProvisioner {
  constructor(private readonly cognito=new CognitoIdentityProviderClient({}),private readonly userPoolId=process.env.WORKFORCE_USER_POOL_ID??'') {}
  async invite(input:WorkforceInvite):Promise<WorkforceInviteResult> {
    if(!this.userPoolId) throw new Error('Workforce identity service is unavailable');
    const username=input.username.trim().toLowerCase();
    try {
      const created=await this.cognito.send(new AdminCreateUserCommand({
        UserPoolId:this.userPoolId,
        Username:username,
        UserAttributes:[{Name:'email',Value:input.email.trim().toLowerCase()},{Name:'name',Value:input.name.trim()}],
        DesiredDeliveryMediums:['EMAIL'],
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
}
