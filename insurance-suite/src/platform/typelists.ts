import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.js';
import { recordAudit } from './audit.js';
import { typelistFileSchema, type TypelistFile } from './typelist-schema.js';
import { ValidationError } from './validation-error.js';

export type Language = 'en' | 'hi' | 'te';

// The column holding the name in each language. Only these three fixed values ever reach the SQL text.
const NAME_COLUMN: Record<Language, string> = { en: 'name_en', hi: 'name_hi', te: 'name_te' };

export interface TypelistEntry {
  code: string;
  name: string; // in the language asked for
  sortOrder: number;
  retired: boolean;
}

export interface LoadResult {
  typelist: string;
  version: string;
  outcome: 'loaded' | 'unchanged';
}

interface ParsedFile {
  file: string;
  checksum: string;
  content: TypelistFile;
}

// "2026.10.1" compared as numbers, so 2026.9.1 comes before 2026.10.1.
function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// First pass: read every .json file and check it against the schema. Problems are collected, not thrown one by one.
function readTypelistFiles(directory: string): { files: ParsedFile[]; errors: string[] } {
  const files: ParsedFile[] = [];
  const errors: string[] = [];

  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json')).sort()) {
    // A byte order mark at the start of the file (some Windows editors add one) and Windows line endings are
    // removed, so neither changes how the file is read or its fingerprint.
    const raw = readFileSync(join(directory, file), 'utf8');
    const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, '\n');

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      errors.push(`${file}: the file is not valid JSON (${(error as Error).message})`);
      continue;
    }

    const parsed = typelistFileSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`${file}: ${issue.path.map(String).join('.') || 'file'}: ${issue.message}`);
      continue;
    }
    files.push({ file, checksum: createHash('sha256').update(text).digest('hex'), content: parsed.data });
  }
  return { files, errors };
}

// Second pass, still changing nothing: should this file be applied, or skipped because it is already loaded?
async function decide(db: Database, parsed: ParsedFile): Promise<'apply' | 'skip'> {
  const { file, checksum, content } = parsed;

  const history = await db.query<{ version: string; checksum: string }>(
    "select version, checksum from platform.config_version where kind = 'typelist' and name = $1",
    [content.typelist],
  );

  const sameVersion = history.rows.find((row) => row.version === content.version);
  if (sameVersion) {
    if (sameVersion.checksum === checksum) return 'skip';
    throw new ValidationError([`${file}: version ${content.version} of ${content.typelist} was already loaded with different content. Change the version number.`]);
  }

  const newest = history.rows.map((row) => row.version).sort(compareVersions).at(-1);
  if (newest !== undefined && compareVersions(content.version, newest) < 0) {
    throw new ValidationError([`${file}: version ${content.version} is older than the loaded version ${newest}`]);
  }

  // A code can be retired but never removed: old records still refer to it.
  const existing = await db.query<{ code: string }>('select code from platform.typelist_entry where typelist = $1', [content.typelist]);
  const inFile = new Set(content.entries.map((e) => e.code));
  const removed = existing.rows.map((row) => row.code).filter((code) => !inFile.has(code));
  if (removed.length > 0) {
    throw new ValidationError([`${file}: ${removed.join(', ')} cannot be removed from ${content.typelist}. Mark it "retired": true instead`]);
  }
  return 'apply';
}

// Applies one file: the entries, the version record and the audit entry are saved together or not at all.
async function apply(db: Database, parsed: ParsedFile, actor: string): Promise<void> {
  const { checksum, content } = parsed;
  await db.transaction(async (tx) => {
    await tx.query('insert into platform.typelist (name) values ($1) on conflict do nothing', [content.typelist]);
    for (const e of content.entries) {
      await tx.query(
        `insert into platform.typelist_entry (typelist, code, sort_order, retired, name_en, name_hi, name_te)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (typelist, code) do update
           set sort_order = excluded.sort_order, retired = excluded.retired,
               name_en = excluded.name_en, name_hi = excluded.name_hi, name_te = excluded.name_te`,
        [content.typelist, e.code, e.sort, e.retired ?? false, e.names.en, e.names.hi, e.names.te],
      );
    }
    await tx.query(
      `insert into platform.config_version (kind, name, version, checksum, effective_from, loaded_by)
       values ('typelist', $1, $2, $3, $4::date, $5)`,
      [content.typelist, content.version, checksum, content.effective_from, actor],
    );
    await recordAudit(tx, {
      actor,
      action: 'config.load',
      entityType: 'typelist',
      entityId: content.typelist,
      details: { version: content.version, entries: content.entries.length },
    });
  });
}

// Loads every typelist file in a folder. All files are checked first; if any has a problem, nothing is loaded.
export async function loadTypelists(db: Database, directory: string, actor: string): Promise<LoadResult[]> {
  const { files, errors } = readTypelistFiles(directory);

  const seen = new Map<string, string>();
  for (const { file, content } of files) {
    const other = seen.get(content.typelist);
    if (other) errors.push(`${file}: the typelist ${content.typelist} is also defined in ${other}`);
    else seen.set(content.typelist, file);
  }
  if (errors.length > 0) throw new ValidationError(errors);

  const plan: { parsed: ParsedFile; action: 'apply' | 'skip' }[] = [];
  for (const parsed of files) {
    try {
      plan.push({ parsed, action: await decide(db, parsed) });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      errors.push(...error.errors);
    }
  }
  if (errors.length > 0) throw new ValidationError(errors);

  const results: LoadResult[] = [];
  for (const { parsed, action } of plan) {
    if (action === 'apply') await apply(db, parsed, actor);
    results.push({ typelist: parsed.content.typelist, version: parsed.content.version, outcome: action === 'apply' ? 'loaded' : 'unchanged' });
  }
  return results;
}

// The entries of a typelist in sort order, with names in the chosen language (English by default).
// Retired codes are left out unless asked for. Returns null if there is no such typelist.
export async function getTypelist(
  db: Database,
  name: string,
  options: { language?: Language; includeRetired?: boolean } = {},
): Promise<TypelistEntry[] | null> {
  const known = await db.query('select 1 from platform.typelist where name = $1', [name]);
  if (known.rows.length === 0) return null;

  const column = NAME_COLUMN[options.language ?? 'en'];
  const result = await db.query<{ code: string; name: string; sort_order: number; retired: boolean }>(
    `select code, ${column} as name, sort_order, retired
       from platform.typelist_entry
      where typelist = $1 ${options.includeRetired ? '' : 'and not retired'}
      order by sort_order, code`,
    [name],
  );
  return result.rows.map((row) => ({ code: row.code, name: row.name, sortOrder: row.sort_order, retired: row.retired }));
}

// May this code still be used for new records? True only if it exists and is not retired.
export async function isActiveTypelistCode(db: Database, typelist: string, code: string): Promise<boolean> {
  const result = await db.query('select 1 from platform.typelist_entry where typelist = $1 and code = $2 and not retired', [typelist, code]);
  return result.rows.length > 0;
}
