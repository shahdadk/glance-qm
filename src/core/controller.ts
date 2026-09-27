import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppendTranscriptRequest, CalendarAction, CreateMeetingRequest, Evidence, MeetingSnapshot, MeetingStatus, PostMessageRequest, ServerEvent, Task } from '../shared/contracts.js';
import { SnapshotStore } from './store.js';
import { bounded, calculate, judgmentSchema, summaryOutputSchema, type AmbientInput, type AmbientProviders, type ContextAnchor, type Judgment, type ProviderReceipt, type QmExecutionTrace, type TaskInput } from './providers.js';

export class DomainError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
type TaskOrigin = TaskInput & { receipt?: ProviderReceipt; artifactPath?: string };
interface ActionExecution {
  proposalVersion: number;
  correctionEpoch: number;
  revision: number;
  state: 'proposed' | 'executing' | 'sent' | 'uncertain' | 'cancelled';
  idempotencyKey: string;
  receipt?: ProviderReceipt;
  error?: string;
}
export interface MeetingRecord extends MeetingSnapshot {
  correctionEpoch: number;
  operatorMessages: { id: string; text: string; createdAt: string }[];
  taskOrigins: Record<string, TaskOrigin>;
  memoryEvidence: Evidence[];
  memoryQuery?: string;
  lastRecallRevision?: number;
  actionExecution?: ActionExecution;
  finalization: { state: 'not_started' | 'running' | 'completed' | 'failed'; receipt?: ProviderReceipt; error?: string };
  warnings: { code: string; message: string; createdAt: string }[];
  providerMode: AmbientProviders['mode'];
  attendeeLabels?: string[];
  decisionReceipts?: { receiptId: string; receipt?: unknown; revision: number; kind: string; acceptedAt: string }[];
  providerExecutions?: (QmExecutionTrace & { inputRevision: number; recordedAt: string })[];
}
interface Loop {
  timer?: ReturnType<typeof setTimeout>;
  firstPending?: number;
  pending: boolean;
  inFlight?: Promise<void>;
  lastCueAt: number;
  lastJudgedRevision: number;
  manual?: boolean;
}
export interface ControllerOptions {
  directory: string;
  providers: AmbientProviders;
  debounceMs?: number;
  maxWaitMs?: number;
  cooldownMs?: number;
  providerTimeoutMs?: number;
  summaryIntervalMs?: number;
  now?: () => number;
}

/** Durable meeting state and scheduling only. Reasoning and document work execute in QM. */
export class MeetingController extends EventEmitter {
  readonly store: SnapshotStore<MeetingRecord>;
  readonly providers: AmbientProviders;
  private loops = new Map<string, Loop>();
  private finalizers = new Map<string, Promise<void>>();
  private summaries = new Map<string, Promise<void>>();
  private actionRuns = new Map<string, Promise<void>>();
  private interval: ReturnType<typeof setInterval>;
  private closed = false;
  private options: Required<Omit<ControllerOptions, 'providers' | 'directory'>>;

  constructor(options: ControllerOptions) {
    super();
    this.store = new SnapshotStore(options.directory);
    this.providers = options.providers;
    this.options = { debounceMs: options.debounceMs ?? 2000, maxWaitMs: options.maxWaitMs ?? 6000, cooldownMs: options.cooldownMs ?? 8000, providerTimeoutMs: options.providerTimeoutMs ?? 25000, summaryIntervalMs: options.summaryIntervalMs ?? 30000, now: options.now ?? Date.now };
    this.interval = setInterval(() => { void this.rollSummaries(); }, this.options.summaryIntervalMs);
    this.interval.unref();
  }

