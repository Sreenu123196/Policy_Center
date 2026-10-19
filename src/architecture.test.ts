import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The module rules of CLAUDE.md, checked by reading the source (document sections 3 and 17):
//  - a module imports another module only through its public door, ../<module>/index.js
//  - a module never reads or writes another module's tables
// Platform is shared by everyone, and the testing support and these tests are exempt.

const MODULES = ['contacts', 'policy', 'billing', 'claims', 'platform'] as const;
const root = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(module: string): string[] {
  const folder = join(root, module);
  return readdirSync(folder)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(folder, name));
}

describe('module boundaries', () => {
  for (const module of MODULES) {
    const others = MODULES.filter((m) => m !== module);

    it(`${module} imports other modules only through their index.js`, () => {
      const violations: string[] = [];
      for (const file of sourceFiles(module)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/from '\.\.\/(\w+)\/([^']+)'/g)) {
          const [, target, path] = match;
          if (target && path && (MODULES as readonly string[]).includes(target) && path !== 'index.js') violations.push(`${file}: imports ../${target}/${path}`);
        }
      }
      expect(violations).toEqual([]);
    });

    it(`${module} never reads or writes the tables of another module`, () => {
      const violations: string[] = [];
      for (const file of sourceFiles(module)) {
        const text = readFileSync(file, 'utf8');
        for (const other of others) {
          if (module !== 'platform' && other === 'platform') continue; // Platform is shared: audit log, outbox, typelists
          const pattern = new RegExp(`\\b(from|join|into|update|delete from)\\s+${other}\\.[a-z_]+`, 'gi');
          for (const match of text.matchAll(pattern)) violations.push(`${file}: ${match[0]}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

// The API is the edge of the system (document section 17). It is not a module: it may use every module, but only through
// the public doors, and it never touches a table.
describe('the API layer', () => {
  const files = readdirSync(join(root, 'api'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(root, 'api', name));

  it('imports modules only through their index.js', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '\.\.\/(\w+)\/([^']+)'/g)) {
        const [, target, path] = match;
        if (target && path && (MODULES as readonly string[]).includes(target) && path !== 'index.js') violations.push(`${file}: imports ../${target}/${path}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never reads or writes a table', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\b(from|join|into|update|delete from)\s+(contacts|policy|billing|claims|platform)\.[a-z_]+/gi)) violations.push(`${file}: ${match[0]}`);
    }
    expect(violations).toEqual([]);
  });
});

