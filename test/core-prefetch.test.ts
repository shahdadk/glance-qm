import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { MeetingController } from '../src/core/controller.js';
import { unavailableProviders, type AmbientProviders } from '../src/core/providers.js';
import type { Evidence } from '../src/shared/contracts.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const source = (name: string): Evidence => ({ id: `exa:fixture-${name}`, label: `Fixture ${name}`, text: `Public source excerpt for ${name}.`, url: `https://example.com/${name}`, kind: 'external' });
async function setup(extra: Partial<AmbientProviders>, timing = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kompx-prefetch-'));
  const providers: AmbientProviders = { ...unavailableProviders(), mode: 'fixture', configured: { qm: true, gbrain: false, calendar: false }, judge: async () => ({ kind: 'quiet', reason: 'Nothing useful' }), ...extra };
  const controller = new MeetingController({ directory: join(directory, 'meetings'), providers, debounceMs: 1, maxWaitMs: 5, cooldownMs: 1, summaryIntervalMs: 60000, ...timing });
  cleanups.push(async () => { await controller.close(); await rm(directory, { recursive: true, force: true }); });
  const meeting = await controller.create({ title: 'Synthetic public introduction' });
  return { controller, meeting, providers };
}

it('prefetches sources only and requires a new authorized judgment after the matching final', async () => {
  let prefetches = 0; let judgments = 0; let verifications = 0;
  const returned = source('Ada');
  const { controller, meeting } = await setup({ decisionMode: 'jev-native', prefetch: async () => { prefetches++; return [returned]; }, judge: async input => {
    judgments++; expect(input.recentTranscript.every(segment => segment.isFinal)).toBe(true);
    expect(input.evidence).toContainEqual(returned);
    return { kind: 'cue', topic: 'Introduction', text: returned.text, evidenceIds: [returned.id], authorization: { receiptId: 'fixture-final-receipt', verify: current => { verifications++; return current.anchor.contextDigest === input.anchor.contextDigest; } } };
  } });
  await controller.append(meeting.id, { segmentId: 'intro', text: 'My name is Ada', revision: 1, isFinal: false });
  await controller.waitForIdle(meeting.id);
  expect(prefetches).toBe(1); expect(judgments).toBe(0);
  const partial = await controller.get(meeting.id); expect(partial.cue).toBeUndefined(); expect(partial.tasks).toHaveLength(0); expect(partial.externalEvidence).toEqual([]);
  await controller.append(meeting.id, { segmentId: 'intro', text: 'My name is Ada', revision: 1, isFinal: true });
  await controller.waitForIdle(meeting.id);
  expect(judgments).toBe(1); expect(verifications).toBe(1); expect((await controller.get(meeting.id)).cue?.evidence).toEqual([returned]);
});

it('aborts superseded partial lookup, runs one flight, and never reuses its late sources', async () => {
  const started = deferred<AbortSignal>(); const old = deferred<Evidence[]>(); let calls = 0; let active = 0; let maximum = 0;
  const { controller, meeting } = await setup({ prefetch: async (_input, signal) => {
    calls++; active++; maximum = Math.max(maximum, active);
    if (calls === 1) { started.resolve(signal); const result = await old.promise; active--; return result; }
    active--; return [source('Bea')];
  }, judge: async input => { expect(input.evidence.some(item => item.id === source('Ada').id)).toBe(false); return { kind: 'cue', topic: 'Introduction', text: 'Public Bea fact.', evidenceIds: [source('Bea').id], authorization: { receiptId: 'fixture-final-receipt', verify: current => current.anchor.contextDigest === input.anchor.contextDigest } }; } });
  cleanups.push(async () => { old.resolve([]); });
  await controller.append(meeting.id, { segmentId: 'intro', text: 'My name is Ada', revision: 1, isFinal: false });
  const signal = await started.promise;
  await controller.append(meeting.id, { segmentId: 'intro', text: 'My name is Bea', revision: 2, isFinal: false });
  expect(signal.aborted).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 230)); expect(calls).toBe(1);
  old.resolve([source('Ada')]); await controller.waitForIdle(meeting.id);
  expect(maximum).toBe(1); expect(calls).toBe(2);
  await controller.append(meeting.id, { segmentId: 'intro', text: 'My name is Bea', revision: 2, isFinal: true });
  await controller.waitForIdle(meeting.id); expect((await controller.get(meeting.id)).cue?.evidence).toEqual([source('Bea')]);
});

