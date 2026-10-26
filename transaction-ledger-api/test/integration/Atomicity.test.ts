// Brief, "Atomicity": creating a transaction and updating the balance are one operation;
// if either fails, neither change may be persisted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountRepository } from '../../src/repositories/AccountRepository.ts';
import { TransactionRepository } from '../../src/repositories/TransactionRepository.ts';
import { TransactionService } from '../../src/services/TransactionService.ts';
import { balanceOf, createAccount, transactionData } from '../ApiTestTrait.ts';
import { json } from '../TestCase.ts';

test('test_failed_insert_rolls_back_the_balance_update', async () => {
  const id = await createAccount();
  await json('POST', `/api/accounts/${id}/transactions`, transactionData('credit', 100));
  const service = new TransactionService(new AccountRepository(), new TransactionRepository());

  // Called past request validation on purpose: the balance moves by -5 first,
  // then the insert breaks the database's CHECK (amount > 0).
  await assert.rejects(
    service.create(id, { type: 'credit', amount: -5, description: '', reference_id: 'atomic-1' }),
    /check constraint/,
  );

  assert.equal(await balanceOf(id), 100);
  assert.equal((await json('GET', `/api/accounts/${id}/transactions`)).body.pagination.total_records, 1);
});