  /** Recover receipts conservatively: ambiguous external work is never retried automatically. */
  async recover(): Promise<void> {
    for (const record of await this.store.list()) {
      if (record.actionExecution?.state === 'executing' || record.finalization.state === 'running' || record.tasks.some(task => task.status === 'running')) {
        await this.store.update(record.id, value => {
          if (value.actionExecution?.state === 'executing') {
            value.actionExecution.state = 'uncertain';
            value.actionExecution.error = 'Server restarted during send; verify the provider receipt before retrying.';
            if (value.calendarAction) value.calendarAction.status = 'uncertain';
          }
          if (value.finalization.state === 'running') value.finalization = { state: 'failed', error: 'Server restarted during finalization; no blind retry performed.' };
          for (const task of value.tasks) if (task.status === 'running') { task.status = 'failed'; task.error = 'Server restarted during QM work; inspect its durable run before retrying.'; }
        });
      }
      if (record.status === 'listening' && record.transcript.some(segment => segment.isFinal)) this.schedule(record.id);
      if (record.status === 'ended') this.startFinalizer(record.id);
    }
  }

  async create(input: CreateMeetingRequest): Promise<MeetingRecord> {
    const timestamp = this.iso();
    const value: MeetingRecord = {
      id: randomUUID(), title: input.title, status: 'listening', revision: 0,
      participants: [{ id: 'operator', name: 'You', role: 'owner', joinedAt: timestamp }],
      transcript: [], tasks: [], createdAt: timestamp, updatedAt: timestamp,
      correctionEpoch: 0, operatorMessages: [], taskOrigins: {}, memoryEvidence: [],
      finalization: { state: 'not_started' }, warnings: [], providerMode: this.providers.mode,
    };
    // Names are context labels, not authenticated people or QM group memberships.
    if (input.participantNames?.length) {
      value.attendeeLabels = [...input.participantNames];
      value.warnings.push({ code: 'single_operator', message: `Attendee labels: ${input.participantNames.join(', ')}. This local installation authenticates only its operator.`, createdAt: timestamp });
    }
    if (!this.providers.configured.qm) value.warnings.push({ code: 'qm_unavailable', message: 'QM is not configured. Capture is available; ambient cues and summaries are unavailable.', createdAt: timestamp });
    if (!this.providers.configured.gbrain) value.warnings.push({ code: 'gbrain_unavailable', message: 'GBrain is not configured. Cross-meeting recall and shared summary persistence are unavailable.', createdAt: timestamp });
    await this.store.create(value);
    this.publish(value);
    return value;
  }

  get(id: string): Promise<MeetingRecord> { return this.store.read(id); }

  /** Send the initial state and attach its listener while holding the meeting's write queue. */
  subscribe(id: string, listener: (event: ServerEvent) => void): Promise<() => void> {
    return this.store.readLocked(id, value => {
      listener({ type: 'snapshot', meetingId: id, payload: structuredClone(value) });
      this.on('event', listener);
      return () => this.off('event', listener);
    });
  }

  async append(id: string, input: AppendTranscriptRequest): Promise<MeetingRecord> {
    const update = await this.store.update(id, value => {
      if (value.status !== 'listening') throw new DomainError(409, 'capture_stopped', 'The meeting is no longer listening.');
      const previous = value.transcript.find(segment => segment.id === input.segmentId);
      if (previous) {
        if (input.revision < previous.revision) return false;
        const same = previous.text === input.text && previous.speaker === input.speaker;
        if (input.revision === previous.revision) {
          if (same && (previous.isFinal || !input.isFinal)) return false;
          if (!same) throw new DomainError(409, 'segment_revision_conflict', 'Changed text requires a newer segment revision.');
        }
        if (previous.isFinal && !input.isFinal) return false;
        if (previous.isFinal && (!same || input.isFinal !== previous.isFinal)) {
          value.correctionEpoch++;
          delete value.cue;
          delete value.summary;
          value.memoryEvidence = [];
          delete value.memoryQuery;
          for (const task of value.tasks) if (task.status === 'queued') { task.status = 'cancelled'; task.error = 'A transcript correction changed the assignment context. A fresh assignment is required.'; }
        }
      }
      const segment = { id: input.segmentId, text: input.text, isFinal: input.isFinal, revision: input.revision, ...(input.speaker ? { speaker: input.speaker } : {}), capturedAt: this.iso() };
      if (previous) value.transcript[value.transcript.indexOf(previous)] = segment;
      else value.transcript.push(segment);
      value.revision++;
      value.updatedAt = this.iso();
      if (input.isFinal) delete value.cue;
      if (input.isFinal && value.actionExecution?.state === 'proposed') {
        value.actionExecution.state = 'cancelled';
        if (value.calendarAction) value.calendarAction.status = 'cancelled';
      }
      return input.isFinal;
    });
    this.publish(update.value);
    if (update.result) this.schedule(id);
    return update.value;
  }

