import { AdminDeleteUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

export interface IdentityRemover {
  removePatient(username:string,expectedSub:string):Promise<void>;
  assertStaffRemovable(username:string):Promise<void>;
  removeStaff(username:string):Promise<void>;
}

export class CognitoIdentityRemover implements IdentityRemover {
  constructor(private readonly cognito=new CognitoIdentityProviderClient({}),
    private readonly patientPools=[process.env.PATIENT_USER_POOL_ID,process.env.STAFF_USER_POOL_ID].filter((value):value is string=>Boolean(value)),
    private readonly workforcePool=process.env.WORKFORCE_USER_POOL_ID??''){}

  async removePatient(username:string,expectedSub:string):Promise<void>{
    if(!this.patientPools.length) throw new Error('Patient identity service is unavailable');
    let usernameReused=false;
    for(const pool of this.patientPools){
      try {
        const found=await this.cognito.send(new AdminGetUserCommand({UserPoolId:pool,Username:username}));
        const sub=found.UserAttributes?.find(item=>item.Name==='sub')?.Value;
        if(sub!==expectedSub) { usernameReused=true; continue; }
        await this.cognito.send(new AdminDeleteUserCommand({UserPoolId:pool,Username:username}));
        return;
      } catch(error){ if(!(error instanceof Error)||error.name!=='UserNotFoundException') throw error; }
    }
    if(usernameReused) throw new Error('The username now belongs to a different identity; the archived chart was kept');
    // The identity may already have been removed by a previous attempt. The chart remains archived.
  }

  async assertStaffRemovable(username:string):Promise<void>{
    if(!this.workforcePool) throw new Error('Workforce identity service is unavailable');
    try {
      const found=await this.cognito.send(new AdminGetUserCommand({UserPoolId:this.workforcePool,Username:username}));
      const groups=await this.cognito.send(new AdminListGroupsForUserCommand({UserPoolId:this.workforcePool,Username:found.Username??username}));
      if(groups.Groups?.some(group=>group.GroupName==='platform_admin')) throw new Error('Platform administrator sign in cannot be removed here');
    } catch(error){ if(!(error instanceof Error)||error.name!=='UserNotFoundException') throw error; }
  }
  async removeStaff(username:string):Promise<void>{
    await this.assertStaffRemovable(username);
    try { await this.cognito.send(new AdminDeleteUserCommand({UserPoolId:this.workforcePool,Username:username})); }
    catch(error){ if(!(error instanceof Error)||error.name!=='UserNotFoundException') throw error; }
  }
}
