import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { googleAccessTokenProvider } from './calendar.ts';
import { checkResponse, IntegrationError, object, requestSignal, required, type Fetch } from './http.ts';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export interface DocumentDeliveryInput {
  taskId: string; artifactId: string; content: string;
  generation: number; contextDigest: string;
  recipient: { email: string; name?: string };
  subject: string; body: string; filename: string; contentType: 'text/markdown; charset=utf-8';
}
export interface DeliveryPreview { input: DocumentDeliveryInput; contentSha256: string; contextRevision: number; proposalVersion: number; digest: string }
export interface DeliveryApproval { confirmed: true; digest: string; contextRevision: number; proposalVersion: number }
export interface DeliveryReceipt { id: string; provider: 'gmail'; messageId: string; mimeMessageId: string; accepted: true; previewDigest: string }
export interface DeliveryFailure { code: 'authentication' | 'http_error' | 'uncertain_send'; status?: number; requiresReview: true }
export interface DeliveryAttemptStore {
  /** Atomic durable claim, before dispatch. Never automatically release a claim. */
  claim(key: string, digest: string): Promise<boolean>;
  finish(key: string, state: 'sent' | 'uncertain' | 'rejected', receipt?: DeliveryReceipt, failure?: DeliveryFailure): Promise<void>;
}
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
function header(value: string, label: string, limit = 300): string {
  if (!value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw new IntegrationError('protocol_error', `Invalid delivery ${label}`);
  return value;
}
/** Deliberately accepts a single ASCII dot-atom mailbox, not display names/lists/comments. */
export function deliveryMailbox(value: string): string {
  header(value, 'email', 254);
  const parts = value.split('@'); const local = parts[0]; const domain = parts[1];
  if (parts.length !== 2 || !local || !domain || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local) || domain.length > 253 || !domain.includes('.') || domain.split('.').some(p => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(p))) throw new IntegrationError('protocol_error', 'Delivery needs one valid email address');
  return `${local}@${domain.toLowerCase()}`;
}
export function prepareDocumentDelivery(input: DocumentDeliveryInput, contextRevision: number, proposalVersion: number): DeliveryPreview {
  header(input.taskId, 'task ID'); header(input.artifactId, 'artifact ID'); header(input.subject, 'subject'); header(input.filename, 'filename', 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*\.md$/.test(input.filename) || input.filename.includes('..')) throw new IntegrationError('protocol_error', 'Delivery filename must be a simple Markdown filename');
  if (input.contentType !== 'text/markdown; charset=utf-8' || !input.content.trim() || Buffer.byteLength(input.content, 'utf8') > 5_000_000 || input.body.length > 10_000) throw new IntegrationError('protocol_error', 'Delivery document is invalid or too large');
  if (!Number.isInteger(contextRevision) || contextRevision < 0 || !Number.isInteger(proposalVersion) || proposalVersion < 1) throw new IntegrationError('protocol_error', 'Delivery preview version is invalid');
  if (!Number.isInteger(input.generation) || input.generation < 1 || !/^[a-f0-9]{64}$/.test(input.contextDigest)) throw new IntegrationError('protocol_error', 'Delivery source generation or context digest is invalid');
  const normalized: DocumentDeliveryInput = { taskId: input.taskId, artifactId: input.artifactId, generation: input.generation, contextDigest: input.contextDigest, content: input.content, recipient: { email: deliveryMailbox(input.recipient.email), ...(input.recipient.name ? { name: header(input.recipient.name, 'recipient name', 120) } : {}) }, subject: input.subject, body: input.body, filename: input.filename, contentType: input.contentType };
  const value = { input: normalized, contentSha256: sha256(normalized.content), contextRevision, proposalVersion };
  return { ...value, digest: sha256(JSON.stringify(value)) };
}
function encodedWords(value: string): string {
  // Unicode code points stay intact; each encoded word remains below RFC 2047's 75-byte limit.
  const chunks: string[] = []; let chunk = '';
  for (const point of value) { if (Buffer.byteLength(chunk + point, 'utf8') > 42) { chunks.push(chunk); chunk = ''; } chunk += point; }
  if (chunk) chunks.push(chunk);
  return chunks.map(c => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ');
}
function base64Lines(value: string): string { return Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''; }
export function documentMime(preview: DeliveryPreview, senderEmail: string, idempotencyKey: string): { raw: string; messageId: string } {
  const rebuilt = prepareDocumentDelivery(preview.input, preview.contextRevision, preview.proposalVersion);
  if (rebuilt.digest !== preview.digest || rebuilt.contentSha256 !== preview.contentSha256) throw new IntegrationError('approval_required', 'Delivery MIME source differs from its preview');
  const p = rebuilt.input; const sender = deliveryMailbox(senderEmail);
  const seed = sha256(JSON.stringify([idempotencyKey, preview.digest]));
  const boundary = `kompx_${seed}`; const messageId = `<${seed}@kompx.invalid>`;
  const mime = [
    `From: ${sender}`, `To: ${p.recipient.name ? `${encodedWords(p.recipient.name)} ` : ''}<${p.recipient.email}>`,
    `Subject: ${encodedWords(p.subject)}`, `Message-ID: ${messageId}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(p.body),
    `--${boundary}`, `Content-Type: ${p.contentType}`, 'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${p.filename}"`, '', base64Lines(p.content), `--${boundary}--`, '',
  ].join('\r\n');
  return { raw: Buffer.from(mime, 'utf8').toString('base64url'), messageId };
}

export class GmailDeliveryAdapter {
  private readonly fetch: Fetch; private readonly token: () => Promise<string>; private readonly senderEmail: string;
  constructor(config: { accessToken: string | (() => Promise<string>); senderEmail: string; fetch?: Fetch }) {
    this.senderEmail = deliveryMailbox(config.senderEmail);
    const token = config.accessToken; this.token = typeof token === 'string' ? async () => required(token, 'Gmail access token') : token;
    this.fetch = config.fetch ?? globalThis.fetch;
  }
  /** Read-only token introspection; gmail.send does not grant mailbox/profile reading. */
  async readiness(signal?: AbortSignal): Promise<{ ready: boolean; scopeGranted: boolean }> {
    const token = required(await this.token(), 'Gmail access token');
    const response = await checkResponse(await this.fetch(`https://oauth2.googleapis.com/tokeninfo?${new URLSearchParams({ access_token: token })}`, { signal: requestSignal(signal, 30_000), redirect: 'error' }), 'Google OAuth');
    const data = object(await response.json());
    const scopeGranted = typeof data.scope === 'string' && data.scope.split(/\s+/).includes(GMAIL_SEND_SCOPE);
    return { ready: scopeGranted, scopeGranted };
  }
  async sendDocument(preview: DeliveryPreview, approval: DeliveryApproval, idempotencyKey: string, attempts: DeliveryAttemptStore, signal?: AbortSignal): Promise<DeliveryReceipt> {
    const rebuilt = prepareDocumentDelivery(preview.input, preview.contextRevision, preview.proposalVersion);
    if (approval.confirmed !== true || approval.digest !== preview.digest || rebuilt.digest !== preview.digest || rebuilt.contentSha256 !== preview.contentSha256 || approval.contextRevision !== preview.contextRevision || approval.proposalVersion !== preview.proposalVersion) throw new IntegrationError('approval_required', 'Delivery preview changed; review the recipient and document again');
    required(idempotencyKey, 'Delivery idempotency key');
    const mime = documentMime(rebuilt, this.senderEmail, idempotencyKey);
    const token = required(await this.token(), 'Gmail access token');
    signal?.throwIfAborted();
    if (!(await attempts.claim(idempotencyKey, preview.digest))) throw new IntegrationError('duplicate_attempt', 'Document delivery was already attempted; review its stored outcome before proceeding');
    let rejection: DeliveryFailure | undefined;
    try {
      const response = await this.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw: mime.raw }), signal: requestSignal(signal, 30_000), redirect: 'error' });
      if (!response.ok) {
        // A completed 4xx response is a definitive rejection. 5xx/transport errors may follow acceptance.
        if (response.status >= 400 && response.status < 500) rejection = { code: response.status === 401 || response.status === 403 ? 'authentication' : 'http_error', status: response.status, requiresReview: true };
        await response.body?.cancel();
        throw new IntegrationError(rejection?.code ?? 'uncertain_send', `Gmail returned HTTP ${response.status}; review delivery before retrying`, response.status);
      }
      const value = object(await response.json());
      if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.id)) throw new IntegrationError('uncertain_send', 'Gmail accepted the request without a valid message receipt');
      const receipt: DeliveryReceipt = { id: value.id, provider: 'gmail', messageId: value.id, mimeMessageId: mime.messageId, accepted: true, previewDigest: rebuilt.digest };
      await attempts.finish(idempotencyKey, 'sent', receipt); return receipt;
    } catch (error) {
      // The durable executing claim remains even if recording the final state fails.
      try { await attempts.finish(idempotencyKey, rejection ? 'rejected' : 'uncertain', undefined, rejection ?? { code: 'uncertain_send', requiresReview: true }); }
      catch { throw new IntegrationError('uncertain_send', 'Delivery outcome could not be persisted; the durable claim prevents retry. Review Gmail before further action'); }
      if (rejection && error instanceof IntegrationError) throw error;
      throw new IntegrationError('uncertain_send', 'Document delivery outcome is uncertain; inspect Gmail and the stored attempt before any further action');
    }
  }
}

