import { describe, expect, it } from 'vitest';
import { IntegrationError, type Fetch } from '../src/integrations/http.ts';
import {
  buildMemorableTrace,
  MemorableClient,
  type MemorableCommandRunner,
  type MemorableWorkflow,
} from '../src/integrations/memorable.ts';

const workflow: MemorableWorkflow = {
  sessionId: 'meeting-with-raw-identifiers@example.com',
  actions: [
    { type: 'save_summary', verified: true, id: 'summary-secret-id' },
    { type: 'create_document', verified: true, status: 'completed' },
    { type: 'send_calendar', verified: true, ok: true },
  ],
};

describe('Memorable integration', () => {
  it('constructs only hashed IDs and abstract allow-listed steps', () => {
    const trace = buildMemorableTrace(workflow);

    expect(trace.session_id).not.toContain('meeting-with-raw-identifiers');
    expect(JSON.stringify(trace)).not.toContain('example.com');
    expect(JSON.stringify(trace)).not.toContain('summary-secret-id');
    expect(trace.harness).toBe('glance-qm');
    expect(trace.tool_calls).toEqual([
      { name: 'save_summary', input: { command: 'save meeting summary' }, result: { ok: true } },
      { name: 'verify_summary', input: { command: 'verify persisted summary revision' }, result: { ok: true } },
      { name: 'create_document', input: { command: 'create document' }, result: { ok: true } },
      { name: 'verify_document', input: { command: 'verify persisted document' }, result: { ok: true } },
      { name: 'send_calendar', input: { command: 'send calendar invitation' }, result: { ok: true } },
      { name: 'verify_calendar', input: { command: 'verify calendar invitation readback' }, result: { ok: true } },
    ]);
  });

  it('rejects failed or unknown action types before invoking the CLI', async () => {
    const calls: string[][] = [];
    const runner: MemorableCommandRunner = async (_executable, args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const client = new MemorableClient({ runner });

    await expect(client.storeSuccessfulWorkflow({ sessionId: 's', actions: [{ type: 'send_calendar', status: 'uncertain', verified: true }] })).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(client.storeSuccessfulWorkflow({ sessionId: 's', actions: [{ type: 'save_summary' }] })).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(client.storeSuccessfulWorkflow({ sessionId: 's', actions: ['save_summary' as never] })).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(client.storeSuccessfulWorkflow({ sessionId: 's', actions: [{ type: 'save_summary', ok: true }, { type: 'delete_everything' as never }] })).rejects.toMatchObject({ code: 'protocol_error' });
    expect(calls).toEqual([]);
  });

  it('reports saved only after ingest and list readback prove the slug', async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const runner: MemorableCommandRunner = async (_executable, args, options) => {
      calls.push({ args: [...args], ...(options.input !== undefined ? { input: options.input } : {}) });
      if (args[0] === 'ingest') return { exitCode: 0, stdout: 'memorable: stored procedures/abc-safe-workflow, semantic recall unavailable\n', stderr: '' };
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ intent: 'successful-qm-workflow', preferred: 'procedures/abc-safe-workflow', revisions: [{ slug: 'procedures/abc-safe-workflow', revision: 1, verified: true }] }]),
        stderr: '',
      };
    };
    const client = new MemorableClient({ executable: '/isolated/memorable', home: '/isolated/memorable-home', runner });
    const result = await client.storeSuccessfulWorkflow(workflow);

    expect(result.status).toBe('saved');
    if (result.status === 'saved') expect(result.slug).toBe('procedures/abc-safe-workflow');
    expect(calls.map(call => call.args)).toEqual([['ingest', '-'], ['list', '--json']]);
    const sent = JSON.parse(calls[0]?.input ?? '{}') as Record<string, unknown>;
    expect(sent).toEqual(expect.objectContaining({ harness: 'glance-qm', tool_calls: expect.any(Array) }));
    expect(sent).not.toHaveProperty('corpus');
    expect(JSON.stringify(sent)).not.toContain('example.com');
    expect(JSON.stringify(sent)).not.toContain('summary-secret-id');
  });

  it('does not trust an exit-zero queue or refusal as a save', async () => {
    const runner: MemorableCommandRunner = async (_executable, args) => {
      if (args[0] === 'ingest') return { exitCode: 0, stdout: 'memorable: extraction refused; queued for later\n', stderr: '' };
      throw new Error('list must not run without a stored slug');
    };
    const client = new MemorableClient({ runner });
    await expect(client.storeSuccessfulWorkflow({ sessionId: 's', actions: [{ type: 'save_summary', verified: true }] })).resolves.toMatchObject({ status: 'pending' });
  });

  it('recalls a query and reads the returned slug using separate argv entries', async () => {
    const calls: string[][] = [];
    const runner: MemorableCommandRunner = async (_executable, args) => {
      calls.push([...args]);
      if (args[0] === 'recall') return { exitCode: 0, stdout: '0.991 procedures/abc-safe-workflow [lexical]\n', stderr: '' };
      return { exitCode: 0, stdout: '---\ntitle: Safe workflow\n---\n', stderr: '' };
    };
    const client = new MemorableClient({ runner });
    const result = await client.recall('successful QM workflow: save_summary');

    expect(result).toMatchObject({ status: 'found', slug: 'procedures/abc-safe-workflow' });
    expect(calls).toEqual([
      ['recall', 'successful QM workflow: save_summary'],
      ['show', 'procedures/abc-safe-workflow'],
    ]);
  });

  it('returns an extraction draft and request ID without pretending it was stored', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetch: Fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ draft: { title: 'Safe workflow', steps: [] }, request_id: 'req-safe-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new MemorableClient({ apiKey: 'mk_test_key', extractionUrl: 'http://127.0.0.1:8787/v1/extract', fetch });
    const result = await client.extractDraft(workflow);

    expect(result).toEqual({ draft: { title: 'Safe workflow', steps: [] }, request_id: 'req-safe-1' });
    expect(result).not.toHaveProperty('saved');
    expect(requestBody).toEqual(expect.objectContaining({ skip_embedding: true, harness: 'glance-qm' }));
    expect(requestBody).not.toHaveProperty('corpus');
    expect(JSON.stringify(requestBody)).not.toContain('example.com');
  });

  it('maps a missing configured binary to IntegrationError unavailable', async () => {
    const client = new MemorableClient({ executable: '/definitely/missing/memorable', timeoutMs: 500 });
    await expect(client.recall('successful QM workflow')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.recall('authorization: Bearer secret')).rejects.toMatchObject({ code: 'protocol_error' });
    expect(client).toBeInstanceOf(MemorableClient);
    expect(new IntegrationError('not_configured', 'test')).toBeInstanceOf(Error);
  });
});
