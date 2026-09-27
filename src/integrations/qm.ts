import { createHmac } from 'node:crypto';
import { checkResponse, endpoint, IntegrationError, object, requestSignal, required, type Fetch } from './http.ts';
import { parseSse } from './sse.ts';
export interface QmActor { externalId: string; displayName?: string; email?: string }
export interface QmTurnRequest {
  surface: string; actor: QmActor;
  conversation: { kind: 'group' | 'dm' | 'channel'; threadRef: string; channelRef?: string; audience?: QmActor[]; channelName?: string };
  text: string; readOnly?: boolean; model?: string; harness?: string; thinkingLevel?: string; skipMemory?: boolean; fastMode?: boolean;
}
export interface QmRunResult { runId: string; text: string; status: string; events: Record<string, unknown>[]; result?: unknown }
export function signQmRequest(secret: string, method: string, pathWithQuery: string, body = '', timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  required(secret, 'QM source secret');
  const signature = createHmac('sha256', secret).update(`v0:${timestamp}:${method.toUpperCase()}\n${pathWithQuery}\n${body}`).digest('hex');
  return { 'x-timestamp': String(timestamp), 'x-signature': `v0=${signature}` };
}
export class QmClient {
  private readonly url: URL; private readonly fetch: Fetch; private readonly secret: string;
  constructor(config: { baseUrl: string; sourceSecret: string; fetch?: Fetch }) {
    this.url = endpoint(required(config.baseUrl, 'QM URL')); this.secret = required(config.sourceSecret, 'QM source secret'); this.fetch = config.fetch ?? globalThis.fetch;
  }
  private async request(path: string, method: string, data?: unknown, signal?: AbortSignal): Promise<Response> {
    const url = new URL(path, this.url); const body = data === undefined ? '' : JSON.stringify(data);
    return checkResponse(await this.fetch(url, { method, headers: { ...signQmRequest(this.secret, method, url.pathname + url.search, body), ...(body ? { 'content-type': 'application/json' } : {}), accept: path.endsWith('/events') ? 'text/event-stream' : 'application/json' }, ...(body ? { body } : {}), redirect: 'error', signal: requestSignal(signal) }), 'QM');
  }
  async submitTurn(request: QmTurnRequest, signal?: AbortSignal): Promise<{ runId: string }> {
    const data = object(await (await this.request('/v1/turns?async=1', 'POST', request, signal)).json());
    if (typeof data.runId !== 'string' || !data.runId) throw new IntegrationError('protocol_error', 'QM did not return a run ID');
    return { runId: data.runId };
  }
  async collectRun(runId: string, signal?: AbortSignal): Promise<QmRunResult> {
    const response = await this.request(`/v1/runs/${encodeURIComponent(runId)}/events`, 'GET', undefined, signal);
    if (!response.body) throw new IntegrationError('protocol_error', 'QM run stream is missing');
    let text = ''; let status = 'running'; let result: unknown; let finished = false;
    const events: Record<string, unknown>[] = [];
    for await (const frame of parseSse(response.body)) {
      let event: Record<string, unknown>; try { event = object(JSON.parse(frame.data)); } catch { throw new IntegrationError('protocol_error', 'QM emitted malformed SSE data'); }
      events.push(event);
      if (events.length > 20_000) throw new IntegrationError('protocol_error', 'QM run exceeded event limit');
      if (event.type === 'CUSTOM' && event.name === 'delta') {
        const delta = object(event.value); const offset = delta.offset;
        if (typeof delta.delta !== 'string' || typeof offset !== 'number' || offset < 0 || !Number.isInteger(offset) || offset > text.length) throw new IntegrationError('protocol_error', 'QM text stream has an invalid offset');
        text += delta.delta.slice(Math.max(0, text.length - offset));
      }
      if (event.type === 'CUSTOM' && event.name === 'run') {
        const run = object(event.value); if (typeof run.partial === 'string') text = run.partial;
        if (typeof run.status === 'string') status = run.status;
        if (run.result !== undefined && run.result !== null) { result = run.result; const r = typeof result === 'object' ? object(result) : {}; if (typeof r.reply === 'string') text = r.reply; else if (typeof r.text === 'string') text = r.text; if (['failed', 'refused', 'pending_approval'].includes(String(r.status))) status = String(r.status); }
      }
      if (event.type === 'RUN_FINISHED') { finished = true; break; }
    }
    if (!finished) throw new IntegrationError('protocol_error', 'QM stream ended before run completion');
    if (['failed', 'refused', 'pending_approval'].includes(status)) throw new IntegrationError('tool_error', 'QM run failed');
    if (status !== 'done') throw new IntegrationError('protocol_error', 'QM completion had no terminal successful snapshot');
    return { runId, text, status, events, ...(result !== undefined ? { result } : {}) };
  }
  async runTurn(request: QmTurnRequest, signal?: AbortSignal): Promise<QmRunResult> { const { runId } = await this.submitTurn(request, signal); return this.collectRun(runId, signal); }
  /** Requires an explicitly configured administrative principal, never inferred from a user turn. */
  async registerGBrainConnector(config: { id?: string; url: string; bearerToken: string; adminHeaders: Record<string, string>; readOnly?: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const id = config.id ?? 'gbrain'; if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new IntegrationError('protocol_error', 'Invalid connector ID');
    const url = new URL(`/v1/admin/mcp-servers/${id}`, this.url);
    const body = JSON.stringify({ name: 'GBrain', url: endpoint(config.url).href, auth: 'bearer', bearerToken: required(config.bearerToken, 'GBrain bearer token'), credentialScope: 'shared', readOnly: config.readOnly ?? true, enabled: true, validate: true });
    const response = await checkResponse(await this.fetch(url, { method: 'PUT', headers: { ...config.adminHeaders, ...signQmRequest(this.secret, 'PUT', url.pathname, body), 'content-type': 'application/json' }, body, redirect: 'error', signal: requestSignal(signal) }), 'QM');
    return object(await response.json());
  }
}
