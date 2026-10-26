import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { TransferResource } from '../../src/resources/TransferResource.ts';
import { assertApiError, assertApiSuccess, balanceOf, createAccount, transactionData } from '../ApiTestTrait.ts';
import { json } from '../TestCase.ts';

/** Account A with 100 and account B with 50, as in the brief. */
async function createAccountsAB(): Promise<[string, string]> {
  const [a, b] = [await createAccount('A'), await createAccount('B')];
  await json('POST', `/api/accounts/${a}/transactions`, transactionData('credit', 100));
  await json('POST', `/api/accounts/${b}/transactions`, transactionData('credit', 50));
  return [a, b];
}

const transfer = (from: string, to: string, amount: number, reference_id: string) =>
  json('POST', '/api/transfers', { from_account_id: from, to_account_id: to, amount, reference_id });

describe('TransferApi', () => {
  test('test_create_transfer', async () => {
    const [a, b] = await createAccountsAB();

    const response = await transfer(a, b, 30, 't-1');

    assertApiSuccess(response, 201, TransferResource.schema);
    assert.equal(response.body.message, 'Transfer completed successfully');
    assert.equal(response.body.data.debit.type, 'debit');
    assert.equal(response.body.data.credit.type, 'credit');
    assert.equal(await balanceOf(a), 70);
    assert.equal(await balanceOf(b), 80);
  });

  test('test_transfer_with_insufficient_balance_moves_nothing', async () => {
    const [a, b] = await createAccountsAB();

    assertApiError(await transfer(a, b, 500, 't-2'), 422, 'Insufficient balance');

    assert.equal(await balanceOf(a), 100);
    assert.equal(await balanceOf(b), 50);
  });

  test('test_transfer_to_missing_account_rolls_back', async () => {
    const [a] = await createAccountsAB();

    assertApiError(await transfer(a, randomUUID(), 10, 't-3'), 404, 'Destination account not found');
    assertApiError(await transfer(randomUUID(), a, 10, 't-3'), 404, 'Source account not found');

    assert.equal(await balanceOf(a), 100);
  });

  test('test_transfer_validation', async () => {
    const [a, b] = await createAccountsAB();

    assertApiError(await transfer(a, a, 10, 't-4'), 422, 'The to account id field and from account id must be different.');
    assertApiError(await transfer('nope', b, 10, 't-4'), 422, 'The from account id field must be a valid UUID.');
  });

  test('test_duplicate_transfer_is_rejected', async () => {
    const [a, b] = await createAccountsAB();
    const first = await transfer(a, b, 10, 't-5');

    const again = await transfer(a, b, 10, 't-5');

    assertApiError(again, 409, 'A transaction with this reference_id already exists');
    assert.deepEqual(again.body.data, { transaction_id: first.body.data.debit.id });
    assert.equal(await balanceOf(a), 90);
  });

  test('test_transfer_accepts_uppercase_ids', async () => {
    const [a, b] = await createAccountsAB();

    const response = await transfer(a.toUpperCase(), b.toUpperCase(), 30, 't-6');

    assertApiSuccess(response, 201, TransferResource.schema);
    assert.equal(response.body.data.debit.account_id, a);
    assert.equal(await balanceOf(a), 70);
    assert.equal(await balanceOf(b), 80);
  });

  test('test_transfer_to_same_account_in_other_case_is_rejected', async () => {
    const [a] = await createAccountsAB();

    const response = await transfer(a, a.toUpperCase(), 10, 't-7');

    assertApiError(response, 422, 'The to account id field and from account id must be different.');
    assert.equal(await balanceOf(a), 100);
  });

  test('test_parallel_opposite_transfers_do_not_deadlock', async () => {
    const [a, b] = await createAccountsAB();

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? transfer(a, b, 5, `p-${i}`) : transfer(b, a, 5, `p-${i}`))),
    );

    assert.ok(responses.every((r) => r.status === 201), JSON.stringify(responses.filter((r) => r.status !== 201)));
    assert.equal((await balanceOf(a)) + (await balanceOf(b)), 150);
  });
});
