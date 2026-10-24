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
  preferredContact:z.enum(['email','text','phone']).default('email'),
  textConsent:z.boolean().default(false),
  preferredTime:z.string().trim().max(60).optional(),
  message:z.string().trim().max(1000).optional(),
  website:z.string().max(0).optional(),
}).strict();

export type PublicBookingInquiry=z.infer<typeof inquiryInput>;

export async function createPublicBookingInquiry(pool:Pool,target:PublicBookingTarget,input:unknown,request:{ip?:string;userAgent:string}){
  const inquiry=inquiryInput.parse(input);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org',$1,true),set_config('app.current_location',$2,true)",[target.organizationId,target.locationId]);
    const result=await client.query<{inquiry_id:string;patient_id:string}>('SELECT * FROM clinical.create_public_booking_inquiry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[
      inquiry.firstName,inquiry.lastName,inquiry.phone,inquiry.email??null,inquiry.appointmentType,inquiry.preferredDate??null,
      inquiry.preferredContact,inquiry.preferredTime??'',inquiry.message??'',request.ip??null,request.userAgent.slice(0,256),
    ]);
    await client.query('COMMIT');
    return {id:result.rows[0]!.inquiry_id,patientId:result.rows[0]!.patient_id,patient:{firstName:inquiry.firstName,lastName:inquiry.lastName,email:inquiry.email??null,phone:inquiry.phone,textConsent:inquiry.textConsent}};
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally { client.release(); }
}