  async message(id: string, input: PostMessageRequest): Promise<MeetingRecord> {
    if (input.participantId !== 'operator') throw new DomainError(403, 'participant_not_authorized', 'This token can act only as the local operator.');
    const update = await this.store.update(id, value => {
      if (value.status === 'ended') throw new DomainError(409, 'meeting_ended', 'This meeting has ended.');
      value.operatorMessages.push({ id: randomUUID(), text: input.text, createdAt: this.iso() });
      value.revision++;
      value.updatedAt = this.iso();
      delete value.cue;
      value.correctionEpoch++;
      for (const task of value.tasks) if (task.status === 'queued') { task.status = 'cancelled'; task.error = 'An operator correction changed the assignment context. A fresh assignment is required.'; }
      if (value.actionExecution?.state === 'proposed') { value.actionExecution.state = 'cancelled'; if (value.calendarAction) value.calendarAction.status = 'cancelled'; }
    });
    this.publish(update.value);
    this.schedule(id, true);
    return update.value;
  }

  async end(id: string): Promise<MeetingRecord> {
    const update = await this.store.update(id, value => {
      if (value.status === 'ended') return false;
      value.status = 'ended'; value.updatedAt = this.iso(); value.revision++;
      if (value.actionExecution?.state === 'proposed') value.actionExecution.revision = value.revision;
      delete value.cue;
      return true;
    });
    const loop = this.loops.get(id);
    if (loop?.timer) { clearTimeout(loop.timer); delete loop.timer; }
    if (loop) loop.pending = false;
    this.publish(update.value);
    if (update.result) this.startFinalizer(id);
    return update.value;
  }

  async control(id: string, action: 'pause' | 'resume'): Promise<MeetingRecord> {
    const update = await this.store.update(id, value => {
      if (value.status === 'ended') throw new DomainError(409, 'meeting_ended', 'An ended meeting cannot resume.');
      const status = action === 'pause' ? 'paused' : 'listening';
      if (value.status === status) return;
      value.status = status; value.revision++; value.updatedAt = this.iso();
      if (value.actionExecution?.state === 'proposed') value.actionExecution.revision = value.revision;
      delete value.cue;
    });
    if (action === 'pause') {
      const loop = this.loops.get(id);
      if (loop?.timer) { clearTimeout(loop.timer); delete loop.timer; }
      if (loop) loop.pending = false;
    } else this.schedule(id);
    this.publish(update.value); return update.value;
  }

  async confirm(id: string, actionId: string, proposalVersion: number): Promise<MeetingRecord> {
    const { value, result } = await this.store.update(id, current => {
      const action = current.calendarAction; const execution = current.actionExecution;
      if (!action || action.id !== actionId || !execution) throw new DomainError(404, 'action_not_found', 'Unknown calendar proposal.');
      if (action.proposalVersion !== proposalVersion) throw new DomainError(409, 'stale_proposal', 'Review the current proposal before confirming.');
      if (execution.state === 'sent' || execution.state === 'executing') return false;
      if (execution.state === 'uncertain') throw new DomainError(409, 'send_uncertain', 'The earlier send may have succeeded. Inspect the provider before retrying.');
      if (execution.state !== 'proposed' || execution.correctionEpoch !== current.correctionEpoch || execution.revision !== current.revision) throw new DomainError(409, 'stale_proposal', 'The conversation changed. A fresh proposal is required.');
      if (!this.providers.configured.calendar) throw new DomainError(503, 'calendar_unavailable', 'Calendar is not configured; nothing was sent.');
      execution.state = 'executing'; action.status = 'confirmed';
      return true;
    });
    this.publish(value);
    if (result) {
      const run = this.executeCalendar(value).finally(() => this.actionRuns.delete(actionId));
      this.actionRuns.set(actionId, run);
    }
    return value;
  }

