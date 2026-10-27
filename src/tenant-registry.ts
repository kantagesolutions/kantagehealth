import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { z } from 'zod';

const databaseSecret=z.object({host:z.string().min(1),port:z.number().int().positive().default(5432),database:z.string().min(1),username:z.string().min(1),password:z.string().min(1),sslRootCert:z.string().min(1)}).strict();
const bookingClinic=z.object({key:z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),locationId:z.string().uuid(),clinicName:z.string().trim().min(1).max(160),timezone:z.string().trim().min(1).max(100)}).strict();
const tenantEntry=z.object({organizationId:z.string().uuid(),databaseSecretArn:z.string().min(1),documentsBucket:z.string().min(3),staffUserPoolId:z.string().min(1),staffClientId:z.string().min(1),staffClientIds:z.array(z.string().min(1)).optional(),bookingClinics:z.array(bookingClinic).default([])}).strict();
const registrySchema=z.object({tenants:z.array(tenantEntry)}).strict();
export type TenantConfig=z.infer<typeof tenantEntry>;
export type BookingClinic=z.infer<typeof bookingClinic>;
export function staffClientIds(tenant:TenantConfig):string[] { return [...new Set([tenant.staffClientId,...(tenant.staffClientIds??[])])]; }

// The API runs as several tasks over one registry secret, so no task's copy can be trusted for long. Reads
// use a copy at most this old; a lookup that misses re-reads sooner, but no more than once a second, so
// requests for unknown organizations or booking links cannot turn into a read of the secret each.
const freshForMs=30_000, missRetryAfterMs=1_000;

export class TenantRegistry {
  #cache?:{tenants:Promise<Map<string,TenantConfig>>;loadedAt:number};
  constructor(private readonly client:Pick<SecretsManagerClient,'send'>,private readonly registrySecretId:string,private readonly now:()=>number=Date.now) {}
  async findBooking(key:string):Promise<{tenant:TenantConfig; clinic:BookingClinic}|undefined> {
    return this.lookup(tenants=>{
      for(const tenant of tenants.values()) { const clinic=tenant.bookingClinics.find(item=>item.key===key); if(clinic) return {tenant,clinic}; }
      return undefined;
    });
  }
  async get(organizationId:string):Promise<TenantConfig> {
    const tenant=await this.find(organizationId);
    if(!tenant) throw new Error('Unknown or inactive healthcare organization');
    return tenant;
  }
  async find(organizationId:string):Promise<TenantConfig|undefined> {
    return this.lookup(tenants=>tenants.get(organizationId));
  }
  async list():Promise<TenantConfig[]> {
    return [...(await this.snapshot(freshForMs)).values()];
  }
  // For callers that must act on the current registry, such as an authenticated administrator.
  async refresh():Promise<TenantConfig[]> {
    return [...(await this.snapshot(0)).values()];
  }
  async add(tenant:TenantConfig):Promise<void> {
    await this.write(tenants=>{
      if(tenants.has(tenant.organizationId)) throw new Error('Organization is already connected');
      return [...tenants.values(),tenant];
    });
  }
  // Removing an organization also retires its booking links. Removing one that is not registered is not
  // an error, so a delete can be retried after a partial failure.
  async remove(organizationId:string):Promise<void> {
    await this.write(tenants=>tenants.has(organizationId)?[...tenants.values()].filter(item=>item.organizationId!==organizationId):undefined);
  }
  // Each clinic has its own booking link. The public booking page reads the clinic's name and timezone
  // from here, so a rename must reach the registry as well as the database.
  async addBookingClinic(organizationId:string,clinic:BookingClinic):Promise<void> {
    await this.replaceBookingClinics(organizationId,clinics=>{
      if(clinics.some(item=>item.locationId===clinic.locationId)) throw new Error('This clinic already has a booking link');
      return [...clinics,clinic];
    });
  }
  async updateBookingClinic(organizationId:string,locationId:string,changes:{clinicName:string;timezone:string}):Promise<void> {
    await this.replaceBookingClinics(organizationId,clinics=>clinics.map(item=>item.locationId===locationId?{...item,...changes}:item));
  }
  private async replaceBookingClinics(organizationId:string,change:(clinics:BookingClinic[])=>BookingClinic[]):Promise<void> {
    await this.write(tenants=>{
      const tenant=tenants.get(organizationId);
      if(!tenant) throw new Error('Organization is not connected');
      return [...tenants.values()].map(item=>item.organizationId===organizationId?{...tenant,bookingClinics:change(tenant.bookingClinics)}:item);
    });
  }
  // Every change starts from the secret as it is now, never from this task's copy: writing back an older
  // copy would undo what another task changed since, such as an organization it just created.
  private async write(change:(tenants:Map<string,TenantConfig>)=>TenantConfig[]|undefined):Promise<void> {
    const updated=change(await this.snapshot(0));
    if(!updated) return;
    await this.client.send(new PutSecretValueCommand({SecretId:this.registrySecretId,SecretString:JSON.stringify({tenants:updated})}));
    this.#cache={tenants:Promise.resolve(new Map(updated.map(tenant=>[tenant.organizationId,tenant]))),loadedAt:this.now()};
  }
  private async lookup<T>(find:(tenants:Map<string,TenantConfig>)=>T|undefined):Promise<T|undefined> {
    return find(await this.snapshot(freshForMs)) ?? find(await this.snapshot(missRetryAfterMs));
  }
  private snapshot(maxAgeMs:number):Promise<Map<string,TenantConfig>> {
    const now=this.now();
    if(!this.#cache || now-this.#cache.loadedAt>=maxAgeMs) {
      const tenants=this.load();
      const entry={tenants,loadedAt:now};
      this.#cache=entry;
      // A failed read must not be kept: the next request tries again.
      tenants.catch(()=>{ if(this.#cache===entry) this.#cache=undefined; });
    }
    return this.#cache.tenants;
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

// The variable must name the registry secret, never hold its contents. ECS injects a secret's value
// for anything declared under a task definition's `secrets`, and when this variable was declared there
// every registry read failed and the whole platform returned 503 without a trace. Refusing to start
// turns that mistake into a failed deploy instead.
export function registrySecretIdFrom(value:string|undefined):string {
  if(!value) throw new Error('KANTAGE_TENANT_REGISTRY_SECRET_ID is required');
  if(!/^[A-Za-z0-9/_+=.@:-]{1,2048}$/.test(value)) throw new Error('KANTAGE_TENANT_REGISTRY_SECRET_ID must be the registry secret\'s ARN or name, not its contents');
  return value;
}

export function productionRegistry():TenantRegistry {
  return new TenantRegistry(new SecretsManagerClient({}),registrySecretIdFrom(process.env.KANTAGE_TENANT_REGISTRY_SECRET_ID));
}
