// Boots the app on a random port against DATABASE_URL. Importing this registers the hooks.
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before } from 'node:test';
import { app } from '../src/app.ts';
import { DB } from '../src/database/DB.ts';

const server = app.listen(0);
let baseUrl = '';

before(async () => {
  if (!server.listening) await once(server, 'listening');
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  await DB.migrate();
});

after(async () => {
  server.close();
  await DB.end();
});

export const url = (path: string) => baseUrl + path;

/** Like Laravel's $this->json($method, $uri, $data). */
export async function json(method: string, path: string, data?: unknown) {
  const response = await fetch(url(path), {
    method,
    headers: data === undefined ? {} : { 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** Sends a raw body with the given content type, for malformed-request tests. */
export async function raw(method: string, path: string, body: string, contentType = 'application/json') {
  const response = await fetch(url(path), { method, headers: { 'content-type': contentType }, body });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

export type ApiResponse = Awaited<ReturnType<typeof json>>;