/** A restart or concurrent request cannot reclaim a send, including uncertain outcomes. */
export class FileDeliveryAttemptStore implements DeliveryAttemptStore {
  constructor(private readonly directory: string) {}
  private file(key: string): string { return join(this.directory, `${sha256(key)}.json`); }
  private async syncDirectory(): Promise<void> { const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  async claim(key: string, digest: string): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let file; try { file = await open(this.file(key), 'wx', 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    try { await file.writeFile(JSON.stringify({ digest, state: 'executing', startedAt: new Date().toISOString() })); await file.sync(); } finally { await file.close(); }
    await this.syncDirectory(); return true;
  }
  async finish(key: string, state: 'sent' | 'uncertain' | 'rejected', receipt?: DeliveryReceipt, failure?: DeliveryFailure): Promise<void> {
    const target = this.file(key); const previous = object(JSON.parse(await readFile(target, 'utf8')));
    const temporary = `${target}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ ...previous, state, finishedAt: new Date().toISOString(), ...(receipt ? { receipt } : {}), ...(failure ? { failure } : {}) })); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target); await this.syncDirectory();
  }
}

export function createDocumentSender(env: Readonly<Record<string, string | undefined>>) {
  const accessToken = env.GOOGLE_GMAIL_ACCESS_TOKEN ?? env.GOOGLE_ACCESS_TOKEN;
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID ?? env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_OAUTH_REFRESH_TOKEN ?? env.GOOGLE_REFRESH_TOKEN;
  const credentials = clientId && clientSecret && refreshToken ? googleAccessTokenProvider({ clientId, clientSecret, refreshToken }) : accessToken;
  const scopeGranted = (env.GOOGLE_OAUTH_SCOPES ?? '').split(/\s+/).includes(GMAIL_SEND_SCOPE);
  const senderEmail = env.GOOGLE_GMAIL_FROM_EMAIL;
  const adapter = credentials && scopeGranted && senderEmail ? new GmailDeliveryAdapter({ accessToken: credentials, senderEmail }) : undefined;
  const attempts = new FileDeliveryAttemptStore(resolve(env.GLANCE_LOCAL_DIR ?? '.local', 'delivery-attempts'));
  return { configured: Boolean(adapter), adapter, attempts };
}
