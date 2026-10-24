import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessError, audit, context, query, requireCapability } from './context.js';

const uploadInput=z.object({patientId:z.string().uuid(),name:z.string().trim().min(1).max(180),contentType:z.enum(['application/pdf','image/jpeg','image/png']),sizeBytes:z.number().int().min(1).max(20_971_520),documentKind:z.enum(['intake_form','insurance_card','identity','consent','treatment','uploaded_record']).default('uploaded_record')}).strict();

export async function listDocuments(patientId?:string){
  requireCapability('documents.read');
  const result=patientId
    ? await query('SELECT id,patient_id,name,content_type,size_bytes,document_kind,status,created_at FROM clinical.documents WHERE patient_id=$1 ORDER BY created_at DESC',[z.string().uuid().parse(patientId)])
    : await query('SELECT id,patient_id,name,content_type,size_bytes,document_kind,status,created_at FROM clinical.documents ORDER BY created_at DESC LIMIT 200');
  await audit('documents.read','document');
  return result.rows;
}

export async function createDocumentUpload(input:unknown){
  const c=requireCapability('documents.upload');
  const value=uploadInput.parse(input);
  const linked=await query('SELECT patient_id FROM clinical.patient_locations WHERE patient_id=$1',[value.patientId]);
  if(!linked.rowCount) throw new AccessError(404,'Not found');
  const id=randomUUID();
  const objectKey=`${c.organizationId}/${c.locationId}/${value.patientId}/${id}`;
  await query(`INSERT INTO clinical.documents(id,organization_id,location_id,patient_id,object_key,name,status,content_type,size_bytes,document_kind)
    VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)`,[id,c.organizationId,c.locationId,value.patientId,objectKey,value.name,value.contentType,value.sizeBytes,value.documentKind]);
  await audit('documents.upload','document',id);
  return {id,objectKey,contentType:value.contentType};
}

export async function completeDocument(id:string){
  requireCapability('documents.upload');
  const result=await query<{id:string}>("UPDATE clinical.documents SET status='ready' WHERE id=$1 AND status='pending' RETURNING id",[z.string().uuid().parse(id)]);
  if(!result.rows[0]) throw new AccessError(404,'Not found');
  return result.rows[0];
}

export async function patientDocumentObject(poolQuery:(sql:string,values:unknown[])=>Promise<{rows:{object_key:string;content_type:string;name:string}[]}>,organizationId:string,sub:string,id:string){
  const result=await poolQuery(`SELECT d.object_key,d.content_type,d.name FROM clinical.patient_portal_accounts pa JOIN clinical.documents d ON d.organization_id=pa.organization_id AND d.patient_id=pa.patient_id
    WHERE pa.organization_id=$1 AND pa.cognito_sub=$2 AND d.id=$3 AND d.status='ready'`,[organizationId,sub,z.string().uuid().parse(id)]);
  return result.rows[0];
}
