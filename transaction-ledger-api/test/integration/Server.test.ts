// Runs src/server.ts as a real process to check startup failures and graceful shutdown.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

const serverScript = new URL('../../src/server.ts', import.meta.url).pathname;

function startServer(port: number) {
  const child = spawn(process.execPath, [serverScript], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return { child, output: () => output };
}

async function freePort(): Promise<number> {
  const probe = createServer().listen(0);
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  return port;
}

test('test_sigterm_shuts_down_gracefully', { timeout: 15_000 }, async () => {
  const server = startServer(await freePort());
  while (!server.output().includes('listening')) await setTimeout(50);

  const started = Date.now();
  server.child.kill('SIGTERM');
  const [code] = await once(server.child, 'exit');

  assert.equal(code, 0, server.output());
  assert.ok(Date.now() - started < 3000, 'shutdown should not wait for a SIGKILL');
});

test('test_busy_port_fails_loudly', { timeout: 15_000 }, async () => {
  const blocker = createServer().listen(0);
  await once(blocker, 'listening');

  const server = startServer((blocker.address() as AddressInfo).port);
  const [code] = await once(server.child, 'exit');
  blocker.close();

  assert.notEqual(code, 0);
  assert.match(server.output(), /EADDRINUSE/);
  assert.doesNotMatch(server.output(), /listening on/);
});
