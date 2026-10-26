import { Router } from 'express';
import { z } from 'zod';
import { accountAPIController, transactionAPIController, transferAPIController } from '../container.ts';
import { ModelNotFoundException } from '../exceptions/ModelNotFoundException.ts';

export const api = Router();

// Like ->whereUuid('id'): a malformed id can never match an account.
api.param('id', (_req, _res, next, id) => {
  next(z.uuid().safeParse(id).success ? undefined : new ModelNotFoundException('Account'));
});

api.post('/accounts', accountAPIController.store);
api.get('/accounts/:id/balance', accountAPIController.balance);

api.get('/accounts/:id/transactions', transactionAPIController.index);
api.post('/accounts/:id/transactions', transactionAPIController.store);

api.post('/transfers', transferAPIController.store);
