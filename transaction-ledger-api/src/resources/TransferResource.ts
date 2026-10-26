import { z } from 'zod';
import type { Transaction } from '../models/Transaction.ts';
import { JsonResource } from './JsonResource.ts';
import { TransactionResource } from './TransactionResource.ts';

export class TransferResource extends JsonResource {
  static schema = z.strictObject({
    debit: TransactionResource.schema,
    credit: TransactionResource.schema,
  });

  static toArray(transfer: { debit: Transaction; credit: Transaction }): z.output<typeof TransferResource.schema> {
    return {
      debit: TransactionResource.toArray(transfer.debit),
      credit: TransactionResource.toArray(transfer.credit),
    };
  }
}
