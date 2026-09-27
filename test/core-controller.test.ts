import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MeetingController } from '../src/core/controller.js';
import { calculate, unavailableProviders, type AmbientInput, type AmbientProviders, type Judgment } from '../src/core/providers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function setup(overrides: Partial<AmbientProviders> = {}, timings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'glance-core-'));
  const providers: AmbientProviders = { ...unavailableProviders(), mode: 'fixture', configured: { qm: true, gbrain: true, calendar: true }, judge: async () => ({ kind: 'quiet', reason: 'No useful cue' }), summarize: async () => ({ text: 'Fixture summary', decisions: [], openQuestions: [], owners: [], nextSteps: [] }), saveSummary: async () => ({ id: 'fixture-summary' }), prepareDocument: async () => ({ content: '# Fixture document', receipt: { id: 'fixture-document' } }), sendCalendar: async () => ({ id: 'fixture-calendar' }), ...overrides };
  const controller = new MeetingController({ directory: join(directory, 'meetings'), providers, debounceMs: 1, cooldownMs: 1, maxWaitMs: 3, providerTimeoutMs: 500, summaryIntervalMs: 60000, ...timings });
  cleanups.push(async () => { await controller.close(); await rm(directory, { recursive: true, force: true }); });
  const meeting = await controller.create({ title: 'Fixture meeting' });
  return { controller, meeting, providers, directory };
}
const final = (text: string, revision = 1, segmentId = 'segment-1', speaker?: string) => ({ segmentId, text, isFinal: true, revision, ...(speaker ? { speaker } : {}) });
const cue = (input: AmbientInput): Judgment => ({ kind: 'cue', topic: 'Budget', text: 'Budget is $200.', evidenceIds: [input.evidence[0]!.id] });

