import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { AmbientProviders } from '../core/providers.ts';
import { GoogleCalendarAdapter, googleAccessTokenProvider, prepareCalendar, type CalendarAttemptStore, type CalendarReceipt } from './calendar.ts';
import { IntegrationError } from './http.ts';
/** Crash-safe attempt claims. An uncertain/unfinished claim is never deleted or retried automatically. */
export class FileCalendarAttemptStore implements CalendarAttemptStore {
  constructor(private readonly directory: string) {}
  private file(key: string): string { return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`); }
  private async syncDirectory(): Promise<void> { const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  async claim(key: string, digest: string): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(this.file(key), 'wx', 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    try { await file.writeFile(JSON.stringify({ digest, state: 'executing', startedAt: new Date().toISOString() })); await file.sync(); } finally { await file.close(); }
    await this.syncDirectory(); return true;
  }
  async finish(key: string, state: 'sent' | 'uncertain', receipt?: CalendarReceipt): Promise<void> {
    const target = this.file(key); const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ state, finishedAt: new Date().toISOString(), ...(receipt ? { receipt } : {}) })); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target); await this.syncDirectory();
  }
}
export function createCalendarSender(env: Readonly<Record<string, string | undefined>>): { configured: boolean; sendCalendar: AmbientProviders['sendCalendar'] } {
  const accessToken = env.GOOGLE_CALENDAR_ACCESS_TOKEN ?? env.GOOGLE_ACCESS_TOKEN;
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID ?? env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN ?? env.GOOGLE_REFRESH_TOKEN;
  const credentials = clientId && clientSecret && refreshToken ? googleAccessTokenProvider({ clientId, clientSecret, refreshToken }) : accessToken;
  const adapter = credentials ? new GoogleCalendarAdapter({ accessToken: credentials }) : undefined;
  const attempts = new FileCalendarAttemptStore(resolve(env.GLANCE_LOCAL_DIR ?? '.local', 'calendar-attempts'));
  return {
    configured: Boolean(adapter),
    async sendCalendar(input, signal) {
      if (!adapter) throw new IntegrationError('not_configured', 'Google Calendar is not configured');
      // The core's confirm route durably binds this status to the exact action,
      // proposal version, meeting revision and correction epoch before calling us.
      if (input.proposal.status !== 'confirmed') throw new IntegrationError('approval_required', 'Calendar proposal has not been confirmed');
      const p = input.proposal;
      const preview = prepareCalendar({ calendarId: env.GOOGLE_CALENDAR_ID ?? 'primary', title: p.title, description: p.description, start: p.start, end: p.end, timeZone: p.timeZone, attendees: p.attendees.map(a => ({ email: a.email, ...(a.name ? { name: a.name } : {}) })) }, input.correctionEpoch, p.proposalVersion);
      const receipt = await adapter.send(preview, { confirmed: true, digest: preview.digest, contextRevision: preview.contextRevision, proposalVersion: preview.proposalVersion }, input.idempotencyKey, attempts, signal);
      return { id: receipt.id, ...(receipt.url ? { url: receipt.url } : {}), detail: 'Google Calendar event sent with attendee notifications and verified by readback.' };
    },
  };
}
