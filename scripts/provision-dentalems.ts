import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { databaseClientFromSecret } from './database-secret.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const masterSecretId = required('DATABASE_SECRET_ID');
const tenantRegistrySecretId = required('KANTAGE_TENANT_REGISTRY_SECRET_ID');
const tenantDatabaseSecretName = required('TENANT_DATABASE_SECRET_NAME');
const documentsBucket = required('DOCUMENTS_BUCKET');
const staffUserPoolId = required('STAFF_USER_POOL_ID');
const staffClientId = required('STAFF_CLIENT_ID');
const secrets = new SecretsManagerClient({});
const client = await databaseClientFromSecret(masterSecretId);

await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await client.query<{name:string}>('SELECT name FROM schema_migrations')).rows.map(row => row.name));
  const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of (await readdir(migrationsDir)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) {
    if (applied.has(name)) continue;
    await client.query('BEGIN');
    try {
      await client.query(await readFile(join(migrationsDir, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  const existing = await client.query<{organization_id:string;location_id:string}>(`
    SELECT o.id organization_id, l.id location_id
    FROM clinical.organizations o
    JOIN clinical.locations l ON l.organization_id=o.id
    WHERE o.slug='dentalems' AND l.name='DentalEMS Baltimore'
    LIMIT 1
  `);
  const organizationId = existing.rows[0]?.organization_id ?? randomUUID();
  const locationId = existing.rows[0]?.location_id ?? randomUUID();
  if (!existing.rows[0]) {
    await client.query(
      `INSERT INTO clinical.organizations(id,slug,name,status) VALUES($1,'dentalems','Express Dental Emergency Services','active')`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO clinical.locations(id,organization_id,name,timezone,address,status) VALUES($1,$2,'DentalEMS Baltimore','America/New_York','Baltimore, Maryland','active')`,
      [locationId, organizationId],
    );
  }

  let tenantSecretArn: string;
  let tenantPassword: string;
  try {
    const current = await secrets.send(new GetSecretValueCommand({ SecretId: tenantDatabaseSecretName }));
    if (!current.SecretString || !current.ARN) throw new Error('Existing DentalEMS database secret is incomplete');
    tenantSecretArn = current.ARN;
    tenantPassword = JSON.parse(current.SecretString).password as string;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error;
    tenantPassword = randomBytes(36).toString('base64url');
    const master = await secrets.send(new GetSecretValueCommand({ SecretId: masterSecretId }));
    if (!master.SecretString) throw new Error('Master database secret is unavailable');
    const masterData = JSON.parse(master.SecretString) as {host?:string;port?:number;dbname?:string};
    const databaseHost = masterData.host ?? required('DATABASE_HOST');
    const ca = await (await fetch('https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem')).text();
    const created = await secrets.send(new CreateSecretCommand({
      Name: tenantDatabaseSecretName,
      Description: 'Least-privilege DentalEMS database login for Kantage Healthcare',
      SecretString: JSON.stringify({
        host: databaseHost,
        port: masterData.port ?? 5432,
        database: masterData.dbname ?? 'clinical',
        username: 'kh_dentalems_app',
        password: tenantPassword,
        sslRootCert: ca,
      }),
    }));
    if (!created.ARN) throw new Error('DentalEMS database secret was not created');
    tenantSecretArn = created.ARN;
  }

  const quotedPassword = (await client.query<{password:string}>('SELECT quote_literal($1) password', [tenantPassword])).rows[0]?.password;
  if (!quotedPassword) throw new Error('Unable to prepare tenant database credential');
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kh_dentalems_app') THEN CREATE ROLE kh_dentalems_app LOGIN PASSWORD ${quotedPassword}; ELSE ALTER ROLE kh_dentalems_app PASSWORD ${quotedPassword}; END IF; END $$`);
  await client.query('GRANT kh_request TO kh_dentalems_app');

  const registryValue = await secrets.send(new GetSecretValueCommand({ SecretId: tenantRegistrySecretId }));
  if (!registryValue.SecretString) throw new Error('Tenant registry is unavailable');
  const registry = JSON.parse(registryValue.SecretString) as {tenants:Array<Record<string,unknown>>};
  const previous = registry.tenants.find(item => item.organizationId === organizationId) as Record<string,unknown> | undefined;
  const previousClinic = Array.isArray(previous?.bookingClinics)
    ? (previous.bookingClinics as Array<Record<string,unknown>>).find(item => item.locationId === locationId)
    : undefined;
  const bookingKey = typeof previousClinic?.key === 'string' ? previousClinic.key : randomBytes(32).toString('base64url');
  const tenant = {
    organizationId,
    databaseSecretArn: tenantSecretArn,
    documentsBucket,
    staffUserPoolId,
    staffClientId,
    bookingClinics: [{ key: bookingKey, locationId, clinicName: 'Express Dental Emergency Services', timezone: 'America/New_York' }],
  };
  registry.tenants = [...registry.tenants.filter(item => item.organizationId !== organizationId), tenant];
  await secrets.send(new PutSecretValueCommand({ SecretId: tenantRegistrySecretId, SecretString: JSON.stringify(registry) }));

  const bookingSecretName = 'kantage-healthcare-production-dentalems-booking';
  const bookingSecretString = JSON.stringify({ apiUrl: 'https://health.kantage.solutions', bookingKey });
  try {
    await secrets.send(new CreateSecretCommand({ Name: bookingSecretName, Description: 'DentalEMS public booking integration', SecretString: bookingSecretString }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ResourceExistsException') throw error;
    await secrets.send(new PutSecretValueCommand({ SecretId: bookingSecretName, SecretString: bookingSecretString }));
  }
  console.log(JSON.stringify({ status: 'provisioned', organizationId, locationId, bookingSecretName }));
} finally {
  await client.end();
}