describe('durable ambient controller', () => {
  it('deduplicates partial/final delivery and rejects same-revision content changes', async () => {
    let calls = 0;
    const { controller, meeting } = await setup({ judge: async () => { calls++; return { kind: 'quiet', reason: 'quiet' }; } });
    await controller.append(meeting.id, { ...final('Budget is 200'), isFinal: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls).toBe(0);
    await controller.append(meeting.id, final('Budget is 200'));
    await controller.append(meeting.id, final('Budget is 200'));
    await controller.waitForIdle(meeting.id);
    const snapshot = await controller.get(meeting.id);
    expect(snapshot.transcript).toHaveLength(1);
    expect(snapshot.revision).toBe(2);
    expect(snapshot.correctionEpoch).toBe(0);
    expect(calls).toBe(1);
    await expect(controller.append(meeting.id, final('Budget is 300'))).rejects.toMatchObject({ code: 'segment_revision_conflict' });
  });

  it('serializes simultaneous transcript writes without dropping segments', async () => {
    const { controller, meeting } = await setup();
    await Promise.all(Array.from({ length: 20 }, (_, index) => controller.append(meeting.id, final(`Sentence ${index}`, 1, `s${index}`))));
    const snapshot = await controller.get(meeting.id);
    expect(snapshot.transcript).toHaveLength(20);
    expect(snapshot.revision).toBe(20);
    expect(snapshot.correctionEpoch).toBe(0);
  });

  it('rejects a cue completed after its transcript was corrected and coalesces latest work', async () => {
    const started = deferred<void>(); const result = deferred<Judgment>();
    let calls = 0;
    const { controller, meeting } = await setup({ judge: async input => { calls++; if (calls === 1) { started.resolve(); return result.promise; } return { kind: 'quiet', reason: 'Corrected topic' }; } });
    await controller.append(meeting.id, final('Budget is $200.'));
    await started.promise;
    await controller.append(meeting.id, final('Actually budget is $300.', 2));
    await controller.append(meeting.id, final('Actually budget is $400.', 3));
    result.resolve({ kind: 'cue', topic: 'Budget', text: 'Budget is $200.', evidenceIds: ['transcript:segment-1:1'] });
    await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).cue).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('rejects a result when substantial new topic context arrives during the run', async () => {
    const started = deferred<void>(); const result = deferred<Judgment>(); let calls = 0;
    const { controller, meeting } = await setup({ judge: async () => { if (++calls === 1) { started.resolve(); return result.promise; } return { kind: 'quiet', reason: 'New topic' }; } });
    await controller.append(meeting.id, final('Old budget topic.'));
    await started.promise;
    await controller.append(meeting.id, final('We have moved on to the employee launch plan and must discuss its milestones and the new ownership structure.', 1, 'new-topic'));
    result.resolve({ kind: 'cue', topic: 'Old budget', text: 'Old topic', evidenceIds: ['transcript:segment-1:1'] });
    await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).cue).toBeUndefined();
  });

  it.each(['cue', 'task', 'calendar'] as const)('rejects a deferred %s after even a short new final withdraws its context', async kind => {
    const started = deferred<void>(); const result = deferred<Judgment>(); let calls = 0;
    const { controller, meeting } = await setup({ decisionMode: 'qm-only', judge: async () => {
      if (++calls === 1) { started.resolve(); return result.promise; }
      return { kind: 'quiet', reason: 'Request withdrawn in latest transcript' };
    } });
    await controller.append(meeting.id, final('Jarvis, prepare the brief and schedule a follow-up.', 1, 'segment-1', 'operator'));
    await started.promise;
    await controller.append(meeting.id, final('Cancel that meeting and task.', 1, 'withdrawal'));
    const evidenceIds = ['transcript:segment-1:1'];
    if (kind === 'cue') result.resolve({ kind, topic: 'Follow-up', text: 'The follow-up is ready.', evidenceIds });
    if (kind === 'task') result.resolve({ kind, title: 'Withdrawn brief', instructions: 'Prepare the brief', assignedTo: 'agent', assignmentBasis: 'direct_agent_request', explicitAssignmentSegmentId: 'segment-1', evidenceIds });
    if (kind === 'calendar') result.resolve({ kind, proposal: { title: 'Withdrawn meeting', start: '2026-10-01T10:00:00-07:00', end: '2026-10-01T10:30:00-07:00', timeZone: 'America/Los_Angeles', attendees: [{ email: 'fixture@example.com' }], description: 'Withdrawn' }, evidenceIds });
    await controller.waitForIdle(meeting.id);
    const record = await controller.get(meeting.id);
    expect(record.cue).toBeUndefined(); expect(record.tasks).toHaveLength(0); expect(record.calendarAction).toBeUndefined();
    await expect(controller.confirm(meeting.id, 'stale-action', 1)).rejects.toMatchObject({ code: 'action_not_found' });
    expect(calls).toBe(2);
  });

  it('publishes one cue with exact original evidence, and rejects invented references', async () => {
    const { controller, meeting, providers } = await setup({ judge: async input => cue(input) });
    await controller.append(meeting.id, final('Budget is $200.'));
    await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).cue?.evidence[0]?.text).toBe('Budget is $200.');
    providers.judge = async () => ({ kind: 'cue', topic: 'Budget', text: 'Unsupported result', evidenceIds: ['invented-source'] });
    await controller.append(meeting.id, final('New evidence', 1, 'second'));
    await controller.waitForIdle(meeting.id);
    const record = await controller.get(meeting.id);
    expect(record.cue?.text).not.toBe('Unsupported result');
    expect(record.warnings.some(warning => warning.message.includes('unknown evidence'))).toBe(true);
  });

  it('checks Jev authorization against current input before publishing', async () => {
    const { controller, meeting } = await setup({ judge: async input => ({ ...cue(input), authorization: { receiptId: 'decision-1', verify: () => false } }) });
    await controller.append(meeting.id, final('Budget is $200.'));
    await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).cue).toBeUndefined();
  });
  it('fails closed when native mode returns a non-quiet action without a Jev receipt', async () => {
    const { controller, meeting } = await setup({ decisionMode: 'jev-native', judge: async input => cue(input) });
    await controller.append(meeting.id, final('Budget is $200.'));
    await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).cue).toBeUndefined();
    expect((await controller.get(meeting.id)).warnings.some(warning => warning.message.includes('no authorization receipt'))).toBe(true);
  });

  it('bounds a stalled provider and never runs two ambient jobs concurrently', async () => {
    let active = 0; let maximum = 0; let calls = 0;
    const started = deferred<void>();
    const { controller, meeting } = await setup({ judge: async (_input, signal) => {
      active++; calls++; maximum = Math.max(maximum, active); started.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      active--; return { kind: 'quiet', reason: 'aborted' };
    } }, { providerTimeoutMs: 25 });
    await controller.append(meeting.id, final('First thought'));
    await started.promise;
    await controller.append(meeting.id, final('Next thought', 1, 's2'));
    await controller.waitForIdle(meeting.id);
    expect(maximum).toBe(1); expect(calls).toBe(2);
    expect((await controller.get(meeting.id)).warnings.some(warning => warning.code === 'ambient_unavailable')).toBe(true);
  });

  it('never turns unknown-speaker first person into an operator task', async () => {
    const { controller, meeting } = await setup({ judge: async input => ({ kind: 'task', title: 'Prepare brief', instructions: 'Draft a brief', assignedTo: 'operator', explicitAssignmentSegmentId: 'segment-1', evidenceIds: [input.evidence[0]!.id] }) });
    await controller.append(meeting.id, final('I will prepare the brief.'));
    await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).tasks).toHaveLength(0);
  });

  it('accepts a direct authenticated operator message as task assignment evidence', async () => {
    const { controller, meeting } = await setup({ judge: async input => ({ kind: 'task', title: 'Typed brief', instructions: 'Prepare the brief', assignedTo: 'operator', explicitAssignmentSegmentId: input.operatorMessages[0]!.id, evidenceIds: [input.evidence[0]!.id] }) });
    await controller.message(meeting.id, { participantId: 'operator', text: 'Please prepare my brief.' });
    await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('queued');
  });

  it.each([
    ['Jarvis, please draft the shared project brief after this meeting.', 'direct_agent_request'],
    ['We agreed to have the assistant prepare the shared project brief.', 'agreed_shared_work'],
  ] as const)('starts agent-owned preparation from unknown-speaker shared work: %s', async (text, assignmentBasis) => {
    const { controller, meeting } = await setup({ judge: async input => ({ kind: 'task', title: 'Shared project brief', instructions: 'Prepare a read-only Markdown brief', assignedTo: 'agent', assignmentBasis, explicitAssignmentSegmentId: 'segment-1', evidenceIds: [input.evidence[0]!.id] }) });
    await controller.append(meeting.id, final(text));
    await controller.end(meeting.id); await controller.waitForIdle(meeting.id);
    const record = await controller.get(meeting.id);
    expect(record.tasks[0]?.status).toBe('completed');
    expect(record.taskOrigins[record.tasks[0]!.id]?.assignedTo).toBe('agent');
    expect(record.taskOrigins[record.tasks[0]!.id]?.assignmentBasis).toBe(assignmentBasis);
  });

  it('does not reclassify an unknown speaker wearer commitment as agent work', async () => {
    const { controller, meeting } = await setup({ judge: async input => ({ kind: 'task', title: 'Personal brief', instructions: 'Draft brief', assignedTo: 'agent', assignmentBasis: 'wearer_commitment', explicitAssignmentSegmentId: 'segment-1', evidenceIds: [input.evidence[0]!.id] }) });
    await controller.append(meeting.id, final('I will draft the brief.'));
    await controller.end(meeting.id); await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).tasks).toHaveLength(0);
  });

  it('continues explicitly accepted document work after end and finalizes once', async () => {
    let saves = 0; let documents = 0;
    const { controller, meeting } = await setup({ judge: async input => ({ kind: 'task', title: 'Prepare brief', instructions: 'Prepare the brief', assignedTo: 'operator', explicitAssignmentSegmentId: 'segment-1', evidenceIds: [input.evidence[0]!.id] }), saveSummary: async () => { saves++; return { id: 'saved' }; }, prepareDocument: async () => { documents++; return { content: '# Brief', receipt: { id: 'qm-task' } }; } });
    await controller.append(meeting.id, final('Please prepare the brief for me.', 1, 'segment-1', 'operator'));
    await controller.waitForIdle(meeting.id);
    await Promise.all([controller.end(meeting.id), controller.end(meeting.id)]);
    await controller.waitForIdle(meeting.id);
    const record = await controller.get(meeting.id);
    expect(saves).toBe(1); expect(documents).toBe(1);
    expect(record.tasks[0]?.status).toBe('completed');
    expect(record.taskOrigins[record.tasks[0]!.id]?.origin.meetingId).toBe(meeting.id);
    expect(record.finalization.state).toBe('completed');
    await expect(controller.append(meeting.id, final('Late input'))).rejects.toMatchObject({ code: 'capture_stopped' });
  });

  it('does not execute queued assignments invalidated by a correction', async () => {
    const { controller, meeting, providers } = await setup({ judge: async input => ({ kind: 'task', title: 'Prepare brief', instructions: 'Prepare the brief', assignedTo: 'operator', explicitAssignmentSegmentId: 'segment-1', evidenceIds: [input.evidence[0]!.id] }) });
    await controller.append(meeting.id, final('Prepare the brief.', 1, 'segment-1', 'operator'));
    await controller.waitForIdle(meeting.id);
    providers.judge = async () => ({ kind: 'quiet', reason: 'Assignment withdrawn' });
    await controller.append(meeting.id, final('Do not prepare the brief.', 2, 'segment-1', 'operator'));
    await controller.end(meeting.id); await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('cancelled');
  });

  it('does not execute an accepted task withdrawn by a new final segment', async () => {
    let documents = 0;
    const { controller, meeting, providers } = await setup({ judge: async input => ({ kind: 'task', title: 'Brief', instructions: 'Write brief', assignedTo: 'agent', assignmentBasis: 'direct_agent_request', explicitAssignmentSegmentId: 'segment-1', evidenceIds: [input.evidence[0]!.id] }), prepareDocument: async () => { documents++; return { content: '# Brief', receipt: { id: 'unexpected' } }; } });
    await controller.append(meeting.id, final('Jarvis, please prepare the brief.')); await controller.waitForIdle(meeting.id);
    providers.judge = async () => ({ kind: 'quiet', reason: 'Task withdrawn' });
    await controller.append(meeting.id, final('Do not prepare that document.', 1, 'withdrawal'));
    await controller.end(meeting.id); await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('cancelled'); expect(documents).toBe(0);
  });

  it('reaffirms a standing task against the full final transcript before dispatch', async () => {
    const { controller, meeting } = await setup({ judge: async input => ({ kind: 'task', title: 'Brief', instructions: 'Write brief', assignedTo: 'agent', assignmentBasis: 'direct_agent_request', explicitAssignmentSegmentId: 'segment-1', evidenceIds: [input.evidence.find(item => item.id === 'transcript:segment-1:1')!.id] }) });
    await controller.append(meeting.id, final('Jarvis, please prepare the brief.')); await controller.waitForIdle(meeting.id);
    await controller.append(meeting.id, final('Include our timeline too.', 1, 'continuation'));
    await controller.end(meeting.id); await controller.waitForIdle(meeting.id);
    const record = await controller.get(meeting.id);
    expect(record.tasks).toHaveLength(1); expect(record.tasks[0]?.status).toBe('completed');
    expect(record.taskOrigins[record.tasks[0]!.id]?.origin.finalCount).toBe(2);
  });

  it('retains capture and explicit unavailable state when providers are missing', async () => {
    const { controller, meeting } = await setup(unavailableProviders());
    await controller.append(meeting.id, final('Hello'));
    await controller.end(meeting.id); await controller.waitForIdle(meeting.id);
    const snapshot = await controller.get(meeting.id);
    expect(snapshot.transcript).toHaveLength(1);
    expect(snapshot.cue).toBeUndefined(); expect(snapshot.summary).toBeUndefined();
    expect(snapshot.finalization.state).toBe('failed');
    expect(snapshot.warnings.some(warning => warning.code === 'qm_unavailable')).toBe(true);
  });

  it('judges the flushed final assignment even when End beats the debounce timer', async () => {
    const { controller, meeting } = await setup({ judge: async input => input.purpose === 'finalization' ? { kind: 'task', title: 'Final brief', instructions: 'Write brief', assignedTo: 'operator', explicitAssignmentSegmentId: 'segment-1', evidenceIds: [input.evidence[0]!.id] } : { kind: 'quiet', reason: 'quiet' } }, { debounceMs: 100 });
    await controller.append(meeting.id, final('Please prepare my final brief.', 1, 'segment-1', 'operator'));
    await controller.end(meeting.id); await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('completed');
  });

  it('prevents participant impersonation and capture while paused', async () => {
    const { controller, meeting } = await setup();
    await expect(controller.message(meeting.id, { participantId: 'someone-else', text: 'Do this' })).rejects.toMatchObject({ status: 403 });
    await controller.control(meeting.id, 'pause');
    await expect(controller.append(meeting.id, final('Hello'))).rejects.toMatchObject({ status: 409 });
    await controller.control(meeting.id, 'resume');
    expect((await controller.append(meeting.id, final('Hello'))).status).toBe('listening');
  });

  it('answers explicit operator input while paused without resuming capture', async () => {
    const { controller, meeting } = await setup({ judge: async input => ({ kind: 'calculate', expression: '48 / 6', label: 'Interviews per week', evidenceIds: [input.evidence[0]!.id] }) });
    await controller.control(meeting.id, 'pause');
    await controller.message(meeting.id, { participantId: 'operator', text: 'What is 48 divided by 6?' });
    await controller.waitForIdle(meeting.id);
    const record = await controller.get(meeting.id);
    expect(record.status).toBe('paused'); expect(record.cue?.text).toBe('Interviews per week: 8');
  });

  it('recovers ambiguous work without automatically replaying external actions', async () => {
    const { controller, meeting, providers } = await setup();
    let sends = 0; providers.sendCalendar = async () => { sends++; return { id: 'unexpected' }; };
    await controller.store.update(meeting.id, value => {
      value.status = 'ended';
      value.finalization = { state: 'running' };
      value.actionExecution = { proposalVersion: 1, correctionEpoch: 0, revision: 0, state: 'executing', idempotencyKey: 'uncertain-at-restart' };
      value.calendarAction = { id: 'action', proposalVersion: 1, title: 'Invite', start: '2026-10-01T10:00:00-07:00', end: '2026-10-01T10:30:00-07:00', timeZone: 'America/Los_Angeles', attendees: [{ email: 'fixture@example.com' }], description: 'Fixture', status: 'confirmed' };
    });
    await controller.recover();
    const recovered = await controller.get(meeting.id);
    expect(recovered.actionExecution?.state).toBe('uncertain');
    expect(recovered.calendarAction?.status).toBe('uncertain');
    expect(recovered.finalization.state).toBe('failed');
    expect(sends).toBe(0);
  });

  it('recovers finalization when a crash followed the durable ended marker', async () => {
    let saves = 0;
    const { controller, meeting } = await setup({ saveSummary: async () => { saves++; return { id: 'recovered-summary' }; } });
    await controller.store.update(meeting.id, value => { value.status = 'ended'; });
    await controller.recover(); await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).finalization.state).toBe('completed'); expect(saves).toBe(1);
    await controller.recover(); await controller.waitForIdle(meeting.id); expect(saves).toBe(1);
  });

  it.each(['completed', 'failed'] as const)('recovers never-started document work after summary %s without replaying its write', async state => {
    let saves = 0; let documents = 0;
    const { controller, meeting } = await setup({ judge: async input => ({ kind: 'task', title: 'Brief', instructions: 'Write brief', assignedTo: 'agent', assignmentBasis: 'direct_agent_request', explicitAssignmentSegmentId: 'segment-1', evidenceIds: [input.evidence[0]!.id] }), saveSummary: async () => { saves++; return { id: 'unexpected-save' }; }, prepareDocument: async () => { documents++; return { content: '# Recovered brief', receipt: { id: 'recovered-document' } }; } });
    await controller.append(meeting.id, final('Jarvis, prepare the brief.')); await controller.waitForIdle(meeting.id);
    await controller.store.update(meeting.id, value => { value.status = 'ended'; value.finalization = { state }; });
    await controller.recover(); await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).tasks[0]?.status).toBe('completed'); expect(documents).toBe(1); expect(saves).toBe(0);
    await controller.recover(); await controller.waitForIdle(meeting.id); expect(documents).toBe(1);
  });

  it('evaluates bounded arithmetic without executing code', () => {
    expect(calculate('(120 * 1.25) - 20')).toBe(130);
    expect(() => calculate('process.exit()')).toThrow();
    expect(() => calculate('1 / 0')).toThrow();
  });
});

