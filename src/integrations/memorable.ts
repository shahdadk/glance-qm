import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { checkResponse, endpoint, IntegrationError, object, requestSignal, required, type Fetch } from './http.ts';

/**
 * Memorable is a procedural-memory store.  The integration deliberately only
 * knows about the small set of successful QM actions below.  It does not take
 * transcript text, meeting titles, participant labels, calendar addresses, or
 * provider receipts as input to the trace it sends to Memorable.
 */
export const MEMORABLE_ACTION_TYPES = ['create_document', 'send_calendar', 'save_summary'] as const;
export type MemorableActionType = (typeof MEMORABLE_ACTION_TYPES)[number];

/** Trace-only verification steps are derived from a verified provider receipt. */
export const MEMORABLE_TRACE_ACTION_TYPES = [
  'create_document',
  'verify_document',
  'send_calendar',
  'verify_calendar',
  'save_summary',
  'verify_summary',
] as const;
export type MemorableTraceActionType = (typeof MEMORABLE_TRACE_ACTION_TYPES)[number];

const ACTION_COMMANDS: Record<MemorableActionType, readonly [string, string]> = {
  create_document: ['create document', 'verify persisted document'],
  send_calendar: ['send calendar invitation', 'verify calendar invitation readback'],
  save_summary: ['save meeting summary', 'verify persisted summary revision'],
};

const VERIFICATION_ACTIONS: Record<MemorableActionType, MemorableTraceActionType> = {
  create_document: 'verify_document',
  send_calendar: 'verify_calendar',
  save_summary: 'verify_summary',
};

const SUCCESS_STATUSES = new Set(['completed', 'complete', 'sent', 'saved', 'success', 'succeeded', 'verified']);
const FAILURE_STATUSES = new Set(['failed', 'failure', 'cancelled', 'canceled', 'uncertain', 'pending', 'proposed', 'queued', 'running']);
const DEFAULT_COMMAND = 'memorable';
const DEFAULT_EXTRACTION_URL = 'https://memorable-extraction-api.memorable.workers.dev/v1/extract';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ACTIONS = 32;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_QUERY_LENGTH = 200;

export interface MemorableAction {
  /** The only action names accepted by this adapter. */
  type: MemorableActionType;
  /** Optional outcome fields are checked when supplied; they are never sent. */
  ok?: boolean;
  success?: boolean;
  verified?: boolean;
  status?: string;
  receipt?: { verified?: boolean } | undefined;
  id?: string;
}

/**
 * A workflow is intentionally abstract.  `sessionId` is hashed before it
 * leaves the process and action fields other than their allow-listed type are
 * ignored after validation.
 */
export interface MemorableWorkflow {
  sessionId: string;
  actions: readonly MemorableAction[];
}

/** Recall can use the abstract vocabulary without claiming an action happened. */
export interface MemorableRecallWorkflow {
  actions: readonly MemorableActionType[];
}

export interface MemorableTrace {
  session_id: string;
  task_description: string;
  harness: 'glance-qm';
  tool_calls: {
    name: MemorableTraceActionType;
    input: { command: string };
    result: { ok: true };
  }[];
}

export interface MemorableCommandOptions {
  /** Input is written to stdin; it is never interpolated into a shell command. */
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface MemorableCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
}

export type MemorableCommandRunner = (
  executable: string,
  args: readonly string[],
  options: MemorableCommandOptions,
) => Promise<MemorableCommandResult>;

export interface MemorableClientConfig {
  /** Absolute path or PATH name. `MEMORABLE_BIN` is used when omitted. */
  executable?: string;
  /** Alias for `executable`, useful for callers that call this a command. */
  command?: string;
  /** Alias for `executable`. */
  binary?: string;
  /** Passed to the CLI as MEMORABLE_HOME; no setup is performed by this client. */
  home?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  runner?: MemorableCommandRunner;

  /** Optional direct extraction path. This path returns a draft and never stores it. */
  extractionUrl?: string;
  extractUrl?: string;
  apiKey?: string;
  fetch?: Fetch;
}

export interface MemorableListRevision {
  slug: string;
  revision?: number;
  title?: string;
  verified?: boolean;
  [key: string]: unknown;
}

export interface MemorableListEntry {
  intent?: string;
  preferred?: string | null;
  revisions: MemorableListRevision[];
  [key: string]: unknown;
}

export type MemorableStoreResult =
  | {
      status: 'saved';
      slug: string;
      readback: MemorableListEntry;
    }
  | {
      status: 'pending' | 'unavailable';
      reason: MemorableStoreReason;
      exitCode?: number | null;
    };

