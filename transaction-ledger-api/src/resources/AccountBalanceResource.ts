import { z } from 'zod';
import type { Account } from '../models/Account.ts';
import { JsonResource } from './JsonResource.ts';

export class AccountBalanceResource extends JsonResource {
  static schema = z.strictObject({
    account_id: z.uuid(),
    balance: z.number(),
  });

  static toArray(account: Account): z.output<typeof AccountBalanceResource.schema> {
    return { account_id: account.id, balance: account.balance };
  }
}
