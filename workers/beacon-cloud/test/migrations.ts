import { applyMigrationStatements } from '../scripts/migration-sql';

type Database = {prepare(sql:string):{run():Promise<unknown>}};

/** Keep trigger bodies intact while executing the committed SQLite migrations. */
export async function applyMigrations(db:Database, files?:string[]) {
  await applyMigrationStatements(db,{files});
}
