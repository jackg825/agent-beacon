// Offline only: write a new device credential and D1 statement into a private directory.
// This command does not enroll a device, deploy, or change collector configuration.
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
const [id, name, ...flags] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || '') || !name || name.length>120 || flags.some(f=>f!=='--rotate')) {
  console.error('Usage: npm run device:prepare -- DEVICE_ID "DISPLAY_NAME" [--rotate]'); process.exit(1);
}
const directory=resolve('.local',`${id}-${Date.now()}`);
await mkdir(directory,{recursive:true,mode:0o700});
const parent=await stat(resolve('.local'));
if ((parent.mode & 0o077)!==0) { console.error('.local must have private permissions (0700).'); process.exit(1); }
const token=`bcn_cf_${randomBytes(32).toString('base64url')}`;
const hash=createHash('sha256').update(token).digest('hex');
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const sql=`INSERT INTO devices(id,name,token_hash,created_at) VALUES(${quote(id)},${quote(name)},${quote(hash)},${quote(new Date().toISOString())})` +
  (flags.includes('--rotate')?' ON CONFLICT(id) DO UPDATE SET name=excluded.name,token_hash=excluded.token_hash,revoked=0':'')+';\n';
await writeFile(resolve(directory,'device-token'),token+'\n',{mode:0o600,flag:'wx'});
await writeFile(resolve(directory,'enroll.sql'),sql,{mode:0o600,flag:'wx'});
console.log(`Prepared private device-token and enroll.sql in ${directory}. No credential printed; no external write performed.`);
