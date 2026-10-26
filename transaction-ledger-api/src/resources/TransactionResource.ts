import { z } from 'zod';
import type { Transaction } from '../models/Transaction.ts';
import { dateTimeSchema, formatDateTime, JsonResource } from './JsonResource.ts';

export class TransactionResource extends JsonResource {
  static schema = z.strictObject({
    id: z.uuid(),
    account_id: z.uuid(),
    type: z.enum(['credit', 'debit']),
    amount: z.number(),
    description: z.string(),
    reference_id: z.string(),
    created_at: dateTimeSchema,
  });

  static toArray(transaction: Transaction): z.output<typeof TransactionResource.schema> {
    return {
      id: transaction.id,
      account_id: transaction.account_id,
      type: transaction.type,
      amount: transaction.amount,
      description: transaction.description,
      reference_id: transaction.reference_id,
      created_at: formatDateTime(transaction.created_at),
    };
  }
}
