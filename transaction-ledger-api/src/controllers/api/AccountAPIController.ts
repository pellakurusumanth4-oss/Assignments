import type { RequestHandler } from 'express';
import type { AccountRepository } from '../../repositories/AccountRepository.ts';
import { CreateAccountAPIRequest } from '../../requests/api/CreateAccountAPIRequest.ts';
import { AccountBalanceResource } from '../../resources/AccountBalanceResource.ts';
import { AccountResource } from '../../resources/AccountResource.ts';
import { AppBaseController } from '../AppBaseController.ts';

export class AccountAPIController extends AppBaseController {
  private accountRepository: AccountRepository;

  constructor(accountRepo: AccountRepository) {
    super();
    this.accountRepository = accountRepo;
  }

  /** POST /api/accounts */
  store: RequestHandler = async (req, res) => {
    const input = CreateAccountAPIRequest.validated(req.body);

    const account = await this.accountRepository.create(input);

    this.sendResponse(res, AccountResource.toArray(account), 'Account saved successfully', 201);
  };

  /** GET /api/accounts/:id/balance */
  balance: RequestHandler<{ id: string }> = async (req, res) => {
    const account = await this.accountRepository.findOrFail(req.params.id);

    this.sendResponse(res, AccountBalanceResource.toArray(account), 'Account balance retrieved successfully');
  };
}
