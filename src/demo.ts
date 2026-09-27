import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingController } from './core/controller.js';
import { unavailableProviders, type AmbientProviders } from './core/providers.js';

console.log('OFFLINE FIXTURE REHEARSAL — not live provider or hardware verification');
const directory = await mkdtemp(join(tmpdir(), 'glance-demo-'));
let sends = 0;
const providers: AmbientProviders = {
  ...unavailableProviders(), mode: 'fixture', configured: { qm: true, gbrain: true, calendar: false },
  judge: async input => {
    const assignment = input.recentTranscript.find(segment => segment.id === 'assignment');
    if (assignment) return { kind: 'task', title: 'Synthetic launch brief', instructions: 'Prepare the corrected launch brief.', assignedTo: 'operator', explicitAssignmentSegmentId: assignment.id, evidenceIds: [`transcript:${assignment.id}:${assignment.revision}`] };
    return { kind: 'cue', text: input.recentTranscript.at(-1)!.text, topic: 'Synthetic launch budget', evidenceIds: [input.evidence.at(-1)!.id] };
  },
  summarize: async () => ({ text: 'Synthetic launch budget corrected to 300.', decisions: ['Budget: 300'], openQuestions: [], owners: ['operator'], nextSteps: ['Prepare launch brief'] }),
  saveSummary: async () => ({ id: 'fixture-memory-receipt' }),
  prepareDocument: async () => ({ content: '# Synthetic launch brief\nBudget: 300\n', receipt: { id: 'fixture-document-receipt' } }),
  sendCalendar: async () => { sends++; throw new Error('Fixture must never send invitations'); },
};
const controller = new MeetingController({ directory: join(directory, 'meetings'), providers, debounceMs: 1, maxWaitMs: 5, cooldownMs: 0, summaryIntervalMs: 60000 });
const started = Date.now();
try {
  const meeting = await controller.create({ title: 'OFFLINE FIXTURE: synthetic launch' });
  await controller.append(meeting.id, { segmentId: 'budget', text: 'Budget is 200.', revision: 1, isFinal: false });
  assert.equal((await controller.get(meeting.id)).cue, undefined);
  await controller.append(meeting.id, { segmentId: 'budget', text: 'Budget is 200.', revision: 1, isFinal: true });
  await controller.waitForIdle(meeting.id);
  assert.equal((await controller.get(meeting.id)).cue?.text, 'Budget is 200.');
  const corrected = await controller.append(meeting.id, { segmentId: 'budget', text: 'Budget is 300.', revision: 2, isFinal: true });
  assert.equal(corrected.cue, undefined);
  assert.equal(corrected.correctionEpoch, 1);
  await controller.waitForIdle(meeting.id);
  assert.equal((await controller.get(meeting.id)).cue?.text, 'Budget is 300.');
  await controller.append(meeting.id, { segmentId: 'assignment', text: 'Please prepare the corrected launch brief for me.', revision: 1, isFinal: true, speaker: 'operator' });
  await controller.end(meeting.id);
  await controller.waitForIdle(meeting.id);
  const result = await controller.get(meeting.id);
  assert.equal(result.finalization.state, 'completed');
  assert.equal(result.tasks[0]?.status, 'completed');
  assert.match(result.tasks[0]?.content ?? '', /Budget: 300/);
  assert.equal(sends, 0);
  console.log(JSON.stringify({ mode: 'offline-fixture', checks: 9, listening: 'passed', finalTranscriptCue: 'passed', correctionInvalidation: 'passed', endSummary: result.finalization.state, document: result.tasks[0]?.status, calendarSends: sends, elapsedMs: Date.now() - started }, null, 2));
} finally {
  await controller.close();
  await rm(directory, { recursive: true, force: true });
}
