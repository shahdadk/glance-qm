import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppendTranscriptRequest, CalendarAction, CreateMeetingRequest, Evidence, MeetingSnapshot, MeetingStatus, PostMessageRequest, ServerEvent, Task } from '../shared/contracts.js';
import { evidenceSchema } from '../shared/contracts.js';
import { SnapshotStore } from './store.js';
import { bounded, calculate, judgmentSchema, ProviderUnavailableError, summaryOutputSchema, type AmbientInput, type AmbientProviders, type ContextAnchor, type Judgment, type ProviderReceipt, type QmExecutionTrace, type TaskInput } from './providers.js';

export class DomainError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
type TaskOrigin = TaskInput & { generation?: number; assignmentEvidenceIds?: string[]; receipt?: ProviderReceipt; artifactPath?: string; artifactDigest?: string; reviewedContextDigest?: string; reviewedAt?: string };
interface ActionExecution {
  proposalVersion: number;
  correctionEpoch: number;
  revision: number;
  contextRevision?: number;
  contextDigest?: string;
  state: 'proposed' | 'executing' | 'sent' | 'uncertain' | 'cancelled';
  idempotencyKey: string;
  receipt?: ProviderReceipt;
  error?: string;
}
export interface MeetingRecord extends MeetingSnapshot {
  correctionEpoch: number;
  contextRevision?: number;
  summaryContextDigest?: string;
  operatorMessages: { id: string; text: string; createdAt: string }[];
  taskOrigins: Record<string, TaskOrigin>;
  memoryEvidence: Evidence[];
  memoryQuery?: string;
  lastRecallRevision?: number;
  externalEvidence?: Evidence[];
  researchQuery?: string;
  lastResearchRevision?: number;
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
  immediate?: boolean;
}
interface PartialPrefetch {
  pending?: { segmentId: string; text: string; revision: number; epoch: number; readyAt: number; key: string };
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  abort?: AbortController;
  activeEpoch?: number;
  lastKey?: string;
  budgetContext?: number;
  attempts?: number;
  cached?: { segmentId: string; text: string; epoch: number; evidence: Evidence[] };
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
  private taskRuns = new Map<string, Promise<void>>();
  private prefetches = new Map<string, PartialPrefetch>();
  private interval: ReturnType<typeof setInterval>;
  private closed = false;
  private options: Required<Omit<ControllerOptions, 'providers' | 'directory'>>;

  constructor(options: ControllerOptions) {
    super();
    this.store = new SnapshotStore(options.directory);
    this.providers = options.providers;
    this.options = { debounceMs: options.debounceMs ?? 450, maxWaitMs: options.maxWaitMs ?? 2000, cooldownMs: options.cooldownMs ?? 8000, providerTimeoutMs: options.providerTimeoutMs ?? 25000, summaryIntervalMs: options.summaryIntervalMs ?? 30000, now: options.now ?? Date.now };
    this.interval = setInterval(() => { void this.rollSummaries(); }, this.options.summaryIntervalMs);
    this.interval.unref();
  }

  /** Recover receipts conservatively: ambiguous external work is never retried automatically. */
  async recover(): Promise<void> {
    for (const record of await this.store.list()) {
      await this.store.update(record.id, value => { this.ensureContext(value); });
      if (record.actionExecution?.state === 'executing' || record.deliveryAction?.status === 'sending' || record.finalization.state === 'running' || record.tasks.some(task => task.status === 'running')) {
        await this.store.update(record.id, value => {
          if (value.actionExecution?.state === 'executing') {
            value.actionExecution.state = 'uncertain';
            value.actionExecution.error = 'Server restarted during send; verify the provider receipt before retrying.';
            if (value.calendarAction) value.calendarAction.status = 'uncertain';
          }
          if (value.finalization.state === 'running') value.finalization = { state: 'failed', error: 'Server restarted during finalization; no blind retry performed.' };
          if (value.deliveryAction?.status === 'sending') { value.deliveryAction.status = 'uncertain'; value.deliveryAction.providerError = 'Server restarted during delivery; verify the provider receipt before retrying.'; }
          for (const task of value.tasks) if (task.status === 'running') { task.status = 'failed'; task.error = 'Server restarted during QM work; inspect its durable run before retrying.'; }
        });
      }
      if (record.status === 'listening' && record.transcript.some(segment => segment.isFinal)) this.schedule(record.id);
      if (record.status === 'ended') this.startFinalizer(record.id);
      else for (const task of record.tasks) if (task.status === 'queued' && record.taskOrigins[task.id]?.assignedTo === 'agent') this.startTask(record.id, task.id);
    }
  }

