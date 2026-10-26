import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, test } from 'node:test';
import { DB } from '../../src/database/DB.ts';
import { TransactionResource } from '../../src/resources/TransactionResource.ts';
import { assertApiError, assertApiPaginated, assertApiSuccess, balanceOf, createAccount, transactionData } from '../ApiTestTrait.ts';
import { json } from '../TestCase.ts';

describe('TransactionApi', () => {
  test('test_create_transaction', async () => {
    const id = await createAccount();

    const response = await json('POST', `/api/accounts/${id}/transactions`, transactionData('credit', 100, 'inv-1'));

    assertApiSuccess(response, 201, TransactionResource.schema);
    assert.equal(response.body.message, 'Transaction saved successfully');
    assert.deepEqual(
      { ...response.body.data, id: undefined, created_at: undefined },
      { id: undefined, account_id: id, type: 'credit', amount: 100, description: 'credit 100', reference_id: 'inv-1', created_at: undefined },
    );
  });

  test('test_brief_example_ends_at_100', async () => {
    const id = await createAccount();

    for (const data of [transactionData('credit', 100), transactionData('credit', 50), transactionData('debit', 30), transactionData('debit', 20)]) {
      assertApiSuccess(await json('POST', `/api/accounts/${id}/transactions`, data), 201);
    }

    assert.equal(await balanceOf(id), 100);
  });

  test('test_debit_above_balance_is_rejected_and_changes_nothing', async () => {
    const id = await createAccount();
    await json('POST', `/api/accounts/${id}/transactions`, transactionData('credit', 100));

    const response = await json('POST', `/api/accounts/${id}/transactions`, transactionData('debit', 150));

    assertApiError(response, 422, 'Insufficient balance');
    assert.deepEqual(response.body.data, { balance: 100, amount: 150 });
    assert.equal(await balanceOf(id), 100);
    assert.equal((await json('GET', `/api/accounts/${id}/transactions`)).body.pagination.total_records, 1);
  });

  test('test_duplicate_reference_is_not_applied_twice', async () => {
    const id = await createAccount();
    const first = await json('POST', `/api/accounts/${id}/transactions`, transactionData('credit', 100, 'order-1'));

    const again = await json('POST', `/api/accounts/${id}/transactions`, transactionData('credit', 100, 'order-1'));

    assertApiError(again, 409, 'A transaction with this reference_id already exists');
    assert.deepEqual(again.body.data, { transaction_id: first.body.data.id });
    assert.equal(await balanceOf(id), 100);
  });

  test('test_same_reference_allowed_on_different_accounts', async () => {
    const [a, b] = [await createAccount(), await createAccount()];

    assertApiSuccess(await json('POST', `/api/accounts/${a}/transactions`, transactionData('credit', 10, 'shared')), 201);
    assertApiSuccess(await json('POST', `/api/accounts/${b}/transactions`, transactionData('credit', 10, 'shared')), 201);
  });

  test('test_create_transaction_on_unknown_account', async () => {
    const response = await json('POST', `/api/accounts/${randomUUID()}/transactions`, transactionData('credit', 10));

    assertApiError(response, 404, 'Account not found');
  });

  test('test_create_transaction_validation', async () => {
    const id = await createAccount();
    const cases: [object, string, string][] = [
      [{ ...transactionData('credit', 10), type: 'refund' }, 'type', 'The selected type is invalid.'],
      [transactionData('credit', 0), 'amount', 'The amount field must be greater than 0.'],
      [transactionData('credit', -5), 'amount', 'The amount field must be greater than 0.'],
      [transactionData('credit', 1.234), 'amount', 'The amount field must have 0-2 decimal places.'],
      [{ ...transactionData('credit', 10), amount: '10' }, 'amount', 'The amount field must be a number.'],
      [{ type: 'credit', amount: 10 }, 'reference_id', 'The reference id field is required.'],
      [{ ...transactionData('credit', 10), reference_id: '  ' }, 'reference_id', 'The reference id field is required.'],
      [{ ...transactionData('credit', 10), id: 'my-own-id' }, 'id', 'The id field is prohibited.'],
    ];

    for (const [payload, field, message] of cases) {
      const response = await json('POST', `/api/accounts/${id}/transactions`, payload);

      assertApiError(response, 422, message);
      assert.deepEqual(response.body.errors[field], [message], JSON.stringify(payload));
    }
    assert.equal(await balanceOf(id), 0);
  });

  test('test_validation_reports_every_invalid_field', async () => {
    const id = await createAccount();

    const response = await json('POST', `/api/accounts/${id}/transactions`, { type: 'x', amount: -1 });

    assertApiError(response, 422, 'The selected type is invalid. (and 2 more errors)');
    assert.deepEqual(Object.keys(response.body.errors).sort(), ['amount', 'reference_id', 'type']);
  });

  test('test_concurrent_debits_never_overdraw', async () => {
    const id = await createAccount();
    await json('POST', `/api/accounts/${id}/transactions`, transactionData('credit', 100));

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => json('POST', `/api/accounts/${id}/transactions`, transactionData('debit', 30))),
    );

    assert.equal(responses.filter((r) => r.status === 201).length, 3);
    assert.equal(responses.filter((r) => r.status === 422).length, 7);
    assert.equal(await balanceOf(id), 10);
  });

  test('test_concurrent_retries_create_exactly_one_transaction', async () => {
    const id = await createAccount();

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => json('POST', `/api/accounts/${id}/transactions`, transactionData('credit', 25, 'retry-me'))),
    );

    assert.equal(responses.filter((r) => r.status === 201).length, 1);
    assert.equal(responses.filter((r) => r.status === 409).length, 7);
    assert.equal(await balanceOf(id), 25);
  });

  test('test_transactions_are_immutable', async () => {
    const id = await createAccount();
    const { body } = await json('POST', `/api/accounts/${id}/transactions`, transactionData('credit', 10));
    const transactionId = body.data.id;

    // No edit/delete routes exist...
    assertApiError(await json('PUT', `/api/accounts/${id}/transactions/${transactionId}`, { amount: 999 }), 404);
    assertApiError(await json('DELETE', `/api/accounts/${id}/transactions/${transactionId}`), 404);
    // ...and the database refuses direct edits too.
    await assert.rejects(DB.query('UPDATE transactions SET amount = 999 WHERE id = $1', [transactionId]), /immutable/);
    await assert.rejects(DB.query('DELETE FROM transactions WHERE id = $1', [transactionId]), /immutable/);
  });
});

