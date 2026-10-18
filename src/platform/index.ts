// Platform module (document sections 12, 13 and 17): users, roles, audit log, typelists,
// activities and events, shared by all other modules. This file is the module's public door.
export { MODULES } from './modules.js';
export type { ModuleName } from './modules.js';
export { createDatabase } from './database.js';
export { runMigrations } from './migrate.js';
export { ValidationError } from './validation-error.js';
export { isUuid } from './ids.js';
export { createProducerCode, createProducerOrganisation, deactivateProducerCode, getProducerCode } from './producers.js';
export type { ProducerCode, ProducerOrganisation } from './producers.js';
export { canSeeProducerCode } from './visibility.js';
export type { Visibility } from './visibility.js';
