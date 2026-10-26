import type { ErrorRequestHandler } from 'express';
import { ResponseUtil } from '../utils/ResponseUtil.ts';
import { DuplicateTransactionException } from './DuplicateTransactionException.ts';
import { HttpException } from './HttpException.ts';
import { InsufficientBalanceException } from './InsufficientBalanceException.ts';
import { ModelNotFoundException } from './ModelNotFoundException.ts';
import { ValidationException } from './ValidationException.ts';

/** Express error middleware: every error leaves the API as JSON in the `{ success: false, message }` envelope. */
export const Handler: ErrorRequestHandler = (err, _req, res, _next) => {
  const [status, body] = renderException(err);
  res.status(status).json(body);
};

/** The only place that maps exceptions to HTTP statuses, so services and repositories stay HTTP-agnostic. */
export function renderException(err: any): [number, object] {
  if (err instanceof ValidationException) {
    return [422, { ...ResponseUtil.makeError(err.message), errors: err.errors }];
  }
  if (err instanceof ModelNotFoundException) {
    return [404, ResponseUtil.makeError(err.message)];
  }
  if (err instanceof DuplicateTransactionException) {
    return [409, ResponseUtil.makeError(err.message, { transaction_id: err.transactionId })];
  }
  if (err instanceof InsufficientBalanceException) {
    return [422, ResponseUtil.makeError(err.message, { balance: err.balance, amount: err.amount })];
  }
  if (err instanceof HttpException) {
    return [err.status, ResponseUtil.makeError(err.message)];
  }
  if (err?.type === 'entity.parse.failed') {
    return [400, ResponseUtil.makeError('Malformed JSON request body')];
  }
  if (err?.expose && err.status >= 400 && err.status < 500) {
    // Other body-parser rejections, e.g. 413 body too large, 415 unsupported charset
    return [err.status, ResponseUtil.makeError(err.message.charAt(0).toUpperCase() + err.message.slice(1))];
  }
  if (err?.code === '23505') {
    // unique_violation: safety net behind the duplicate checks in TransactionService
    return [409, ResponseUtil.makeError('A transaction with this reference_id already exists')];
  }
  console.error(err);
  return [500, ResponseUtil.makeError('Server Error')];
}
