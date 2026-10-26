import { DB } from '../database/DB.ts';
import { Transaction, type TransactionType } from '../models/Transaction.ts';
import { BaseRepository } from './BaseRepository.ts';

export class TransactionRepository extends BaseRepository<Transaction> {
  model() {
    return Transaction;
  }

  /** A transaction that already uses `referenceId`, preferring the first of `accountIds` (a transfer's source). */
  async findByReference(referenceId: string, accountIds: string[]): Promise<Transaction | null> {
    const { rows } = await DB.query<Transaction>(
      `SELECT * FROM transactions WHERE reference_id = $1 AND account_id = ANY($2::uuid[])
       ORDER BY array_position($2::uuid[], account_id) LIMIT 1`,
      [referenceId, accountIds],
    );
    return rows[0] ?? null;
  }

  /** One page of an account's history, latest first, plus the total number of matching rows. */
  async paginateByAccount(accountId: string, type: TransactionType | undefined, page: number, limit: number) {
    const where = 'account_id = $1 AND ($2::text IS NULL OR type = $2)'; // NULL type = both
    const params = [accountId, type ?? null];
    const [count, list] = await Promise.all([
      DB.query<{ total: number }>(`SELECT count(*)::int AS total FROM transactions WHERE ${where}`, params),
      DB.query<Transaction>(
        `SELECT * FROM transactions WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
        [...params, limit, (page - 1) * limit],
      ),
    ]);
    return { items: list.rows, total: count.rows[0].total };
  }
}
