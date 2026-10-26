import { z } from 'zod';
import { selected, typed } from '../../utils/rules.ts';
import { APIRequest } from '../APIRequest.ts';

export class ListTransactionAPIRequest extends APIRequest {
  static rules() {
    return z.object({
      type: z.enum(['credit', 'debit'], selected('type')).optional(),
      page: z.coerce
        .number(typed('page', 'an integer'))
        .int('The page field must be an integer.')
        .min(1, 'The page field must be at least 1.')
        .default(1),
      limit: z.coerce
        .number(typed('limit', 'an integer'))
        .int('The limit field must be an integer.')
        .min(1, 'The limit field must be at least 1.')
        .max(100, 'The limit field must not be greater than 100.')
        .default(20),
    });
  }
}