describe('TransactionApi history', () => {
  let id = '';

  before(async () => {
    id = await createAccount();
    for (let i = 1; i <= 5; i++) await json('POST', `/api/accounts/${id}/transactions`, transactionData('credit', i * 10, `h-${i}`));
    for (let i = 1; i <= 2; i++) await json('POST', `/api/accounts/${id}/transactions`, transactionData('debit', i, `h-d${i}`));
  });

  const references = (response: { body: { data: { reference_id: string }[] } }) => response.body.data.map((t) => t.reference_id);

  test('test_list_transactions_latest_first_with_pagination', async () => {
    const response = await json('GET', `/api/accounts/${id}/transactions?page=1&limit=3`);

    assertApiPaginated(response, TransactionResource.schema);
    assert.equal(response.body.message, 'Transactions retrieved successfully');
    assert.deepEqual(response.body.pagination, { page: 1, limit: 3, total_records: 7, total_pages: 3 });
    assert.deepEqual(references(response), ['h-d2', 'h-d1', 'h-5']);
    assert.deepEqual(references(await json('GET', `/api/accounts/${id}/transactions?page=3&limit=3`)), ['h-1']);
  });

  test('test_list_transactions_filtered_by_type', async () => {
    const credits = await json('GET', `/api/accounts/${id}/transactions?type=credit`);
    assert.equal(credits.body.pagination.total_records, 5);
    assert.ok(credits.body.data.every((t: { type: string }) => t.type === 'credit'));

    const debits = await json('GET', `/api/accounts/${id}/transactions?type=debit`);
    assert.equal(debits.body.pagination.total_records, 2);
  });

  test('test_list_transactions_defaults', async () => {
    const response = await json('GET', `/api/accounts/${id}/transactions`);

    assert.deepEqual(response.body.pagination, { page: 1, limit: 20, total_records: 7, total_pages: 1 });
  });

  test('test_list_transactions_rejects_invalid_params', async () => {
    const cases: [string, string][] = [
      ['type=refund', 'The selected type is invalid.'],
      ['page=0', 'The page field must be at least 1.'],
      ['page=abc', 'The page field must be an integer.'],
      ['page=1.5', 'The page field must be an integer.'],
      ['limit=0', 'The limit field must be at least 1.'],
      ['limit=101', 'The limit field must not be greater than 100.'],
    ];

    for (const [query, message] of cases) {
      assertApiError(await json('GET', `/api/accounts/${id}/transactions?${query}`), 422, message);
    }
  });

  test('test_list_transactions_of_unknown_account', async () => {
    assertApiError(await json('GET', `/api/accounts/${randomUUID()}/transactions`), 404, 'Account not found');
  });
});
