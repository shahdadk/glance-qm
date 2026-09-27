import { describe, expect, it, vi } from 'vitest';
import { createJevAdapter, JevDecisionGate, JevError, JEV_HOLD_ID, parseJevResponse, type JevAdapter, type JevDecisionInput, type JevRequest, type JevResponse } from '../src/integrations/jev.js';

const questions: JevRequest['questions'] = { department: {
  type: 'choice', instructions: 'Which team should handle this?',
  criteria: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages, integrations', sales: 'Pricing, upgrades, new accounts' },
} };
// Exact response example from https://docs.typesafe.ai/api (2026-09-27), not a live receipt.
const officialFixture: JevResponse = {
  model: 'jev-1.13.0', answers: { department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 }, confidence: 0.81 } },
  usage: { input_tokens: 318, output_tokens: 34 },
};
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
function gateInput(): JevDecisionInput {
  return { snapshot: { meetingId: 'm1', revision: 4, evidence: [{ id: 'e1', text: 'Please calculate 15 * 8.' }] }, candidates: [
    { id: 'calculate', description: 'Calculate the requested amount', payload: { kind: 'calculate', expression: '15 * 8', evidenceIds: ['e1'] } },
    { id: 'quiet', description: 'Remain quiet', payload: { kind: 'quiet', reason: 'No help needed' } },
  ], instructions: 'Select the appropriate next action supported by the meeting evidence.' };
}
function decisionResponse(choice = 'calculate', confidence = 0.95): JevResponse {
  return { model: 'jev-1.13.0', answers: { action: { type: 'choice', choice, confidence, probabilities: { calculate: choice === 'calculate' ? 0.96 : 0.02, quiet: choice === 'quiet' ? 0.96 : 0.02, [JEV_HOLD_ID]: choice === JEV_HOLD_ID ? 0.96 : 0.02 } } }, usage: { input_tokens: 12, output_tokens: 4 } };
}
function fakeAdapter(result = decisionResponse()): JevAdapter { return { configured: () => true, batch: async () => result }; }

