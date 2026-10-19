import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULES } from './modules.js';

// The folder that holds every module: src/
const srcDir = fileURLToPath(new URL('..', import.meta.url));

describe('modules (document section 2)', () => {
  it('are the five from the document: contacts, policy, billing, claims and the shared platform', () => {
    expect(MODULES).toEqual(['contacts', 'policy', 'billing', 'claims', 'platform']);
  });

  it('each have a folder with a public index.ts, the only door other modules may use', () => {
    for (const name of MODULES) {
      expect(existsSync(join(srcDir, name, 'index.ts')), `${name}/index.ts is missing`).toBe(true);
    }
  });
});
