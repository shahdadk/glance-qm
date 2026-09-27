import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ExaClient, publicResearchQuery } from '../src/integrations/exa.ts';
const fixture = (results: unknown[]) => new Response(JSON.stringify({ results }));
const row = (url = 'https://docs.nodejs.org/api/stream.html', text = 'Actual source text') => ({ title: 'Streams', url, text });
const client = (results: unknown[]) => new ExaClient({ apiKey: 'fixture', fetch: async () => fixture(results) });

test('Exa sends documented bounded search and preserves actual source content/provenance', async () => {
  const exa = new ExaClient({ apiKey: 'fixture', fetch: async (url, init) => {
    assert.equal(url, 'https://api.exa.ai/search'); assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'fixture');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), { query: 'Node streams backpressure', type: 'fast', numResults: 4, contents: { text: { maxCharacters: 3000 }, livecrawlTimeout: 1000 } });
    return fixture([row()]);
  }});
  const [evidence] = await exa.search(' Node streams backpressure ');
  assert.equal(evidence?.text, 'Actual source text'); assert.equal(evidence?.kind, 'external');
  assert.equal(evidence?.url, row().url); assert.match(evidence!.id, /^exa:[a-f0-9]{32}$/);
  assert.equal(exa.getProvenance(evidence!.id)?.contentHash.length, 64);
  assert.ok(!Number.isNaN(Date.parse(exa.getProvenance(evidence!.id)!.retrievedAt)));
});
test('Exa ignores malformed and contentless results and accepts exact highlights', async () => {
  const evidence = await client([null, {}, {title:'Only title',url:row().url}, {url:row().url,text:34,summary:'Not evidence'}, {url:row().url,highlights:['Exact highlight',null,'Second']}]).search('streams');
  assert.equal(evidence.length, 1); assert.equal(evidence[0]?.text, 'Exact highlight\nSecond');
  assert.deepEqual(await client([]).search('streams'), []);
});
test('Exa rejects non-public URLs, credentials and IP literals', async () => {
  const urls = ['file:///etc/passwd', 'javascript:alert(1)', 'https://localhost/a', 'http://127.0.0.1/a', 'http://2130706433/a', 'http://[::1]/a', 'http://10.1.2.3/a', 'https://service.internal/a', 'https://a.local/a', 'https://user:pass@example.org/a', 'https://example.org:8000/a'];
  assert.deepEqual(await client(urls.map(url=>row(url))).search('streams'), []);
});
test('Exa bounds source count/text and IDs are canonical, content-bound, deduplicated', async () => {
  const results = [row('https://EXAMPLE.org:443/a#one','x'.repeat(4000)), row('https://example.org/a#two','x'.repeat(4000)), ...Array.from({length:7}, (_,i)=>row(`https://example.org/${i}`))];
  const evidence = await client(results).search('streams');
  assert.equal(evidence.length, 4); assert.equal(evidence[0]?.text.length, 3000);
  const same = await client([row('https://example.org/a','x'.repeat(4000))]).search('streams');
  assert.equal(evidence[0]?.id, same[0]?.id);
  const changed = await client([row('https://example.org/a','changed')]).search('streams');
  assert.notEqual(evidence[0]?.id, changed[0]?.id);
});
for (const [status, code] of [[401,'authentication'],[403,'authentication'],[402,'quota'],[429,'quota'],[500,'unavailable']] as const) {
  test(`Exa classifies ${status}, makes one attempt and never exposes provider body`, async () => {
    let calls = 0;
    const exa = new ExaClient({apiKey:'fixture',fetch:async()=>{ calls++; return new Response('private-provider-body', {status}); }});
    await assert.rejects(exa.search('streams'), {code, message:`Exa returned HTTP ${status}`}); assert.equal(calls,1);
  });
}
test('Exa handles invalid envelope, JSON, excessive response and transport failure', async () => {
  for (const body of ['{}','not json',JSON.stringify({results:[row(undefined,'x'.repeat(260000))]})]) {
    await assert.rejects(new ExaClient({apiKey:'fixture',fetch:async()=>new Response(body)}).search('streams'), {code:'invalid_response'});
  }
  await assert.rejects(new ExaClient({apiKey:'fixture',fetch:async()=>{throw new Error('secret');}}).search('streams'), {code:'unavailable',message:'Exa research is unavailable'});
});
test('Exa rejects missing keys and obvious private query payloads before transport', async () => {
  await assert.rejects(new ExaClient({}).search('streams'),{code:'unconfigured'});
  for (const input of ['', 'x'.repeat(241), 'Contact person@example.org', 'https://internal.example/a', 'password=private', 'first\nsecond']) assert.throws(()=>publicResearchQuery(input), {code:'invalid_query'});
});
test('Exa propagates cancellation and enforces bounded timeout', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client([]).search('streams',controller.signal), {code:'aborted'});
  const pending: typeof fetch = async (_url, init) => await new Promise((_resolve, reject)=>{
    init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});
  });
  await assert.rejects(new ExaClient({apiKey:'fixture',timeoutMs:10,fetch:pending}).search('streams'), {code:'timeout'});
  const ongoing = new AbortController(); const result = new ExaClient({apiKey:'fixture',fetch:pending}).search('streams',ongoing.signal);
  ongoing.abort(); await assert.rejects(result,{code:'aborted'});
});
