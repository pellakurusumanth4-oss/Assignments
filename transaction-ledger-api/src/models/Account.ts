import { z } from 'zod';
import { typed } from '../utils/rules.ts';

export interface Account {
  id: string;
  name: string;
  balance: number;
  created_at: Date;
}

export const Account = {
  name: 'Account',

  table: 'accounts',

  // Only these columns can be mass-assigned; balance always starts at the DB default of 0.
  fillable: ['name'],

  // strictObject: any other key (e.g. balance) fails validation as "prohibited".
  rules: z.strictObject({
    name: z
      .string(typed('name', 'a string'))
      .trim()
      .min(1, 'The name field is required.')
      .max(100, 'The name field must not be greater than 100 characters.'),
  }),
};
