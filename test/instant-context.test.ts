import { describe, expect, it, vi } from 'vitest';
import { instantIdentitySpans, tryInstantContext } from '../src/integrations/instant-context.ts';
import { JevDecisionGate, type JevAdapter } from '../src/integrations/jev.ts';
import type { AmbientInput } from '../src/core/providers.ts';

function input(text = "Hi, I'm Ada Lovelace.", isFinal = true): AmbientInput {
  return { anchor: { meetingId: 'm', revision: 1, correctionEpoch: 0, finalCount: isFinal ? 1 : 0, capturedAt: 1 }, meeting: { id: 'm', title: 'Meeting', participants: [] }, recentTranscript: [{ id: 's1', text, isFinal, revision: 0, capturedAt: '2026-09-27T00:00:00Z' }], evidence: [{ id: 'transcript:s1:0', text, label: 'Transcript', kind: 'transcript' }], operatorMessages: [] };
}
function gate(hold = false) {
  const batch = vi.fn<JevAdapter['batch']>().mockImplementation(async request => {
    const q = request.questions.action!;
    if (q.type !== 'choice') throw new Error('Expected choice');
    const keys = Object.keys(q.criteria);
    const choice = hold ? '__hold__' : keys[0]!;
    return { model: 'fixture', answers: { action: { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])), confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  return { gate: new JevDecisionGate({ configured: () => true, batch }), batch };
}
const signal = () => new AbortController().signal;

describe('bounded literal identity candidates', () => {
  it('extracts general verbatim names and organization context without fixed identities', () => {
    expect(instantIdentitySpans("Hi, I'm Ada Lovelace. I work here.")).toEqual(['Ada Lovelace']);
    expect(instantIdentitySpans('This is Marisol Vega from Northstar.')).toEqual(['Marisol Vega from Northstar']);
    expect(instantIdentitySpans('Meet Alex at Brightwave.')).toEqual(['Alex at Brightwave']);
  });
  it('does not guess from a first name, arbitrary task text, or appearance', () => {
    for (const text of ["I'm Alex.", "I'm drafting a proposal.", 'The face looks like Ada Lovelace.', 'Discuss Ada Lovelace.']) expect(instantIdentitySpans(text)).toEqual([]);
  });
});

describe('native instant context', () => {
  it('lets Jev select the research action and attaches a snapshot-bound receipt', async () => {
    const fixture = gate(); const original = input();
    const result = await tryInstantContext(fixture.gate, original, signal());
    expect(result).toMatchObject({ kind: 'research', query: 'Ada Lovelace', evidenceIds: ['transcript:s1:0'] });
    expect(result?.authorization?.verify(original)).toBe(true);
    expect(result?.authorization?.verify({ ...original, anchor: { ...original.anchor, correctionEpoch: 1 } })).toBe(false);
    expect(fixture.batch).toHaveBeenCalledTimes(1);
  });
  it('holds when Jev rejects an enumerated span; regex does not authorize research', async () => {
    const fixture = gate(true);
    expect(await tryInstantContext(fixture.gate, input('This is Not Ada Lovelace.'), signal())).toMatchObject({ kind: 'quiet' });
  });
  it('selects a verbatim short source fact and binds the entire source evidence', async () => {
    const fixture = gate(); const enriched = input();
    const sentence = 'Ada Lovelace wrote an algorithm for the Analytical Engine.';
    enriched.evidence.push({ id: 'exa:1', kind: 'external', text: sentence, label: 'Ada Lovelace biography', url: 'https://museum.org/ada' });
    const result = await tryInstantContext(fixture.gate, enriched, signal());
    expect(result).toMatchObject({ kind: 'cue', text: `Possible match: ${sentence}`, evidenceIds: ['exa:1'] });
    expect(result?.authorization?.verify(enriched)).toBe(true);
    const changed = structuredClone(enriched); changed.evidence[1]!.text = 'Changed source';
    expect(result?.authorization?.verify(changed)).toBe(false);
    if (result?.kind === 'cue') expect(result.text.length).toBeLessThanOrEqual(160);
  });
  it('omits long sentences intact and falls through rather than truncating qualifications', async () => {
    const fixture = gate(); const enriched = input();
    enriched.evidence.push({ id: 'exa:1', kind: 'external', text: `Ada Lovelace ${'carefully qualified historical claim '.repeat(6)}.`, label: 'Ada biography', url: 'https://museum.org/ada' });
    expect(await tryInstantContext(fixture.gate, enriched, signal())).toBeUndefined();
    expect(fixture.batch).not.toHaveBeenCalled();
  });
  it('preserves decimals and negation instead of restarting at an internal period', async () => {
    const fixture = gate(); const enriched = input();
    const sentence = 'Ada Lovelace did not save $1.5 billion through the Analytical Engine.';
    enriched.evidence.push({ id: 'exa:1', kind: 'external', text: sentence, label: 'Ada Lovelace biography', url: 'https://museum.org/ada' });
    const result = await tryInstantContext(fixture.gate, enriched, signal());
    expect(result).toMatchObject({ kind: 'cue', text: `Possible match: ${sentence}` });
    const overlong = input();
    overlong.evidence.push({ id: 'exa:2', kind: 'external', text: `Ada Lovelace ${'was repeatedly misquoted and '.repeat(6)}did not save $1.5 billion through the Analytical Engine.`, label: 'Ada biography', url: 'https://museum.org/ada' });
    expect(await tryInstantContext(fixture.gate, overlong, signal())).toBeUndefined();
  });
  it('lets Jev hold unrelated previous sources instead of treating a string match as identity proof', async () => {
    const fixture = gate(true); const current = input();
    current.evidence.push({ id: 'exa:old', kind: 'external', text: 'Grace Hopper developed an early computer compiler.', label: 'Grace Hopper biography', url: 'https://museum.org/other' });
    expect(await tryInstantContext(fixture.gate, current, signal())).toMatchObject({ kind: 'quiet' });
    expect(fixture.batch).toHaveBeenCalledTimes(1);
  });
  it('prefers the last repeated introduction and lets Jev validate an ASR spelling variant', async () => {
    const fixture = gate(); const current = input("Hi, I'm Gary Tatten. Let me try that again. I'm Gary Tan.");
    expect(await tryInstantContext(fixture.gate, current, signal())).toMatchObject({ kind: 'research', query: 'Gary Tan' });
    const sentence = 'Garry Tan is president and CEO of Y Combinator and a General Partner.';
    current.evidence.push({ id: 'exa:alias', kind: 'external', text: sentence, label: 'Garry Tan: YC Partner', url: 'https://www.ycombinator.com/people/garry-tan' });
    const result = await tryInstantContext(fixture.gate, current, signal());
    expect(result).toMatchObject({ kind: 'cue', text: `Possible match: ${sentence}`, evidenceIds: ['exa:alias'] });
    expect(result?.authorization?.verify(current)).toBe(true);
    const q = fixture.batch.mock.calls[1]![0].questions.action!;
    expect(q.instructions).toContain('conflicting organization/role');
    expect(q.instructions).toContain('ASR spelling differences');
  });
  it('never publishes partial speech, but explicitly authorized prefetch can select research only', async () => {
    const fixture = gate(); const partial = input(undefined, false);
    expect(await tryInstantContext(fixture.gate, partial, signal())).toBeUndefined();
    partial.evidence.push({ id: 'exa:1', kind: 'external', text: 'Ada Lovelace wrote an algorithm for the Analytical Engine.', label: 'Ada Lovelace biography', url: 'https://museum.org/ada' });
    expect(await tryInstantContext(fixture.gate, partial, signal(), { allowPartial: true, researchOnly: true })).toMatchObject({ kind: 'research' });
    // Even a caller forgetting researchOnly cannot publish from tentative speech.
    expect(await tryInstantContext(fixture.gate, partial, signal(), { allowPartial: true })).toMatchObject({ kind: 'research' });
    const sent = fixture.batch.mock.calls[0]![0].state as { snapshot: AmbientInput };
    expect(sent.snapshot.recentTranscript[0]!.isFinal).toBe(false);
  });
  it('falls through non-introductions, finalization and mismatched transcript evidence', async () => {
    const fixture = gate();
    expect(await tryInstantContext(fixture.gate, input('Please write a PRD.'), signal())).toBeUndefined();
    expect(await tryInstantContext(fixture.gate, { ...input(), purpose: 'finalization' }, signal())).toBeUndefined();
    const bad = input(); bad.evidence[0]!.text = 'Different transcript';
    expect(await tryInstantContext(fixture.gate, bad, signal())).toBeUndefined();
    expect(fixture.batch).not.toHaveBeenCalled();
  });
});
