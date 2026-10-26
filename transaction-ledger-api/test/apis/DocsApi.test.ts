import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { openApiDocument } from '../../src/docs/openapi.ts';
import { json, url } from '../TestCase.ts';

describe('DocsApi', () => {
  test('test_openapi_document_lists_every_endpoint', async () => {
    const response = await json('GET', '/api/docs.json');

    assert.equal(response.status, 200);
    assert.equal(response.body.openapi, '3.1.0');
    const operations = Object.entries(response.body.paths).flatMap(([path, methods]) =>
      Object.keys(methods as object).map((method) => `${method.toUpperCase()} ${path}`),
    );
    assert.deepEqual(operations.sort(), [
      'GET /accounts/{id}/balance',
      'GET /accounts/{id}/transactions',
      'POST /accounts',
      'POST /accounts/{id}/transactions',
      'POST /transfers',
    ]);
  });

  test('test_swagger_ui_is_served', async () => {
    const response = await fetch(url('/api/docs/'));

    assert.equal(response.status, 200);
    assert.match(await response.text(), /swagger-ui/);
  });

  test('test_exported_openapi_json_is_up_to_date', async () => {
    const exported = JSON.parse(await readFile(new URL('../../openapi.json', import.meta.url), 'utf8'));

    assert.deepEqual(exported, JSON.parse(JSON.stringify(openApiDocument)), 'openapi.json is stale: run npm run docs:export');
  });
});
