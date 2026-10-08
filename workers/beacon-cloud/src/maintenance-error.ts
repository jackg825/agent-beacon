// Kept apart from maintenance.ts so track modules, which maintenance.ts imports to
// build its task list, can throw coded errors without an import cycle.
/** Error codes are the only failure detail a scheduled report carries. */
export class MaintenanceError extends Error {
  constructor(public code: string) { super(code); }
}
