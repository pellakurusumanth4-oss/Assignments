import assert from 'node:assert/strict';
import { z } from 'zod';
import { PaginationResource } from '../src/resources/PaginationResource.ts';
import { ResponseUtil } from '../src/utils/ResponseUtil.ts';
import { type ApiResponse, json } from './TestCase.ts';

// Assertions parse the body with the same schemas the Swagger docs are generated from,
// so every API test also proves the docs describe the real responses.

export function assertApiSuccess(response: ApiResponse, status = 200, data: z.ZodType = z.unknown()) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  ResponseUtil.responseSchema(data).parse(response.body);
}

export function assertApiPaginated(response: ApiResponse, item: z.ZodType) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  ResponseUtil.responseSchema(z.array(item), { pagination: PaginationResource.schema }).parse(response.body);
}

export function assertApiError(response: ApiResponse, status: number, message?: string) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  z.union([ResponseUtil.errorSchema, ResponseUtil.validationErrorSchema]).parse(response.body);
  if (message !== undefined) assert.equal(response.body.message, message);
}

export async function createAccount(name = 'Test User'): Promise<string> {
  const response = await json('POST', '/api/accounts', { name });
  assertApiSuccess(response, 201);
  return response.body.data.id;
}

let referenceSeq = 0;

/** Transaction payload factory; each call gets a fresh reference_id unless one is given. */
export const transactionData = (type: 'credit' | 'debit', amount: number, reference_id = `ref-${++referenceSeq}`) => ({
  type,
  amount,
  description: `${type} ${amount}`,
  reference_id,
});

export async function balanceOf(accountId: string): Promise<number> {
  const response = await json('GET', `/api/accounts/${accountId}/balance`);
  assertApiSuccess(response);
  return response.body.data.balance;
}
