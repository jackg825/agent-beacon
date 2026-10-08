import { readFile, readdir } from 'node:fs/promises';

type Database = Pick<D1Database, 'prepare' | 'batch'>;

/**
 * Keep trigger bodies intact while executing the committed SQLite migrations. Each
 * file runs as one D1 batch (one transaction): through the Miniflare proxy every
 * call is a new loopback connection, and per-statement calls exhausted macOS
 * ephemeral ports when the suite ran twice in a row.
 */
export async function applyMigrations(db:Database, files?:string[]) {
  const names=files??(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const sql=await readFile('migrations/'+name,'utf8');
    const statements:string[]=[];
    let statement='';
    for (const line of sql.split('\n')) {
      if (/^\s*--/.test(line) || !line.trim()) continue;
      statement+=line+'\n';
      const trigger=/^\s*CREATE\s+TRIGGER\b/i.test(statement);
      if (trigger ? /^\s*END;\s*$/.test(line) : /;\s*$/.test(line)) {
        statements.push(statement); statement='';
      }
    }
    if (statement.trim()) throw new Error('Unterminated migration statement in '+name);
    await db.batch(statements.map(text=>db.prepare(text)));
  }
}
