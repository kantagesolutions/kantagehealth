import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { z } from 'zod';

const databaseSecret=z.object({host:z.string().min(1),port:z.number().int().positive().default(5432),database:z.string().min(1),username:z.string().min(1),password:z.string().min(1),sslRootCert:z.string().min(1)}).strict();
const bookingClinic=z.object({key:z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),locationId:z.string().uuid(),clinicName:z.string().trim().min(1).max(160),timezone:z.string().trim().min(1).max(100)}).strict();
const tenantEntry=z.object({organizationId:z.string().uuid(),databaseSecretArn:z.string().min(1),documentsBucket:z.string().min(3),staffUserPoolId:z.string().min(1),staffClientId:z.string().min(1),bookingClinics:z.array(bookingClinic).default([])}).strict();
const registrySchema=z.object({tenants:z.array(tenantEntry)}).strict();
export type TenantConfig=z.infer<typeof tenantEntry>;
export type BookingClinic=z.infer<typeof bookingClinic>;

export class TenantRegistry {
  #cache?:Promise<Map<string,TenantConfig>>;
  constructor(private readonly client:Pick<SecretsManagerClient,'send'>,private readonly registrySecretId:string) {}
  async findBooking(key:string):Promise<{tenant:TenantConfig; clinic:BookingClinic}|undefined> {
    const tenants=await (this.#cache ??= this.load());
    for(const tenant of tenants.values()) { const clinic=tenant.bookingClinics.find(item=>item.key===key); if(clinic) return {tenant,clinic}; }
    return undefined;
  }
  async get(organizationId:string):Promise<TenantConfig> {
    const tenants=await (this.#cache ??= this.load());
    const tenant=tenants.get(organizationId);
    if(!tenant) throw new Error('Unknown or inactive healthcare organization');
    return tenant;
  }
  private async load():Promise<Map<string,TenantConfig>> {
    const result=await this.client.send(new GetSecretValueCommand({SecretId:this.registrySecretId}));
    if(!result.SecretString) throw new Error('Healthcare tenant registry is unavailable');
    const parsed=registrySchema.safeParse(JSON.parse(result.SecretString));
    if(!parsed.success) throw new Error('Healthcare tenant registry is invalid');
    const tenants=new Map(parsed.data.tenants.map(tenant=>[tenant.organizationId,tenant]));
    if(tenants.size!==parsed.data.tenants.length) throw new Error('Healthcare tenant registry contains duplicate organizations');
    return tenants;
  }
}

export class TenantPoolRegistry {
  #pools=new Map<string,Promise<Pool>>();
  constructor(private readonly client:Pick<SecretsManagerClient,'send'>) {}
  async get(tenant:TenantConfig):Promise<Pool> {
    return this.#pools.get(tenant.organizationId) ?? this.create(tenant);
  }
  private async create(tenant:TenantConfig):Promise<Pool> {
    const poolPromise=this.loadPool(tenant).catch(error=>{this.#pools.delete(tenant.organizationId); throw error;});
    this.#pools.set(tenant.organizationId,poolPromise);
    return poolPromise;
  }
  private async loadPool(tenant:TenantConfig):Promise<Pool> {
    const result=await this.client.send(new GetSecretValueCommand({SecretId:tenant.databaseSecretArn}));
    if(!result.SecretString) throw new Error('Tenant database credentials are unavailable');
    const credentials=databaseSecret.safeParse(JSON.parse(result.SecretString));
    if(!credentials.success) throw new Error('Tenant database credentials are invalid');
    const pool=new Pool({host:credentials.data.host,port:credentials.data.port,database:credentials.data.database,user:credentials.data.username,password:credentials.data.password,ssl:{ca:credentials.data.sslRootCert,rejectUnauthorized:true},max:10,idleTimeoutMillis:30_000,connectionTimeoutMillis:5_000,maxUses:5_000});
    await pool.query('SELECT 1');
    return pool;
  }
  async close():Promise<void> { await Promise.all([...this.#pools.values()].map(async pool=>{(await pool).end();})); }
}

export function productionRegistry():TenantRegistry {
  const secretId=process.env.KANTAGE_TENANT_REGISTRY_SECRET_ID;
  if(!secretId) throw new Error('KANTAGE_TENANT_REGISTRY_SECRET_ID is required');
  return new TenantRegistry(new SecretsManagerClient({}),secretId);
}