  private async executeCalendar(record: MeetingRecord): Promise<void> {
    const action = record.calendarAction!; const execution = record.actionExecution!;
    try {
      const receipt = await bounded(signal => this.providers.sendCalendar({ meetingId: record.id, proposal: action, idempotencyKey: execution.idempotencyKey, correctionEpoch: execution.correctionEpoch }, signal), this.options.providerTimeoutMs);
      const update = await this.store.update(record.id, value => {
        if (value.actionExecution?.idempotencyKey !== execution.idempotencyKey) return;
        value.actionExecution.state = 'sent'; value.actionExecution.receipt = receipt;
        if (value.calendarAction) value.calendarAction.status = 'sent';
      });
      this.publish(update.value);
    } catch (error) {
      const update = await this.store.update(record.id, value => {
        if (value.actionExecution?.idempotencyKey !== execution.idempotencyKey) return;
        value.actionExecution.state = 'uncertain'; value.actionExecution.error = this.errorText(error);
        if (value.calendarAction) value.calendarAction.status = 'uncertain';
      });
      this.publish(update.value);
      await this.warning(record.id, 'calendar_send_uncertain', 'Calendar send has no verified receipt. It may have succeeded; automatic retry is disabled.');
    }
  }

  private schedule(id: string, manual = false): void {
    if (this.closed) return;
    let loop = this.loops.get(id);
    if (!loop) { loop = { pending: false, lastCueAt: 0, lastJudgedRevision: -1 }; this.loops.set(id, loop); }
    loop.pending = true;
    if (manual) loop.manual = true;
    loop.firstPending ??= this.options.now();
    if (loop.inFlight) return;
    if (loop.timer) clearTimeout(loop.timer);
    const now = this.options.now();
    const delay = Math.max(0, Math.min(this.options.debounceMs, loop.firstPending + this.options.maxWaitMs - now), loop.manual ? 0 : loop.lastCueAt + this.options.cooldownMs - now);
    loop.timer = setTimeout(() => {
      delete loop!.timer;
      loop!.pending = false; delete loop!.firstPending;
      const explicit = loop!.manual === true; delete loop!.manual;
      loop!.inFlight = this.judge(id, loop!, false, explicit).catch(error => this.warning(id, 'ambient_unavailable', this.errorText(error))).finally(() => {
        delete loop!.inFlight;
        if (loop!.pending && !this.closed) this.schedule(id);
      });
    }, delay);
    loop.timer.unref();
  }

  private input(record: MeetingRecord, complete = false): AmbientInput {
    const finals = record.transcript.filter(segment => segment.isFinal);
    const recent = complete ? [...finals] : finals.slice(-24);
    // The full transcript remains durable; the judge receives only a bounded current window.
    let size = 0;
    const recentTranscript = recent.reverse().filter(segment => { size += segment.text.length; return complete || size <= 14000; }).reverse();
    const operatorMessages = record.operatorMessages.slice(-8);
    const anchor: ContextAnchor = { meetingId: record.id, revision: record.revision, correctionEpoch: record.correctionEpoch, finalCount: finals.length, capturedAt: this.options.now(), ...(finals.at(-1) ? { lastSegmentId: finals.at(-1)!.id } : {}) };
    return structuredClone({ anchor, meeting: { id: record.id, title: record.title, participants: record.participants, tasks: record.tasks.map(task => ({ id: task.id, title: task.title, status: task.status })), ...(record.calendarAction ? { calendarAction: record.calendarAction } : {}), ...(record.attendeeLabels ? { attendeeLabels: record.attendeeLabels } : {}), ...(record.summary ? { summary: record.summary } : {}) }, recentTranscript, evidence: [...recentTranscript.map(segment => ({ id: `transcript:${segment.id}:${segment.revision}`, label: segment.speaker ? `Transcript · ${segment.speaker}` : 'Transcript · unknown speaker', text: segment.text, kind: 'transcript' as const })), ...operatorMessages.map(message => ({ id: `message:${message.id}`, label: 'Authenticated operator message', text: message.text, kind: 'transcript' as const })), ...record.memoryEvidence], operatorMessages });
  }

