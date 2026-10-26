import { z } from 'zod';
import { DuplicateTransactionException } from '../exceptions/DuplicateTransactionException.ts';
import { renderException } from '../exceptions/Handler.ts';
import { InsufficientBalanceException } from '../exceptions/InsufficientBalanceException.ts';
import { ModelNotFoundException } from '../exceptions/ModelNotFoundException.ts';
import { ValidationException } from '../exceptions/ValidationException.ts';
import type { Account } from '../models/Account.ts';
import type { Transaction } from '../models/Transaction.ts';
import { CreateAccountAPIRequest } from '../requests/api/CreateAccountAPIRequest.ts';
import { CreateTransactionAPIRequest } from '../requests/api/CreateTransactionAPIRequest.ts';
import { CreateTransferAPIRequest } from '../requests/api/CreateTransferAPIRequest.ts';
import { ListTransactionAPIRequest } from '../requests/api/ListTransactionAPIRequest.ts';
import { AccountBalanceResource } from '../resources/AccountBalanceResource.ts';
import { AccountResource } from '../resources/AccountResource.ts';
import { PaginationResource } from '../resources/PaginationResource.ts';
import { TransactionResource } from '../resources/TransactionResource.ts';
import { TransferResource } from '../resources/TransferResource.ts';
import { ResponseUtil } from '../utils/ResponseUtil.ts';

// The OpenAPI document is generated from the same request rules, resources and exception renderer
// the API runs on, so neither the schemas nor the examples can drift from the real behaviour.

/** Zod → JSON Schema. OpenAPI 3.1 uses JSON Schema 2020-12 as is. */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'output') {
  const { $schema: _, ...result } = z.toJSONSchema(schema, {
    io,
    override: ({ jsonSchema: node }) => {
      if (node.format === 'uuid') delete node.pattern; // the RFC regex adds nothing next to format: uuid
      if (node.maximum === Number.MAX_SAFE_INTEGER) delete node.maximum;
      if (node.minimum === Number.MIN_SAFE_INTEGER) delete node.minimum;
    },
  });
  return result;
}

const json = (schema: object, example: unknown) => ({ 'application/json': { schema, example } });

function body(rules: z.ZodType, example: unknown) {
  rules.parse(example); // fails at startup if a docs example ever stops being valid input
  return { required: true, content: json(jsonSchema(rules, 'input'), example) };
}

const success = (description: string, data: z.ZodType, message: string, example: unknown) => ({
  description,
  content: json(jsonSchema(ResponseUtil.responseSchema(data)), ResponseUtil.makeResponse(message, example)),
});

/** One example per exception, rendered exactly as the API renders it. */
function failure(description: string, ...errors: Error[]) {
  const validation = errors.some((error) => error instanceof ValidationException);
  const schema = validation ? z.union([ResponseUtil.errorSchema, ResponseUtil.validationErrorSchema]) : ResponseUtil.errorSchema;
  return {
    description,
    content: {
      'application/json': {
        schema: jsonSchema(schema),
        examples: Object.fromEntries(errors.map((error) => [error.message, { summary: error.message, value: renderException(error)[1] }])),
      },
    },
  };
}

/** The ValidationException the API raises for `input`. */
const invalid = (rules: z.ZodType, input: unknown) => ValidationException.fromZodError(rules.safeParse(input).error!);

// Sample records, turned into examples by the real resources.
const createdAt = new Date('2026-10-26T14:03:35Z');
const account: Account = { id: 'f029211e-f5fe-4a0e-811e-5a4a5cd32157', name: 'Asha', balance: 100, created_at: createdAt };
const recipientId = '3b0f8e0e-6a4f-4c9b-9a51-2f1f5b7c9d10';
const salary: Transaction = {
  id: 'ec711fe8-af62-440d-8794-9d4ffd64d7b1',
  account_id: account.id,
  type: 'credit',
  amount: 100,
  description: 'Salary',
  reference_id: 'inv-001',
  created_at: createdAt,
};
const transfer = {
  debit: { ...salary, id: '5d2c1a9e-0b7f-4e3a-b1c4-7f6e5d4c3b2a', type: 'debit', amount: 30, description: 'Rent share', reference_id: 'transfer-77' },
  credit: { ...salary, id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', account_id: recipientId, amount: 30, description: 'Rent share', reference_id: 'transfer-77' },
} satisfies { debit: Transaction; credit: Transaction };

const accountIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Account id',
  schema: { type: 'string', format: 'uuid' },
  example: account.id,
};

const historyQueryParams = Object.entries(jsonSchema(ListTransactionAPIRequest.rules()).properties ?? {}).map(
  ([name, schema]) => ({ name, in: 'query', required: false, schema }),
);

