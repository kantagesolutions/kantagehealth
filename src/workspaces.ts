import type { Pool } from 'pg';

export interface StaffWorkspace {
  organizationId:string;
  organizationName:string;
  staffName:string;
  locationId:string;
  locationName:string;
  locationAddress:string;
  timezone:string;
  roles:string[];
}

export async function listStaffWorkspaces(pool:Pool,organizationId:string,identities:string[]):Promise<StaffWorkspace[]> {
  const aliases=[...new Set(identities.filter(value=>value.length>0))];
  if(!aliases.length) return [];
  const result=await pool.query<{
    organization_id:string;
    organization_name:string;
    staff_name:string;
    location_id:string;
    location_name:string;
    location_address:string;
    timezone:string;
    roles:string[];
  // The cast is required. pg sends arrays untyped, and while migration 008's single-text overload
  // existed, Postgres resolved this call to it and compared each account with the literal "{a,b}",
  // so every staff member saw "No clinic assigned".
  }>('SELECT * FROM clinical.staff_workspaces($1,$2::text[])',[organizationId,aliases]);
  return result.rows.map(row=>({
    organizationId:row.organization_id,
    organizationName:row.organization_name,
    staffName:row.staff_name,
    locationId:row.location_id,
    locationName:row.location_name,
    locationAddress:row.location_address,
    timezone:row.timezone,
    roles:row.roles,
  }));
}
