import type { Pool } from 'pg';
import { z } from 'zod';
import { AccessError, audit, query, requireCapability } from './context.js';
import type { TenantConfig, TenantPoolRegistry } from './tenant-registry.js';

// Counts and totals per clinic for a date range. Never a patient.
const rangeInput=z.object({from:z.string().date(),to:z.string().date()}).strict();
const maxDays=366;

export function reportRange(params:URLSearchParams){
  const range=rangeInput.parse({from:params.get('from')??undefined,to:params.get('to')??undefined});
  const days=(Date.parse(range.to)-Date.parse(range.from))/86_400_000;
  if(days<0) throw new AccessError(400,'The start date must be on or before the end date.');
  if(days>=maxDays) throw new AccessError(400,'Choose a range of one year or less.');
  return range;
}

interface FigureRow { payments_cents:string|number; [key:string]:unknown; }
// pg returns bigint as a string; a clinic's payment total in cents fits a JavaScript number.
const figures=(rows:FigureRow[])=>rows.map(row=>({...row,payments_cents:Number(row.payments_cents)}));

export async function clinicReports(params:URLSearchParams){
  requireCapability('reports.read');
  const {from,to}=reportRange(params);
  const result=await query<FigureRow>('SELECT * FROM clinical.clinic_reports($1,$2)',[from,to]);
  await audit('reports.read','report');
  return {from,to,clinics:figures(result.rows)};
}

// Every clinic of every organization. Like the client list, it reads each tenant's database and keeps
// each clinic once, so organizations sharing a database are not counted twice.
export async function platformReports(tenants:TenantConfig[],pools:TenantPoolRegistry,params:URLSearchParams){
  const {from,to}=reportRange(params);
  const rows:FigureRow[]=[]; const seen=new Set<unknown>(); const read=new Set<Pool>();
  for(const tenant of tenants){
    const pool=await pools.get(tenant); if(read.has(pool)) continue; read.add(pool);
    for(const row of (await pool.query<FigureRow>('SELECT * FROM clinical.platform_reports($1,$2)',[from,to])).rows) if(!seen.has(row.location_id)){seen.add(row.location_id);rows.push(row);}
  }
  return {from,to,clinics:figures(rows)};
}
