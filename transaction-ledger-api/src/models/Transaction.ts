import { z } from 'zod';
import { selected, typed } from '../utils/rules.ts';

export type TransactionType = 'credit' | 'debit';

export interface Transaction {
  id: string;
  account_id: string;
  type: TransactionType;
  amount: number;
  description: string;
  reference_id: string;
  created_at: Date;
}

export const Transaction = {
  name: 'Transaction',

  table: 'transactions',

  fillable: ['account_id', 'type', 'amount', 'description', 'reference_id'],

  rules: z.strictObject({
    type: z.enum(['credit', 'debit'], selected('type')),
    amount: z
      .number(typed('amount', 'a number'))
      .gt(0, 'The amount field must be greater than 0.')
      .max(1_000_000_000, 'The amount field must not be greater than 1000000000.')
      .refine((value) => /^-?\d+(\.\d{1,2})?$/.test(String(value)), 'The amount field must have 0-2 decimal places.'),
    description: z
      .string(typed('description', 'a string'))
      .trim()
      .max(255, 'The description field must not be greater than 255 characters.')
      .default(''),
    reference_id: z
      .string(typed('reference id', 'a string'))
      .trim()
      .min(1, 'The reference id field is required.')
      .max(100, 'The reference id field must not be greater than 100 characters.'),
  }),
};

export type TransactionInput = z.output<typeof Transaction.rules>;
