import { processingPanel } from './dashboard-processing';
import { syncPanel } from './dashboard-sync';
import { operationsPanel } from './dashboard-operations';

/**
 * A track's dashboard tab. `html` is the static inner markup of its tabpanel and
 * `script` runs inside the main dashboard closure, so it can use byId, text, button,
 * date, status, failure, api, options, onSubmit and state, and must register
 * `panelLoaders[tab] = async () => {...}` to load when the tab opens. Both are
 * trusted source strings; recorded or authored data only ever enters textContent.
 */
export interface DashboardPanel { tab: string; label: string; html: string; script: string }

export const panels: DashboardPanel[] = [processingPanel, syncPanel, operationsPanel]
  .filter((panel): panel is DashboardPanel => panel !== null);
