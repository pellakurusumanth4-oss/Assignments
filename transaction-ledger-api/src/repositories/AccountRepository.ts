import { DB } from '../database/DB.ts';
import { Account } from '../models/Account.ts';
import { BaseRepository } from './BaseRepository.ts';

export class AccountRepository extends BaseRepository<Account> {
  model() {
    return Account;
  }

  /**
   * SELECT ... FOR UPDATE: locks the rows until the surrounding DB.transaction() ends.
   * Rows are locked in id order so two transfers in opposite directions can't deadlock.
   */
  async findManyForUpdate(ids: string[]): Promise<Account[]> {
    const { rows } = await DB.query<Account>(
      'SELECT * FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [ids],
    );
    return rows;
  }

  async findForUpdate(id: string): Promise<Account | null> {
    const [account] = await this.findManyForUpdate([id]);
    return account ?? null;
  }

  /** Adds `amount` (negative for a debit) to the balance. */
  async incrementBalance(id: string, amount: number): Promise<void> {
    await DB.query('UPDATE accounts SET balance = balance + $2 WHERE id = $1', [id, amount]);
  }
}
