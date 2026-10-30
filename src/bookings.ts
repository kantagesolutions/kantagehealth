import { z } from 'zod';
import { AccessError, audit, context, query, requireCapability } from './context.js';

export async function listBookingInquiries(){
  requireCapability('schedule.read');
  // A possible match may be a patient at another clinic in the organization, which row-level security
  // hides from this clinic, so its name comes from a definer function limited to this clinic's requests.
  // Send the requested calendar day as YYYY-MM-DD. Serializing a PostgreSQL date as a
  // JavaScript Date can shift it by one day in the staff member's timezone.
  const result=await query(`SELECT b.id,b.patient_id,b.appointment_type,b.preferred_date::text AS preferred_date,b.preferred_time,b.preferred_contact,b.sms_consent,b.message,b.status,b.activation_status,b.created_at,b.source,
    p.first_name,p.last_name,p.phone,p.email,m.match_name,m.match_clinic,m.matched_on
    FROM clinical.booking_inquiries b JOIN clinical.patients p ON p.organization_id=b.organization_id AND p.id=b.patient_id
    LEFT JOIN clinical.booking_possible_matches() m ON m.inquiry_id=b.id
    ORDER BY CASE b.status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END,b.created_at DESC LIMIT 200`);
  await audit('bookings.read','booking_inquiry');
  return result.rows;
}

const matchInput=z.object({samePatient:z.boolean()}).strict();
// Staff decide whether a booking that only partly matched an existing patient is that patient.
export async function resolveBookingMatch(id:string,input:unknown){
  requireCapability('patients.edit');
  const bookingId=z.string().uuid().parse(id);
  const {samePatient}=matchInput.parse(input);
  const result=await query<{patient_id:string}>('SELECT clinical.resolve_booking_match($1,$2) AS patient_id',[bookingId,samePatient]);
  await audit(samePatient?'bookings.match_confirmed':'bookings.match_dismissed','booking_inquiry',bookingId);
  return {id:bookingId,patientId:result.rows[0]?.patient_id,samePatient};
}

const scheduleInput=z.object({startTime:z.iso.datetime({offset:true}),durationMinutes:z.number().int().min(5).max(480)}).strict();
export async function scheduleBookingInquiry(id:string,input:unknown){
  const c=requireCapability('schedule.manage');
  const bookingId=z.string().uuid().parse(id);
  const schedule=scheduleInput.parse(input);
  const booking=await query<{patient_id:string;appointment_type:string}>('SELECT patient_id,appointment_type FROM clinical.booking_inquiries WHERE id=$1 FOR UPDATE',[bookingId]);
  if(!booking.rows[0]) throw new AccessError(404,'Not found');
  const appointment=await query<{id:string}>(`UPDATE clinical.appointments SET provider_user_id=$1,start_time=$2,duration_minutes=$3,status='confirmed'
    WHERE id=(SELECT id FROM clinical.appointments WHERE patient_id=$4 AND location_id=$5 AND status='requested' ORDER BY id LIMIT 1) RETURNING id`,[c.userId,schedule.startTime,schedule.durationMinutes,booking.rows[0].patient_id,c.locationId]);
  if(!appointment.rows[0]) {
    const created=await query<{id:string}>(`INSERT INTO clinical.appointments(organization_id,location_id,patient_id,provider_user_id,service,start_time,duration_minutes,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'confirmed') RETURNING id`,[c.organizationId,c.locationId,booking.rows[0].patient_id,c.userId,booking.rows[0].appointment_type,schedule.startTime,schedule.durationMinutes]);
    appointment.rows.push(created.rows[0]!);
  }
  await query("UPDATE clinical.booking_inquiries SET status='scheduled' WHERE id=$1",[bookingId]);
  await audit('appointments.schedule','appointment',appointment.rows[0]!.id);
  return appointment.rows[0];
}