  private async judge(id: string, loop: Loop, finalizing = false, manual = false): Promise<void> {
    const record = await this.get(id);
    if ((!finalizing && record.status !== 'listening' && !(manual && record.status === 'paused')) || (!finalizing && record.revision === loop.lastJudgedRevision)) return;
    const expectedStatus = record.status;
    if (!this.providers.configured.qm) return;
    const input = this.input(record, finalizing);
    if (finalizing) input.purpose = 'finalization';
    if (!input.recentTranscript.length && !input.operatorMessages.length) return;
    loop.lastJudgedRevision = record.revision;
    const providerJudgment = await bounded(signal => this.providers.judge(input, signal), this.options.providerTimeoutMs);
    if (providerJudgment.qmTrace) {
      await this.store.update(id, value => {
        value.providerExecutions = [...(value.providerExecutions ?? []), { ...providerJudgment.qmTrace!, inputRevision: input.anchor.revision, recordedAt: this.iso() }].slice(-100);
      });
    }
    const judgment = judgmentSchema.parse(providerJudgment);
    if (this.providers.decisionMode === 'jev-native' && judgment.kind !== 'quiet' && !providerJudgment.authorization) throw new Error('Jev-native action has no authorization receipt; the result was rejected.');
    if (finalizing && judgment.kind !== 'task') return;
    const authorized = (value: MeetingRecord): boolean => {
      const current = this.input(value, finalizing);
      if (finalizing) current.purpose = 'finalization';
      return !providerJudgment.authorization || providerJudgment.authorization.verify(current);
    };
    if (judgment.kind === 'quiet') {
      const update = await this.store.update(id, value => { if (this.fresh(value, input.anchor, expectedStatus) && authorized(value)) delete value.cue; });
      this.publish(update.value); return;
    }
    const evidence = judgment.evidenceIds.map(evidenceId => input.evidence.find(item => item.id === evidenceId));
    if (evidence.some(item => !item)) throw new Error('QM returned an unknown evidence reference; the result was rejected.');
    const grounded = evidence as Evidence[];
    if (judgment.kind === 'recall') {
      if (record.memoryQuery === judgment.query || record.lastRecallRevision === input.anchor.revision) return;
      const permitted = await this.store.update(id, value => {
        if (!this.fresh(value, input.anchor, expectedStatus) || !authorized(value)) return false;
        if (providerJudgment.authorization) value.decisionReceipts = [...(value.decisionReceipts ?? []), { receiptId: providerJudgment.authorization.receiptId, ...(providerJudgment.authorization.receipt ? { receipt: providerJudgment.authorization.receipt } : {}), revision: value.revision, kind: judgment.kind, acceptedAt: this.iso() }].slice(-100);
        return true;
      });
      if (!permitted.result) return;
      const recalled = await bounded(signal => this.providers.recall(judgment.query, signal), this.options.providerTimeoutMs);
      const update = await this.store.update(id, value => {
        if (!this.fresh(value, input.anchor, expectedStatus) || !authorized(value)) return false;
        value.memoryEvidence = recalled.filter(item => item.kind === 'memory' || item.kind === 'external').slice(0, 8);
        value.memoryQuery = judgment.query;
        value.lastRecallRevision = value.revision;
        return true;
      });
      if (update.result) { loop.lastJudgedRevision = -1; this.schedule(id, manual); }
      return;
    }
    const update = await this.store.update(id, value => {
      if (!this.fresh(value, input.anchor, expectedStatus) || !authorized(value)) return false;
      if (providerJudgment.authorization) value.decisionReceipts = [...(value.decisionReceipts ?? []), { receiptId: providerJudgment.authorization.receiptId, ...(providerJudgment.authorization.receipt ? { receipt: providerJudgment.authorization.receipt } : {}), revision: value.revision, kind: judgment.kind, acceptedAt: this.iso() }].slice(-100);
      if (judgment.kind === 'task') {
        const assignment = input.recentTranscript.find(segment => segment.id === judgment.explicitAssignmentSegmentId);
        const directAssignment = input.operatorMessages.find(message => message.id === judgment.explicitAssignmentSegmentId);
        // A first-person sentence from an unknown speaker is never a wearer commitment.
        const trustedSpeech = assignment?.speaker === 'operator' && grounded.some(item => item.id === `transcript:${assignment.id}:${assignment.revision}`);
        const trustedMessage = directAssignment && grounded.some(item => item.id === `message:${directAssignment.id}`);
        if (judgment.assignedTo === 'operator' && !trustedSpeech && !trustedMessage) throw new Error('Document work lacks an explicit operator assignment.');
        if (judgment.assignedTo === 'agent') {
          const sourceGrounded = assignment && grounded.some(item => item.id === `transcript:${assignment.id}:${assignment.revision}`);
          const sharedBasis = judgment.assignmentBasis === 'direct_agent_request' || judgment.assignmentBasis === 'agreed_shared_work';
          if ((!sourceGrounded && !trustedMessage) || !sharedBasis) throw new Error('Agent work requires a grounded assistant request or shared agreement, not an inferred wearer commitment.');
        }
        const existing = value.tasks.find(task => task.title === judgment.title && task.status !== 'cancelled');
        if (existing && (existing.status !== 'queued' || !finalizing)) return false;
        const task: Task = existing ?? { id: randomUUID(), title: judgment.title, status: 'queued' };
        if (!existing) value.tasks.push(task);
        value.taskOrigins[task.id] = { id: task.id, meetingId: id, title: task.title, instructions: judgment.instructions, origin: input.anchor, evidence: grounded, assignedTo: judgment.assignedTo, ...(judgment.assignmentBasis ? { assignmentBasis: judgment.assignmentBasis } : {}) };
      } else if (judgment.kind === 'calendar') {
        this.validateCalendar(judgment.proposal);
        if (value.actionExecution?.state === 'executing' || value.actionExecution?.state === 'uncertain') return false;
        if (value.calendarAction?.status === 'sent') {
          const previous = value.calendarAction;
          const sameAttendees = previous.attendees.map(item => item.email.toLowerCase()).sort().join('|') === judgment.proposal.attendees.map(item => item.email.toLowerCase()).sort().join('|');
          if (previous.title === judgment.proposal.title && Date.parse(previous.start) === Date.parse(judgment.proposal.start) && Date.parse(previous.end) === Date.parse(judgment.proposal.end) && sameAttendees) return false;
        }
        const action: CalendarAction = { ...judgment.proposal, id: randomUUID(), proposalVersion: (value.calendarAction?.proposalVersion ?? 0) + 1, status: 'proposed' };
        value.calendarAction = action;
        value.actionExecution = { proposalVersion: action.proposalVersion, correctionEpoch: value.correctionEpoch, revision: value.revision, state: 'proposed', idempotencyKey: randomUUID() };
      } else {
        if (!manual && this.options.now() - loop.lastCueAt < this.options.cooldownMs) return false;
        let text: string; let detail: string | undefined; let sources = grounded;
        if (judgment.kind === 'calculate') {
          const answer = calculate(judgment.expression);
          text = `${judgment.label}: ${Number(answer.toPrecision(10))}`;
          sources = [...grounded, { id: `calculation:${randomUUID()}`, label: 'Verified arithmetic', text: `${judgment.expression} = ${answer}`, kind: 'calculation' }];
        } else { text = judgment.text; detail = judgment.detail; }
        value.cue = { id: randomUUID(), text, ...(detail ? { detail } : {}), evidence: sources, revision: value.revision };
        loop.lastCueAt = this.options.now();
      }
      return true;
    });
    if (update.result) this.publish(update.value);
  }

