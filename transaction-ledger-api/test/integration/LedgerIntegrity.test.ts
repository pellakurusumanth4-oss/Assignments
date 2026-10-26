import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DB } from '../../src/database/DB.ts';
import '../TestCase.ts';

test('test_every_balance_equals_the_sum_of_its_transactions', async () => {
  const { rows } = await DB.query(`
    SELECT a.id, a.balance FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.id
    GROUP BY a.id, a.balance
    HAVING a.balance <> COALESCE(SUM(CASE t.type WHEN 'credit' THEN t.amount ELSE -t.amount END), 0)`);

  assert.deepEqual(rows, []);
});
