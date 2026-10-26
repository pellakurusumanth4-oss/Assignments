import { AccountAPIController } from './controllers/api/AccountAPIController.ts';
import { TransactionAPIController } from './controllers/api/TransactionAPIController.ts';
import { TransferAPIController } from './controllers/api/TransferAPIController.ts';
import { AccountRepository } from './repositories/AccountRepository.ts';
import { TransactionRepository } from './repositories/TransactionRepository.ts';
import { TransactionService } from './services/TransactionService.ts';

// Composition root, in place of Laravel's service container: the only file that picks concrete classes.
// Everything else receives its dependencies through the constructor.

const accountRepository = new AccountRepository();
const transactionRepository = new TransactionRepository();
const transactionService = new TransactionService(accountRepository, transactionRepository);

export const accountAPIController = new AccountAPIController(accountRepository);
export const transactionAPIController = new TransactionAPIController(accountRepository, transactionRepository, transactionService);
export const transferAPIController = new TransferAPIController(transactionService);
