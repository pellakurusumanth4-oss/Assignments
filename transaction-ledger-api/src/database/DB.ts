import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

// NUMERIC arrives as a string by default; the JSON API returns amounts as numbers.
// shortcut: exact to the cent only below 2^53 / 100 (~90 trillion); switch to string amounts if balances can grow past that.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number.parseFloat);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Without a listener, an idle connection dropped by the server (e.g. a Postgres restart) crashes the process.
// The pool discards that connection and opens a fresh one for the next query.
pool.on('error', (err) => console.error('Idle database connection lost:', err.message));

const migrationsDir = new URL('../../database/migrations/', import.meta.url);

// Connection of the open DB.transaction(), so repositories join it without passing a client around.
const currentTransaction = new AsyncLocalStorage<pg.PoolClient>();

/** Small stand-in for Laravel's DB facade. */
export const DB = {
  query<R extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
    const client = currentTransaction.getStore();
    return client ? client.query<R>(sql, params) : pool.query<R>(sql, params);
  },

  /** Like DB::transaction(): commits when `callback` resolves, rolls back when it throws. */
  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    // The pool stops listening for errors on a checked-out connection. The failing query rejects
    // on its own; this listener only stops a dropped connection from also crashing the process.
    const onError = (err: Error) => console.error('Database connection lost mid-transaction:', err.message);
    client.on('error', onError);
    let brokenConnection: Error | undefined;

    try {
      await client.query('BEGIN');
      const result = await currentTransaction.run(client, callback);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // If ROLLBACK fails too, the connection is broken: releasing it with the error destroys it instead of re-pooling it.
      brokenConnection = await client.query('ROLLBACK').then(() => undefined, (rollbackError: Error) => rollbackError);
      throw err;
    } finally {
      client.off('error', onError);
      client.release(brokenConnection);
    }
  },

  /** Runs every .sql file in database/migrations in name order. */
  async migrate(): Promise<void> {
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      await pool.query(await readFile(new URL(file, migrationsDir), 'utf8'));
    }
  },

  end: () => pool.end(),
};
