import type { RequestHandler } from 'express';
import { CreateTransferAPIRequest } from '../../requests/api/CreateTransferAPIRequest.ts';
import { TransferResource } from '../../resources/TransferResource.ts';
import type { TransactionService } from '../../services/TransactionService.ts';
import { AppBaseController } from '../AppBaseController.ts';

export class TransferAPIController extends AppBaseController {
  private transactionService: TransactionService;

  constructor(transactionService: TransactionService) {
    super();
    this.transactionService = transactionService;
  }

  /** POST /api/transfers */
  store: RequestHandler = async (req, res) => {
    const input = CreateTransferAPIRequest.validated(req.body);

    const transfer = await this.transactionService.transfer(input);

    this.sendResponse(res, TransferResource.toArray(transfer), 'Transfer completed successfully', 201);
  };
}
