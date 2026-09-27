import { createHash } from 'node:crypto';
import { checkResponse, IntegrationError, object, requestSignal, required, type Fetch } from './http.ts';
export interface CalendarInput { calendarId: string; title: string; start: string; end: string; timeZone: string; attendees: { email: string; name?: string }[]; description: string }
export interface CalendarPreview { input: CalendarInput; contextRevision: number; proposalVersion: number; digest: string }
export interface CalendarApproval { digest: string; contextRevision: number; proposalVersion: number; confirmed: true }
export interface CalendarReceipt { id: string; url?: string; calendarId: string; verified: true }
export interface CalendarAttemptStore {
  /** Must atomically and durably claim a previously unused key BEFORE the network write. */
  claim(key: string, digest: string): Promise<boolean>;
  finish(key: string, state: 'sent' | 'uncertain', receipt?: CalendarReceipt): Promise<void>;
}
function digest(preview: Omit<CalendarPreview, 'digest'>): string { return createHash('sha256').update(JSON.stringify(preview)).digest('hex'); }
export function prepareCalendar(input: CalendarInput, contextRevision: number, proposalVersion: number): CalendarPreview {
  if (!input.title.trim() || !input.calendarId.trim() || !input.description.trim()) throw new IntegrationError('protocol_error', 'Calendar preview is incomplete');
  // Require an offset: ambiguous local dates must be resolved before the user reviews the preview.
  if (![input.start, input.end].every(value => /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))) || Date.parse(input.end) <= Date.parse(input.start)) throw new IntegrationError('protocol_error', 'Calendar dates need explicit offsets and a positive duration');
  try { new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone }); } catch { throw new IntegrationError('protocol_error', 'Calendar time zone is invalid'); }
  if (!input.attendees.length || input.attendees.some(a => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email))) throw new IntegrationError('protocol_error', 'Calendar attendees need valid email addresses');
  if (!Number.isInteger(contextRevision) || contextRevision < 0 || !Number.isInteger(proposalVersion) || proposalVersion < 1) throw new IntegrationError('protocol_error', 'Calendar preview version is invalid');
  const normalized: CalendarInput = { calendarId: input.calendarId, title: input.title, start: input.start, end: input.end, timeZone: input.timeZone, attendees: input.attendees.map(a => ({ email: a.email.trim().toLowerCase(), ...(a.name ? { name: a.name } : {}) })).sort((a,b) => a.email.localeCompare(b.email)), description: input.description };
  if (new Set(normalized.attendees.map(a => a.email)).size !== normalized.attendees.length) throw new IntegrationError('protocol_error', 'Calendar attendee list contains duplicates');
  const preview = { input: normalized, contextRevision, proposalVersion }; return { ...preview, digest: digest(preview) };
}
export class GoogleCalendarAdapter {
  private readonly fetch: Fetch; private readonly token: () => Promise<string>;
  constructor(config: { accessToken: string | (() => Promise<string>); fetch?: Fetch }) {
    if (typeof config.accessToken === 'string') { const token = required(config.accessToken, 'Google Calendar access token'); this.token = async () => token; } else this.token = config.accessToken;
    this.fetch = config.fetch ?? globalThis.fetch;
  }
  private async request(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await checkResponse(await this.fetch(`https://www.googleapis.com/calendar/v3/${path}`, { method, headers: { authorization: `Bearer ${required(await this.token(), 'Google Calendar access token')}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: requestSignal(signal, 30_000), redirect: 'error' }), 'Google Calendar');
    return object(await response.json());
  }
  async readBack(calendarId: string, eventId: string, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.request(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, 'GET', undefined, signal); }
  async send(preview: CalendarPreview, approval: CalendarApproval, idempotencyKey: string, attempts: CalendarAttemptStore, signal?: AbortSignal): Promise<CalendarReceipt> {
    const rebuilt = prepareCalendar(preview.input, preview.contextRevision, preview.proposalVersion);
    if (!approval.confirmed || approval.digest !== preview.digest || rebuilt.digest !== preview.digest || approval.contextRevision !== preview.contextRevision || approval.proposalVersion !== preview.proposalVersion) throw new IntegrationError('approval_required', 'Calendar preview changed; review and confirm it again');
    required(idempotencyKey, 'Calendar idempotency key');
    if (!(await attempts.claim(idempotencyKey, preview.digest))) throw new IntegrationError('duplicate_attempt', 'This calendar send was already attempted; read back its status before proceeding');
    const eventId = createHash('sha256').update(`glance-qm:${idempotencyKey}`).digest('hex');
    try {
      const value = rebuilt.input;
      const body = { id: eventId, summary: value.title, description: value.description, start: { dateTime: value.start, timeZone: value.timeZone }, end: { dateTime: value.end, timeZone: value.timeZone }, attendees: value.attendees.map(a => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}) })), extendedProperties: { private: { glancePreviewDigest: rebuilt.digest } } };
      const inserted = await this.request(`calendars/${encodeURIComponent(value.calendarId)}/events?sendUpdates=all`, 'POST', body, signal);
      if (inserted.id !== eventId) throw new IntegrationError('protocol_error', 'Calendar returned an unexpected event ID');
      const verified = await this.readBack(value.calendarId, eventId, signal);
      const attendees = Array.isArray(verified.attendees) ? verified.attendees.map(a => String(object(a).email).toLowerCase()).sort() : [];
      const start = object(verified.start); const end = object(verified.end);
      const privateProps = object(object(verified.extendedProperties).private);
      if (verified.id !== eventId || verified.status === 'cancelled' || verified.summary !== value.title || verified.description !== value.description || Date.parse(String(start.dateTime)) !== Date.parse(value.start) || Date.parse(String(end.dateTime)) !== Date.parse(value.end) || JSON.stringify(attendees) !== JSON.stringify(value.attendees.map(a => a.email).sort()) || privateProps.glancePreviewDigest !== rebuilt.digest) throw new IntegrationError('uncertain_send', 'Calendar event readback does not match the approved preview');
      const receipt: CalendarReceipt = { id: eventId, calendarId: value.calendarId, verified: true, ...(typeof verified.htmlLink === 'string' ? { url: verified.htmlLink } : {}) };
      await attempts.finish(idempotencyKey, 'sent', receipt); return receipt;
    } catch { await attempts.finish(idempotencyKey, 'uncertain'); throw new IntegrationError('uncertain_send', `Calendar send outcome is uncertain; inspect event ${eventId} before any further action`); }
  }
}

/** Standard OAuth refresh grant. Tokens remain server-side; this does not request new scopes. */
export function googleAccessTokenProvider(config: { clientId: string; clientSecret: string; refreshToken: string; fetch?: Fetch }): () => Promise<string> {
  required(config.clientId, 'Google OAuth client ID'); required(config.clientSecret, 'Google OAuth client secret'); required(config.refreshToken, 'Google OAuth refresh token');
  let token: string | undefined; let expiresAt = 0;
  return async () => {
    if (token && Date.now() < expiresAt) return token;
    const response = await checkResponse(await (config.fetch ?? globalThis.fetch)('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken }).toString(), redirect: 'error', signal: requestSignal(undefined, 30_000) }), 'Google OAuth');
    const data = object(await response.json());
    if (typeof data.access_token !== 'string' || !data.access_token) throw new IntegrationError('authentication', 'Google OAuth returned no access token');
    token = data.access_token; expiresAt = Date.now() + Math.max(0, (typeof data.expires_in === 'number' ? data.expires_in : 300) - 30) * 1000;
    return token;
  };
}
