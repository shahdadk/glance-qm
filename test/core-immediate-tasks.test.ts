import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { MeetingController } from '../src/core/controller.js';
import { unavailableProviders, type AmbientProviders, type TaskInput } from '../src/core/providers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'kompx-immediate-'));
  const started = deferred<TaskInput>(); const document = deferred<{ content: string; receipt: { id: string } }>(); let calls = 0;
  const providers: AmbientProviders = { ...unavailableProviders(), mode: 'fixture', configured: { qm: true, gbrain: false, calendar: false },
    judge: async input => ({ kind: 'task', title: 'Product requirements', instructions: 'Prepare a read-only PRD from the discussion', assignedTo: 'agent', assignmentBasis: 'agreed_shared_work', explicitAssignmentSegmentId: 'assignment', evidenceIds: [input.evidence.find(item => item.id === 'transcript:assignment:1')!.id] }),
    prepareDocument: async input => { calls++; started.resolve(input); return document.promise; },
  };
  const controller = new MeetingController({ directory: join(directory, 'meetings'), providers, debounceMs: 1, cooldownMs: 1, maxWaitMs: 5, providerTimeoutMs: 1000, summaryIntervalMs: 60000 });
  cleanups.push(async () => { document.resolve({ content: '# Cleanup draft', receipt: { id: 'fixture-cleanup' } }); await controller.close(); await rm(directory, { recursive: true, force: true }); });
  const meeting = await controller.create({ title: 'Synthetic product discussion' });
  await controller.append(meeting.id, { segmentId: 'assignment', text: 'We agree the assistant should prepare the PRD now.', isFinal: true, revision: 1 });
  const input = await started.promise;
  return { controller, meeting, providers, input, document, calls: () => calls };
}

it('starts read-only agent work while listening and preserves capture and original source receipt', async () => {
  const { controller, meeting, input, document, calls } = await setup();
  let record = await controller.get(meeting.id);
  expect(record.status).toBe('listening'); expect(record.tasks[0]?.status).toBe('running');
  await controller.append(meeting.id, { segmentId: 'partial', text: 'Unfinished additional thought', revision: 1, isFinal: false });
  document.resolve({ content: '# Product requirements', receipt: { id: 'actual-fixture-qm-run' } });
  await controller.waitForIdle(meeting.id); record = await controller.get(meeting.id);
  expect(record.status).toBe('listening'); expect(record.tasks[0]?.status).toBe('completed'); expect(calls()).toBe(1);
  expect(record.taskOrigins[record.tasks[0]!.id]?.receipt?.id).toBe('actual-fixture-qm-run');
  expect(record.tasks[0]?.origin?.contextDigest).toBe(input.origin.contextDigest);
  expect(record.tasks[0]?.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
});

it('does not cancel on unrelated new finals, but holds the completed draft for exact-context review', async () => {
  const { controller, meeting, document, calls } = await setup();
  await controller.append(meeting.id, { segmentId: 'follow-up', text: 'Also include an accessibility milestone.', revision: 1, isFinal: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('running'); expect(calls()).toBe(1);
  document.resolve({ content: '# Original-scope draft', receipt: { id: 'fixture-run' } });
  await controller.waitForIdle(meeting.id);
  const record = await controller.get(meeting.id); const taskId = record.tasks[0]!.id;
  expect(record.tasks[0]?.status).toBe('review_required'); expect(record.tasks[0]?.error).toContain('changed');
  const review = await controller.task(meeting.id, taskId);
  await controller.reviewTask(meeting.id, taskId, review.generation, review.contextDigest);
  expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('completed');
});

it('fences explicit cancellation against a late result and duplicate task proposal', async () => {
  const { controller, meeting, providers, document, calls } = await setup();
  const taskId = (await controller.get(meeting.id)).tasks[0]!.id;
  providers.judge = async input => ({ kind: 'cancel_task', taskId, evidenceIds: [input.evidence.find(item => item.id === 'transcript:withdrawal:1')!.id] });
  await controller.append(meeting.id, { segmentId: 'withdrawal', text: 'Withdraw the PRD preparation request.', revision: 1, isFinal: true });
  for (let index = 0; index < 100 && (await controller.get(meeting.id)).tasks[0]?.status !== 'cancelled'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('cancelled');
  document.resolve({ content: '# Superseded draft', receipt: { id: 'late-fixture-run' } });
  await controller.waitForIdle(meeting.id);
  const record = await controller.get(meeting.id);
  expect(record.tasks[0]?.status).toBe('cancelled'); expect(record.tasks[0]?.content).toBeUndefined(); expect(calls()).toBe(1);
  expect(record.tasks[0]?.generation).toBe(2);
});

it('holds a result after correction and rejects review bound to an older context', async () => {
  const { controller, meeting, providers, document } = await setup();
  providers.judge = async () => ({ kind: 'quiet', reason: 'Corrected scope requires review' });
  const taskId = (await controller.get(meeting.id)).tasks[0]!.id;
  const old = await controller.task(meeting.id, taskId);
  await controller.append(meeting.id, { segmentId: 'assignment', text: 'The PRD scope now excludes the original feature.', revision: 2, isFinal: true });
  document.resolve({ content: '# Draft from original scope', receipt: { id: 'fixture-run' } });
  await controller.waitForIdle(meeting.id);
  expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('review_required');
  await expect(controller.reviewTask(meeting.id, taskId, old.generation, old.contextDigest)).rejects.toMatchObject({ code: 'stale_task_review' });
});

it('never replays a running task after ambiguous restart recovery', async () => {
  const { controller, meeting, document, calls } = await setup();
  await controller.recover();
  expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('failed');
  document.resolve({ content: '# Late interrupted run', receipt: { id: 'fixture-run' } });
  await controller.waitForIdle(meeting.id);
  expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('failed'); expect(calls()).toBe(1);
});
