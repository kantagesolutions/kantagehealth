import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export interface PublicBookingTarget {
  organizationId:string;
  locationId:string;
  clinicName:string;
  timezone:string;
}

export function isOpenPreferredDate(value:string,openWeekdays:number[]=[1,2,3,4],blockedDates:string[]=[]):boolean {
  const day=new Date(`${value}T00:00:00Z`).getUTCDay();
  return openWeekdays.includes(day)&&!blockedDates.includes(value);
}

const preferredDate=z.string().date();
export class BookingDateClosedError extends Error {
  constructor(){super('That clinic is not accepting appointment requests on this date. Choose an open day.');}
}
export interface BookingSchedule {openWeekdays:number[];blockedDates:string[];}
const dateOnly=(value:string|Date)=>value instanceof Date?`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`:String(value).slice(0,10);
export async function bookingSchedule(pool:Pool,organizationId:string,locationId:string):Promise<BookingSchedule>{
  const result=await pool.query<{open_weekdays:number[];blocked_dates:(string|Date)[]}>('SELECT * FROM clinical.booking_schedule($1,$2)',[organizationId,locationId]);
  const row=result.rows[0];
  if(!row) throw new Error('Clinic not found');
  return {openWeekdays:row.open_weekdays,blockedDates:row.blocked_dates.map(dateOnly)};
}
async function assertBookingDateOpen(query:{query:(sql:string,params:unknown[])=>Promise<{rows:{open:boolean}[]}>},org:string,loc:string,date:string){
  const result=await query.query('SELECT clinical.booking_date_open($1,$2,$3::date) AS open',[org,loc,date]);
  if(!result.rows[0]?.open) throw new BookingDateClosedError();
}

const inquiryInput=z.object({
  firstName:z.string().trim().min(1).max(100),
  lastName:z.string().trim().min(1).max(100),
  phone:z.string().trim().min(7).max(40),
  email:z.string().trim().email().max(254).optional(),
  appointmentType:z.string().trim().min(1).max(160),
  preferredDate:preferredDate.optional(),
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
    if(inquiry.preferredDate) await assertBookingDateOpen(client,target.organizationId,target.locationId,inquiry.preferredDate);
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

export interface ClinicChoice extends BookingSchedule { key:string; name:string; address:string; timezone:string; }

// The clinics a patient can choose from: the organization's active clinics that have a booking link.
// Each is identified by its booking link, never by an internal id.
export async function listBookingClinics(pool:Pool,organizationId:string,bookingClinics:{key:string;locationId:string}[]):Promise<ClinicChoice[]>{
  const keys=new Map(bookingClinics.map(clinic=>[clinic.locationId,clinic.key]));
  const result=await pool.query<{location_id:string;name:string;address:string;timezone:string}>('SELECT * FROM clinical.booking_clinics($1)',[organizationId]);
  return Promise.all(result.rows.flatMap(row=>{ const key=keys.get(row.location_id); return key?[bookingSchedule(pool,organizationId,row.location_id).then(schedule=>({key,name:row.name,address:row.address,timezone:row.timezone,...schedule}))]:[]; }));
}

const portalBookingInput=z.object({
  clinic:z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
  appointmentType:z.string().trim().min(1).max(160),
  preferredDate:preferredDate.optional(),
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
  if(booking.preferredDate) await assertBookingDateOpen(pool,tenant.organizationId,clinic.locationId,booking.preferredDate);
  const result=await pool.query<{inquiry_id:string;clinic_name:string}>('SELECT * FROM clinical.create_patient_portal_booking($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[
    tenant.organizationId,sub,clinic.locationId,booking.appointmentType,booking.preferredDate??null,booking.preferredContact,booking.preferredTime??'',booking.message??'',request.ip??null,request.userAgent.slice(0,256),
  ]);
  return {id:result.rows[0]!.inquiry_id,clinicName:result.rows[0]!.clinic_name};
}
