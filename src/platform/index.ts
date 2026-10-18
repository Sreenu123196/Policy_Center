// Platform module (document sections 12, 13 and 17): users, roles, audit log, typelists,
// activities and events, shared by all other modules.
export { MODULES } from './modules.js';
export type { ModuleName } from './modules.js';
export { createDatabase } from './database.js';
export { runMigrations } from './migrate.js';