const accountNotFound = failure('Account not found', new ModelNotFoundException('Account'));

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Transaction Ledger API',
    version: '1.0.0',
    description: [
      'Accounts with credit/debit transactions, balances, paginated history and atomic transfers.',
      '',
      'Every response uses one envelope: `{ "success": true, "data": …, "message": "…" }`, or on error',
      '`{ "success": false, "message": "…" }` plus `data` or `errors` with details.',
      '',
      'Any endpoint can also return: `400` malformed JSON, `404` unknown route, `413` body over 100 kB,',
      '`415` unsupported charset (use UTF-8), `500` server error.',
      '',
      '`reference_id` makes writes safe to retry: it can be used once per account.',
    ].join('\n'),
  },
  servers: [{ url: '/api' }],
  tags: [
    { name: 'Accounts', description: 'Create accounts and read balances' },
    { name: 'Transactions', description: 'Credits, debits and transaction history' },
    { name: 'Transfers', description: 'Move money between two accounts atomically' },
  ],
  paths: {
    '/accounts': {
      post: {
        tags: ['Accounts'],
        operationId: 'createAccount',
        summary: 'Create an account',
        description: 'The balance always starts at 0; clients cannot set it.',
        requestBody: body(CreateAccountAPIRequest.rules(), { name: 'Asha' }),
        responses: {
          201: success('Account created', AccountResource.schema, 'Account saved successfully', AccountResource.toArray({ ...account, balance: 0 })),
          422: failure(
            'Validation failed',
            invalid(CreateAccountAPIRequest.rules(), { name: 'Asha', balance: 500 }),
            invalid(CreateAccountAPIRequest.rules(), {}),
          ),
        },
      },
    },
    '/accounts/{id}/balance': {
      get: {
        tags: ['Accounts'],
        operationId: 'getAccountBalance',
        summary: 'Get the current balance',
        parameters: [accountIdParam],
        responses: {
          200: success('Current balance', AccountBalanceResource.schema, 'Account balance retrieved successfully', AccountBalanceResource.toArray(account)),
          404: accountNotFound,
        },
      },
    },
    '/accounts/{id}/transactions': {
      get: {
        tags: ['Transactions'],
        operationId: 'listTransactions',
        summary: 'Transaction history',
        description: 'Latest first. Filter by `type`; paginate with `page` and `limit`.',
        parameters: [accountIdParam, ...historyQueryParams],
        responses: {
          200: {
            description: 'One page of transactions',
            content: json(
              jsonSchema(ResponseUtil.responseSchema(z.array(TransactionResource.schema), { pagination: PaginationResource.schema })),
              {
                ...ResponseUtil.makeResponse('Transactions retrieved successfully', TransactionResource.collection([salary])),
                pagination: PaginationResource.toArray({ page: 1, limit: 20, total: 1 }),
              },
            ),
          },
          404: accountNotFound,
          422: failure('Invalid query parameters', invalid(ListTransactionAPIRequest.rules(), { type: 'refund', limit: '500' })),
        },
      },
      post: {
        tags: ['Transactions'],
        operationId: 'createTransaction',
        summary: 'Add a credit or debit',
        description: 'A debit larger than the balance is rejected and changes nothing.',
        parameters: [accountIdParam],
        requestBody: body(CreateTransactionAPIRequest.rules(), {
          type: 'credit',
          amount: 100,
          description: 'Salary',
          reference_id: 'inv-001',
        }),
        responses: {
          201: success('Transaction recorded', TransactionResource.schema, 'Transaction saved successfully', TransactionResource.toArray(salary)),
          404: accountNotFound,
          409: failure('reference_id already used on this account', new DuplicateTransactionException(salary.id)),
          422: failure(
            'Insufficient balance, or validation failed',
            new InsufficientBalanceException(100, 150),
            invalid(CreateTransactionAPIRequest.rules(), { type: 'refund', amount: -5, reference_id: 'inv-002' }),
          ),
        },
      },
    },
    '/transfers': {
      post: {
        tags: ['Transfers'],
        operationId: 'createTransfer',
        summary: 'Transfer money between two accounts',
        description: 'Debits the source and credits the destination in one database transaction: both happen or neither does.',
        requestBody: body(CreateTransferAPIRequest.rules(), {
          from_account_id: account.id,
          to_account_id: recipientId,
          amount: 30,
          description: 'Rent share',
          reference_id: 'transfer-77',
        }),
        responses: {
          201: success('Transfer completed', TransferResource.schema, 'Transfer completed successfully', TransferResource.toArray(transfer)),
          404: failure(
            'Source or destination account not found',
            new ModelNotFoundException('Source account'),
            new ModelNotFoundException('Destination account'),
          ),
          409: failure('reference_id already used on one of the accounts', new DuplicateTransactionException(transfer.debit.id)),
          422: failure(
            'Insufficient balance, or validation failed',
            new InsufficientBalanceException(100, 500),
            invalid(CreateTransferAPIRequest.rules(), { from_account_id: account.id, to_account_id: account.id, amount: 30, reference_id: 't-1' }),
          ),
        },
      },
    },
  },
  components: {
    schemas: {
      Account: jsonSchema(AccountResource.schema),
      AccountBalance: jsonSchema(AccountBalanceResource.schema),
      Transaction: jsonSchema(TransactionResource.schema),
      Transfer: jsonSchema(TransferResource.schema),
      Pagination: jsonSchema(PaginationResource.schema),
      Error: jsonSchema(ResponseUtil.errorSchema),
      ValidationError: jsonSchema(ResponseUtil.validationErrorSchema),
    },
  },
};
