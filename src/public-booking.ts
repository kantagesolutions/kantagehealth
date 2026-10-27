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
    const result=await client.query<{inquiry_id:string;patient_id:string}>('SELECT * FROM clinical.create_public_booking_inquiry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[
      inquiry.firstName,inquiry.lastName,inquiry.phone,inquiry.email??null,inquiry.appointmentType,inquiry.preferredDate??null,
      inquiry.preferredContact,inquiry.preferredTime??'',inquiry.message??'',inquiry.textConsent,request.ip??null,request.userAgent.slice(0,256),
    ]);
    await client.query('COMMIT');
    return {id:result.rows[0]!.inquiry_id,patientId:result.rows[0]!.patient_id,patient:{firstName:inquiry.firstName,lastName:inquiry.lastName,email:inquiry.email??null,phone:inquiry.phone,textConsent:inquiry.textConsent}};
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally { client.release(); }
}

export interface ClinicChoice { key:string; name:string; address:string; timezone:string; }

// The clinics a patient can choose from: the organization's active clinics that have a booking link.
// Each is identified by its booking link, never by an internal id.
export async function listBookingClinics(pool:Pool,organizationId:string,bookingClinics:{key:string;locationId:string}[]):Promise<ClinicChoice[]>{
  const keys=new Map(bookingClinics.map(clinic=>[clinic.locationId,clinic.key]));
  const result=await pool.query<{location_id:string;name:string;address:string;timezone:string}>('SELECT * FROM clinical.booking_clinics($1)',[organizationId]);
  return result.rows.flatMap(row=>{ const key=keys.get(row.location_id); return key?[{key,name:row.name,address:row.address,timezone:row.timezone}]:[]; });
}

const portalBookingInput=z.object({
  clinic:z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
  appointmentType:z.string().trim().min(1).max(160),
  preferredDate:z.string().date().optional(),
  preferredContact:z.enum(['email','text','phone']).default('email'),
  preferredTime:z.string().trim().max(60).optional(),
  message:z.string().trim().max(1000).optional(),
}).strict();

// A signed-in patient asks for an appointment at the clinic they choose. They are identified by their
// portal account, so nothing they submit is matched against other patients.
export async function createPatientPortalBooking(pool:Pool,tenant:{organizationId:string;bookingClinics:{key:string;locationId:string}[]},sub:string,input:unknown,request:{ip?:string;userAgent:string}){
  const booking=portalBookingInput.parse(input);
  const clinic=tenant.bookingClinics.find(item=>item.key===booking.clinic);
  if(!clinic) return undefined;
  const result=await pool.query<{inquiry_id:string;clinic_name:string}>('SELECT * FROM clinical.create_patient_portal_booking($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[
    tenant.organizationId,sub,clinic.locationId,booking.appointmentType,booking.preferredDate??null,booking.preferredContact,booking.preferredTime??'',booking.message??'',request.ip??null,request.userAgent.slice(0,256),
  ]);
  return {id:result.rows[0]!.inquiry_id,clinicName:result.rows[0]!.clinic_name};
}
