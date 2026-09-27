import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { MeetingController, type MeetingRecord } from '../src/core/controller.js';
import { unavailableProviders, type AmbientProviders, type SummaryOutput } from '../src/core/providers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const summary = (text: string): SummaryOutput => ({ text, decisions: [], owners: [], openQuestions: [], nextSteps: [] });
async function until(controller: MeetingController, id: string, condition: (record: MeetingRecord) => boolean) {
  for (let index = 0; index < 200; index++) { const record = await controller.get(id); if (condition(record)) return record; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Checkpoint did not reach expected state');
}
async function setup(extra: Partial<AmbientProviders>) {
  const directory = await mkdtemp(join(tmpdir(), 'kompx-memory-'));
  const providers: AmbientProviders = { ...unavailableProviders(), mode: 'fixture', configured: { qm: true, gbrain: true, calendar: false }, judge: async input => ({ kind: 'cue', text: 'Existing useful cue', topic: 'Fixture', evidenceIds: [input.evidence[0]!.id] }), summarize: async () => summary('Fixture rolling memory'), saveSummary: async () => ({ id: 'fixture-readback-receipt' }), ...extra };
  const controller = new MeetingController({ directory: join(directory, 'meetings'), providers, summaryIntervalMs: 20, debounceMs: 1, cooldownMs: 1, providerTimeoutMs: 1000 });
  cleanups.push(async () => { await controller.close(); await rm(directory, { recursive: true, force: true }); });
  const meeting = await controller.create({ title: 'Synthetic memory checkpoint' });
  await controller.append(meeting.id, { segmentId: 'fact', text: 'The agreed synthetic budget is 200.', revision: 1, isFinal: true });
  return { controller, meeting };
}

it.each(['listening', 'paused'] as const)('persists a %s rolling summary without End, and deduplicates finalization', async status => {
  let writes = 0;
  const { controller, meeting } = await setup({ saveSummary: async () => { writes++; return { id: 'fixture-confirmed-readback' }; } });
  if (status === 'paused') await controller.control(meeting.id, 'pause');
  const record = await until(controller, meeting.id, value => value.memoryCheckpoint?.state === 'saved');
  expect(record.status).toBe(status); expect(record.finalization.state).toBe('not_started');
  expect(record.memoryCheckpoint?.receipt?.id).toBe('fixture-confirmed-readback'); expect(record.cue?.text).toBe('Existing useful cue');
  await new Promise(resolve => setTimeout(resolve, 60)); expect(writes).toBe(1);
  await controller.end(meeting.id); await controller.waitForIdle(meeting.id);
  expect(writes).toBe(1); expect((await controller.get(meeting.id)).finalization.receipt?.id).toBe('fixture-confirmed-readback');
});

it('never writes a summary known to be stale after a transcript correction', async () => {
  const started = deferred<void>(); const old = deferred<SummaryOutput>(); const saved: string[] = []; let summaries = 0;
  const { controller, meeting } = await setup({ summarize: async () => { if (++summaries === 1) { started.resolve(); return old.promise; } return summary('Corrected fixture summary'); }, saveSummary: async input => { saved.push(input.summary.text); return { id: 'fixture-corrected-readback' }; } });
  cleanups.push(async () => { old.resolve(summary('Old fixture summary')); });
  await started.promise;
  await controller.append(meeting.id, { segmentId: 'fact', text: 'The corrected synthetic budget is 300.', revision: 2, isFinal: true });
  old.resolve(summary('Old fixture summary'));
  const record = await until(controller, meeting.id, value => value.memoryCheckpoint?.state === 'saved');
  expect(saved).toEqual(['Corrected fixture summary']); expect(record.summary?.text).toBe('Corrected fixture summary');
});

it('keeps capture and local summaries working when shared-memory persistence fails', async () => {
  const { controller, meeting } = await setup({ saveSummary: async () => { throw new Error('Fixture GBrain unavailable'); } });
  const failed = await until(controller, meeting.id, value => value.memoryCheckpoint?.state === 'failed');
  expect(failed.status).toBe('listening'); expect(failed.summary?.text).toBe('Fixture rolling memory');
  expect(failed.finalization.state).toBe('not_started');
  const next = await controller.append(meeting.id, { segmentId: 'next', text: 'Capture continues during the memory outage.', revision: 1, isFinal: true });
  expect(next.status).toBe('listening'); expect(next.transcript).toHaveLength(2);
});

it('serializes a final corrected save after an already-started live write', async () => {
  const began = deferred<void>(); const release = deferred<void>(); const writes: string[] = []; let active = 0; let maximum = 0;
  const { controller, meeting } = await setup({ summarize: async input => summary(input.recentTranscript[0]!.text), saveSummary: async input => {
    writes.push(input.summary.text); active++; maximum = Math.max(maximum, active);
    if (writes.length === 1) { began.resolve(); await release.promise; }
    active--; return { id: `fixture-readback-${writes.length}` };
  } });
  cleanups.push(async () => { release.resolve(); });
  await began.promise;
  await controller.append(meeting.id, { segmentId: 'fact', text: 'The final corrected synthetic budget is 400.', revision: 2, isFinal: true });
  await controller.end(meeting.id); release.resolve(); await controller.waitForIdle(meeting.id);
  const record = await controller.get(meeting.id);
  expect(maximum).toBe(1); expect(writes).toEqual(['The agreed synthetic budget is 200.', 'The final corrected synthetic budget is 400.']);
  expect(record.memoryCheckpoint?.state).toBe('saved'); expect(record.finalization.receipt?.id).toBe('fixture-readback-2');
});
