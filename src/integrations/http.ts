export type Fetch = typeof globalThis.fetch;
export type IntegrationErrorCode = 'not_configured' | 'authentication' | 'http_error' | 'protocol_error' | 'tool_error' | 'approval_required' | 'duplicate_attempt' | 'uncertain_send' | 'unavailable';
export class IntegrationError extends Error {
  constructor(readonly code: IntegrationErrorCode, message: string, readonly status?: number) { super(message); this.name = 'IntegrationError'; }
}
export function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new IntegrationError('not_configured', `${name} is not configured`);
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntegrationError('protocol_error', 'Provider returned an invalid object');
  return value as Record<string, unknown>;
}
export async function checkResponse(response: Response, provider: string): Promise<Response> {
  if (!response.ok) {
    // Provider bodies can contain prompts or credentials; never expose them in errors.
    await response.body?.cancel();
    throw new IntegrationError(response.status === 401 || response.status === 403 ? 'authentication' : 'http_error', `${provider} returned HTTP ${response.status}`, response.status);
  }
  return response;
}
export function endpoint(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new IntegrationError('not_configured', 'Invalid provider endpoint');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new IntegrationError('not_configured', 'Provider endpoint requires HTTPS');
  return url;
}
export function requestSignal(signal?: AbortSignal, timeoutMs = 120_000): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