describe('calendar confirmation guard', () => {
  const judgment = (input: AmbientInput): Judgment => ({ kind: 'calendar', proposal: { title: 'Follow-up', start: '2026-10-01T10:00:00-07:00', end: '2026-10-01T10:30:00-07:00', timeZone: 'America/Los_Angeles', attendees: [{ email: 'fixture@example.com' }], description: 'Review the brief' }, evidenceIds: [input.evidence[0]!.id] });
  it('sends at most once under concurrent confirmations', async () => {
    let sends = 0;
    const { controller, meeting } = await setup({ judge: async input => judgment(input), sendCalendar: async () => { sends++; return { id: 'provider-event' }; } });
    await controller.append(meeting.id, final('Schedule a follow-up.')); await controller.waitForIdle(meeting.id);
    const action = (await controller.get(meeting.id)).calendarAction!;
    await Promise.all([controller.confirm(meeting.id, action.id, action.proposalVersion), controller.confirm(meeting.id, action.id, action.proposalVersion)]);
    await controller.waitForIdle(meeting.id);
    expect(sends).toBe(1); expect((await controller.get(meeting.id)).calendarAction?.status).toBe('sent');
  });
  it('invalidates a proposal when corrected and blocks stale approval', async () => {
    const { controller, meeting, providers } = await setup({ judge: async input => judgment(input) });
    await controller.append(meeting.id, final('Schedule October 1.')); await controller.waitForIdle(meeting.id);
    const action = (await controller.get(meeting.id)).calendarAction!;
    providers.judge = async () => ({ kind: 'quiet', reason: 'Needs new date' });
    await controller.append(meeting.id, final('Actually October 2.', 2));
    await expect(controller.confirm(meeting.id, action.id, action.proposalVersion)).rejects.toMatchObject({ code: 'stale_proposal' });
  });
  it('allows the exact unchanged preview to be confirmed after capture ends', async () => {
    const { controller, meeting } = await setup({ judge: async input => judgment(input) });
    await controller.append(meeting.id, final('Schedule the follow-up.')); await controller.waitForIdle(meeting.id);
    const action = (await controller.get(meeting.id)).calendarAction!;
    await controller.end(meeting.id); await controller.waitForIdle(meeting.id);
    await controller.confirm(meeting.id, action.id, action.proposalVersion); await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).calendarAction?.status).toBe('sent');
  });
  it('persists uncertain sends and prevents a blind retry', async () => {
    let sends = 0;
    const { controller, meeting } = await setup({ judge: async input => judgment(input), sendCalendar: async () => { sends++; throw new Error('Connection lost after submitting'); } });
    await controller.append(meeting.id, final('Schedule follow-up.')); await controller.waitForIdle(meeting.id);
    const action = (await controller.get(meeting.id)).calendarAction!;
    await controller.confirm(meeting.id, action.id, action.proposalVersion); await controller.waitForIdle(meeting.id);
    expect((await controller.get(meeting.id)).actionExecution?.state).toBe('uncertain');
    await expect(controller.confirm(meeting.id, action.id, action.proposalVersion)).rejects.toMatchObject({ code: 'send_uncertain' });
    expect(sends).toBe(1);
  });
});