export type MemorableStoreReason = 'queued' | 'rejected' | 'consent_required' | 'readback_unavailable' | 'unverified' | 'cli_failed';

export interface MemorableRecallMatch {
  slug: string;
  score?: number;
  reasons?: string[];
}

export type MemorableRecallResult =
  | {
      status: 'found';
      query: string;
      slug: string;
      matches: MemorableRecallMatch[];
      procedure: string;
    }
  | {
      status: 'none' | 'unavailable';
      query: string;
      matches: MemorableRecallMatch[];
    };

export interface MemorableDraftResult {
  draft: Record<string, unknown>;
  request_id: string;
  /** The API can return a draft alongside a refusal; it is still not stored. */
  refused?: string;
}

interface RawCommandResult extends Partial<MemorableCommandResult> {
  /** A few injected process runners use Node's `code` spelling. */
  code?: number | null;
  status?: number | null;
  exit_code?: number | null;
}

function isActionType(value: unknown): value is MemorableActionType {
  return typeof value === 'string' && (MEMORABLE_ACTION_TYPES as readonly string[]).includes(value);
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Hashes an identifier without exposing the caller's meeting/session value. */
export function memorableIdentifier(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_ID_LENGTH) throw new IntegrationError('protocol_error', 'Memorable session ID is invalid');
  return `glance-qm-${hashIdentifier(normalized)}`;
}

function successfulActionType(value: MemorableAction, index: number): MemorableActionType {
  const action = value;
  if (!action || typeof action !== 'object' || !isActionType(action.type)) {
    throw new IntegrationError('protocol_error', `Memorable action ${index + 1} is not allow-listed`);
  }

  // The adapter must receive evidence that the action really completed. A
  // type name, `ok: true`, or a status string by itself is not evidence.
  if (action.verified !== true && action.receipt?.verified !== true) {
    throw new IntegrationError('protocol_error', `Memorable action ${action.type} lacks a verified receipt`);
  }
  if (action.ok !== undefined && action.ok !== true || action.success !== undefined && action.success !== true || action.verified === false || action.receipt?.verified === false) {
    throw new IntegrationError('protocol_error', `Memorable action ${action.type} was not successful`);
  }
  if (action.status !== undefined) {
    const status = action.status.trim().toLowerCase();
    if (FAILURE_STATUSES.has(status) || !SUCCESS_STATUSES.has(status)) {
      throw new IntegrationError('protocol_error', `Memorable action ${action.type} was not verified`);
    }
  }
  return action.type;
}

function actionTypes(workflow: MemorableWorkflow): MemorableActionType[] {
  if (!workflow || typeof workflow !== 'object' || typeof workflow.sessionId !== 'string' || !Array.isArray(workflow.actions)) {
    throw new IntegrationError('protocol_error', 'Memorable workflow requires a session ID and actions');
  }
  if (workflow.actions.length === 0 || workflow.actions.length > MAX_ACTIONS) {
    throw new IntegrationError('protocol_error', 'Memorable workflow needs between one and 32 actions');
  }
  return workflow.actions.map((action, index) => successfulActionType(action, index));
}

/**
 * Builds the only trace shape this adapter is allowed to send.  The generated
 * command descriptors are deliberately abstract, so this function cannot
 * accidentally forward a transcript, attendee, file body, or secret.
 */
export function buildMemorableTrace(workflow: MemorableWorkflow): MemorableTrace {
  const types = actionTypes(workflow);
  const task = `Successful QM workflow: ${types.join(' -> ')}`;
  return {
    session_id: memorableIdentifier(workflow.sessionId),
    task_description: task.slice(0, MAX_QUERY_LENGTH),
    harness: 'glance-qm',
    tool_calls: types.flatMap(type => [
      { name: type, input: { command: ACTION_COMMANDS[type][0] }, result: { ok: true as const } },
      { name: VERIFICATION_ACTIONS[type], input: { command: ACTION_COMMANDS[type][1] }, result: { ok: true as const } },
    ]),
  };
}

function safeRecallQuery(query: string): string {
  if (typeof query !== 'string') throw new IntegrationError('protocol_error', 'Memorable recall query is invalid');
  const normalized = query.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > MAX_QUERY_LENGTH) throw new IntegrationError('protocol_error', 'Memorable recall query is invalid');
  // Queries are arguments, never shell fragments. Refuse obvious credential
  // and address material rather than guessing how to redact it.
  if (/\b(?:bearer|authorization|api[_ -]?key|secret|password|token)\s*[:=]/i.test(normalized) || /\bmk_[A-Za-z0-9_-]+\b/.test(normalized) || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(normalized)) {
    throw new IntegrationError('protocol_error', 'Memorable recall query contains protected data');
  }
  return normalized;
}

