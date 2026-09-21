import { z } from 'zod';
import { audit, query, requireCapability, AccessError } from './context.js';
export const patientInput=z.object({firstName:z.string().trim().min(1).max(80),lastName:z.string().trim().min(1).max(80),phone:z.string().trim().min(7).max(30),email:z.email().max(254).optional()}).strict();
export async function listPatients(){
 requireCapability('patients.read');
 const result=await query('SELECT id,first_name,last_name,phone,email,status FROM clinical.patients ORDER BY created_at DESC,id LIMIT 100');
 await audit('patients.list','patient'); return result.rows;
}
export async function readPatient(id:string){
 requireCapability('patients.read');
 const result=await query('SELECT id,first_name,last_name,phone,email,status FROM clinical.patients WHERE id=$1',[id]);
 if(!result.rows[0]) throw new AccessError(404,'Not found');
 await audit('patients.read','patient',id); return result.rows[0];
}
export async function createPatient(input:unknown){
 const c=requireCapability('patients.edit'); const p=patientInput.parse(input);
 const result=await query<{id:string}>('INSERT INTO clinical.patients(organization_id,location_id,first_name,last_name,phone,email) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[c.organizationId,c.locationId,p.firstName,p.lastName,p.phone,p.email||null]);
 const id=result.rows[0]!.id;
 await query('INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES($1,$2,$3)',[c.organizationId,c.locationId,id]);
 await audit('patients.create','patient',id); return {id};
}
export async function listCareRecords(patientId:string){
 requireCapability('clinical.read');
 const rows=await query('SELECT id,record_type,note,provider_user_id,occurred_at FROM clinical.care_records WHERE patient_id=$1 ORDER BY occurred_at DESC LIMIT 100',[patientId]);
 await audit('records.read','patient',patientId); return rows.rows;
}
export async function createCareRecord(patientId:string,input:unknown){
 const c=requireCapability('clinical.write');
 const p=z.object({recordType:z.enum(['note','treatment','follow_up']),note:z.string().trim().min(1).max(10000)}).strict().parse(input);
 const linked=await query('SELECT patient_id FROM clinical.patient_locations WHERE patient_id=$1',[patientId]);
 if(!linked.rowCount) throw new AccessError(404,'Not found');
 const rows=await query<{id:string}>('INSERT INTO clinical.care_records(organization_id,location_id,patient_id,record_type,note,provider_user_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[c.organizationId,c.locationId,patientId,p.recordType,p.note,c.userId]);
 await audit('records.create','care_record',rows.rows[0]!.id); return rows.rows[0];
}