  private fresh(value: MeetingRecord, anchor: ContextAnchor, expectedStatus: MeetingStatus = 'listening'): boolean {
    // Even one short new utterance can withdraw an assignment or change the topic.
    // A result belongs to its immutable input revision; it must never be re-stamped as current.
    return value.status === expectedStatus && value.revision === anchor.revision && value.correctionEpoch === anchor.correctionEpoch && this.options.now() - anchor.capturedAt <= this.options.providerTimeoutMs;
  }

  private validateCalendar(proposal: Omit<CalendarAction, 'id' | 'proposalVersion' | 'status'>): void {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(proposal.start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(proposal.end)) throw new Error('Calendar proposals require exact ISO date/time and offset.');
    if (!Number.isFinite(Date.parse(proposal.start)) || !(Date.parse(proposal.end) > Date.parse(proposal.start))) throw new Error('Calendar time range is invalid.');
    for (const timestamp of [proposal.start, proposal.end]) {
      const date = timestamp.slice(0, 10);
      if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Calendar date does not exist.');
    }
    new Intl.DateTimeFormat('en-US', { timeZone: proposal.timeZone }).format();
    if (!proposal.attendees.length) throw new Error('Calendar attendees must be resolved before confirmation.');
  }

  private async rollSummaries(): Promise<void> {
    if (this.closed || !this.providers.configured.qm) return;
    try {
      for (const record of await this.store.list()) {
        if (record.status === 'listening' && record.transcript.some(segment => segment.isFinal) && (!record.summary || record.summary.revision < record.revision)) void this.summarize(record.id).catch(error => this.warning(record.id, 'summary_unavailable', this.errorText(error)));
      }
    } catch { /* Individual request paths still surface storage failure. */ }
  }

