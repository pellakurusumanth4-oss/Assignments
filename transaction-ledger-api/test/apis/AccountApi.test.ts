import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { AccountBalanceResource } from '../../src/resources/AccountBalanceResource.ts';
import { AccountResource } from '../../src/resources/AccountResource.ts';
import { assertApiError, assertApiSuccess, createAccount } from '../ApiTestTrait.ts';
import { json, raw } from '../TestCase.ts';

describe('AccountApi', () => {
  test('test_create_account', async () => {
    const response = await json('POST', '/api/accounts', { name: 'Asha' });

    assertApiSuccess(response, 201, AccountResource.schema);
    assert.equal(response.body.message, 'Account saved successfully');
    assert.equal(response.body.data.name, 'Asha');
    assert.equal(response.body.data.balance, 0);
  });

  test('test_create_account_prohibits_initial_balance', async () => {
    const response = await json('POST', '/api/accounts', { name: 'Rich', balance: 1000 });

    assertApiError(response, 422, 'The balance field is prohibited.');
    assert.deepEqual(response.body.errors, { balance: ['The balance field is prohibited.'] });
  });

  test('test_create_account_requires_name', async () => {
    for (const payload of [{}, { name: '' }, { name: '   ' }, { name: 42 }]) {
      const response = await json('POST', '/api/accounts', payload);

      assertApiError(response, 422);
      assert.ok(response.body.errors.name, JSON.stringify(payload));
    }
  });

  test('test_read_account_balance', async () => {
    const id = await createAccount();

    const response = await json('GET', `/api/accounts/${id}/balance`);

    assertApiSuccess(response, 200, AccountBalanceResource.schema);
    assert.deepEqual(response.body.data, { account_id: id, balance: 0 });
  });

  test('test_read_balance_with_uppercase_id', async () => {
    const id = await createAccount();

    const response = await json('GET', `/api/accounts/${id.toUpperCase()}/balance`);

    assertApiSuccess(response, 200, AccountBalanceResource.schema);
    assert.equal(response.body.data.account_id, id);
  });

  test('test_read_balance_of_unknown_or_malformed_account', async () => {
    assertApiError(await json('GET', `/api/accounts/${randomUUID()}/balance`), 404, 'Account not found');
    assertApiError(await json('GET', '/api/accounts/not-a-uuid/balance'), 404, 'Account not found');
  });

  test('test_malformed_json_body', async () => {
    assertApiError(await raw('POST', '/api/accounts', '{"name":'), 400, 'Malformed JSON request body');
  });

  test('test_body_over_100kb_is_413', async () => {
    const response = await raw('POST', '/api/accounts', JSON.stringify({ name: 'x'.repeat(200_000) }));

    assertApiError(response, 413, 'Request entity too large');
  });

  test('test_unsupported_charset_is_415', async () => {
    const response = await raw('POST', '/api/accounts', '{"name":"x"}', 'application/json; charset=latin1');

    assertApiError(response, 415, 'Unsupported charset "LATIN1"');
  });

  test('test_missing_body', async () => {
    assertApiError(await json('POST', '/api/accounts'), 422, 'The request body must be a JSON object.');
  });

  test('test_unknown_route', async () => {
    assertApiError(await json('GET', '/api/nope'), 404, 'Route not found');
  });

  test('test_framework_header_is_hidden', async () => {
    const response = await json('GET', '/api/nope');

    assert.equal(response.headers.get('x-powered-by'), null);
  });
});
