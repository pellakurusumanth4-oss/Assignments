import { DB } from '../database/DB.ts';
import { DuplicateTransactionException } from '../exceptions/DuplicateTransactionException.ts';
import { InsufficientBalanceException } from '../exceptions/InsufficientBalanceException.ts';
import { ModelNotFoundException } from '../exceptions/ModelNotFoundException.ts';
import type { Account } from '../models/Account.ts';
import type { Transaction, TransactionInput } from '../models/Transaction.ts';
import type { AccountRepository } from '../repositories/AccountRepository.ts';
import type { TransactionRepository } from '../repositories/TransactionRepository.ts';

type TransferInput = Omit<TransactionInput, 'type'> & { from_account_id: string; to_account_id: string };

/** All money movement goes through here, always inside one DB transaction. Throws domain exceptions, never HTTP ones. */
export class TransactionService {
  private accountRepository: AccountRepository;
  private transactionRepository: TransactionRepository;

  constructor(accountRepo: AccountRepository, transactionRepo: TransactionRepository) {
    this.accountRepository = accountRepo;
    this.transactionRepository = transactionRepo;
  }

  /** Credit or debit one account. */
  create(accountId: string, input: TransactionInput): Promise<Transaction> {
    return DB.transaction(async () => {
      // The row lock serialises writes per account, so the duplicate and balance checks below can't race.
      const account = await this.accountRepository.findForUpdate(accountId);
      if (!account) throw new ModelNotFoundException('Account');

      // Duplicates first: retrying a request that already succeeded must say "already exists", not "insufficient".
      await this.ensureReferenceUnused(input.reference_id, [accountId]);
      if (input.type === 'debit') this.ensureSufficientBalance(account, input.amount);

      return this.apply(accountId, input);
    });
  }

  /** Debit one account and credit another, all or nothing. Expects lower-case ids (see CreateTransferAPIRequest). */
  transfer(input: TransferInput): Promise<{ debit: Transaction; credit: Transaction }> {
    const { from_account_id: fromId, to_account_id: toId, ...entry } = input;

    return DB.transaction(async () => {
      const accounts = await this.accountRepository.findManyForUpdate([fromId, toId]);
      const source = accounts.find((account) => account.id === fromId);
      if (!source) throw new ModelNotFoundException('Source account');
      if (!accounts.some((account) => account.id === toId)) throw new ModelNotFoundException('Destination account');

      await this.ensureReferenceUnused(entry.reference_id, [fromId, toId]);
      this.ensureSufficientBalance(source, entry.amount);

      const debit = await this.apply(fromId, { ...entry, type: 'debit' });
      const credit = await this.apply(toId, { ...entry, type: 'credit' });
      return { debit, credit };
    });
  }

  private async ensureReferenceUnused(referenceId: string, accountIds: string[]): Promise<void> {
    const existing = await this.transactionRepository.findByReference(referenceId, accountIds);
    if (existing) throw new DuplicateTransactionException(existing.id);
  }

  private ensureSufficientBalance(account: Account, amount: number): void {
    if (account.balance < amount) throw new InsufficientBalanceException(account.balance, amount);
  }

  /** Moves the balance and records the entry. Caller must hold the account row lock. */
  private async apply(accountId: string, input: TransactionInput): Promise<Transaction> {
    await this.accountRepository.incrementBalance(accountId, input.type === 'credit' ? input.amount : -input.amount);
    return this.transactionRepository.create({ ...input, account_id: accountId });
  }
}
