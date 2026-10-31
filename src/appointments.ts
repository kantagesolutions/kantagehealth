import { z } from 'zod';
import { AccessError, audit, query, requireCapability } from './context.js';

const appointmentInput=z.object({patientId:z.string().uuid(),providerUserId:z.string().uuid().nullable().optional(),service:z.string().trim().min(1).max(160),startTime:z.iso.datetime({offset:true}),durationMinutes:z.number().int().min(5).max(480)}).strict();
const appointmentChange=z.object({service:z.string().trim().min(1).max(160),startTime:z.iso.datetime({offset:true}),durationMinutes:z.number().int().min(5).max(480)}).strict();

const rangeInput=z.object({from:z.iso.datetime({offset:true}),to:z.iso.datetime({offset:true})}).strict()
  .refine(range=>Date.parse(range.from)<Date.parse(range.to)&&Date.parse(range.to)-Date.parse(range.from)<=62*86_400_000,'A range runs forwards and covers at most two months');

// With a range, the appointments booked for a time inside it, as the schedule calendar shows them;
// without one, the clinic's appointment list as before.
export async function listAppointments(range?:{from?:string|null;to?:string|null}){
  const c=requireCapability('schedule.read');
  // A linked patient's appointments at other clinics are readable for their chart, but the schedule is
  // this clinic's own.
  const result=range?.from||range?.to
    ? await (async()=>{ const {from,to}=rangeInput.parse({from:range.from,to:range.to}); return query('SELECT id,patient_id,provider_user_id,service,start_time,duration_minutes,status FROM clinical.appointments WHERE location_id=$1 AND start_time>=$2 AND start_time<$3 ORDER BY start_time ASC LIMIT 1000',[c.locationId,from,to]); })()
    : await query('SELECT id,patient_id,provider_user_id,service,start_time,duration_minutes,status FROM clinical.appointments WHERE location_id=$1 ORDER BY start_time ASC LIMIT 200',[c.locationId]);
  await audit('appointments.read','appointment');
  return result.rows;
}

export async function createAppointment(input:unknown){
  const c=requireCapability('schedule.manage');
  const appointment=appointmentInput.parse(input);
  const patient=await query('SELECT patient_id FROM clinical.patient_locations WHERE patient_id=$1',[appointment.patientId]);
  if(!patient.rowCount) throw new AccessError(404,'Not found');
  const result=await query<{id:string}>('INSERT INTO clinical.appointments(organization_id,location_id,patient_id,provider_user_id,service,start_time,duration_minutes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[c.organizationId,c.locationId,appointment.patientId,appointment.providerUserId??null,appointment.service,appointment.startTime,appointment.durationMinutes]);
  const id=result.rows[0]!.id;
  await audit('appointments.create','appointment',id);
  return {id};
}

export async function updateAppointment(appointmentId:string,input:unknown){
  const c=requireCapability('schedule.manage');
  const id=z.string().uuid().parse(appointmentId),change=appointmentChange.parse(input);
  const current=await query<{status:string}>('SELECT status FROM clinical.appointments WHERE id=$1 AND location_id=$2 FOR UPDATE',[id,c.locationId]);
  if(!current.rowCount) throw new AccessError(404,'Appointment not found');
  if(current.rows[0]!.status!=='confirmed') throw new AccessError(409,'Only confirmed appointments can be edited');
  const result=await query('UPDATE clinical.appointments SET service=$1,start_time=$2,duration_minutes=$3 WHERE id=$4 AND location_id=$5 RETURNING id,patient_id,provider_user_id,service,start_time,duration_minutes,status',[change.service,change.startTime,change.durationMinutes,id,c.locationId]);
  await audit('appointments.update','appointment',id);
  return result.rows[0]!;
}

export async function cancelAppointment(appointmentId:string){
  const c=requireCapability('schedule.manage');
  const id=z.string().uuid().parse(appointmentId);
  const current=await query<{status:string}>('SELECT status FROM clinical.appointments WHERE id=$1 AND location_id=$2 FOR UPDATE',[id,c.locationId]);
  if(!current.rowCount) throw new AccessError(404,'Appointment not found');
  if(current.rows[0]!.status==='cancelled') throw new AccessError(409,'Appointment is already cancelled');
  if(current.rows[0]!.status!=='confirmed') throw new AccessError(409,'Only confirmed appointments can be cancelled');
  const result=await query('UPDATE clinical.appointments SET status=$1 WHERE id=$2 AND location_id=$3 RETURNING id,patient_id,provider_user_id,service,start_time,duration_minutes,status',['cancelled',id,c.locationId]);
  await audit('appointments.cancel','appointment',id);
  return result.rows[0]!;
}
