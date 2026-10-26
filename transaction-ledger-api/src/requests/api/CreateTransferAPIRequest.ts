import { z } from 'zod';
import { Transaction } from '../../models/Transaction.ts';
import { typed } from '../../utils/rules.ts';
import { APIRequest } from '../APIRequest.ts';

export class CreateTransferAPIRequest extends APIRequest {
  static rules() {
    return z
      .strictObject({
        // Lower-cased so ids compare equal to the ones Postgres returns (UUIDs are case-insensitive).
        from_account_id: z.uuid(typed('from account id', 'a valid UUID')).toLowerCase(),
        to_account_id: z.uuid(typed('to account id', 'a valid UUID')).toLowerCase(),
        // amount, description and reference_id follow the same rules as a transaction
        ...Transaction.rules.omit({ type: true }).shape,
      })
      .refine((input) => input.from_account_id !== input.to_account_id, {
        message: 'The to account id field and from account id must be different.',
        path: ['to_account_id'],
      });
  }
}