describe('direct TypeSafe HTTP adapter', () => {
  it('uses the exact documented endpoint, map contract and bearer authentication', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(officialFixture));
    const adapter = createJevAdapter({ apiKey: 'synthetic-test-key', fetch: fetchMock });
    expect(await adapter.batch({ state: 'Help! My payouts have been failing for 3 days.', questions })).toEqual(officialFixture);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer synthetic-test-key', 'Content-Type': 'application/json' } });
    expect(JSON.parse(init!.body as string)).toEqual({ model: 'jev-1.13.0', state: 'Help! My payouts have been failing for 3 days.', questions });
  });
  it('batches independent Choice, Score and Noul against one state', async () => {
    const all: JevRequest['questions'] = { ...questions, urgency: { type: 'noul', instructions: 'Is this urgent?' }, frustration: { type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Frustrated', 'Very angry'] } };
    const raw = { ...officialFixture, answers: { ...officialFixture.answers, urgency: { type: 'noul', noul: 0.95 }, frustration: { type: 'score', score: 1.05, legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' }, probabilities: { '0': 0, '1': 0.95, '2': 0.05 }, confidence: 0.92 } } };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(raw));
    expect((await createJevAdapter({ apiKey: 'test', fetch: fetchMock }).batch({ state: { text: 'urgent' }, questions: all })).answers).toEqual(raw.answers);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    { type: 'choice', choice: 'billing', probabilities: { billing: 88, technical: 12, sales: 0 }, confidence: 81 },
    { type: 'choice', choice: 'billing', probabilities: { billing: 0.88, technical: 0.12 }, confidence: 0.81 },
    { type: 'choice', choice: 'billing', probabilities: { billing: 0.5, technical: 0.12, sales: 0 }, confidence: 0.81 },
    { type: 'choice', choice: 'outside', probabilities: { billing: 0.88, technical: 0.12, sales: 0 }, confidence: 0.81 },
    { type: 'choice', choice: 'technical', probabilities: { billing: 0.88, technical: 0.12, sales: 0 }, confidence: 0.81 },
    { type: 'noul', noul: 0.81 },
  ])('fails closed on malformed answer %# without unit conversion', answer => {
    expect(() => parseJevResponse({ ...officialFixture, answers: { department: answer } }, questions)).toThrow(JevError);
  });
  it('rejects missing answers and malformed JSON', async () => {
    expect(() => parseJevResponse({ ...officialFixture, answers: {} }, questions)).toThrow(JevError);
    const adapter = createJevAdapter({ apiKey: 'test', fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{')) });
    await expect(adapter.batch({ state: '', questions })).rejects.toMatchObject({ kind: 'invalid' });
  });
  it('does not call the network when unconfigured or already cancelled', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(createJevAdapter({ apiKey: '', fetch: fetchMock }).batch({ state: '', questions })).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(createJevAdapter({ apiKey: 'test', fetch: fetchMock }).batch({ state: '', questions }, AbortSignal.abort())).rejects.toMatchObject({ kind: 'deadline' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('stops at its deadline even when fetch ignores abort; never retries', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
      const task = createJevAdapter({ apiKey: 'test', fetch: fetchMock, deadlineMs: 1500 }).batch({ state: '', questions });
      const assertion = expect(task).rejects.toMatchObject({ kind: 'deadline' });
      await vi.advanceTimersByTimeAsync(1500);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('redacts HTTP bodies and network errors and does not retry rate limits', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ secret: 'never-display-this' }, 429));
    await expect(createJevAdapter({ apiKey: 'test', fetch: fetchMock }).batch({ state: '', questions })).rejects.toMatchObject({ kind: 'unavailable', message: 'Jev request failed with HTTP 429' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRejectedValue(new Error('secret-key-in-url'));
    await expect(createJevAdapter({ apiKey: 'test', fetch: fetchMock }).batch({ state: '', questions })).rejects.toMatchObject({ message: 'Jev request could not be completed' });
  });
});

describe('judgment-first candidate gate', () => {
  it('sends candidate payloads and an explicit hold option and binds the selected payload', async () => {
    const input = gateInput();
    const batch = vi.fn<JevAdapter['batch']>().mockResolvedValue(decisionResponse());
    const gate = new JevDecisionGate({ configured: () => true, batch });
    const decision = await gate.decide(input);
    expect(batch.mock.calls[0]![0].state).toEqual({ snapshot: input.snapshot, candidates: input.candidates });
    expect(batch.mock.calls[0]![0].questions.action).toMatchObject({ type: 'choice', criteria: { calculate: { payload: input.candidates[0]!.payload }, [JEV_HOLD_ID]: expect.any(String) } });
    expect(decision.status).toBe('selected');
    if (decision.status !== 'selected') throw new Error('Expected selection');
    expect(decision.selectedCandidateId).toBe('calculate');
    expect(decision.receipt.answer.probabilities).toEqual({ calculate: 0.96, quiet: 0.02, __hold__: 0.02 });
    expect(gate.verify(decision.receipt, input)).toBe(true);
    expect(gate.verify({ ...decision.receipt, selectedCandidateId: 'quiet' }, input)).toBe(false);
    expect(gate.verify(decision.receipt, { ...input, snapshot: { revision: 5 } })).toBe(false);
    expect(gate.verify(decision.receipt, { ...input, candidates: input.candidates.map(c => ({ ...c, payload: { kind: 'calendar' } })) })).toBe(false);
    expect(gate.verify(decision.receipt, { ...input, instructions: 'Do something else' })).toBe(false);
    expect(new JevDecisionGate(fakeAdapter()).verify(decision.receipt, input)).toBe(false);
  });
  it.each([[JEV_HOLD_ID, 0.95], ['calculate', 0.4]])('holds choice %s at confidence %s', async (choice, confidence) => {
    const decision = await new JevDecisionGate(fakeAdapter(decisionResponse(choice as string, confidence as number))).decide(gateInput());
    expect(decision.status).toBe('hold');
    expect(decision).not.toHaveProperty('receipt');
  });
  it('rejects unknown candidate IDs, duplicate IDs and incomplete fake adapter answers', async () => {
    const input = gateInput();
    expect((await new JevDecisionGate(fakeAdapter()).decide({ ...input, candidates: [input.candidates[0]!, input.candidates[0]!] })).status).toBe('invalid');
    const bad = decisionResponse();
    bad.answers.action = { type: 'choice', choice: 'calculate', confidence: 1, probabilities: { calculate: 1 } };
    expect((await new JevDecisionGate(fakeAdapter(bad)).decide(input)).status).toBe('invalid');
  });
  it('rejects input mutation during inference and core freshness failure', async () => {
    const input = gateInput();
    const gate = new JevDecisionGate({ configured: () => true, batch: async () => { (input.snapshot as { revision: number }).revision++; return decisionResponse(); } });
    expect((await gate.decide(input)).status).toBe('stale');
    expect((await new JevDecisionGate(fakeAdapter()).decide({ ...gateInput(), isCurrent: () => false })).status).toBe('stale');
  });
  it('expires receipts and rejects cancellation, unavailable and deadline outcomes', async () => {
    let now = 10;
    const input = gateInput();
    const gate = new JevDecisionGate(fakeAdapter(), { now: () => now, receiptTtlMs: 100 });
    const decision = await gate.decide(input);
    if (decision.status !== 'selected') throw new Error('Expected selection');
    now = 110;
    expect(gate.verify(decision.receipt, input)).toBe(false);
    expect((await gate.decide(input, AbortSignal.abort())).status).toBe('deadline');
    expect((await new JevDecisionGate(createJevAdapter({ apiKey: '' })).decide(input)).status).toBe('unavailable');
    const failing: JevAdapter = { configured: () => true, batch: async () => { throw new JevError('deadline', 'Timed out'); } };
    expect((await new JevDecisionGate(failing).decide(input)).status).toBe('deadline');
  });
});