  private summarize(id: string): Promise<void> {
    const running = this.summaries.get(id);
    if (running) return running;
    const promise = (async () => {
      const record = await this.get(id); const input = this.input(record, record.status === 'ended' || !record.summary);
      const summary = summaryOutputSchema.parse(await bounded(signal => this.providers.summarize(input, signal), this.options.providerTimeoutMs));
      const update = await this.store.update(id, value => {
        if (value.correctionEpoch !== input.anchor.correctionEpoch) return;
        value.summary = { ...summary, revision: input.anchor.revision, createdAt: this.iso() };
      });
      this.publish(update.value);
    })().finally(() => this.summaries.delete(id));
    this.summaries.set(id, promise); return promise;
  }

  private startFinalizer(id: string): void {
    if (this.finalizers.has(id)) return;
    const run = this.finalize(id).catch(error => this.warning(id, 'finalization_failed', this.errorText(error))).finally(() => this.finalizers.delete(id));
    this.finalizers.set(id, run);
  }

  private async finalize(id: string): Promise<void> {
    // Let a rolling summary finish, then summarize the fully flushed durable final state.
    await this.summaries.get(id)?.catch(() => undefined);
    const claimed = await this.store.update(id, value => {
      if (value.finalization.state !== 'not_started') return false;
      value.finalization = { state: 'running' }; return true;
    });
    if (!claimed.result) {
      // The summary may already have a receipt while document tasks are still safely queued.
      // Only never-started tasks resume; running work was marked uncertain/failed by recovery.
      if (claimed.value.finalization.state !== 'running') await this.executeQueuedTasks(id);
      return;
    }
    this.publish(claimed.value);
    const ambientLoop = this.loops.get(id);
    await ambientLoop?.inFlight?.catch(() => undefined);
    if (this.providers.configured.qm) {
      try { await this.judge(id, ambientLoop ?? { pending: false, lastCueAt: 0, lastJudgedRevision: -1 }, true); }
      catch (error) { await this.warning(id, 'final_assignment_unavailable', this.errorText(error)); }
    }
    try {
      await this.summarize(id);
      const record = await this.get(id);
      if (!record.summary) throw new Error('QM final summary is unavailable.');
      const receipt = await bounded(signal => this.providers.saveSummary({ meetingId: id, title: record.title, summary: record.summary!, transcript: record.transcript.filter(segment => segment.isFinal) }, signal), this.options.providerTimeoutMs);
      const update = await this.store.update(id, value => { value.finalization = { state: 'completed', receipt }; });
      this.publish(update.value);
    } catch (error) {
      const update = await this.store.update(id, value => { value.finalization = { state: 'failed', error: this.errorText(error) }; });
      this.publish(update.value);
      await this.warning(id, 'finalization_unavailable', this.errorText(error));
    }
    // Accepted document work is independent of microphone state and GBrain availability.
    await this.executeQueuedTasks(id);
  }

