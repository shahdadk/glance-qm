import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MeetingController } from '../src/core/controller.js';
import { unavailableProviders } from '../src/core/providers.js';
import { FileDeliveryAttemptStore, GmailDeliveryAdapter } from '../src/integrations/delivery.js';
import { createApp } from '../src/server/app.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); });
async function setup(options: { self?: boolean; provider?: typeof fetch; token?: () => Promise<string> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-route-'));
  const controller = new MeetingController({ directory: join(directory, 'meetings'), providers: unavailableProviders(), summaryIntervalMs: 100_000 });
  const provider = vi.fn(options.provider ?? (async () => new Response(JSON.stringify({ id: 'fixture-message-1' }), { status: 200 })));
  const adapter = new GmailDeliveryAdapter({ senderEmail: 'wearer@example.com', accessToken: options.token ?? 'fixture-token', fetch: provider });
  const runtime = createApp({ controller, token: 'local-test-operator-token', delivery: { env: options.self === false ? {} : { GOOGLE_GMAIL_FROM_EMAIL: 'wearer@example.com' }, sender: { configured: true, adapter, attempts: new FileDeliveryAttemptStore(join(directory, 'attempts')) } } });
  await new Promise<void>(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  cleanup.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const meeting = await controller.create({ title: 'Document meeting' });
  const content = '# Product requirements\n\nOnly the reviewed canonical artifact.\n';
  const digest = createHash('sha256').update(content).digest('hex');
  await controller.updateDelivery(meeting.id, record => {
    const context = controller.finalizedContext(record);
    record.tasks.push({ id: 'task-doc', title: 'Product requirements', status: 'completed', content, generation: 1, artifactDigest: digest, contextDigest: context.digest });
    record.taskOrigins['task-doc'] = { id: 'task-doc', meetingId: meeting.id, title: 'Product requirements', instructions: 'Write a PRD', evidence: [], assignedTo: 'agent', generation: 1, artifactDigest: digest, origin: { meetingId: meeting.id, revision: 0, correctionEpoch: 0, finalCount: 0, capturedAt: Date.now(), contextRevision: context.revision, contextDigest: context.digest } };
  });
  const request = (path: string, body: unknown, auth = true) => fetch(`${base}/api/meetings/${meeting.id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer local-test-operator-token' } : {}) }, body: JSON.stringify(body) });
  const prepare = async () => { const response = await request('tasks/task-doc/delivery', { recipient: 'self' }); expect(response.status).toBe(201); return response.json(); };
  return { controller, meeting, provider, request, prepare, content };
}

it('requires operator authentication and an explicit resolvable recipient without sending', async () => {
  const s = await setup({ self: false });
  expect((await s.request('tasks/task-doc/delivery', { recipient: { email: 'person@example.com' } }, false)).status).toBe(401);
  expect((await s.request('tasks/task-doc/delivery', { recipient: 'self' })).status).toBe(409);
  expect((await s.request('tasks/task-doc/delivery', { recipient: { name: 'Someone' } })).status).toBe(400);
  expect((await s.request('tasks/task-doc/delivery', { recipient: { email: 'person@example.com' }, participantId: 'owner' })).status).toBe(400);
  expect((await s.request('tasks/unknown/delivery', { recipient: { email: 'person@example.com' } })).status).toBe(404);
  expect(s.provider).not.toHaveBeenCalled();
});

it('previews canonical content and sends only after the exact version is confirmed once', async () => {
  const s = await setup(); const prepared = await s.prepare(); const action = prepared.deliveryAction;
  expect(action.recipient.email).toBe('wearer@example.com'); expect(action.status).toBe('proposed'); expect(s.provider).not.toHaveBeenCalled();
  expect((await s.request(`deliveries/${action.id}/confirm`, { proposalVersion: action.proposalVersion + 1 })).status).toBe(409);
  expect((await s.request(`deliveries/${action.id}/confirm`, { proposalVersion: action.proposalVersion, confirmedBy: 'someone' })).status).toBe(400);
  const result = await s.request(`deliveries/${action.id}/confirm`, { proposalVersion: action.proposalVersion });
  expect(result.status).toBe(200); expect((await result.json()).deliveryAction).toMatchObject({ status: 'sent', providerMessageId: 'fixture-message-1' });
  const mime = Buffer.from(JSON.parse(s.provider.mock.calls[0]![1]!.body as string).raw, 'base64url').toString();
  expect(mime).toContain(Buffer.from(s.content).toString('base64').slice(0, 60));
  expect((await s.request(`deliveries/${action.id}/confirm`, { proposalVersion: action.proposalVersion })).status).toBe(409);
  expect(s.provider).toHaveBeenCalledTimes(1);
});

it('rejects changed artifact bytes and review-required or cancelled tasks', async () => {
  const s = await setup(); const prepared = await s.prepare(); const action = prepared.deliveryAction;
  await s.controller.updateDelivery(s.meeting.id, record => { record.tasks[0]!.content += ' Unreviewed change'; });
  expect((await s.request(`deliveries/${action.id}/confirm`, { proposalVersion: action.proposalVersion })).status).toBe(409);
  await s.controller.updateDelivery(s.meeting.id, record => { record.tasks[0]!.status = 'review_required'; });
  expect((await s.request('tasks/task-doc/delivery', { recipient: 'self' })).status).toBe(409);
  await s.controller.cancelTask(s.meeting.id, 'task-doc');
  expect((await s.request(`deliveries/${action.id}/confirm`, { proposalVersion: action.proposalVersion })).status).toBe(409);
  expect(s.provider).not.toHaveBeenCalled();
});

it('serializes concurrent confirmations into exactly one provider request', async () => {
  const s = await setup(); const { deliveryAction: a } = await s.prepare();
  const results = await Promise.all([s.request(`deliveries/${a.id}/confirm`, { proposalVersion: a.proposalVersion }), s.request(`deliveries/${a.id}/confirm`, { proposalVersion: a.proposalVersion })]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]); expect(s.provider).toHaveBeenCalledTimes(1);
});

it('keeps ambiguous provider outcomes uncertain and blocks blind retries or replacement', async () => {
  const s = await setup({ provider: async () => { throw new Error('connection lost'); } }); const { deliveryAction: a } = await s.prepare();
  const result = await s.request(`deliveries/${a.id}/confirm`, { proposalVersion: a.proposalVersion });
  expect(result.status).toBe(502); expect((await result.json()).deliveryAction.status).toBe('uncertain');
  expect((await s.request(`deliveries/${a.id}/confirm`, { proposalVersion: a.proposalVersion })).status).toBe(409);
  expect((await s.request('tasks/task-doc/delivery', { recipient: 'self' })).status).toBe(409);
  expect(s.provider).toHaveBeenCalledTimes(1);
});

it('rechecks the finalized source after token refresh, before provider dispatch', async () => {
  let resume!: () => void; let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; }); const token = new Promise<void>(resolve => { resume = resolve; });
  const s = await setup({ token: async () => { started(); await token; return 'fixture-token'; } });
  const { deliveryAction: a } = await s.prepare(); const sending = s.request(`deliveries/${a.id}/confirm`, { proposalVersion: a.proposalVersion });
  await waiting;
  await s.controller.append(s.meeting.id, { segmentId: 'new-final', text: 'Change the requirements before sending.', revision: 1, isFinal: true });
  resume(); const response = await sending;
  expect(response.status).toBe(409); expect(s.provider).not.toHaveBeenCalled();
});

it('requires review after changed context and binds the next preview to the reviewed generation', async () => {
  const s = await setup(); const { deliveryAction: old } = await s.prepare();
  await s.controller.append(s.meeting.id, { segmentId: 'updated-context', text: 'The PRD should use the agreed launch date.', revision: 1, isFinal: true });
  expect((await s.request(`deliveries/${old.id}/confirm`, { proposalVersion: old.proposalVersion })).status).toBe(409);
  const detail = await s.controller.task(s.meeting.id, 'task-doc');
  expect(detail.task.status).toBe('review_required');
  expect((await s.request('tasks/task-doc/delivery', { recipient: 'self' })).status).toBe(409);
  expect((await s.request('tasks/task-doc/review', { generation: detail.generation, contextDigest: detail.contextDigest })).status).toBe(200);
  const { deliveryAction: current } = await s.prepare();
  expect(current.contextDigest).toBe(detail.contextDigest); expect(current.proposalVersion).toBe(old.proposalVersion + 1);
  await s.controller.updateDelivery(s.meeting.id, record => { record.taskOrigins['task-doc']!.generation = 2; });
  expect((await s.request(`deliveries/${current.id}/confirm`, { proposalVersion: current.proposalVersion })).status).toBe(409);
  expect(s.provider).not.toHaveBeenCalled();
});

it('recovers an interrupted send as uncertain without retrying it', async () => {
  const s = await setup(); const { deliveryAction: a } = await s.prepare();
  await s.controller.updateDelivery(s.meeting.id, record => { record.deliveryAction!.status = 'sending'; });
  await s.controller.recover();
  expect((await s.controller.get(s.meeting.id)).deliveryAction?.status).toBe('uncertain');
  expect((await s.request(`deliveries/${a.id}/confirm`, { proposalVersion: a.proposalVersion })).status).toBe(409);
  expect(s.provider).not.toHaveBeenCalled();
});

it('reuses identical concurrent delivery preparations and sends their shared approval only once', async () => {
  const s = await setup();
  const [first, second] = await Promise.all([s.prepare(), s.prepare()]);
  expect(second.deliveryAction).toEqual(first.deliveryAction);
  expect(second.deliveryExecution).toEqual(first.deliveryExecution);
  const a = first.deliveryAction;
  const results = await Promise.all([s.request(`deliveries/${a.id}/confirm`, { proposalVersion: a.proposalVersion }), s.request(`deliveries/${a.id}/confirm`, { proposalVersion: a.proposalVersion })]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  expect(s.provider).toHaveBeenCalledTimes(1);
});

it('blocks repeat artifact delivery across recipient changes and durable recovery', async () => {
  const s = await setup(); const { deliveryAction: a } = await s.prepare();
  expect((await s.request(`deliveries/${a.id}/confirm`, { proposalVersion: a.proposalVersion })).status).toBe(200);
  const duplicate = await s.request('tasks/task-doc/delivery', { recipient: 'self' });
  expect(duplicate.status).toBe(409); expect((await duplicate.json()).error.code).toBe('document_already_delivered');
  const other = await s.request('tasks/task-doc/delivery', { recipient: { email: 'other@example.com' } });
  expect(other.status).toBe(201); const b = (await other.json()).deliveryAction;
  expect((await s.request(`deliveries/${b.id}/confirm`, { proposalVersion: b.proposalVersion })).status).toBe(200);
  await s.controller.recover();
  const backToA = await s.request('tasks/task-doc/delivery', { recipient: { email: 'WEARER@example.com' }, subject: 'Different subject still cannot resend the same document' });
  expect(backToA.status).toBe(409); expect((await backToA.json()).error.code).toBe('document_already_delivered');
  const persisted = await s.controller.get(s.meeting.id) as unknown as { deliveryReceipts: unknown[] };
  expect(persisted.deliveryReceipts).toHaveLength(2);
  expect(s.provider).toHaveBeenCalledTimes(2);
});
