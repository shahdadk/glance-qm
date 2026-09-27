import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MeetingController } from '../src/core/controller.js';
import { unavailableProviders } from '../src/core/providers.js';
import { createApp } from '../src/server/app.js';
import { loadOperatorToken } from '../src/server/auth.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'glance-server-'));
  const token = await loadOperatorToken(join(directory, 'operator-token'));
  const controller = new MeetingController({ directory: join(directory, 'meetings'), providers: unavailableProviders() });
  const runtime = createApp({ controller, token });
  await new Promise<void>(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const address = runtime.server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return { directory, base, token, headers, controller };
}

it('protects state routes and keeps health free of credentials', async () => {
  const { base, headers, token } = await setup();
  const health = await fetch(`${base}/api/health`).then(response => response.json());
  expect(health.providers.qm).toBe('unconfigured');
  expect(JSON.stringify(health)).not.toContain(token);
  expect((await fetch(`${base}/api/meetings`, { method: 'POST', body: JSON.stringify({ title: 'Meeting' }), headers: { 'Content-Type': 'application/json' } })).status).toBe(401);
  const response = await fetch(`${base}/api/meetings`, { method: 'POST', body: JSON.stringify({ title: 'Meeting', participantNames: ['Pretend member'] }), headers });
  expect(response.status).toBe(201);
  const record = await response.json();
  expect(record.participants).toHaveLength(1);
  expect(record.participants[0].id).toBe('operator');
  expect((await fetch(`${base}/api/meetings/${record.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ participantId: 'Pretend member', text: 'Impersonate' }) })).status).toBe(403);
});

it('validates requests and rejects disallowed web origins', async () => {
  const { base, headers } = await setup();
  expect((await fetch(`${base}/api/meetings`, { method: 'POST', headers, body: '{}' })).status).toBe(400);
  expect((await fetch(`${base}/api/health`, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
  const allowed = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:5174' } });
  expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5174');
});

it('uses the same private operator token across restarts', async () => {
  const { directory, token } = await setup();
  expect(await loadOperatorToken(join(directory, 'operator-token'))).toBe(token);
  expect((await stat(join(directory, 'operator-token'))).mode & 0o777).toBe(0o600);
});

it('authenticates a websocket before emitting snapshots and streams committed updates', async () => {
  const { base, controller, token } = await setup();
  const record = await controller.create({ title: 'Shared view' });
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/meetings/${record.id}/events`);
  cleanups.push(async () => { ws.terminate(); });
  const messages: { type: string; payload: { revision: number } }[] = [];
  ws.on('message', raw => { messages.push(JSON.parse(raw.toString())); });
  await new Promise(resolve => ws.once('open', resolve));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(messages).toHaveLength(0);
  const initial = new Promise(resolve => ws.once('message', resolve));
  ws.send(JSON.stringify({ type: 'auth', token })); await initial;
  expect(messages[0]?.type).toBe('snapshot');
  const next = new Promise(resolve => ws.once('message', resolve));
  await controller.append(record.id, { segmentId: 's1', text: 'Committed text', revision: 1, isFinal: true }); await next;
  expect(messages.at(-1)?.payload.revision).toBe(1);
  ws.close();
});

it('rejects websocket query credentials and invalid authentication', async () => {
  const { base, controller } = await setup();
  const record = await controller.create({ title: 'Private view' });
  const query = new WebSocket(`${base.replace('http', 'ws')}/api/meetings/${record.id}/events?token=unsafe`);
  const code = await new Promise<number>(resolve => { query.on('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.resume(); query.terminate(); }); query.on('error', () => undefined); });
  expect(code).toBe(403);
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/meetings/${record.id}/events`);
  await new Promise(resolve => ws.once('open', resolve));
  const closed = new Promise<number>(resolve => ws.once('close', resolve));
  ws.send(JSON.stringify({ type: 'auth', token: 'invalid' }));
  expect(await closed).toBe(4401);
});
