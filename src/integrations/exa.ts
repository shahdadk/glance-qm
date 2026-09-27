import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Evidence } from '../shared/contracts.ts';

export type ExaErrorCode = 'unconfigured' | 'invalid_query' | 'authentication' | 'quota' | 'unavailable' | 'timeout' | 'aborted' | 'invalid_response';
export class ExaError extends Error {
  constructor(readonly code: ExaErrorCode, message: string, readonly status?: number) {
    super(message); this.name = 'ExaError';
  }
}
export interface ExaOptions { apiKey?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch }
export interface ExaProvenance { url: string; title: string; retrievedAt: string; contentHash: string }
const MAX_RESULTS = 4;
const MAX_TEXT = 3000;
const MAX_RESPONSE_BYTES = 256_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only a short public topic may cross this boundary, never a transcript. */
export function publicResearchQuery(input: string): string {
  const query = input.trim().replace(/\s+/g, ' ');
  if (!query || query.length > 240 || /[\r\n]/.test(input) ||
      /\b(?:https?:\/\/|file:|localhost\b)|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:api[_ -]?key|password|bearer|secret|access[_ -]?token)\s*[:=]|\bsk-[a-z\d_-]{12,}/i.test(query)) {
    throw new ExaError('invalid_query', 'Research requires a short public topic without personal identifiers or credentials');
  }
  return query;
}

/** Do not follow returned links. Reject literals and local/reserved hostnames. */
function publicUrl(input: unknown): URL | undefined {
  if (typeof input !== 'string' || input.length > 2048) return;
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') ||
        isIP(host.replace(/^\[|\]$/g, '')) ||
        /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)) return;
    url.hash = '';
    return url;
  } catch { return; }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ExaError('invalid_response', 'Exa returned no response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ExaError('invalid_response', 'Exa response exceeded the content budget');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ExaError('invalid_response', 'Exa returned invalid JSON'); }
}

/** Server-only Exa search. No retries, alternate providers, or cross-query cache. */
export class ExaClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly apiKey: string;
  private readonly provenance = new Map<string, ExaProvenance>();
  constructor(options: ExaOptions) {
    this.apiKey = options.apiKey?.trim() ?? '';
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.min(5000, Math.max(1, options.timeoutMs ?? 4000));
  }
  getProvenance(id: string): ExaProvenance | undefined {
    const record = this.provenance.get(id); return record ? { ...record } : undefined;
  }
  async search(input: string, signal?: AbortSignal): Promise<Evidence[]> {
    if (!this.apiKey) throw new ExaError('unconfigured', 'Exa is not configured');
    const query = publicResearchQuery(input);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      requestSignal.throwIfAborted();
      const response = await this.fetcher('https://api.exa.ai/search', {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify({ query, type: 'fast', numResults: MAX_RESULTS,
          contents: { text: { maxCharacters: MAX_TEXT }, livecrawlTimeout: 1000 } }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const code = [401, 403].includes(response.status) ? 'authentication' : [402, 429].includes(response.status) ? 'quota' : 'unavailable';
        throw new ExaError(code, `Exa returned HTTP ${response.status}`, response.status);
      }
      const body = await boundedJson(response);
      requestSignal.throwIfAborted();
      if (!body || typeof body !== 'object' || !Array.isArray((body as {results?: unknown}).results)) {
        throw new ExaError('invalid_response', 'Exa returned an invalid result envelope');
      }
      const results = (body as { results: unknown[] }).results;
      const evidence: Evidence[] = []; const seen = new Set<string>();
      const retrievedAt = new Date().toISOString();
      for (const item of results) {
        if (!item || typeof item !== 'object') continue;
        const result = item as Record<string, unknown>; const url = publicUrl(result.url);
        if (!url || seen.has(url.href)) continue;
        const raw = typeof result.text === 'string' && result.text.trim() ? result.text :
          Array.isArray(result.highlights) ? result.highlights.filter((s): s is string => typeof s === 'string').join('\n') : '';
        if (!raw.trim()) continue; // A title or synthetic summary is not source evidence.
        const text = raw.slice(0, MAX_TEXT); if (!text.trim()) continue;
        const title = typeof result.title === 'string' && result.title.trim() ? result.title.trim().slice(0, 240) : url.hostname;
        const contentHash = hash(text);
        const id = `exa:${hash(`${url.href}\n${contentHash}`).slice(0, 32)}`;
        const sourceUrl = result.url as string;
        evidence.push({ id, label: title, text, url: sourceUrl, kind: 'external' });
        this.provenance.set(id, { url: sourceUrl, title, retrievedAt, contentHash });
        while (this.provenance.size > 64) this.provenance.delete(this.provenance.keys().next().value!);
        seen.add(url.href);
        if (evidence.length === MAX_RESULTS) break;
      }
      return evidence;
    } catch (error) {
      if (signal?.aborted) throw new ExaError('aborted', 'Exa research was cancelled');
      if (timeout.aborted) throw new ExaError('timeout', 'Exa research timed out');
      if (error instanceof ExaError) throw error;
      throw new ExaError('unavailable', 'Exa research is unavailable');
    }
  }
}
