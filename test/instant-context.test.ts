import { describe, expect, it, vi } from 'vitest';
import { instantIdentitySpans, tryInstantContext } from '../src/integrations/instant-context.ts';
import { JevDecisionGate, type JevAdapter } from '../src/integrations/jev.ts';
import type { AmbientInput } from '../src/core/providers.ts';

function input(text = "Hi, I'm Ada Lovelace.", isFinal = true): AmbientInput {
  return { anchor: { meetingId: 'm', revision: 1, correctionEpoch: 0, finalCount: isFinal ? 1 : 0, capturedAt: 1 }, meeting: { id: 'm', title: 'Meeting', participants: [] }, recentTranscript: [{ id: 's1', text, isFinal, revision: 0, capturedAt: '2026-09-27T00:00:00Z' }], evidence: [{ id: 'transcript:s1:0', text, label: 'Transcript', kind: 'transcript' }], operatorMessages: [] };
}
function gate(hold = false) {
  const batch = vi.fn<JevAdapter['batch']>().mockImplementation(async request => {
    if (!request.questions.action) return { model: 'fixture', answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, question.type === 'choice' ? { type: 'choice' as const, choice: Object.keys(question.criteria)[0]!, probabilities: Object.fromEntries(Object.keys(question.criteria).map((id, index) => [id, index === 0 ? 1 : 0])), confidence: 1 } : { type: 'noul' as const, noul: 1 }])), usage: { input_tokens: 1, output_tokens: 1 } };
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
    expect(instantIdentitySpans('Sajan Khosa, Liquid Energy')).toEqual(['Sajan Khosa, Liquid Energy']);
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
  it('normalizes only a literal company connective for consistent public lookup', async () => {
    const fixture = gate();
    const result = await tryInstantContext(fixture.gate, input("I'm Sajan Khosa from Liquid Energy."), signal());
    expect(result).toMatchObject({ kind: 'research', query: 'Sajan Khosa, Liquid Energy official company technology' });
  });
  it('preserves public company fragments and lowercase ASR without inventing a person', async () => {
    expect(instantIdentitySpans('Cosa from Liquid Energy.')).toEqual(['from Liquid Energy']);
    expect(instantIdentitySpans('From liquid energy, I’m years old.').at(-1)).toBe('from liquid energy');
    const fixture = gate();
    expect(await tryInstantContext(fixture.gate, input('Cosa from Liquid Energy.'), signal())).toMatchObject({kind:'research',query:'Liquid Energy official company technology'});
    expect(await tryInstantContext(fixture.gate, input("I'm marisol vega from northstar labs."), signal())).toMatchObject({kind:'research',query:'marisol vega, northstar labs official company technology'});
  });
  it('retains an introduction through short fillers but expires after sixty seconds', async () => {
    const fixture = gate(); const current=input('Cosa from Liquid Energy.');
    current.recentTranscript.push({id:'filler',revision:0,isFinal:true,text:'Um.',capturedAt:'2026-09-27T00:00:15Z'});
    current.evidence.push({id:'transcript:filler:0',kind:'transcript',text:'Um.',label:'Transcript'});
    expect(await tryInstantContext(fixture.gate,current,signal())).toMatchObject({kind:'research',query:'Liquid Energy official company technology',evidenceIds:['transcript:s1:0']});
    current.recentTranscript[1]!.capturedAt='2026-09-27T00:01:01Z';
    expect(await tryInstantContext(fixture.gate,current,signal())).toBeUndefined();
  });
  it('handles a later company-affiliation question after the earlier introduction expires', async () => {
    const fixture=gate(); const current=input('from liquid energy');
    current.evidence.push({id:'exa:company',kind:'external',label:'Liquid Energy',url:'https://liquidenergy.world/about',text:'Liquid Energy builds modular compute systems. We develop industrial cooling systems.'});
    const first=await tryInstantContext(fixture.gate,current,signal());
    expect(first).toMatchObject({kind:'cue'});
    const text='What company are you with liquid energy?';
    expect(instantIdentitySpans(text)).toEqual(['from liquid energy']);
    current.recentTranscript.push({id:'later',revision:0,isFinal:true,text,capturedAt:'2026-09-27T00:01:05Z'});
    current.evidence.push({id:'transcript:later:0',kind:'transcript',text,label:'Transcript'});
    const later=await tryInstantContext(fixture.gate,current,signal());
    expect(later).toMatchObject({kind:'cue',text:'Possible match: Liquid Energy — company claims\n• Builds modular compute systems\n• Develop industrial cooling systems'});
    expect(later?.authorization?.verify(current)).toBe(true);
    expect(instantIdentitySpans('He is the director of Northstar Labs.')).toEqual(['from Northstar Labs']);
  });
  it('retains a company topic through a 36-second filler but lets a held old topic yield to general judgment', async () => {
    const current=input('What company are you with liquid energy?');
    current.recentTranscript.push({id:'filler',revision:0,isFinal:true,text:'That’s',capturedAt:'2026-09-27T00:00:36Z'});
    current.evidence.push({id:'transcript:filler:0',kind:'transcript',text:'That’s',label:'Transcript'});
    const selected=await tryInstantContext(gate().gate,current,signal());
    expect(selected).toMatchObject({kind:'research',query:'liquid energy official company technology',evidenceIds:['transcript:s1:0']});
    const changed=structuredClone(current); changed.recentTranscript[1]!.text='Stop that company lookup. Prepare a PRD instead.';
    changed.evidence[1]!.text=changed.recentTranscript[1]!.text;
    expect(await tryInstantContext(gate(true).gate,changed,signal())).toBeUndefined();
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
    expect(result).toMatchObject({ kind: 'cue', text: `Possible match: Ada Lovelace\n• ${sentence.replace(/^Ada Lovelace /, '').replace(/\.$/, '').replace(/^./, value => value.toUpperCase())}`, evidenceIds: ['exa:1'] });
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
    expect(result).toMatchObject({ kind: 'cue', text: `Possible match: Ada Lovelace\n• ${sentence.replace(/^Ada Lovelace /, '').replace(/\.$/, '').replace(/^./, value => value.toUpperCase())}` });
    const overlong = input();
    overlong.evidence.push({ id: 'exa:2', kind: 'external', text: `Ada Lovelace ${'was repeatedly misquoted and '.repeat(6)}did not save $1.5 billion through the Analytical Engine.`, label: 'Ada biography', url: 'https://museum.org/ada' });
    expect(await tryInstantContext(fixture.gate, overlong, signal())).toBeUndefined();
  });
  it('lets Jev hold unrelated previous sources instead of treating a string match as identity proof', async () => {
    const fixture = gate(true); const current = input();
    current.evidence.push({ id: 'exa:old', kind: 'external', text: 'Grace Hopper developed an early computer compiler.', label: 'Grace Hopper biography', url: 'https://museum.org/other' });
    expect(await tryInstantContext(fixture.gate, current, signal())).toMatchObject({ kind: 'quiet' });
    expect(fixture.batch).toHaveBeenCalledTimes(2);
  });
  it('requests fresh company research when Jev rejects the previous profile sources', async () => {
    const fixture=gate(); const original=fixture.batch.getMockImplementation()!;
    fixture.batch.mockImplementation(async request => {
      const result=await original(request);
      if(request.questions.source?.type==='choice') {
        const keys=Object.keys(request.questions.source.criteria);
        result.answers.source={type:'choice',choice:'none',probabilities:Object.fromEntries(keys.map(key=>[key,key==='none'?1:0])),confidence:1};
      }
      return result;
    });
    const current=input('from liquid energy');
    current.evidence.push({id:'exa:old',kind:'external',label:'Ada Lovelace biography',text:'Ada Lovelace studied advanced mathematics.',url:'https://museum.org/ada'});
    const result=await tryInstantContext(fixture.gate,current,signal());
    expect(result).toMatchObject({kind:'research',query:'liquid energy official company technology',evidenceIds:['transcript:s1:0']});
    expect(result?.authorization?.verify(current)).toBe(true);
    const changed=structuredClone(current);changed.evidence[1]!.text='Changed previous source';
    expect(result?.authorization?.verify(changed)).toBe(false);
    expect(fixture.batch).toHaveBeenCalledTimes(1);
  });
  it('prefers the last repeated introduction and lets Jev validate an ASR spelling variant', async () => {
    const fixture = gate(); const current = input("Hi, I'm Gary Tatten. Let me try that again. I'm Gary Tan.");
    expect(await tryInstantContext(fixture.gate, current, signal())).toMatchObject({ kind: 'research', query: 'Gary Tan' });
    const sentence = 'Garry Tan is president and CEO of Y Combinator and a General Partner.';
    current.evidence.push({ id: 'exa:alias', kind: 'external', text: sentence, label: 'Garry Tan: YC Partner', url: 'https://www.ycombinator.com/people/garry-tan' });
    const result = await tryInstantContext(fixture.gate, current, signal());
    expect(result).toMatchObject({ kind: 'cue', text: `Possible match: Garry Tan\n• Is president and CEO of Y Combinator and a General Partner`, evidenceIds: ['exa:alias'] });
    expect(result?.authorization?.verify(current)).toBe(true);
    const q = fixture.batch.mock.calls[2]![0].questions.action!;
    expect(q.instructions).toContain('conflicting organization/role');
    expect(q.instructions).toContain('ASR spelling differences');
  });
  it('ranks source-supported education and prior ventures into short bullets with a strict final gate', async () => {
    const fixture = gate(); const current = input("I'm Marisol Vega, CEO of Northstar.");
    current.evidence.push({ id: 'exa:bio', kind: 'external', label: 'Marisol Vega biography', url: 'https://museum.org/marisol', text: 'Marisol Vega studied engineering at Eastlake. She co-founded Moonbeam. Marisol worked at Bluebird.' });
    const result = await tryInstantContext(fixture.gate, current, signal());
    expect(result).toMatchObject({ kind: 'cue', text: 'Possible match: Marisol Vega\n• Studied engineering at Eastlake\n• Co-founded Moonbeam\n• Worked at Bluebird', evidenceIds: ['exa:bio'] });
    expect(result?.authorization?.verify(current)).toBe(true);
    const questions = fixture.batch.mock.calls[0]![0].questions;
    expect(Object.entries(questions).filter(([key]) => key !== 'source').every(([, question]) => question.type === 'noul')).toBe(true);
    const final = fixture.batch.mock.calls[1]![0].questions.action!;
    expect(final.type === 'choice' && Object.keys(final.criteria)).toEqual(['fact_card', '__hold__']);
    const changed = structuredClone(current); changed.evidence[1]!.text += ' Correction.';
    expect(result?.authorization?.verify(changed)).toBe(false);
  });
  it('keeps company capabilities attributed to the company rather than the introduced person', async () => {
    const fixture = gate(); const current = input("Hi, I'm Marisol Vega from Northstar Labs.");
    current.evidence.push({ id: 'exa:company', kind: 'external', label: 'Northstar Labs', url: 'https://northstarlabs.org/about', text: 'Northstar Labs builds modular compute systems. We develop industrial cooling systems.' });
    const result = await tryInstantContext(fixture.gate, current, signal());
    expect(result).toMatchObject({ kind: 'cue', text: 'Possible match: Northstar Labs — company claims\n• Builds modular compute systems\n• Develop industrial cooling systems' });
    expect(result?.authorization?.verify(current)).toBe(true);
  });
  it('ranking never authorizes publication without the strict final gate', async () => {
    const fixture = gate(true); const current = input();
    current.evidence.push({ id: 'exa:bio', kind: 'external', label: 'Ada Lovelace biography', url: 'https://museum.org/ada', text: 'Ada Lovelace studied advanced mathematics.' });
    expect(await tryInstantContext(fixture.gate, current, signal())).toMatchObject({ kind: 'quiet' });
    expect(fixture.batch).toHaveBeenCalledTimes(2);
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
