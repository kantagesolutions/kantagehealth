import { z } from 'zod';
import { AccessError, audit, query, requireCapability } from './context.js';

const paymentInput=z.object({patientId:z.string().uuid(),amountCents:z.number().int().min(0).max(100_000_000),description:z.string().trim().min(1).max(500)}).strict();

export async function listPayments(){
  requireCapability('payments.read');
  const result=await query('SELECT id,patient_id,amount_cents,care_code,description,status,created_at FROM clinical.payments ORDER BY created_at DESC LIMIT 200');
  await audit('payments.read','payment');
  return result.rows;
}

export async function createPaymentRecord(input:unknown){
  const c=requireCapability('payments.manage');
  const payment=paymentInput.parse(input);
  const patient=await query('SELECT patient_id FROM clinical.patient_locations WHERE patient_id=$1',[payment.patientId]);
  if(!patient.rowCount) throw new AccessError(404,'Not found');
  const result=await query<{id:string}>('INSERT INTO clinical.payments(organization_id,location_id,patient_id,amount_cents,description) VALUES($1,$2,$3,$4,$5) RETURNING id',[c.organizationId,c.locationId,payment.patientId,payment.amountCents,payment.description]);
  const id=result.rows[0]!.id;
  await audit('payments.create','payment',id);
  return {id};
}