  private async executeQueuedTasks(id: string): Promise<void> {
    const checked = await this.store.update(id, value => {
      const finalCount = value.transcript.filter(segment => segment.isFinal).length;
      for (const task of value.tasks) {
        if (task.status !== 'queued') continue;
        const origin = value.taskOrigins[task.id]?.origin;
        if (!origin || origin.correctionEpoch !== value.correctionEpoch || origin.finalCount !== finalCount) {
          task.status = 'cancelled';
          task.error = 'The conversation changed after this assignment, and the final judgment did not reaffirm it.';
        }
      }
    });
    this.publish(checked.value);
    await Promise.all(checked.value.tasks.filter(task => task.status === 'queued').map(task => this.executeTask(id, task.id)));
  }

  private async executeTask(id: string, taskId: string): Promise<void> {
    const claimed = await this.store.update(id, value => {
      const task = value.tasks.find(item => item.id === taskId);
      if (!task || task.status !== 'queued') return false;
      task.status = 'running'; return true;
    });
    if (!claimed.result) return;
    this.publish(claimed.value);
    try {
      const result = await bounded(signal => this.providers.prepareDocument(claimed.value.taskOrigins[taskId]!, signal), Math.max(this.options.providerTimeoutMs, 120000));
      if (!result.content && !result.url) throw new Error('QM returned no document artifact.');
      let artifactPath: string | undefined;
      if (result.content) {
        const directory = join(dirname(this.store.directory), 'artifacts', id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        artifactPath = join(directory, `${taskId}.md`);
        const temporary = `${artifactPath}.${randomUUID()}.tmp`;
        await writeFile(temporary, result.content, { mode: 0o600, flag: 'wx' });
        await rename(temporary, artifactPath);
      }
      const update = await this.store.update(id, value => {
        const task = value.tasks.find(item => item.id === taskId)!;
        task.status = 'completed'; if (result.content) task.content = result.content; if (result.url) task.url = result.url;
        value.taskOrigins[taskId]!.receipt = result.receipt;
        if (artifactPath) value.taskOrigins[taskId]!.artifactPath = artifactPath;
      });
      this.publish(update.value);
    } catch (error) {
      const update = await this.store.update(id, value => { const task = value.tasks.find(item => item.id === taskId)!; task.status = 'failed'; task.error = this.errorText(error); });
      this.publish(update.value);
    }
  }

  private async warning(id: string, code: string, message: string): Promise<void> {
    const update = await this.store.update(id, value => {
      value.warnings = [...value.warnings.filter(item => item.code !== code), { code, message, createdAt: this.iso() }].slice(-12);
    });
    this.emit('event', { type: 'error', meetingId: id, payload: { code, message } } satisfies ServerEvent);
    this.publish(update.value);
  }
  private publish(value: MeetingRecord): void { this.emit('event', { type: 'snapshot', meetingId: value.id, payload: structuredClone(value) } satisfies ServerEvent); }
  private iso(): string { return new Date(this.options.now()).toISOString(); }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : 'Provider operation failed'; }

  async waitForIdle(id: string): Promise<void> {
    for (let count = 0; count < 1000; count++) {
      const loop = this.loops.get(id);
      const runs = [loop?.inFlight, this.finalizers.get(id), this.summaries.get(id), ...this.actionRuns.values()].filter(Boolean) as Promise<void>[];
      if (runs.length) await Promise.allSettled(runs);
      else if (loop?.timer) await new Promise(resolve => setTimeout(resolve, 5));
      else return;
    }
    throw new Error('Controller did not settle');
  }

  async close(): Promise<void> {
    this.closed = true; clearInterval(this.interval);
    for (const loop of this.loops.values()) { if (loop.timer) clearTimeout(loop.timer); loop.pending = false; }
    await Promise.allSettled([...this.loops.values()].flatMap(loop => loop.inFlight ? [loop.inFlight] : []).concat([...this.finalizers.values()], [...this.summaries.values()], [...this.actionRuns.values()]));
  }
}
