import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { z } from 'zod';

const staffTokenClaims=z.object({sub:z.string().min(1),token_use:z.literal('access'),client_id:z.string().min(1)}).passthrough();
export type StaffClaims=z.infer<typeof staffTokenClaims>;

export interface StaffAuthConfig { userPoolId:string; clientId:string; }
export interface TokenVerifier { verify(token:string):Promise<unknown>; }

export function staffVerifier(config:StaffAuthConfig):TokenVerifier {
  return CognitoJwtVerifier.create({userPoolId:config.userPoolId,clientId:config.clientId,tokenUse:'access'});
}

export async function verifyStaffToken(token:string,config:StaffAuthConfig,verifier:TokenVerifier=staffVerifier(config)):Promise<StaffClaims> {
  if(!token || token.length>16_384) throw new Error('Unauthorized');
  const verified=await verifier.verify(token).catch(()=>{ throw new Error('Unauthorized'); });
  const claims=staffTokenClaims.safeParse(verified);
  if(!claims.success || claims.data.client_id!==config.clientId) throw new Error('Unauthorized');
  return claims.data;
}
