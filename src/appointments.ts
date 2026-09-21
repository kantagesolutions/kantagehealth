import { z } from 'zod';
import { AccessError, audit, query, requireCapability } from './context.js';

const appointmentInput=z.object({patientId:z.string().uuid(),providerUserId:z.string().uuid(),service:z.string().trim().min(1).max(160),startTime:z.iso.datetime({offset:true}),durationMinutes:z.number().int().min(5).max(480)}).strict();

export async function listAppointments(){
  requireCapability('schedule.read');
  const result=await query('SELECT id,patient_id,provider_user_id,service,start_time,duration_minutes,status FROM clinical.appointments ORDER BY start_time ASC LIMIT 200');
  await audit('appointments.read','appointment');
  return result.rows;
}

export async function createAppointment(input:unknown){
  const c=requireCapability('schedule.manage');
  const appointment=appointmentInput.parse(input);
  const patient=await query('SELECT patient_id FROM clinical.patient_locations WHERE patient_id=$1',[appointment.patientId]);
  if(!patient.rowCount) throw new AccessError(404,'Not found');
  const result=await query<{id:string}>('INSERT INTO clinical.appointments(organization_id,location_id,patient_id,provider_user_id,service,start_time,duration_minutes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[c.organizationId,c.locationId,appointment.patientId,appointment.providerUserId,appointment.service,appointment.startTime,appointment.durationMinutes]);
  const id=result.rows[0]!.id;
  await audit('appointments.create','appointment',id);
  return {id};
}
