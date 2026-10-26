import { z } from 'zod';
import type { Account } from '../models/Account.ts';
import { dateTimeSchema, formatDateTime, JsonResource } from './JsonResource.ts';

export class AccountResource extends JsonResource {
  static schema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    balance: z.number(),
    created_at: dateTimeSchema,
  });

  static toArray(account: Account): z.output<typeof AccountResource.schema> {
    return {
      id: account.id,
      name: account.name,
      balance: account.balance,
      created_at: formatDateTime(account.created_at),
    };
  }
}
