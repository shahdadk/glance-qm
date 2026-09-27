import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDocumentSender, documentMime, FileDeliveryAttemptStore, GMAIL_SEND_SCOPE, GmailDeliveryAdapter, prepareDocumentDelivery, type DeliveryApproval, type DocumentDeliveryInput } from '../src/integrations/delivery.ts';

const source: DocumentDeliveryInput = { taskId: 'task-1', artifactId: 'task-1:2', generation: 2, contextDigest: 'a'.repeat(64), content: '# Product requirements\n\nCafé — 日本語 🕶️\n', recipient: { email: 'colleague@example.com', name: 'Zoë 李' }, subject: 'Review: café requirements', body: 'The document we discussed is attached.', filename: 'product-requirements.md', contentType: 'text/markdown; charset=utf-8' };
const preview = () => prepareDocumentDelivery(structuredClone(source), 4, 1);
const approval = (p = preview()): DeliveryApproval => ({ confirmed: true, digest: p.digest, contextRevision: p.contextRevision, proposalVersion: p.proposalVersion });
const directories: string[] = [];
async function store() { const directory = await mkdtemp(join(tmpdir(), 'delivery-test-')); directories.push(directory); return { directory, attempts: new FileDeliveryAttemptStore(directory) }; }
function adapter(fetch: typeof globalThis.fetch) { return new GmailDeliveryAdapter({ accessToken: 'fixture-token', senderEmail: 'sender@example.com', fetch }); }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('document delivery preview and MIME', () => {
  it('binds exact artifact bytes, recipient, metadata, task, revision and version', () => {
    const p = preview(); expect(p.contentSha256).toBe(createHash('sha256').update(source.content).digest('hex'));
    for (const change of [{ generation: 3 }, { contextDigest: 'b'.repeat(64) }, { content: source.content + '\n' }, { artifactId: 'other' }, { taskId: 'other' }, { recipient: { email: 'other@example.com' } }, { subject: 'Changed' }, { body: 'Changed' }, { filename: 'other.md' }]) expect(prepareDocumentDelivery({ ...source, ...change }, 4, 1).digest).not.toBe(p.digest);
    expect(prepareDocumentDelivery(source, 5, 1).digest).not.toBe(p.digest); expect(prepareDocumentDelivery(source, 4, 2).digest).not.toBe(p.digest);
  });
  it.each(['a@example.com\r\nBcc: evil@example.com', 'a@example.com,evil@example.com', 'Name <a@example.com>', 'a@bad..com', '.a@example.com', 'a..b@example.com', 'a@example.com (comment)', 'a@-example.com', 'a@example.com\u0000'])('rejects injected or ambiguous mailbox %j', email => {
    expect(() => prepareDocumentDelivery({ ...source, recipient: { email } }, 4, 1)).toThrow();
  });
  it('rejects injected subject/name/filename and path traversal', () => {
    for (const change of [{ subject: 'Subject\r\nBcc: evil@example.com' }, { recipient: { email: 'a@example.com', name: 'Name\nBcc: evil@example.com' } }, { filename: '../secret.md' }, { filename: 'file".md' }, { contentType: 'text/markdown\r\nBcc: evil@example.com' }]) expect(() => prepareDocumentDelivery({ ...source, ...change } as DocumentDeliveryInput, 4, 1)).toThrow();
  });
  it('encodes UTF-8 MIME attachment and body without altering exact content', () => {
    const p = preview(); const result = documentMime(p, 'sender@example.com', 'key-1');
    expect(result.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = Buffer.from(result.raw, 'base64url').toString('utf8');
    expect(mime).toContain('From: sender@example.com\r\n'); expect(mime).toContain('<colleague@example.com>'); expect(mime).not.toContain('\r\nBcc:');
    expect(mime).toContain('Content-Type: text/markdown; charset=utf-8'); expect(mime).toContain('filename="product-requirements.md"');
    const attachment = mime.split('filename="product-requirements.md"\r\n\r\n')[1]!.split('\r\n--')[0]!;
    expect(Buffer.from(attachment, 'base64').toString('utf8')).toBe(source.content);
    expect(documentMime(p, 'sender@example.com', 'key-1').messageId).toBe(result.messageId);
    expect(documentMime(p, 'sender@example.com', 'key-2').messageId).not.toBe(result.messageId);
  });
});

describe('Gmail delivery side effect gate', () => {
  it('requires matching approval and untampered source before any network call or durable claim', async () => {
    const fetch = vi.fn(); const a = adapter(fetch); const { directory, attempts } = await store();
    for (const altered of [{ ...preview(), input: { ...source, content: 'tampered' } }, { ...preview(), contentSha256: 'fabricated' }]) await expect(a.sendDocument(altered, approval(), 'key', attempts)).rejects.toMatchObject({ code: 'approval_required' });
    for (const altered of [{ ...approval(), digest: 'wrong' }, { ...approval(), confirmed: false }, { ...approval(), proposalVersion: 2 }, { ...approval(), contextRevision: 9 }]) await expect(a.sendDocument(preview(), altered as DeliveryApproval, 'key', attempts)).rejects.toMatchObject({ code: 'approval_required' });
    expect(fetch).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
  });
  it('claims durably before dispatch, sends once under concurrency, and persists provider receipt', async () => {
    const { directory, attempts } = await store();
    const fetch = vi.fn(async () => { const records = await readdir(directory); expect(records).toHaveLength(1); expect(JSON.parse(await readFile(join(directory, records[0]!), 'utf8')).state).toBe('executing'); return Response.json({ id: 'provider-message-123' }); });
    const a = adapter(fetch); const outcomes = await Promise.allSettled([a.sendDocument(preview(), approval(), 'key', attempts), a.sendDocument(preview(), approval(), 'key', attempts)]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(1);
    const record = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), 'utf8'));
    expect(record).toMatchObject({ state: 'sent', digest: preview().digest, receipt: { id: 'provider-message-123', messageId: 'provider-message-123', accepted: true, provider: 'gmail' } });
    expect(record.receipt.url).toBeUndefined();
    await expect(a.sendDocument(preview(), approval(), 'key', new FileDeliveryAttemptStore(directory))).rejects.toMatchObject({ code: 'duplicate_attempt' });
  });
  it('keeps uncertain transport outcomes durable and refuses restart retry', async () => {
    const { directory, attempts } = await store(); const fetch = vi.fn(async () => { throw new Error('network failed with secret-token'); }); const a = adapter(fetch);
    await expect(a.sendDocument(preview(), approval(), 'key', attempts)).rejects.toMatchObject({ code: 'uncertain_send' });
    const record = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), 'utf8')); expect(record.state).toBe('uncertain'); expect(JSON.stringify(record)).not.toContain('secret-token');
    await expect(a.sendDocument(preview(), approval(), 'key', new FileDeliveryAttemptStore(directory))).rejects.toMatchObject({ code: 'duplicate_attempt' }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 400, 429, 500])('records safe rejection metadata for HTTP %i without exposing body', async status => {
    const { directory, attempts } = await store(); const a = adapter(vi.fn(async () => new Response('sensitive provider body', { status })));
    await expect(a.sendDocument(preview(), approval(), 'key', attempts)).rejects.toMatchObject({ code: status >= 500 ? 'uncertain_send' : status === 401 || status === 403 ? 'authentication' : 'http_error' });
    const text = await readFile(join(directory, (await readdir(directory))[0]!), 'utf8'); expect(text).not.toContain('sensitive'); expect(JSON.parse(text)).toMatchObject({ state: status >= 500 ? 'uncertain' : 'rejected', failure: { requiresReview: true } });
  });
  it.each([{}, { id: '' }, { id: 'fake\r\nheader' }, { id: 42 }, null])('does not invent a provider receipt for malformed success %j', async body => {
    const { attempts } = await store(); await expect(adapter(vi.fn(async () => Response.json(body))).sendDocument(preview(), approval(), 'key', attempts)).rejects.toMatchObject({ code: 'uncertain_send' });
  });
  it('reads token scopes without sending a message', async () => {
    const fetch = vi.fn(async () => Response.json({ scope: GMAIL_SEND_SCOPE })); expect(await adapter(fetch).readiness()).toEqual({ ready: true, scopeGranted: true });
    expect(fetch.mock.calls).toHaveLength(1); expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('https://oauth2.googleapis.com/tokeninfo?');
  });
  it('requires explicit Gmail grant and sender configuration', () => {
    const env = { GOOGLE_ACCESS_TOKEN: 'fixture', GOOGLE_GMAIL_FROM_EMAIL: 'sender@example.com' };
    expect(createDocumentSender(env).configured).toBe(false);
    expect(createDocumentSender({ ...env, GOOGLE_OAUTH_SCOPES: 'https://www.googleapis.com/auth/calendar.events' }).configured).toBe(false);
    expect(createDocumentSender({ ...env, GOOGLE_OAUTH_SCOPES: GMAIL_SEND_SCOPE }).configured).toBe(true);
  });
});
