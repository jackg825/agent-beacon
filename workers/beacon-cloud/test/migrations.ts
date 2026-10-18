import { readFile, readdir } from 'node:fs/promises';

type Database = {prepare(sql:string):{run():Promise<unknown>}};

/** Keep trigger bodies intact while executing the committed SQLite migrations. */
export async function applyMigrations(db:Database, files?:string[]) {
  const names=files??(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const sql=await readFile('migrations/'+name,'utf8');
    let statement='';
    for (const line of sql.split('\n')) {
      if (/^\s*--/.test(line) || !line.trim()) continue;
      statement+=line+'\n';
      const trigger=/^\s*CREATE\s+TRIGGER\b/i.test(statement);
      if (trigger ? /^\s*END;\s*$/.test(line) : /;\s*$/.test(line)) {
        await db.prepare(statement).run(); statement='';
      }
    }
    if (statement.trim()) throw new Error('Unterminated migration statement in '+name);
  }
}
