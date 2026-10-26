import { Account } from '../../models/Account.ts';
import { APIRequest } from '../APIRequest.ts';

export class CreateAccountAPIRequest extends APIRequest {
  static rules() {
    return Account.rules;
  }
}
