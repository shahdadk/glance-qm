import { afterEach, expect, test, vi } from 'vitest';
import { createAmbientProviders } from '../src/integrations/ambient.ts';

const env = { GBRAIN_MCP_URL: 'https://memory.test/mcp', GBRAIN_BEARER_TOKEN: 'fixture', GBRAIN_SAVE_SUMMARY_TOOL: 'put_page', GBRAIN_GET_PAGE_TOOL: 'get_page' };
const input = (revision = 1) => ({ meetingId: 'fixture-checkpoint', title: 'Synthetic checkpoint', transcript: [], summary: { text: `Checkpoint ${revision}`, decisions: [], openQuestions: [], owners: [], nextSteps: [], revision, createdAt: '2026-09-27T12:00:00Z' } });
const signal = () => new AbortController().signal;
function memory(options: { readStatus?: number; readError?: string; conflict?: boolean; loseFirstReply?: boolean; corruptReadback?: boolean } = {}) {
  let page: { content: string; revision: string } | undefined;
  const writes: Record<string, unknown>[] = [];
  const reads: Record<string, unknown>[] = [];
  const receipts = new Map<string, unknown>();
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26' };
    else if (request.method === 'tools/list') result = { tools: [
      { name: 'get_page', inputSchema: { properties: { slug: {}, source_id: {}, include_content: {} }, required: ['slug'] } },
      { name: 'put_page', inputSchema: { properties: { slug: {}, source_id: {}, content: {}, request_id: {}, expected_revision: {} }, required: ['slug', 'content'] } },
    ] };
    else {
      const args = request.params.arguments;
      expect(args.source_id).toBe('glance-demo');
      expect(args.slug).toBe('chan-glance-demo/meetings/fixture-checkpoint');
      if (request.params.name === 'get_page') {
        reads.push(args);
        expect(args.include_content).toBe(true);
        if (options.readStatus) return new Response(null, { status: options.readStatus });
        result = options.readError || !page
          ? { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: options.readError ?? 'page_not_found' }) }] }
          : { content: [{ type: 'text', text: JSON.stringify(options.corruptReadback ? { ...page, content: 'wrong content' } : page) }] };
      } else {
        writes.push(args);
        const key = String(args.request_id);
        if (receipts.has(key)) {
          expect(args).toEqual(writes[0]);
          result = receipts.get(key);
        } else if (options.conflict || (page ? args.expected_revision !== page.revision : args.expected_revision !== undefined)) {
          result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'revision_conflict' }) }] };
        } else {
          page = { content: args.content, revision: `rev-${writes.length}` };
          result = { content: [{ type: 'text', text: JSON.stringify({ state: 'committed', request_id: key, outcome: { revision: page.revision } }) }] };
          receipts.set(key, result);
          if (options.loseFirstReply && writes.length === 1) throw new Error('Fixture lost acknowledgement');
        }
      }
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
  }));
  return { writes, reads };
}
afterEach(() => vi.unstubAllGlobals());

test('creates, replaces the same scoped page with its revision, and deduplicates a verified repeat', async () => {
  const { writes, reads } = memory();
  const providers = createAmbientProviders(env);
  await providers.saveSummary(input(1), signal());
  await providers.saveSummary(input(2), signal());
  await providers.saveSummary(input(2), signal());
  expect(writes).toHaveLength(2);
  expect(writes[0]).not.toHaveProperty('expected_revision');
  expect(writes[1]).toHaveProperty('expected_revision', 'rev-1');
  expect(writes[1]?.request_id).not.toBe(writes[0]?.request_id);
  expect(writes[1]?.content).toContain('Checkpoint 2');
  expect(reads).toHaveLength(5);
});

test('replays exact original arguments after a lost committed response', async () => {
  const { writes } = memory({ loseFirstReply: true });
  const providers = createAmbientProviders(env);
  await expect(providers.saveSummary(input(), signal())).rejects.toMatchObject({ code: 'unavailable' });
  await expect(providers.saveSummary(input(), signal())).resolves.toHaveProperty('id');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

test('rejects revision conflicts without forcing an overwrite', async () => {
  const options = { conflict: false };
  const { writes } = memory(options);
  const providers = createAmbientProviders(env);
  await providers.saveSummary(input(1), signal());
  options.conflict = true;
  await expect(providers.saveSummary(input(2), signal())).rejects.toMatchObject({ code: 'tool_error' });
  expect(writes[1]).toHaveProperty('expected_revision', 'rev-1');
  expect(writes[1]).not.toHaveProperty('force');
});

test.each([401, 403, 404, 503])('does not treat HTTP %s as a missing page', async readStatus => {
  const { writes } = memory({ readStatus });
  await expect(createAmbientProviders(env).saveSummary(input(), signal())).rejects.toBeDefined();
  expect(writes).toHaveLength(0);
});

test('does not treat an authorization tool error as a missing page', async () => {
  const { writes } = memory({ readError: 'permission_denied' });
  await expect(createAmbientProviders(env).saveSummary(input(), signal())).rejects.toMatchObject({ code: 'tool_error' });
  expect(writes).toHaveLength(0);
});

test('does not report success when the committed page readback differs', async () => {
  memory({ corruptReadback: true });
  await expect(createAmbientProviders(env).saveSummary(input(), signal())).rejects.toMatchObject({ code: 'protocol_error' });
});
