import { z } from 'zod';
import { audit, query, requireCapability, AccessError } from './context.js';
export const patientInput=z.object({firstName:z.string().trim().min(1).max(80),lastName:z.string().trim().min(1).max(80),phone:z.string().trim().min(7).max(30),email:z.email().max(254).optional()}).strict();
export async function listPatients(){
 requireCapability('patients.read');
 const result=await query(`SELECT p.id,p.first_name,p.last_name,p.phone,p.email,p.status,
   coalesce(pa.status,'not_enabled') AS portal_status,coalesce(pa.email_sent,false) AS portal_email_sent,coalesce(pa.text_sent,false) AS portal_text_sent
   FROM clinical.patients p LEFT JOIN clinical.patient_portal_accounts pa ON pa.organization_id=p.organization_id AND pa.patient_id=p.id
   ORDER BY p.created_at DESC,p.id LIMIT 100`);
 await audit('patients.list','patient'); return result.rows;
}
export async function readPatient(id:string){
 requireCapability('patients.read');
 const result=await query(`SELECT p.id,p.first_name,p.last_name,p.phone,p.email,p.status,
   coalesce(pa.status,'not_enabled') AS portal_status,coalesce(pa.email_sent,false) AS portal_email_sent,coalesce(pa.text_sent,false) AS portal_text_sent
   FROM clinical.patients p LEFT JOIN clinical.patient_portal_accounts pa ON pa.organization_id=p.organization_id AND pa.patient_id=p.id WHERE p.id=$1`,[id]);
 if(!result.rows[0]) throw new AccessError(404,'Not found');
 await audit('patients.read','patient',id); return result.rows[0];
}
export async function patientPortalInvitation(id:string){
 const c=requireCapability('patients.edit'); const patientId=z.string().uuid().parse(id);
 const result=await query<{id:string;first_name:string;last_name:string;email:string|null;phone:string;sms_consent:boolean;clinic_name:string}>(`SELECT p.id,p.first_name,p.last_name,p.email,p.phone,l.name AS clinic_name,
   coalesce((SELECT b.sms_consent FROM clinical.booking_inquiries b WHERE b.organization_id=p.organization_id AND b.patient_id=p.id ORDER BY b.created_at DESC LIMIT 1),false) AS sms_consent
   FROM clinical.patients p JOIN clinical.locations l ON l.organization_id=p.organization_id AND l.id=$1 WHERE p.id=$2`,[c.locationId,patientId]);
 const patient=result.rows[0]; if(!patient) throw new AccessError(404,'Not found');
 if(!patient.email) throw new AccessError(400,'Add an email address before enabling patient portal access');
 await audit('portal.invite','patient',patient.id);
 return {organizationId:c.organizationId,patientId:patient.id,email:patient.email,phone:patient.phone,firstName:patient.first_name,clinicName:patient.clinic_name,textConsent:patient.sms_consent};
}
export async function createPatient(input:unknown){
 const c=requireCapability('patients.edit'); const p=patientInput.parse(input);
 const result=await query<{id:string}>('INSERT INTO clinical.patients(organization_id,location_id,first_name,last_name,phone,email) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[c.organizationId,c.locationId,p.firstName,p.lastName,p.phone,p.email||null]);
 const id=result.rows[0]!.id;
 await query('INSERT INTO clinical.patient_locations(organization_id,location_id,patient_id) VALUES($1,$2,$3)',[c.organizationId,c.locationId,id]);
 await audit('patients.create','patient',id); return {id};
}
export async function searchRoamingPatients(search:string){
 const c=requireCapability('patients.edit');
 const value=z.string().trim().min(3).max(120).parse(search);
 const result=await query('SELECT * FROM clinical.search_roaming_patients($1,$2,$3)',[c.organizationId,c.locationId,value]);
 await audit('patients.search','patient'); return result.rows;
}
export async function linkPatientToLocation(patientId:string){
 const c=requireCapability('patients.edit');
 const id=z.string().uuid().parse(patientId);
 const result=await query<{linked:boolean}>('SELECT clinical.link_patient_to_location($1,$2,$3) AS linked',[c.organizationId,c.locationId,id]);
 if(!result.rows[0]?.linked) throw new AccessError(404,'Not found');
 await audit('patients.link','patient',id); return {id};
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
