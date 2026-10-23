import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';
import { z } from 'zod';

const rdsSecret = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive().default(5432),
  dbname: z.string().min(1).optional(),
  database: z.string().min(1).optional(),
  username: z.string().min(1),
  password: z.string().min(1),
}).passthrough();

const RDS_GLOBAL_CA_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';

export async function databaseClientFromSecret(secretId: string): Promise<Client> {
  const result = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) throw new Error('Database credentials are unavailable');
  const credentials = rdsSecret.parse(JSON.parse(result.SecretString));
  const caResponse = await fetch(RDS_GLOBAL_CA_URL);
  if (!caResponse.ok) throw new Error('Unable to load the Amazon RDS certificate bundle');
  const ca = await caResponse.text();
  return new Client({
    host: credentials.host,
    port: credentials.port,
    database: credentials.dbname ?? credentials.database ?? 'clinical',
    user: credentials.username,
    password: credentials.password,
    ssl: { ca, rejectUnauthorized: true },
  });
}