function recallQuery(input: string | MemorableWorkflow | MemorableRecallWorkflow): string {
  if (typeof input === 'string') return safeRecallQuery(input);
  if ('sessionId' in input) return buildMemorableTrace(input).task_description;
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > MAX_ACTIONS || input.actions.some(action => !isActionType(action))) throw new IntegrationError('protocol_error', 'Memorable recall workflow is invalid');
  return `Successful QM workflow: ${input.actions.join(' -> ')}`.slice(0, MAX_QUERY_LENGTH);
}

function commandError(message: string, code: 'not_configured' | 'unavailable' = 'unavailable'): IntegrationError {
  return new IntegrationError(code, message);
}

function normalizeCommandResult(value: RawCommandResult): MemorableCommandResult {
  const exitCode = value.exitCode ?? value.code ?? value.exit_code ?? value.status ?? null;
  return {
    exitCode: typeof exitCode === 'number' || exitCode === null ? exitCode : null,
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
    ...(value.signal !== undefined ? { signal: value.signal } : {}),
    ...(value.timedOut !== undefined ? { timedOut: value.timedOut } : {}),
  };
}

function jsonFromOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed) as unknown; } catch { /* CLI diagnostics may surround JSON. */ }
  const starts = [trimmed.indexOf('['), trimmed.indexOf('{')].filter(index => index >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    try { return JSON.parse(trimmed.slice(start)) as unknown; } catch { /* Try the next possible JSON start. */ }
  }
  return undefined;
}

function parseList(value: unknown): MemorableListEntry[] | undefined {
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { procedures?: unknown }).procedures) ? (value as { procedures: unknown[] }).procedures : undefined;
  if (!rows) return undefined;
  const entries: MemorableListEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const revisions = Array.isArray(record.revisions) ? record.revisions.filter((revision): revision is Record<string, unknown> => Boolean(revision && typeof revision === 'object' && !Array.isArray(revision)) && typeof (revision as Record<string, unknown>).slug === 'string').map(revision => ({ ...revision, slug: String(revision.slug) })) : [];
    if (revisions.length === 0) continue;
    entries.push({
      ...(typeof record.intent === 'string' ? { intent: record.intent } : {}),
      ...(typeof record.preferred === 'string' || record.preferred === null ? { preferred: record.preferred } : {}),
      ...record,
      revisions,
    });
  }
  return entries;
}

function extractSlugs(output: string): MemorableRecallMatch[] {
  const matches: MemorableRecallMatch[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const slugMatch = line.match(/\b(procedures\/[A-Za-z0-9._~:/-]+)/);
    const rawSlug = slugMatch?.[1];
    if (!rawSlug || seen.has(rawSlug)) continue;
    const slug = rawSlug.replace(/[),.;]+$/, '');
    seen.add(slug);
    const scoreMatch = line.match(/^\s*(0(?:\.\d+)?|1(?:\.0+)?)\s+/);
    const reasonMatch = line.match(/\[([^\]]+)\]/);
    matches.push({
      slug,
      ...(scoreMatch?.[1] ? { score: Number(scoreMatch[1]) } : {}),
      ...(reasonMatch?.[1] ? { reasons: reasonMatch[1].split(',').map(reason => reason.trim()).filter(Boolean) } : {}),
    });
  }
  return matches;
}

function validateSlug(slug: string): string {
  if (!/^procedures\/[A-Za-z0-9._~:/-]+$/.test(slug)) throw new IntegrationError('protocol_error', 'Memorable returned an invalid procedure slug');
  return slug;
}

function classifyIngestFailure(output: string): MemorableStoreReason {
  const text = output.toLowerCase();
  if (text.includes('consent') || text.includes('write refused') || text.includes('enable')) return 'consent_required';
  if (text.includes('queue') || text.includes('retry') || text.includes('kept')) return 'queued';
  if (text.includes('refus') || text.includes('not stored') || text.includes('empty session')) return 'rejected';
  return 'cli_failed';
}

