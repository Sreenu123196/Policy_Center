// The modules of Insurance Suite (document section 2). Each one owns its own data and API.
// A module may use another module only through that module's public index.ts, never its tables.
export const MODULES = ['contacts', 'policy', 'billing', 'claims', 'platform'] as const;

export type ModuleName = (typeof MODULES)[number];
