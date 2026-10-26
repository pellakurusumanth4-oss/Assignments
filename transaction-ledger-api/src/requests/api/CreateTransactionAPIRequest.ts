import { Transaction } from '../../models/Transaction.ts';
import { APIRequest } from '../APIRequest.ts';

export class CreateTransactionAPIRequest extends APIRequest {
  static rules() {
    return Transaction.rules;
  }
}