  async create(input: CreateMeetingRequest): Promise<MeetingRecord> {
    const timestamp = this.iso();
    const value: MeetingRecord = {
      id: randomUUID(), title: input.title, status: 'listening', revision: 0,
      participants: [{ id: 'operator', name: 'You', role: 'owner', joinedAt: timestamp }],
      transcript: [], tasks: [], createdAt: timestamp, updatedAt: timestamp,
      correctionEpoch: 0, contextRevision: 0, operatorMessages: [], taskOrigins: {}, memoryEvidence: [], externalEvidence: [],
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

  finalizedContext(record: MeetingRecord): { revision: number; digest: string } { return { revision: this.contextRevision(record), digest: this.contextDigest(record) }; }

  async updateDelivery(id: string, mutate: (record: MeetingRecord) => void | Promise<void>): Promise<MeetingRecord> {
    const update = await this.store.update(id, mutate);
    this.publish(update.value);
    if (update.value.deliveryAction) this.emit('event', { type: 'delivery', meetingId: id, payload: { deliveryAction: update.value.deliveryAction } } satisfies ServerEvent);
    return update.value;
  }

  async task(id: string, taskId: string) {
    const record = await this.get(id); const task = record.tasks.find(item => item.id === taskId); const origin = record.taskOrigins[taskId];
    if (!task || !origin) throw new DomainError(404, 'task_not_found', 'Unknown document task.');
    return { task, generation: origin.generation ?? 1, contextRevision: this.contextRevision(record), contextDigest: this.contextDigest(record), origin: origin.origin, evidence: origin.evidence, assignmentEvidenceIds: origin.assignmentEvidenceIds ?? [], artifactDigest: origin.artifactDigest, receipt: origin.receipt };
  }

  async cancelTask(id: string, taskId: string): Promise<MeetingRecord> {
    const update = await this.store.update(id, value => { this.cancelTaskValue(value, taskId); });
    this.publish(update.value); return update.value;
  }

  async reviewTask(id: string, taskId: string, generation: number, contextDigest: string): Promise<MeetingRecord> {
    const update = await this.store.update(id, value => {
      const task = value.tasks.find(item => item.id === taskId); const origin = value.taskOrigins[taskId];
      if (!task || !origin) throw new DomainError(404, 'task_not_found', 'Unknown document task.');
      if ((origin.generation ?? 1) !== generation || contextDigest !== this.contextDigest(value)) throw new DomainError(409, 'stale_task_review', 'The document or context changed; review the latest artifact.');
      if (task.status !== 'review_required' || (!task.content && !task.url)) throw new DomainError(409, 'task_not_reviewable', 'This task has no artifact awaiting review.');
      task.status = 'completed'; task.contextDigest = contextDigest; delete task.error; origin.reviewedContextDigest = contextDigest; origin.reviewedAt = this.iso();
    });
    this.publish(update.value); return update.value;
  }

  private cancelTaskValue(value: MeetingRecord, taskId: string): void {
    const task = value.tasks.find(item => item.id === taskId); const origin = value.taskOrigins[taskId];
    if (!task || !origin) throw new DomainError(404, 'task_not_found', 'Unknown document task.');
    if (task.status === 'cancelled') return;
    origin.generation = (origin.generation ?? 1) + 1;
    task.generation = origin.generation;
    task.status = 'cancelled'; task.error = 'Request withdrawn. Any earlier running result is superseded.';
    if (value.deliveryAction?.status === 'proposed' && value.deliveryAction.taskId === taskId) value.deliveryAction.status = 'cancelled';
  }

  private holdCompletedTasks(value: MeetingRecord): void {
    if (value.deliveryAction?.status === 'proposed') value.deliveryAction.status = 'cancelled';
    for (const task of value.tasks) if (task.status === 'completed' || task.status === 'review_required') {
      task.status = 'review_required'; task.contextDigest = this.contextDigest(value); task.error = 'The conversation changed after this draft was prepared. Review it before using or sending it.';
    }
  }

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
      this.ensureContext(value);
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
          value.externalEvidence = [];
          delete value.researchQuery; delete value.lastResearchRevision;
          delete value.memoryQuery;
          for (const task of value.tasks) if (task.status === 'queued') { task.status = 'cancelled'; task.error = 'A transcript correction changed the assignment context. A fresh assignment is required.'; }
        }
      }
      const segment = { id: input.segmentId, text: input.text, isFinal: input.isFinal, revision: input.revision, ...(input.speaker ? { speaker: input.speaker } : {}), capturedAt: this.iso() };
      if (previous) value.transcript[value.transcript.indexOf(previous)] = segment;
      else value.transcript.push(segment);
      value.revision++;
      if (input.isFinal) value.contextRevision!++;
      if (input.isFinal) this.holdCompletedTasks(value);
      value.updatedAt = this.iso();
      if (input.isFinal) delete value.cue;
      if (input.isFinal && value.actionExecution?.state === 'proposed') {
        value.actionExecution.state = 'cancelled';
        if (value.calendarAction) value.calendarAction.status = 'cancelled';
      }
      return input.isFinal;
    });
    this.publish(update.value);
    const prefetch = this.prefetches.get(id);
    if (prefetch?.cached && prefetch.cached.epoch !== update.value.correctionEpoch) delete prefetch.cached;
    if ((prefetch?.pending && prefetch.pending.epoch !== update.value.correctionEpoch) || (prefetch?.activeEpoch !== undefined && prefetch.activeEpoch !== update.value.correctionEpoch)) this.stopPrefetch(id);
    if (!input.isFinal) this.schedulePrefetch(update.value, input.segmentId);
    if (update.result) this.schedule(id);
    return update.value;
  }

  async message(id: string, input: PostMessageRequest): Promise<MeetingRecord> {
    if (input.participantId !== 'operator') throw new DomainError(403, 'participant_not_authorized', 'This token can act only as the local operator.');
    const update = await this.store.update(id, value => {
      if (value.status === 'ended') throw new DomainError(409, 'meeting_ended', 'This meeting has ended.');
      this.ensureContext(value);
      value.operatorMessages.push({ id: randomUUID(), text: input.text, createdAt: this.iso() });
      value.revision++;
      value.contextRevision!++;
      value.updatedAt = this.iso();
      delete value.cue;
      value.correctionEpoch++;
      value.externalEvidence = []; delete value.researchQuery; delete value.lastResearchRevision;
      this.holdCompletedTasks(value);
      for (const task of value.tasks) if (task.status === 'queued') { task.status = 'cancelled'; task.error = 'An operator correction changed the assignment context. A fresh assignment is required.'; }
      if (value.actionExecution?.state === 'proposed') { value.actionExecution.state = 'cancelled'; if (value.calendarAction) value.calendarAction.status = 'cancelled'; }
    });
    this.publish(update.value);
    this.stopPrefetch(id);
    this.schedule(id, true);
    return update.value;
  }

  async end(id: string): Promise<MeetingRecord> {
    const update = await this.store.update(id, value => {
      if (value.status === 'ended') return false;
      this.ensureContext(value);
      value.status = 'ended'; value.updatedAt = this.iso(); value.revision++;
      delete value.cue;
      return true;
    });
    const loop = this.loops.get(id);
    if (loop?.timer) { clearTimeout(loop.timer); delete loop.timer; }
    if (loop) loop.pending = false;
    this.stopPrefetch(id);
    this.publish(update.value);
    if (update.result) this.startFinalizer(id);
    return update.value;
  }

  async control(id: string, action: 'pause' | 'resume'): Promise<MeetingRecord> {
    const update = await this.store.update(id, value => {
      if (value.status === 'ended') throw new DomainError(409, 'meeting_ended', 'An ended meeting cannot resume.');
      this.ensureContext(value);
      const status = action === 'pause' ? 'paused' : 'listening';
      if (value.status === status) return;
      value.status = status; value.revision++; value.updatedAt = this.iso();
    });
    if (action === 'pause') {
      // Pausing the microphone does not withdraw speech already committed. The
      // existing single-flight loop drains that context once, without new capture.
      if (update.value.transcript.some(segment => segment.isFinal) || update.value.operatorMessages.length) this.schedule(id, true);
    } else {
      const loop = this.loops.get(id);
      if (loop) loop.lastJudgedRevision = -1;
      this.schedule(id);
    }
    this.publish(update.value); return update.value;
  }

  async confirm(id: string, actionId: string, proposalVersion: number): Promise<MeetingRecord> {
    const { value, result } = await this.store.update(id, current => {
      this.ensureContext(current);
      const action = current.calendarAction; const execution = current.actionExecution;
      if (!action || action.id !== actionId || !execution) throw new DomainError(404, 'action_not_found', 'Unknown calendar proposal.');
      if (action.proposalVersion !== proposalVersion) throw new DomainError(409, 'stale_proposal', 'Review the current proposal before confirming.');
      if (execution.state === 'sent' || execution.state === 'executing') return false;
      if (execution.state === 'uncertain') throw new DomainError(409, 'send_uncertain', 'The earlier send may have succeeded. Inspect the provider before retrying.');
      const sameContext = execution.contextDigest !== undefined
        ? execution.contextDigest === this.contextDigest(current) && execution.contextRevision === this.contextRevision(current)
        : execution.revision === current.revision;
      if (execution.state !== 'proposed' || execution.correctionEpoch !== current.correctionEpoch || !sameContext) throw new DomainError(409, 'stale_proposal', 'The conversation changed. A fresh proposal is required.');
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

  private schedule(id: string, manual = false, immediate = false): void {
    if (this.closed) return;
    let loop = this.loops.get(id);
    if (!loop) { loop = { pending: false, lastCueAt: 0, lastJudgedRevision: -1 }; this.loops.set(id, loop); }
    loop.pending = true;
    if (manual) loop.manual = true;
    if (immediate) loop.immediate = true;
    loop.firstPending ??= this.options.now();
    if (loop.inFlight) return;
    if (loop.timer) clearTimeout(loop.timer);
    const now = this.options.now();
    // Attention pacing applies at cue publication, never to background retrieval.
    const delay = loop.immediate ? 0 : Math.max(0, Math.min(this.options.debounceMs, loop.firstPending + this.options.maxWaitMs - now));
    loop.timer = setTimeout(() => {
      delete loop!.timer;
      loop!.pending = false; delete loop!.firstPending;
      const explicit = loop!.manual === true; delete loop!.manual;
      delete loop!.immediate;
      loop!.inFlight = this.judge(id, loop!, false, explicit).catch(error => this.warning(id, 'ambient_unavailable', this.errorText(error))).finally(() => {
        delete loop!.inFlight;
        if (loop!.pending && !this.closed) this.schedule(id);
      });
    }, delay);
    loop.timer.unref();
  }

  private normalizedPartial(text: string): string { return text.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[.!?,;:]+$/, ''); }

  private compatiblePartial(finalText: string, partialText: string): boolean {
    const final = this.normalizedPartial(finalText); const partial = this.normalizedPartial(partialText);
    // Never reuse a shorter literal identity as a prefix of a different name
    // (for example a synthetic "Doe" becoming "Doerr"). Final Jev still rechecks relevance.
    return final === partial || (final.startsWith(partial) && /^[\s.,!?;:—–-]/.test(final.slice(partial.length)));
  }

  private prefetchedEvidence(record: MeetingRecord): Evidence[] {
    const cached = this.prefetches.get(record.id)?.cached;
    if (!cached || cached.epoch !== record.correctionEpoch) return [];
    const final = record.transcript.find(segment => segment.id === cached.segmentId && segment.isFinal);
    return final && this.compatiblePartial(final.text, cached.text) ? cached.evidence : [];
  }

  private stopPrefetch(id: string): void {
    const state = this.prefetches.get(id);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.abort?.abort(); delete state.pending; delete state.cached; delete state.timer;
  }

  private schedulePrefetch(record: MeetingRecord, segmentId: string): void {
    if (!this.providers.prefetch || this.closed || record.status !== 'listening') return;
    const segment = record.transcript.find(item => item.id === segmentId && !item.isFinal);
    if (!segment || !this.normalizedPartial(segment.text)) return;
    let state = this.prefetches.get(record.id);
    if (!state) { state = {}; this.prefetches.set(record.id, state); }
    if (state.budgetContext !== this.contextRevision(record)) { state.budgetContext = this.contextRevision(record); state.attempts = 0; }
    const key = `${record.correctionEpoch}:${segment.id}:${this.normalizedPartial(segment.text)}`;
    if (state.pending?.key === key || state.lastKey === key) return;
    state.abort?.abort();
    if (state.timer) clearTimeout(state.timer);
    if ((state.attempts ?? 0) >= 6) { delete state.pending; delete state.timer; return; }
    state.pending = { segmentId, text: segment.text, revision: segment.revision, epoch: record.correctionEpoch, readyAt: this.options.now() + 200, key };
    this.armPrefetch(record.id, state);
  }

  private armPrefetch(id: string, state: PartialPrefetch): void {
    if (this.closed || state.inFlight || !state.pending) return;
    state.timer = setTimeout(() => {
      delete state.timer;
      const attempt = state.pending!; delete state.pending;
      state.attempts = (state.attempts ?? 0) + 1;
      state.lastKey = attempt.key; state.abort = new AbortController();
      state.activeEpoch = attempt.epoch;
      const abort = state.abort;
      state.inFlight = (async () => {
        const record = await this.get(id);
        if (record.status === 'ended' || record.correctionEpoch !== attempt.epoch || abort.signal.aborted) return;
        const input = this.input(record);
        const sources = evidenceSchema.array().parse(await bounded(signal => this.providers.prefetch!({ ...input, partialTranscript: [{ id: attempt.segmentId, text: attempt.text, revision: attempt.revision, isFinal: false, capturedAt: this.iso() }] }, AbortSignal.any([signal, abort.signal])), 4000));
        const latest = await this.get(id);
        const segment = latest.transcript.find(item => item.id === attempt.segmentId);
        if (abort.signal.aborted || latest.status === 'ended' || latest.correctionEpoch !== attempt.epoch || !segment) return;
        const compatible = segment.isFinal ? this.compatiblePartial(segment.text, attempt.text) : this.normalizedPartial(segment.text) === this.normalizedPartial(attempt.text);
        if (!compatible) return;
        state.cached = { segmentId: attempt.segmentId, text: attempt.text, epoch: attempt.epoch, evidence: sources.filter(item => item.kind === 'external').slice(0, 4) };
        if (segment.isFinal && state.cached.evidence.length) {
          const loop = this.loops.get(id); if (loop) loop.lastJudgedRevision = -1;
          this.schedule(id, latest.status === 'paused', true);
        }
      })().catch(() => { /* Speculation has no user-visible facts; normal final judgment remains authoritative. */ }).finally(() => {
        delete state.inFlight; delete state.abort; delete state.activeEpoch;
        if (state.pending) this.armPrefetch(id, state);
      });
    }, Math.max(0, state.pending.readyAt - this.options.now()));
    state.timer.unref();
  }

  private input(record: MeetingRecord, complete = false): AmbientInput {
    const finals = record.transcript.filter(segment => segment.isFinal);
    const recent = complete ? [...finals] : finals.slice(-24);
    // The full transcript remains durable; the judge receives only a bounded current window.
    let size = 0;
    const recentTranscript = recent.reverse().filter(segment => { size += segment.text.length; return complete || size <= 14000; }).reverse();
    const operatorMessages = record.operatorMessages.slice(-8);
    const anchor: ContextAnchor = { meetingId: record.id, revision: record.revision, contextRevision: this.contextRevision(record), contextDigest: this.contextDigest(record), correctionEpoch: record.correctionEpoch, finalCount: finals.length, capturedAt: this.options.now(), ...(finals.at(-1) ? { lastSegmentId: finals.at(-1)!.id } : {}) };
    const sources = [...record.memoryEvidence, ...(record.externalEvidence ?? []), ...this.prefetchedEvidence(record)].filter((item, index, items) => items.findIndex(other => other.id === item.id) === index);
    return structuredClone({ anchor, meeting: { id: record.id, title: record.title, participants: record.participants, tasks: record.tasks.map(task => ({ id: task.id, title: task.title, status: task.status })), ...(record.calendarAction ? { calendarAction: record.calendarAction } : {}), ...(record.attendeeLabels ? { attendeeLabels: record.attendeeLabels } : {}), ...(record.summary ? { summary: record.summary } : {}) }, recentTranscript, evidence: [...recentTranscript.map(segment => ({ id: `transcript:${segment.id}:${segment.revision}`, label: segment.speaker ? `Transcript · ${segment.speaker}` : 'Transcript · unknown speaker', text: segment.text, kind: 'transcript' as const })), ...operatorMessages.map(message => ({ id: `message:${message.id}`, label: 'Authenticated operator message', text: message.text, kind: 'transcript' as const })), ...sources], operatorMessages });
  }

  private async judge(id: string, loop: Loop, finalizing = false, manual = false): Promise<void> {
    const record = await this.get(id);
    if ((!finalizing && record.status !== 'listening' && !(manual && record.status === 'paused')) || (!finalizing && this.contextRevision(record) === loop.lastJudgedRevision)) return;
    const expectedStatus = record.status;
    if (!this.providers.configured.qm) return;
    const input = this.input(record, finalizing);
    const usedPrefetchedSources = this.prefetchedEvidence(record).length > 0;
    if (finalizing) input.purpose = 'finalization';
    if (!input.recentTranscript.length && !input.operatorMessages.length) return;
    loop.lastJudgedRevision = this.contextRevision(record);
    const providerJudgment = await bounded(signal => this.providers.judge(input, signal), this.options.providerTimeoutMs);
    if (providerJudgment.qmTrace) {
      await this.store.update(id, value => {
        value.providerExecutions = [...(value.providerExecutions ?? []), { ...providerJudgment.qmTrace!, inputRevision: input.anchor.revision, recordedAt: this.iso() }].slice(-100);
      });
    }
    const judgment = judgmentSchema.parse(providerJudgment);
    if (this.providers.decisionMode === 'jev-native' && judgment.kind !== 'quiet' && !providerJudgment.authorization) throw new Error('Jev-native action has no authorization receipt; the result was rejected.');
    if (judgment.kind !== 'quiet' && usedPrefetchedSources && !providerJudgment.authorization) throw new Error('Prefetched public context requires a fresh final-context Jev receipt; the result was rejected.');
    if (finalizing && judgment.kind !== 'task' && judgment.kind !== 'cancel_task') return;
    const authorized = (value: MeetingRecord): boolean => {
      const current = this.input(value, finalizing);
      if (finalizing) current.purpose = 'finalization';
      // Jev still verifies every semantic input field. Only transport-only revision noise
      // is normalized, and only after the immutable finalized sources match exactly.
      if (current.anchor.contextRevision === input.anchor.contextRevision && current.anchor.contextDigest === input.anchor.contextDigest) current.anchor.revision = input.anchor.revision;
      return !providerJudgment.authorization || providerJudgment.authorization.verify(current);
    };
    if (judgment.kind === 'quiet') {
      const update = await this.store.update(id, value => { if (this.fresh(value, input.anchor, expectedStatus) && authorized(value)) delete value.cue; });
      this.publish(update.value); return;
    }
    const evidence = judgment.evidenceIds.map(evidenceId => input.evidence.find(item => item.id === evidenceId));
    if (evidence.some(item => !item)) throw new Error('QM returned an unknown evidence reference; the result was rejected.');
    const grounded = evidence as Evidence[];
    if (judgment.kind === 'recall' || judgment.kind === 'research') {
      const research = judgment.kind === 'research';
      if (research ? record.lastResearchRevision === input.anchor.contextRevision : record.memoryQuery === judgment.query || record.lastRecallRevision === input.anchor.contextRevision) return;
      const permitted = await this.store.update(id, value => {
        if (!this.fresh(value, input.anchor, expectedStatus) || !authorized(value)) return false;
        if (providerJudgment.authorization) value.decisionReceipts = [...(value.decisionReceipts ?? []), { receiptId: providerJudgment.authorization.receiptId, ...(providerJudgment.authorization.receipt ? { receipt: providerJudgment.authorization.receipt } : {}), revision: value.revision, kind: judgment.kind, acceptedAt: this.iso() }].slice(-100);
        return true;
      });
      if (!permitted.result) return;
      if (research && !this.providers.research) throw new ProviderUnavailableError('Exa public web research');
      const recalled = evidenceSchema.array().parse(await bounded(signal => research ? this.providers.research!(judgment.query, signal) : this.providers.recall(judgment.query, signal), Math.min(this.options.providerTimeoutMs, research ? 5000 : this.options.providerTimeoutMs)));
      const update = await this.store.update(id, value => {
        if (!this.fresh(value, input.anchor, expectedStatus) || !authorized(value)) return false;
        if (research) {
          value.externalEvidence = recalled.filter((item, index, items) => item.kind === 'external' && items.findIndex(candidate => candidate.id === item.id) === index).slice(0, 4);
          value.researchQuery = judgment.query;
          value.lastResearchRevision = this.contextRevision(value);
        } else {
          value.memoryEvidence = recalled.filter(item => item.kind === 'memory' || item.kind === 'external').slice(0, 8);
          value.memoryQuery = judgment.query;
          value.lastRecallRevision = this.contextRevision(value);
        }
        return true;
      });
      if (update.result) { loop.lastJudgedRevision = -1; this.schedule(id, manual || update.value.status === 'paused', true); }
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
        if (existing && existing.status !== 'queued') return false;
        const task: Task = existing ?? { id: randomUUID(), title: judgment.title, status: 'queued' };
        if (!existing) value.tasks.push(task);
        value.taskOrigins[task.id] = { id: task.id, meetingId: id, title: task.title, instructions: judgment.instructions, origin: input.anchor, evidence: this.input(value, true).evidence, assignmentEvidenceIds: judgment.evidenceIds, generation: value.taskOrigins[task.id]?.generation ?? 1, assignedTo: judgment.assignedTo, ...(judgment.assignmentBasis ? { assignmentBasis: judgment.assignmentBasis } : {}) };
        task.generation = value.taskOrigins[task.id]!.generation!; task.origin = input.anchor; task.contextDigest = input.anchor.contextDigest!;
      } else if (judgment.kind === 'cancel_task') {
        this.cancelTaskValue(value, judgment.taskId);
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
        value.actionExecution = { proposalVersion: action.proposalVersion, correctionEpoch: value.correctionEpoch, revision: input.anchor.revision, contextRevision: input.anchor.contextRevision!, contextDigest: input.anchor.contextDigest!, state: 'proposed', idempotencyKey: randomUUID() };
      } else {
        if (!manual && this.options.now() - loop.lastCueAt < this.options.cooldownMs) return false;
        let text: string; let detail: string | undefined; let sources = grounded;
        if (judgment.kind === 'calculate') {
          const answer = calculate(judgment.expression);
          text = `${judgment.label}: ${Number(answer.toPrecision(10))}`;
          sources = [...grounded, { id: `calculation:${randomUUID()}`, label: 'Verified arithmetic', text: `${judgment.expression} = ${answer}`, kind: 'calculation' }];
        } else { text = judgment.text; detail = judgment.detail; }
        value.cue = { id: randomUUID(), text, ...(detail ? { detail } : {}), evidence: sources, revision: input.anchor.revision };
        loop.lastCueAt = this.options.now();
      }
      return true;
    });
    if (update.result) {
      this.publish(update.value);
      if (judgment.kind === 'task' && judgment.assignedTo === 'agent') {
        const task = update.value.tasks.find(item => item.title === judgment.title && item.status === 'queued');
        if (task) this.startTask(id, task.id);
      }
    }
  }

  private fresh(value: MeetingRecord, anchor: ContextAnchor, expectedStatus: MeetingStatus = 'listening'): boolean {
    // Even one short new utterance can withdraw an assignment or change the topic.
    // A result belongs to its immutable input revision; it must never be re-stamped as current.
    const sameContext = anchor.contextDigest !== undefined
      ? anchor.contextDigest === this.contextDigest(value) && anchor.contextRevision === this.contextRevision(value)
      : value.revision === anchor.revision;
    const workStillAllowed = value.status === expectedStatus || (expectedStatus === 'listening' && value.status === 'paused');
    return workStillAllowed && sameContext && value.correctionEpoch === anchor.correctionEpoch && this.options.now() - anchor.capturedAt <= this.options.providerTimeoutMs;
  }

  private contextRevision(value: MeetingRecord): number { return value.contextRevision ?? value.revision; }

  private contextDigest(value: MeetingRecord): string {
    return createHash('sha256').update(JSON.stringify({ title: value.title, participants: value.participants, attendeeLabels: value.attendeeLabels ?? [], correctionEpoch: value.correctionEpoch, transcript: value.transcript.filter(segment => segment.isFinal), operatorMessages: value.operatorMessages })).digest('hex');
  }

  private ensureContext(value: MeetingRecord): void {
    if (value.contextRevision !== undefined) return;
    // Existing snapshots retain their transport revision as a conservative semantic baseline.
    // Never invent new provenance for old queued tasks or already-stale action proposals.
    value.contextRevision = value.revision;
    if (value.actionExecution?.state === 'proposed' && value.actionExecution.revision === value.revision && value.actionExecution.correctionEpoch === value.correctionEpoch) {
      value.actionExecution.contextRevision = value.contextRevision;
      value.actionExecution.contextDigest = this.contextDigest(value);
    }
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
        if (record.status === 'listening' && record.transcript.some(segment => segment.isFinal) && (!record.summary || record.summaryContextDigest !== this.contextDigest(record))) void this.summarize(record.id).catch(error => this.warning(record.id, 'summary_unavailable', this.errorText(error)));
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
        value.summaryContextDigest = input.anchor.contextDigest!;
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
        if (!origin || origin.correctionEpoch !== value.correctionEpoch || origin.finalCount !== finalCount || (origin.contextDigest !== undefined && origin.contextDigest !== this.contextDigest(value))) {
          task.status = 'cancelled';
          task.error = 'The conversation changed after this assignment, and the final judgment did not reaffirm it.';
        }
      }
    });
    this.publish(checked.value);
    for (const task of checked.value.tasks.filter(task => task.status === 'queued')) this.startTask(id, task.id);
    await Promise.all([...this.taskRuns.values()]);
  }

  private startTask(id: string, taskId: string): void {
    if (this.taskRuns.has(taskId)) return;
    const run = this.executeTask(id, taskId).catch(error => this.warning(id, 'document_task_failed', this.errorText(error))).finally(() => this.taskRuns.delete(taskId));
    this.taskRuns.set(taskId, run);
  }

  private async executeTask(id: string, taskId: string): Promise<void> {
    const claimed = await this.store.update(id, value => {
      const task = value.tasks.find(item => item.id === taskId);
      if (!task || task.status !== 'queued') return false;
      const source = value.taskOrigins[taskId];
      if (!source || source.origin.correctionEpoch !== value.correctionEpoch || source.origin.finalCount !== value.transcript.filter(segment => segment.isFinal).length || (source.origin.contextDigest !== undefined && source.origin.contextDigest !== this.contextDigest(value))) return false;
      source.generation ??= 1;
      task.status = 'running'; return true;
    });
    if (!claimed.result) return;
    this.publish(claimed.value);
    this.emit('event', { type: 'task', meetingId: id, payload: { task: claimed.value.tasks.find(task => task.id === taskId)! } } satisfies ServerEvent);
    const generation = claimed.value.taskOrigins[taskId]!.generation ?? 1;
    try {
      const result = await bounded(signal => this.providers.prepareDocument(claimed.value.taskOrigins[taskId]!, signal), Math.max(this.options.providerTimeoutMs, 120000));
      if (!result.content && !result.url) throw new Error('QM returned no document artifact.');
      let artifactPath: string | undefined;
      if (result.content) {
        const directory = join(dirname(this.store.directory), 'artifacts', id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        artifactPath = join(directory, `${taskId}-g${generation}.md`);
        const temporary = `${artifactPath}.${randomUUID()}.tmp`;
        await writeFile(temporary, result.content, { mode: 0o600, flag: 'wx' });
        await rename(temporary, artifactPath);
      }
      const update = await this.store.update(id, value => {
        const task = value.tasks.find(item => item.id === taskId)!;
        const origin = value.taskOrigins[taskId]!;
        if (task.status !== 'running' || (origin.generation ?? 1) !== generation) return;
        const stillCurrent = origin.origin.contextDigest !== undefined ? origin.origin.contextDigest === this.contextDigest(value) : origin.origin.correctionEpoch === value.correctionEpoch && origin.origin.finalCount === value.transcript.filter(segment => segment.isFinal).length;
        task.status = stillCurrent ? 'completed' : 'review_required';
        if (!stillCurrent) task.error = 'The conversation changed while this draft was being prepared. Review its original sources before using or sending it.';
        if (result.content) task.content = result.content; if (result.url) task.url = result.url;
        origin.receipt = result.receipt;
        origin.artifactDigest = createHash('sha256').update(result.content ?? result.url!).digest('hex');
        task.artifactDigest = origin.artifactDigest; task.generation = generation; task.contextDigest = this.contextDigest(value);
        if (result.evidence) origin.evidence = [...origin.evidence, ...result.evidence.filter(item => !origin.evidence.some(existing => existing.id === item.id))];
        if (artifactPath) origin.artifactPath = artifactPath;
      });
      this.publish(update.value);
    } catch (error) {
      const update = await this.store.update(id, value => { const task = value.tasks.find(item => item.id === taskId)!; if (task.status !== 'running' || (value.taskOrigins[taskId]?.generation ?? 1) !== generation) return; task.status = 'failed'; task.error = this.errorText(error); });
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
      const prefetch = this.prefetches.get(id);
      const runs = [loop?.inFlight, prefetch?.inFlight, this.finalizers.get(id), this.summaries.get(id), ...this.actionRuns.values(), ...this.taskRuns.values()].filter(Boolean) as Promise<void>[];
      if (runs.length) await Promise.allSettled(runs);
      else if (loop?.timer || prefetch?.timer) await new Promise(resolve => setTimeout(resolve, 5));
      else return;
    }
    throw new Error('Controller did not settle');
  }

  async close(): Promise<void> {
    this.closed = true; clearInterval(this.interval);
    for (const id of this.prefetches.keys()) this.stopPrefetch(id);
    for (const loop of this.loops.values()) { if (loop.timer) clearTimeout(loop.timer); loop.pending = false; }
    await Promise.allSettled([...this.loops.values()].flatMap(loop => loop.inFlight ? [loop.inFlight] : []).concat([...this.finalizers.values()], [...this.summaries.values()], [...this.actionRuns.values()], [...this.taskRuns.values()], [...this.prefetches.values()].flatMap(state => state.inFlight ? [state.inFlight] : [])));
  }
}
