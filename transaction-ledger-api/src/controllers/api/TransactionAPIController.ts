import type { RequestHandler } from 'express';
import type { AccountRepository } from '../../repositories/AccountRepository.ts';
import type { TransactionRepository } from '../../repositories/TransactionRepository.ts';
import { CreateTransactionAPIRequest } from '../../requests/api/CreateTransactionAPIRequest.ts';
import { ListTransactionAPIRequest } from '../../requests/api/ListTransactionAPIRequest.ts';
import { PaginationResource } from '../../resources/PaginationResource.ts';
import { TransactionResource } from '../../resources/TransactionResource.ts';
import type { TransactionService } from '../../services/TransactionService.ts';
import { AppBaseController } from '../AppBaseController.ts';

export class TransactionAPIController extends AppBaseController {
  private accountRepository: AccountRepository;
  private transactionRepository: TransactionRepository;
  private transactionService: TransactionService;

  constructor(accountRepo: AccountRepository, transactionRepo: TransactionRepository, transactionService: TransactionService) {
    super();
    this.accountRepository = accountRepo;
    this.transactionRepository = transactionRepo;
    this.transactionService = transactionService;
  }

  /** GET /api/accounts/:id/transactions?type=&page=&limit= */
  index: RequestHandler<{ id: string }> = async (req, res) => {
    const { type, page, limit } = ListTransactionAPIRequest.validated(req.query);

    const account = await this.accountRepository.findOrFail(req.params.id);

    const { items, total } = await this.transactionRepository.paginateByAccount(account.id, type, page, limit);

    this.sendPaginatedResponse(
      res,
      TransactionResource.collection(items),
      PaginationResource.toArray({ page, limit, total }),
      'Transactions retrieved successfully',
    );
  };

  /** POST /api/accounts/:id/transactions */
  store: RequestHandler<{ id: string }> = async (req, res) => {
    const input = CreateTransactionAPIRequest.validated(req.body);

    const transaction = await this.transactionService.create(req.params.id, input);

    this.sendResponse(res, TransactionResource.toArray(transaction), 'Transaction saved successfully', 201);
  };
}
