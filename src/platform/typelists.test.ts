import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, resetDatabase } from '../testing/database.js';
import { listAuditEntries } from './audit.js';
import { getTypelist, isActiveTypelistCode, loadTypelists } from './typelists.js';
import { ValidationError } from './validation-error.js';

// The project's own typelist files: config/typelists/
const realTypelists = fileURLToPath(new URL('../../config/typelists/', import.meta.url));

let db: PGlite;
let dir: string; // a throwaway folder for the files each test writes

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetDatabase(db);
  dir = mkdtempSync(join(tmpdir(), 'suite-typelists-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A typelist entry whose three names are easy to tell apart.
const entry = (code: string, sort: number, en: string, extra: Record<string, unknown> = {}) => ({
  code,
  sort,
  names: { en, hi: `${en} (hi)`, te: `${en} (te)` },
  ...extra,
});

const colour = (over: Record<string, unknown> = {}) => ({
  typelist: 'colour',
  version: '2026.10.1',
  effective_from: '2026-10-01',
  entries: [entry('red', 10, 'Red'), entry('blue', 20, 'Blue')],
  ...over,
});

const write = (file: string, content: unknown) =>
  writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2));

const errorsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).errors;
};

describe('typelists (document sections 4 and 18)', () => {
  it('load from a file, with a name in English, Hindi and Telugu for each code, in sort order', async () => {
    write('colour.json', colour({
      entries: [
        { code: 'blue', sort: 20, names: { en: 'Blue', hi: 'नीला', te: 'నీలం' } },
        { code: 'red', sort: 10, names: { en: 'Red', hi: 'लाल', te: 'ఎరుపు' } },
      ],
    }));

    expect(await loadTypelists(db, dir, 'admin')).toEqual([{ typelist: 'colour', version: '2026.10.1', outcome: 'loaded' }]);

    expect((await getTypelist(db, 'colour'))?.map((e) => [e.code, e.name])).toEqual([['red', 'Red'], ['blue', 'Blue']]);
    expect((await getTypelist(db, 'colour', { language: 'hi' }))?.map((e) => e.name)).toEqual(['लाल', 'नीला']);
    expect((await getTypelist(db, 'colour', { language: 'te' }))?.map((e) => e.name)).toEqual(['ఎరుపు', 'నీలం']);
    expect(await getTypelist(db, 'nope')).toBeNull();
  });

  it('are not loaded twice: the same version again does nothing, and a changed file under the same version is refused', async () => {
    write('colour.json', colour());
    await loadTypelists(db, dir, 'admin');

    expect(await loadTypelists(db, dir, 'admin')).toEqual([{ typelist: 'colour', version: '2026.10.1', outcome: 'unchanged' }]);

    write('colour.json', colour({ entries: [entry('red', 10, 'Scarlet'), entry('blue', 20, 'Blue')] }));
    expect(await errorsOf(loadTypelists(db, dir, 'admin'))).toEqual([expect.stringMatching(/already loaded with different content.*change the version/i)]);
    expect((await getTypelist(db, 'colour'))?.[0]?.name).toBe('Red');
  });

  it('can be updated by a newer version that adds, renames and retires codes', async () => {
    write('colour.json', colour());
    await loadTypelists(db, dir, 'admin');

    write('colour.json', colour({
      version: '2026.11.1',
      entries: [entry('red', 10, 'Crimson'), entry('blue', 20, 'Blue', { retired: true }), entry('green', 30, 'Green')],
    }));
    expect(await loadTypelists(db, dir, 'admin')).toEqual([{ typelist: 'colour', version: '2026.11.1', outcome: 'loaded' }]);

    const active = await getTypelist(db, 'colour');
    expect(active?.map((e) => e.code)).toEqual(['red', 'green']);
    expect(active?.[0]?.name).toBe('Crimson');
    expect((await getTypelist(db, 'colour', { includeRetired: true }))?.map((e) => [e.code, e.retired])).toEqual([['red', false], ['blue', true], ['green', false]]);
  });

  it('never lose a code: a version that leaves one out is refused, and an older version is refused', async () => {
    write('colour.json', colour({ version: '2026.11.1', entries: [entry('red', 10, 'Red'), entry('blue', 20, 'Blue')] }));
    await loadTypelists(db, dir, 'admin');

    write('colour.json', colour({ version: '2026.12.1', entries: [entry('red', 10, 'Red')] }));
    expect(await errorsOf(loadTypelists(db, dir, 'admin'))).toEqual([expect.stringMatching(/blue cannot be removed.*retired/i)]);

    write('colour.json', colour({ version: '2026.10.5' }));
    expect(await errorsOf(loadTypelists(db, dir, 'admin'))).toEqual([expect.stringMatching(/older than the loaded version 2026\.11\.1/)]);
    expect((await getTypelist(db, 'colour'))?.map((e) => e.code)).toEqual(['red', 'blue']);
  });

  it('are checked against a schema first: every problem in every file is reported together, and nothing at all is loaded', async () => {
    write('bad1.json', {
      typelist: 'Colour',
      version: '2026-10-1',
      effective_from: '2026-13-45',
      entries: [{ code: 'Red', sort: -1, names: { en: 'Red', hi: '', te: 'ఎరుపు' } }],
    });
    write('bad2.json', '{ this is not json');
    write('good.json', colour({ typelist: 'shape' }));

    const errors = await errorsOf(loadTypelists(db, dir, 'admin'));
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/bad1\.json: typelist/),
        expect.stringMatching(/bad1\.json: version/),
        expect.stringMatching(/bad1\.json: effective_from/),
        expect.stringMatching(/bad1\.json: entries\.0\.code/),
        expect.stringMatching(/bad1\.json: entries\.0\.names\.hi/),
        expect.stringMatching(/bad2\.json: .*not valid JSON/i),
      ]),
    );
    expect(await getTypelist(db, 'shape')).toBeNull(); // the good file waited too
  });

  it('refuse a file that lists the same code twice, or has no entries', async () => {
    write('twice.json', colour({ entries: [entry('red', 10, 'Red'), entry('red', 20, 'Red again')] }));
    write('empty.json', colour({ typelist: 'shape', entries: [] }));
    const errors = await errorsOf(loadTypelists(db, dir, 'admin'));
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/twice\.json: entries.*same code/i), expect.stringMatching(/empty\.json: entries.*at least one/i)]),
    );
  });

  it('are recorded: the audit log says who loaded which version, and the version history is kept', async () => {
    write('colour.json', colour());
    await loadTypelists(db, dir, 'release.manager');

    const audit = await listAuditEntries(db, { entityType: 'typelist', entityId: 'colour' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'release.manager', action: 'config.load', details: { version: '2026.10.1', entries: 2 } });

    const history = await db.query<{ name: string; version: string; effective_from: string; loaded_by: string }>(
      "select name, version, to_char(effective_from, 'YYYY-MM-DD') as effective_from, loaded_by from platform.config_version where kind = 'typelist'",
    );
    expect(history.rows).toEqual([{ name: 'colour', version: '2026.10.1', effective_from: '2026-10-01', loaded_by: 'release.manager' }]);
  });

  it('say whether a code can still be used: yes if active, no if retired or unknown', async () => {
    write('colour.json', colour({ entries: [entry('red', 10, 'Red'), entry('blue', 20, 'Blue', { retired: true })] }));
    await loadTypelists(db, dir, 'admin');

    expect(await isActiveTypelistCode(db, 'colour', 'red')).toBe(true);
    expect(await isActiveTypelistCode(db, 'colour', 'blue')).toBe(false);
    expect(await isActiveTypelistCode(db, 'colour', 'purple')).toBe(false);
    expect(await isActiveTypelistCode(db, 'nope', 'red')).toBe(false);
  });
});

describe("the project's own typelists (config/typelists)", () => {
  it('load without problems and give the account contact roles in all three languages', async () => {
    const results = await loadTypelists(db, realTypelists, 'admin');
    expect(results.every((r) => r.outcome === 'loaded')).toBe(true);

    const roles = await getTypelist(db, 'account_contact_role');
    expect(roles?.map((r) => r.code)).toEqual(['named_insured', 'driver', 'financier', 'billing_contact']);
    for (const language of ['en', 'hi', 'te'] as const) {
      const names = (await getTypelist(db, 'account_contact_role', { language }))?.map((r) => r.name) ?? [];
      expect(names).toHaveLength(4);
      expect(names.every((n) => n.trim() !== '')).toBe(true);
    }
  });
});
