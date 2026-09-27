import { z } from 'zod';
import { calendarActionSchema, meetingSummarySchema, type Evidence, type MeetingSnapshot, type MeetingSummary, type CalendarAction } from '../shared/contracts.js';

const referenceIds = z.array(z.string().min(1)).max(12);
const grounded = { evidenceIds: referenceIds.min(1) };
/** The judgment is a decision, not an unconstrained executable tool call. */
export const judgmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quiet'), reason: z.string().max(300) }),
  z.object({ kind: z.literal('recall'), query: z.string().min(1).max(500), ...grounded }),
  z.object({ kind: z.literal('calculate'), expression: z.string().min(1).max(160), label: z.string().min(1).max(100), ...grounded }),
  z.object({ kind: z.literal('cue'), text: z.string().min(1).max(180), detail: z.string().max(1200).optional(), topic: z.string().min(1).max(120), ...grounded }),
  z.object({ kind: z.literal('task'), title: z.string().min(1).max(160), instructions: z.string().min(1).max(2000), assignedTo: z.enum(['agent', 'operator']), assignmentBasis: z.enum(['direct_agent_request', 'agreed_shared_work', 'wearer_commitment']).optional(), explicitAssignmentSegmentId: z.string().min(1), ...grounded }),
  z.object({ kind: z.literal('calendar'), proposal: calendarActionSchema.omit({ id: true, proposalVersion: true, status: true }), ...grounded }),
]);
export type Judgment = z.infer<typeof judgmentSchema>;
export interface QmExecutionTrace { runId: string; requestedModel: string; elapsedMs: number; stage: 'judge' }
export type ProviderJudgment = Judgment & { qmTrace?: QmExecutionTrace; authorization?: { receiptId: string; receipt?: unknown; verify(current: AmbientInput): boolean } };
export const summaryOutputSchema = meetingSummarySchema.omit({ revision: true, createdAt: true });
export type SummaryOutput = z.infer<typeof summaryOutputSchema>;

export interface ContextAnchor {
  meetingId: string;
  revision: number;
  correctionEpoch: number;
  lastSegmentId?: string;
  finalCount: number;
  capturedAt: number;
}
export interface AmbientInput {
  purpose?: 'ambient' | 'finalization';
  anchor: ContextAnchor;
  meeting: Pick<MeetingSnapshot, 'id' | 'title' | 'participants' | 'summary'> & { attendeeLabels?: string[]; tasks?: MeetingSnapshot['tasks']; calendarAction?: MeetingSnapshot['calendarAction'] };
  evidence: Evidence[];
  recentTranscript: MeetingSnapshot['transcript'];
  operatorMessages: { id: string; text: string; createdAt: string }[];
}
export interface TaskInput {
  id: string;
  meetingId: string;
  title: string;
  instructions: string;
  origin: ContextAnchor;
  evidence: Evidence[];
  assignedTo?: 'agent' | 'operator';
  assignmentBasis?: 'direct_agent_request' | 'agreed_shared_work' | 'wearer_commitment';
}
export interface ProviderReceipt { id: string; url?: string; detail?: string }
export interface AmbientProviders {
  mode: 'live' | 'fixture' | 'unconfigured';
  decisionMode?: 'jev-native' | 'qm-only';
  configured: { qm: boolean; gbrain: boolean; calendar: boolean };
  judge(input: AmbientInput, signal: AbortSignal): Promise<ProviderJudgment>;
  summarize(input: AmbientInput, signal: AbortSignal): Promise<SummaryOutput>;
  recall(query: string, signal: AbortSignal): Promise<Evidence[]>;
  saveSummary(input: { meetingId: string; title: string; summary: MeetingSummary; transcript: MeetingSnapshot['transcript'] }, signal: AbortSignal): Promise<ProviderReceipt>;
  prepareDocument(input: TaskInput, signal: AbortSignal): Promise<{ content?: string; url?: string; receipt: ProviderReceipt }>;
  sendCalendar(input: { meetingId: string; proposal: CalendarAction; idempotencyKey: string; correctionEpoch: number }, signal: AbortSignal): Promise<ProviderReceipt>;
}

export class ProviderUnavailableError extends Error {
  readonly code = 'provider_unavailable';
  constructor(public readonly provider: string) { super(`${provider} is not configured. No provider result was generated.`); }
}

export function unavailableProviders(): AmbientProviders {
  return {
    mode: 'unconfigured', configured: { qm: false, gbrain: false, calendar: false },
    judge: async () => { throw new ProviderUnavailableError('QM'); },
    summarize: async () => { throw new ProviderUnavailableError('QM'); },
    recall: async () => { throw new ProviderUnavailableError('GBrain'); },
    saveSummary: async () => { throw new ProviderUnavailableError('GBrain'); },
    prepareDocument: async () => { throw new ProviderUnavailableError('QM'); },
    sendCalendar: async () => { throw new ProviderUnavailableError('Calendar'); },
  };
}

export async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(new Error('Provider timed out; result unavailable')); }, timeoutMs);
  });
  try { return await Promise.race([operation(abort.signal), timeout]); }
  finally { clearTimeout(timer!); }
}

/** Arithmetic-only parser. Never eval model-provided expressions. */
export function calculate(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+*/%-]/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s/g, '') || tokens.length > 64) throw new Error('Unsupported calculation');
  let at = 0;
  function primary(): number {
    const token = tokens[at++];
    if (token === '-') return -primary();
    if (token === '+') return primary();
    if (token === '(') { const value = addition(); if (tokens[at++] !== ')') throw new Error('Unbalanced calculation'); return value; }
    if (!token || !/^\d/.test(token)) throw new Error('Invalid calculation');
    return Number(token);
  }
  function multiplication(): number {
    let value = primary();
    while (tokens[at] === '*' || tokens[at] === '/' || tokens[at] === '%') {
      const op = tokens[at++]; const right = primary();
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }
  function addition(): number {
    let value = multiplication();
    while (tokens[at] === '+' || tokens[at] === '-') { const op = tokens[at++]; const right = multiplication(); value = op === '+' ? value + right : value - right; }
    return value;
  }
  const result = addition();
  if (at !== tokens.length || !Number.isFinite(result)) throw new Error('Invalid calculation');
  return result;
}
