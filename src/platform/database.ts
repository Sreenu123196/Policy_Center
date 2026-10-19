import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import pg from 'pg';

// The database, as the rest of the code sees it (document section 3). Every module uses only this small interface, so
// the same code runs on PGlite (PostgreSQL inside Node, used by the tests and for a quick local run) and on a real
// PostgreSQL server (Docker or a hosted service). All connection code is in this one file.

export interface QueryResult<T> {
  rows: T[];
}

// A transaction in progress: the same calls as the database, but every call is part of one all-or-nothing unit.
export interface Transaction {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>; // several statements, no parameters (used by migrations)
}

export interface Database extends Transaction {
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- PGlite

class PgliteDatabase implements Database {
  constructor(private readonly db: PGlite) {}

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.db.query<T>(sql, params as never[] | undefined);
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      work({
        query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => tx.query<R>(sql, params as never[] | undefined),
        exec: async (sql: string) => {
          await tx.exec(sql);
        },
      }),
    );
  }

  close(): Promise<void> {
    return this.db.close();
  }
}

// Opens the local PostgreSQL (PGlite). With no folder the database lives in memory, which is what the tests use. With a
// folder it keeps its files there.
export async function createDatabase(dataDir?: string): Promise<Database> {
  const db = new PGlite({ ...(dataDir ? { dataDir } : {}), extensions: { btree_gist } });
  await db.waitReady;
  return new PgliteDatabase(db);
}

// ---------------------------------------------------------------- a PostgreSQL server

// The server sends 64-bit integers and exact decimals as text, and dates as JavaScript dates in the local time zone.
// The code reads numbers as numbers (every money column is far below 2^53) and keeps dates as yyyy-mm-dd text, so a
// time zone can never move a date by a day.
const types = pg.types;
types.setTypeParser(20, (value) => Number(value)); // int8
types.setTypeParser(1700, (value) => Number(value)); // numeric
types.setTypeParser(1082, (value) => value); // date

class PostgresDatabase implements Database {
  constructor(private readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params as unknown[] | undefined);
    return { rows: result.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work({
        query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params as unknown[] | undefined)).rows as R[] }),
        exec: async (sql: string) => {
          await client.query(sql);
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

// Connects to a PostgreSQL server, for example postgres://user:password@localhost:5432/insurance_suite.
export async function connectPostgres(url: string, options: { maxConnections?: number } = {}): Promise<Database> {
  const pool = new pg.Pool({ connectionString: url, max: options.maxConnections ?? 10 });
  pool.on('error', (error) => console.error('PostgreSQL connection error:', error.message)); // an idle connection was lost: the pool replaces it
  await pool.query('select 1'); // fail now, with the real reason, if the server cannot be reached
  return new PostgresDatabase(pool);
}

// Chooses the database from the settings: a PostgreSQL server if a URL is given, otherwise PGlite (in a folder or in memory).
export function openDatabase(options: { url?: string | undefined; dataDir?: string | undefined } = {}): Promise<Database> {
  return options.url ? connectPostgres(options.url) : createDatabase(options.dataDir);
}
