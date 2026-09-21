import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const connectionString=process.env.DATABASE_URL;
if(!connectionString) throw new Error('DATABASE_URL is required');

const client=new Client({connectionString,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:undefined});
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied=new Set((await client.query<{name:string}>('SELECT name FROM schema_migrations')).rows.map(row=>row.name));
  const dir=fileURLToPath(new URL('../migrations/',import.meta.url));
  const files=(await readdir(dir)).filter(name=>/^\d+_.+\.sql$/.test(name)).sort();
  for(const name of files) {
    if(applied.has(name)) continue;
    const sql=await readFile(join(dir,name),'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
  }
} finally { await client.end(); }
