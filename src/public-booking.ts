import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export interface PublicBookingTarget {
  organizationId:string;
  locationId:string;
  clinicName:string;
  timezone:string;
}

const inquiryInput=z.object({
  firstName:z.string().trim().min(1).max(100),
  lastName:z.string().trim().min(1).max(100),
  phone:z.string().trim().min(7).max(40),
  email:z.string().trim().email().max(254).optional(),
  appointmentType:z.string().trim().min(1).max(160),
  preferredDate:z.string().date().optional(),
  website:z.string().max(0).optional(),
}).strict();

export type PublicBookingInquiry=z.infer<typeof inquiryInput>;

export async function createPublicBookingInquiry(pool:Pool,target:PublicBookingTarget,input:unknown,request:{ip?:string;userAgent:string}){
  const inquiry=inquiryInput.parse(input);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org',$1,true),set_config('app.current_location',$2,true)",[target.organizationId,target.locationId]);
    const result=await client.query<{id:string}>('SELECT clinical.create_public_booking_inquiry($1,$2,$3,$4,$5,$6,$7,$8) AS id',[
      inquiry.firstName,inquiry.lastName,inquiry.phone,inquiry.email??null,inquiry.appointmentType,inquiry.preferredDate??null,request.ip??null,request.userAgent.slice(0,256),
    ]);
    await client.query('COMMIT');
    return {id:result.rows[0]!.id};
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally { client.release(); }
}
