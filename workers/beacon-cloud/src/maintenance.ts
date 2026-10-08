import { Env, HttpError } from './types';
import { processingMaintenance } from './processing';
import { operationsMaintenance } from './operations';

/** Error codes are the only failure detail a scheduled report carries. */
export class MaintenanceError extends Error {
  constructor(public code: string) { super(code); }
}
export type Schedule = 'frequent' | 'hourly';
// Workers Paid gives crons firing at least hourly 15 min of CPU instead of 30 s,
// so heavy maintenance (backup, health) runs on the hourly schedule.
export const FREQUENT_CRON = '*/15 * * * *';
export const HOURLY_CRON = '17 * * * *';

/** Platform calls one task may make per invocation: D1 statements, R2 operations, outbound fetches. */
export interface Allotment { d1: number; r2: number; fetch: number }
export interface MaintenanceContext {
  now: Date;
  /** Milliseconds left in this invocation's shared budget; tasks stop starting new work at zero. */
  remaining(): number;
  /** Calls this task has made so far, counted by the metered env. */
  usage(): Allotment;
  /** The only outbound fetch a task may use; counted against its `fetch` allotment. */
  fetch: typeof fetch;
}
export interface MaintenanceTask {
  name: string;
  schedule: Schedule;
  allotment: Allotment;
  /** `env` is metered: exceeding the allotment throws MaintenanceError('budget_exhausted:<kind>'). */
  run(env: Env, ctx: MaintenanceContext): Promise<Record<string, unknown>>;
}
export type MaintenanceReport = Record<string, { ok: boolean; duration_ms: number; usage: Allotment;
  result?: Record<string, unknown>; error?: string }>;

// Each track registers its bounded background work here. Every task must be safe
// when invocations overlap; none runs unless MAINTENANCE_TASKS names it.
export const maintenanceTasks: MaintenanceTask[] = [
  ...processingMaintenance,
  ...operationsMaintenance,
];

// Conservative per-invocation caps under Workers Paid (1,000 D1 queries and
// 10,000 subrequests per invocation; D1 and R2 binding calls count as subrequests).
export const INVOCATION_LIMITS: Allotment = { d1: 900, r2: 4000, fetch: 50 };

function code(error: unknown): string {
  if (error instanceof MaintenanceError && /^[a-z0-9_.:-]{1,64}$/.test(error.code)) return error.code;
  if (error instanceof HttpError) return 'http_' + error.status;
  // D1/R2 messages can quote SQL or keys; never copy them into a report.
  return 'task_failed';
}

export class Meter {
  used: Allotment = { d1: 0, r2: 0, fetch: 0 };
  constructor(private limit: Allotment) {}
  take(kind: keyof Allotment, count = 1) {
    if (this.used[kind] + count > this.limit[kind]) throw new MaintenanceError('budget_exhausted:' + kind);
    this.used[kind] += count;
  }
}

const statementTarget = Symbol('statement');
type Wrapped = { [statementTarget]: D1PreparedStatement };
function meteredStatement(statement: D1PreparedStatement, meter: Meter): D1PreparedStatement {
  const run = <T>(call: () => Promise<T>) => { meter.take('d1'); return call(); };
  return {
    [statementTarget]: statement,
    bind: (...values: unknown[]) => meteredStatement(statement.bind(...values), meter),
    first: (column?: string) => run(() => column === undefined ? statement.first() : statement.first(column)),
    all: () => run(() => statement.all()),
    run: () => run(() => statement.run()),
    raw: (options?: { columnNames?: boolean }) => run(() => statement.raw(options as { columnNames: true })),
  } as unknown as D1PreparedStatement;
}
function meteredDatabase(db: D1Database, meter: Meter): D1Database {
  return {
    prepare: (sql: string) => meteredStatement(db.prepare(sql), meter),
    batch: (statements: D1PreparedStatement[]) => {
      // D1 counts every statement in a batch as a query.
      meter.take('d1', statements.length);
      return db.batch(statements.map(statement => (statement as unknown as Wrapped)[statementTarget] ?? statement));
    },
    exec: (sql: string) => { meter.take('d1'); return db.exec(sql); },
    dump: () => { throw new MaintenanceError('unsupported_d1_call'); },
    withSession: () => { throw new MaintenanceError('unsupported_d1_call'); },
  } as unknown as D1Database;
}
function meteredBucket(bucket: R2Bucket, meter: Meter): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { meter.take('r2'); return value.apply(target, args); };
    },
  });
}
/** Wrap every platform binding so a task cannot exceed its allotment, even by mistake. */
export function meteredEnv(env: Env, meter: Meter): Env {
  return { ...env, ...(env.DB ? { DB: meteredDatabase(env.DB, meter) } : {}), ...(env.RAW ? { RAW: meteredBucket(env.RAW, meter) } : {}),
    ...(env.BACKUP ? { BACKUP: meteredBucket(env.BACKUP, meter) } : {}) };
}

/** Task names the operator enabled; nothing runs by default. */
export function enabledTasks(env: Env): Set<string> {
  return new Set((env.MAINTENANCE_TASKS || '').split(',').map(name => name.trim()).filter(Boolean));
}

export async function runMaintenance(env: Env, options: { now?: Date; schedule?: Schedule; tasks?: MaintenanceTask[];
  budgetMs?: number; clock?: () => number; fetcher?: typeof fetch } = {}): Promise<MaintenanceReport> {
  const clock = options.clock ?? (() => Date.now());
  const configured = Number(env.MAINTENANCE_BUDGET_MS);
  const budget = options.budgetMs ?? (Number.isInteger(configured) && configured >= 1000 && configured <= 600_000 ? configured : 25_000);
  const deadline = clock() + budget;
  const enabled = enabledTasks(env);
  const tasks = (options.tasks ?? maintenanceTasks).filter(task => enabled.has(task.name)
    && (!options.schedule || task.schedule === options.schedule));
  const left: Allotment = { ...INVOCATION_LIMITS };
  const report: MaintenanceReport = {};
  for (const task of tasks) {
    const started = clock();
    const meter = new Meter({ d1: Math.min(task.allotment.d1, left.d1), r2: Math.min(task.allotment.r2, left.r2),
      fetch: Math.min(task.allotment.fetch, left.fetch) });
    const outbound = options.fetcher ?? fetch;
    const ctx: MaintenanceContext = { now: options.now ?? new Date(clock()), remaining: () => Math.max(0, deadline - clock()),
      usage: () => ({ ...meter.used }),
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => { meter.take('fetch'); return outbound(input, init); }) as typeof fetch };
    if (ctx.remaining() <= 0) { report[task.name] = { ok: false, duration_ms: 0, usage: meter.used, error: 'budget_exhausted:time' }; continue; }
    try { report[task.name] = { ok: true, duration_ms: 0, usage: meter.used, result: await task.run(meteredEnv(env, meter), ctx) }; }
    catch (error) { report[task.name] = { ok: false, duration_ms: 0, usage: meter.used, error: code(error) }; }
    report[task.name].duration_ms = clock() - started;
    for (const kind of ['d1', 'r2', 'fetch'] as const) left[kind] -= meter.used[kind];
  }
  return report;
}
