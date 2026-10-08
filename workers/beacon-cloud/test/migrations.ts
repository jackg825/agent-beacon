import { applyMigrationStatements } from '../scripts/migration-sql';

type Database<Statement> = {prepare(sql:string):Statement;batch(statements:Statement[]):Promise<unknown>};

/** Keep trigger bodies intact while executing the committed SQLite migrations. */
export async function applyMigrations<Statement>(db:Database<Statement>, files?:string[]) {
  await applyMigrationStatements(db,{files});
}
