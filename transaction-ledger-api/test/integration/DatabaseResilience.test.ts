// A Postgres restart or failover drops connections. The API must survive it, not crash.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { DB } from '../../src/database/DB.ts';
import '../TestCase.ts';

async function terminateBackend(pid: number) {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query('SELECT pg_terminate_backend($1)', [pid]);
  await admin.end();
}

test('test_idle_connection_dropped_by_server_does_not_crash', async () => {
  const { rows } = await DB.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'); // that connection now idles in the pool

  await terminateBackend(rows[0].pid);
  await setTimeout(200);

  assert.equal((await DB.query('SELECT 1 AS ok')).rows[0].ok, 1);
});

test('test_connection_lost_mid_transaction_rolls_back_without_crashing', async () => {
  await assert.rejects(
    DB.transaction(() => DB.query('SELECT pg_terminate_backend(pg_backend_pid())')),
    /terminating connection/,
  );

  assert.equal((await DB.query('SELECT 1 AS ok')).rows[0].ok, 1);
});
