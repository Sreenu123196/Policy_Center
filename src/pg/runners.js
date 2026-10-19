'use strict';
// How the store reaches a database, without caring which one. Both drivers offer the same two things:
//   query(sql, params) -> { rows }
//   transaction(fn)    -> runs fn(q) inside BEGIN / COMMIT, rolling back if fn throws
//
// `pg` is the production driver (a real server). PGlite is the same PostgreSQL engine compiled to WebAssembly, running
// in the same process: no server, no Docker, nothing to install — which is what the tests use, and what makes the
// simulator runnable on a machine without PostgreSQL (DATABASE_URL=memory://).

const { Pool } = require('pg');

class PgRunner {
  constructor(pool) {
    this.pool = pool;
  }

  static fromUrl(url) {
    return new PgRunner(new Pool({ connectionString: url }));
  }

  async query(sql, params = []) {
    return this.pool.query(sql, params);
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn((sql, params = []) => client.query(sql, params));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

class PgliteRunner {
  constructor(db) {
    this.db = db;
  }

  // An in-process database: nothing to install and nothing to keep. Used by the tests and by DATABASE_URL=memory://.
  static async fromUrl(url) {
    const { PGlite } = require('@electric-sql/pglite');
    const dataDir = url && url !== 'memory://' ? String(url).replace(/^pglite:\/\//, '') : undefined;
    return new PgliteRunner(new PGlite(dataDir));
  }

  async query(sql, params = []) {
    return this.db.query(sql, params);
  }

  async transaction(fn) {
    return this.db.transaction(async (tx) => fn((sql, params = []) => tx.query(sql, params)));
  }

  async close() {
    await this.db.close();
  }
}

module.exports = { PgRunner, PgliteRunner };
