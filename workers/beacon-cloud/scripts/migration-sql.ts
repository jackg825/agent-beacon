// Shared by test/migrations.ts and scripts/restore-check.ts. Reads only the committed
// migrations next to this file; never writes under migrations/.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
export type MigrationStatement = { file: string; sql: string; trigger: string | null };
type Database = { prepare(sql: string): { run(): Promise<unknown> } };

/** Split one migration file, keeping trigger bodies (which contain `;`) intact. */
export function splitMigration(file: string, sql: string): MigrationStatement[] {
  const statements: MigrationStatement[] = [];
  let statement = '';
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) || !line.trim()) continue;
    statement += line + '\n';
    const trigger = /^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(statement);
    if (trigger ? /^\s*END;\s*$/.test(line) : /;\s*$/.test(line)) {
      statements.push({ file, sql: statement, trigger: trigger?.[1] ?? null });
      statement = '';
    }
  }
  if (statement.trim()) throw new Error('Unterminated migration statement in ' + file);
  return statements;
}

export async function migrationFiles(directory = migrationsDirectory): Promise<string[]> {
  return (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
}

export async function migrationStatements(files?: string[], directory = migrationsDirectory): Promise<MigrationStatement[]> {
  const names = files ?? await migrationFiles(directory);
  const statements: MigrationStatement[] = [];
  for (const name of names) statements.push(...splitMigration(name, await readFile(directory + name, 'utf8')));
  return statements;
}

/**
 * Apply committed migrations in order. With deferTriggers, CREATE TRIGGER statements
 * are skipped and returned so a restore-only scratch database can load historical rows
 * first and create the same triggers afterwards. Only scripts/restore-check.ts uses it,
 * and only on a local database it created.
 */
export async function applyMigrationStatements(db: Database, options: { files?: string[]; deferTriggers?: boolean } = {}) {
  const deferred: MigrationStatement[] = [];
  for (const statement of await migrationStatements(options.files)) {
    if (options.deferTriggers && statement.trigger) { deferred.push(statement); continue; }
    await db.prepare(statement.sql).run();
  }
  return deferred;
}

/** SQLite stores CREATE text without the terminating semicolon. */
export function normalizedStatement(sql: string): string {
  return sql.trim().replace(/;\s*$/, '').trim();
}