async function defaultCommandRunner(executable: string, args: readonly string[], options: MemorableCommandOptions): Promise<MemorableCommandResult> {
  if (!executable.trim()) throw commandError('Memorable CLI executable is not configured', 'not_configured');
  return new Promise<MemorableCommandResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(commandError('Memorable CLI is unavailable'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    const finish = (result: MemorableCommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: IntegrationError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stop = () => {
      try { child.kill('SIGTERM'); } catch { /* Process may already have exited. */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Ignore a finished child. */ } }, 250);
      killTimer.unref();
    };
    const abort = () => {
      if (!settled) {
        stop();
        fail(commandError('Memorable CLI request was aborted'));
      }
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      bytes += Buffer.byteLength(text);
      if (bytes > options.maxOutputBytes) {
        stop();
        fail(commandError('Memorable CLI output exceeded the configured limit'));
        return;
      }
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));
    child.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      fail(commandError(code === 'ENOENT' ? 'Memorable CLI executable was not found' : 'Memorable CLI is unavailable'));
    });
    child.once('close', (code, signal) => finish({ exitCode: code, stdout, stderr, signal, ...(timedOut ? { timedOut: true } : {}) }));
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      stop();
      fail(commandError('Memorable CLI timed out'));
    }, options.timeoutMs);
    timer.unref();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });

    if (child.stdin) {
      if (options.input !== undefined) child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

export class MemorableClient {
  private readonly config: MemorableClientConfig;
  private readonly runner: MemorableCommandRunner;

  constructor(config: MemorableClientConfig = {}) {
    this.config = { ...config };
    this.runner = config.runner ?? defaultCommandRunner;
  }

  private executable(): string {
    const value = this.config.executable ?? this.config.command ?? this.config.binary ?? process.env.MEMORABLE_BIN ?? DEFAULT_COMMAND;
    if (typeof value !== 'string' || !value.trim()) throw commandError('Memorable CLI executable is not configured', 'not_configured');
    return value;
  }

  private commandOptions(signal?: AbortSignal): MemorableCommandOptions {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = this.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) throw new IntegrationError('not_configured', 'Memorable CLI limits are invalid');
    const env = { ...process.env, ...this.config.env };
    const home = this.config.home ?? process.env.MEMORABLE_HOME;
    if (home?.trim()) env.MEMORABLE_HOME = home;
    return { timeoutMs, maxOutputBytes, ...(signal ? { signal } : {}), env, ...(this.config.cwd ? { cwd: this.config.cwd } : {}) };
  }

  private async run(args: readonly string[], options: Omit<MemorableCommandOptions, 'timeoutMs' | 'maxOutputBytes' | 'env' | 'cwd'> = {}): Promise<MemorableCommandResult> {
    const executable = this.executable();
    const commandOptions = { ...this.commandOptions(options.signal), ...(options.input !== undefined ? { input: options.input } : {}) };
    let runnerResult: Promise<MemorableCommandResult>;
    try {
      runnerResult = this.runner(executable, args, commandOptions);
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw commandError('Memorable CLI is unavailable');
    }
    let result: RawCommandResult;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        runnerResult as Promise<RawCommandResult>,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(commandError('Memorable CLI timed out')), commandOptions.timeoutMs);
          timeout.unref();
        }),
      ]);
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw commandError('Memorable CLI is unavailable');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const normalized = normalizeCommandResult(result);
    if (Buffer.byteLength(normalized.stdout) + Buffer.byteLength(normalized.stderr) > commandOptions.maxOutputBytes) throw commandError('Memorable CLI output exceeded the configured limit');
    return normalized;
  }

  /** Build the sanitized trace without invoking the CLI. */
  trace(workflow: MemorableWorkflow): MemorableTrace {
    return buildMemorableTrace(workflow);
  }

  /**
   * Ingests a sanitized successful workflow and verifies the resulting slug by
   * reading it back through `memorable list --json`. Exit status alone is not
   * treated as proof because the CLI can queue or reject a trace.
   */
  async storeSuccessfulWorkflow(workflow: MemorableWorkflow, signal?: AbortSignal): Promise<MemorableStoreResult> {
    const trace = buildMemorableTrace(workflow);
    const ingest = await this.run(['ingest', '-'], { input: JSON.stringify(trace), ...(signal ? { signal } : {}) });
    const ingestOutput = `${ingest.stdout}\n${ingest.stderr}`;
    if (ingest.exitCode !== 0) {
      const reason = classifyIngestFailure(ingestOutput);
      return { status: reason === 'cli_failed' ? 'unavailable' : 'pending', reason, exitCode: ingest.exitCode };
    }

    const stored = ingestOutput.match(/\b(?:stored|saved)\s+(procedures\/[A-Za-z0-9._~:/-]+)/i);
    if (!stored) return { status: 'pending', reason: /refus|reject|not stored/i.test(ingestOutput) ? 'rejected' : 'unverified', exitCode: ingest.exitCode };
    const storedSlug = stored[1];
    if (!storedSlug) return { status: 'pending', reason: 'unverified', exitCode: ingest.exitCode };
    const slug = validateSlug(storedSlug.replace(/[),.;]+$/, ''));
    const list = await this.run(['list', '--json'], signal ? { signal } : {});
    if (list.exitCode !== 0) return { status: 'pending', reason: 'readback_unavailable', exitCode: list.exitCode };
    const parsed = parseList(jsonFromOutput(list.stdout));
    const readback = parsed?.find(entry => entry.revisions.some(revision => revision.slug === slug));
    if (!readback) return { status: 'pending', reason: 'readback_unavailable', exitCode: list.exitCode };
    return { status: 'saved', slug, readback };
  }

  /** Short alias for callers that use the CLI command name. */
  async ingest(workflow: MemorableWorkflow, signal?: AbortSignal): Promise<MemorableStoreResult> {
    return this.storeSuccessfulWorkflow(workflow, signal);
  }

  /**
   * Recalls an abstract query and reads the selected slug. A workflow input is
   * converted to the same safe task line used for storage; string inputs are
   * treated as already-sanitized task queries and credential-like material is
   * rejected.
   */
  async recall(input: string | MemorableWorkflow | MemorableRecallWorkflow, signal?: AbortSignal): Promise<MemorableRecallResult> {
    const query = recallQuery(input);
    const recalled = await this.run(['recall', query], signal ? { signal } : {});
    const matches = extractSlugs(`${recalled.stdout}\n${recalled.stderr}`);
    if (matches.length === 0) return { status: recalled.exitCode === 0 || /no matching procedures/i.test(`${recalled.stdout} ${recalled.stderr}`) ? 'none' : 'unavailable', query, matches };
    const firstMatch = matches[0];
    if (!firstMatch) return { status: 'none', query, matches };
    const slug = validateSlug(firstMatch.slug);
    const shown = await this.run(['show', slug], signal ? { signal } : {});
    if (shown.exitCode !== 0 || !shown.stdout.trim()) return { status: 'unavailable', query, matches };
    return { status: 'found', query, slug, matches, procedure: shown.stdout };
  }

  /** Recall using only the allow-listed action vocabulary. */
  async recallWorkflow(workflow: MemorableWorkflow | MemorableRecallWorkflow, signal?: AbortSignal): Promise<MemorableRecallResult> {
    return this.recall(workflow, signal);
  }

  /**
   * Calls the optional official extraction endpoint. This returns a draft only
   * and intentionally does not call `memorable ingest` or write local state.
   */
  async extractDraft(workflow: MemorableWorkflow, signal?: AbortSignal): Promise<MemorableDraftResult> {
    const apiKey = this.config.apiKey ?? process.env.MEMORABLE_API_KEY;
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new IntegrationError('not_configured', 'Memorable extraction API key is not configured');
    const urlValue = this.config.extractionUrl ?? this.config.extractUrl ?? process.env.MEMORABLE_EXTRACTION_URL ?? DEFAULT_EXTRACTION_URL;
    const url = endpoint(required(urlValue, 'Memorable extraction URL'));
    const trace = buildMemorableTrace(workflow);
    const response = await checkResponse(await (this.config.fetch ?? globalThis.fetch)(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...trace, skip_embedding: true }),
      redirect: 'error',
      signal: requestSignal(signal, this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    }), 'Memorable extraction API');
    const data = object(await response.json());
    const draft = object(data.draft);
    if (typeof data.request_id !== 'string' || !data.request_id) throw new IntegrationError('protocol_error', 'Memorable extraction response has no request ID');
    if (data.refused !== undefined && typeof data.refused !== 'string') throw new IntegrationError('protocol_error', 'Memorable extraction refusal is malformed');
    return { draft, request_id: data.request_id, ...(typeof data.refused === 'string' ? { refused: data.refused } : {}) };
  }
}

/** Convenience factory for code that prefers a function over a class. */
export function createMemorableClient(config: MemorableClientConfig = {}): MemorableClient {
  return new MemorableClient(config);
}

export { ACTION_COMMANDS as MEMORABLE_ACTION_COMMANDS };