it('aborts on End and cannot publish a late speculative source', async () => {
  const started = deferred<AbortSignal>(); const result = deferred<Evidence[]>();
  const { controller, meeting } = await setup({ prefetch: async (_input, signal) => { started.resolve(signal); return result.promise; } });
  cleanups.push(async () => { result.resolve([]); });
  await controller.append(meeting.id, { segmentId: 'intro', text: 'My name is Ada', revision: 1, isFinal: false });
  const signal = await started.promise; await controller.end(meeting.id); expect(signal.aborted).toBe(true);
  result.resolve([source('Ada')]); await controller.waitForIdle(meeting.id);
  const record = await controller.get(meeting.id); expect(record.status).toBe('ended'); expect(record.cue).toBeUndefined(); expect(record.externalEvidence).toEqual([]);
});

it('does not reuse a shorter partial name as the prefix of a different final identity', async () => {
  const { controller, meeting } = await setup({ prefetch: async () => [source('Ann')], judge: async input => {
    expect(input.evidence.some(item => item.id === source('Ann').id)).toBe(false);
    return { kind: 'quiet', reason: 'Final identity requires a fresh lookup' };
  } });
  await controller.append(meeting.id, { segmentId: 'intro', text: 'My name is Ann', revision: 1, isFinal: false }); await controller.waitForIdle(meeting.id);
  await controller.append(meeting.id, { segmentId: 'intro', text: 'My name is Anna', revision: 2, isFinal: true }); await controller.waitForIdle(meeting.id);
  expect((await controller.get(meeting.id)).cue).toBeUndefined();
});

it('cannot use prefetched context through an unsigned QM-only fallback', async () => {
  const { controller, meeting } = await setup({ decisionMode: 'qm-only', prefetch: async () => [source('Ada')], judge: async () => ({ kind: 'cue', topic: 'Introduction', text: 'Unsigned fact', evidenceIds: [source('Ada').id] }) });
  await controller.append(meeting.id, { segmentId: 'intro', text: 'My name is Ada', revision: 1, isFinal: false }); await controller.waitForIdle(meeting.id);
  await controller.append(meeting.id, { segmentId: 'intro', text: 'My name is Ada', revision: 1, isFinal: true }); await controller.waitForIdle(meeting.id);
  const record = await controller.get(meeting.id); expect(record.cue).toBeUndefined(); expect(record.warnings.some(warning => warning.message.includes('fresh final-context Jev receipt'))).toBe(true);
});

it('bounds distinct partial attempts until finalized context advances', async () => {
  let calls = 0;
  const { controller, meeting } = await setup({ prefetch: async () => { calls++; return []; } });
  for (let revision = 1; revision <= 8; revision++) {
    await controller.append(meeting.id, { segmentId: 'intro', text: `Synthetic unfinished introduction ${revision}`, revision, isFinal: false });
    await controller.waitForIdle(meeting.id);
  }
  expect(calls).toBe(6);
});

it('does not defer fresh research behind cue pacing and resumes verified lookup immediately', async () => {
  const researchStarted = deferred<number>(); const resumed = deferred<number>(); let judgments = 0;
  const { controller, meeting } = await setup({ judge: async input => {
    judgments++;
    if (judgments === 1) return { kind: 'cue', topic: 'First topic', text: 'First useful cue.', evidenceIds: [input.evidence[0]!.id] };
    if (judgments === 2) return { kind: 'research', query: 'public new topic', evidenceIds: [input.evidence[0]!.id] };
    resumed.resolve(Date.now()); return { kind: 'quiet', reason: 'No supported public answer' };
  }, research: async () => { researchStarted.resolve(Date.now()); return []; } }, { debounceMs: 300, maxWaitMs: 500, cooldownMs: 2000 });
  await controller.append(meeting.id, { segmentId: 'first', text: 'First useful question.', revision: 1, isFinal: true }); await controller.waitForIdle(meeting.id);
  const began = Date.now(); await controller.append(meeting.id, { segmentId: 'second', text: 'Look up the new public topic.', revision: 1, isFinal: true });
  const lookedUp = await researchStarted.promise; expect(lookedUp - began).toBeLessThan(1500);
  expect((await resumed.promise) - lookedUp).toBeLessThan(200); await controller.waitForIdle(meeting.id);
});
