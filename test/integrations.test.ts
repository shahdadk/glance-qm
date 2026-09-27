import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signQmRequest, QmClient } from '../src/integrations/qm.ts';
import { GBrainClient } from '../src/integrations/gbrain.ts';
import { GoogleCalendarAdapter, prepareCalendar, type CalendarAttemptStore } from '../src/integrations/calendar.ts';
import { parseSse } from '../src/integrations/sse.ts';
const fixture = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function chunks(text: string): ReadableStream<Uint8Array> { const bytes = new TextEncoder().encode(text); return new ReadableStream({ start(controller) { for (let at = 0; at < bytes.length; at += 3) controller.enqueue(bytes.slice(at, at + 3)); controller.close(); } }); }
test('QM source signing covers exact query and serialized body', () => {
  const body = JSON.stringify({ text: 'hello\nworld' });
  const actual = signQmRequest('fixture-secret', 'POST', '/v1/turns?async=1', body, 123);
  assert.equal(actual['x-signature'], `v0=${createHmac('sha256','fixture-secret').update(`v0:123:POST\n/v1/turns?async=1\n${body}`).digest('hex')}`);
  assert.notEqual(actual['x-signature'], signQmRequest('fixture-secret','POST','/v1/turns',body,123)['x-signature']);
});
test('SSE handles fragmented Unicode, CRLF, comments and multiline data', async () => {
  const output = []; for await (const event of parseSse(chunks(': ping\r\nid: abc\r\ndata: héllo\r\ndata: world\r\n\r\ndata: incomplete'))) output.push(event);
  assert.deepEqual(output, [{ id: 'abc', data: 'héllo\nworld' }]);
});
test('QM completes a source-signed async run with authoritative reply and deduplicated deltas', async () => {
  const events = [{ type:'CUSTOM', name:'run', value:{ status:'running', partial:'Hi ' } }, {type:'CUSTOM',name:'delta',value:{offset:0,delta:'Hi there'}}, {type:'CUSTOM',name:'run',value:{status:'done',partial:'Hi there',result:{status:'ok',reply:'Final reply'}}}, {type:'RUN_FINISHED'}];
  const client = new QmClient({baseUrl:'http://localhost:9081',sourceSecret:'fixture',fetch: async (url, init) => {
    assert.ok(new Headers(init?.headers).get('x-signature'));
    return String(url).includes('async=1') ? fixture({runId:'fixture-run'}) : new Response(chunks(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')), {headers:{'content-type':'text/event-stream'}});
  }});
  const result = await client.runTurn({surface:'web',actor:{externalId:'fixture'},conversation:{kind:'group',threadRef:'fixture'},text:'fixture'});
  assert.equal(result.text, 'Final reply'); assert.equal(result.status,'done');
});
test('QM auth errors fail closed without exposing provider body', async () => {
  const client = new QmClient({baseUrl:'http://localhost:9081',sourceSecret:'fixture',fetch: async()=>new Response('secret provider body',{status:401})});
  await assert.rejects(client.collectRun('fixture'), {code:'authentication',message:'QM returned HTTP 401'});
});
test('QM truncated stream cannot become a successful result', async () => {
  const client = new QmClient({baseUrl:'http://localhost:9081',sourceSecret:'fixture',fetch:async()=>new Response(chunks('data: {"type":"RUN_STARTED"}\n\n'))});
  await assert.rejects(client.collectRun('fixture'), /before run completion/);
});
test('MCP discovers schemas and rejects tool execution errors', async () => {
  let calls=0;
  const client = new GBrainClient({url:'https://example.test/mcp',bearerToken:'fixture-token',fetch:async(_url,init)=>{
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-token');
    const req=JSON.parse(String(init?.body)); calls++;
    if(req.method==='notifications/initialized') return new Response(null,{status:202});
    const result=req.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}}}:req.method==='tools/list'?{tools:[{name:'discovered_search',inputSchema:{type:'object',properties:{query:{type:'string'}}}}]}:{content:[{type:'text',text:'fixture failure'}],isError:true};
    return fixture({jsonrpc:'2.0',id:req.id,result});
  }});
  const catalog=await client.listTools(); assert.equal(catalog[0]?.name,'discovered_search');
  await assert.rejects(client.callTool('invented_tool',{}),{code:'unavailable'});
  await assert.rejects(client.callTool('discovered_search',{query:'fixture'}),{code:'tool_error'}); assert.equal(calls,4);
});
test('MCP OAuth refresh uses documented form grant and never puts secret in MCP args', async () => {
  const requests: string[]=[];
  const client = new GBrainClient({url:'http://localhost:3131/mcp',tokenUrl:'http://localhost:3131/token',clientId:'fixture-client',clientSecret:'fixture-secret',fetch:async(url,init)=>{
    const body=String(init?.body); requests.push(body);
    if(String(url).endsWith('/token')) { assert.equal(new URLSearchParams(body).get('grant_type'),'client_credentials'); return fixture({access_token:'fixture-access',expires_in:3600}); }
    assert.ok(!body.includes('fixture-secret')); const req=JSON.parse(body);
    if(req.method==='notifications/initialized') return new Response(null,{status:202});
    return fixture({jsonrpc:'2.0',id:req.id,result:req.method==='initialize'?{protocolVersion:'2025-06-18'}:{tools:[]}});
  }});
  await client.listTools(); assert.equal(requests.filter(x=>x.includes('grant_type')).length,1);
});
const calendarInput = {calendarId:'primary',title:'Fixture event',description:'Fixture-only test',start:'2026-09-28T10:00:00-07:00',end:'2026-09-28T10:30:00-07:00',timeZone:'America/Los_Angeles',attendees:[{email:'fixture@example.test'}]};
function store(): CalendarAttemptStore { const claims = new Set<string>(); return {claim:async key=>{if(claims.has(key)) return false;claims.add(key);return true},finish:async()=>{}}; }
test('calendar changed preview requires fresh approval with zero network writes', async()=>{
  const preview=prepareCalendar(calendarInput,1,1); const approval={confirmed:true as const,digest:preview.digest,contextRevision:1,proposalVersion:1};
  preview.input.title='Changed'; let writes=0; const client=new GoogleCalendarAdapter({accessToken:'fixture',fetch:async()=>{writes++;return fixture({})}});
  await assert.rejects(client.send(preview,approval,'fixture-key',store()),{code:'approval_required'}); assert.equal(writes,0);
});
test('calendar sends attendees with all updates, verifies readback and prevents duplicate send',async()=>{
  let writes=0;let event:Record<string,unknown>={}; const client=new GoogleCalendarAdapter({accessToken:'fixture',fetch:async(url,init)=>{
    if(init?.method==='POST'){writes++;assert.match(String(url),/sendUpdates=all/);event=JSON.parse(String(init.body));return fixture(event);}
    return fixture({...event,status:'confirmed',htmlLink:'https://calendar.google.com/fixture'});
  }});
  const p=prepareCalendar(calendarInput,3,2);const approval={confirmed:true as const,digest:p.digest,contextRevision:3,proposalVersion:2};const attempts=store();
  const receipt=await client.send(p,approval,'fixture-key',attempts);assert.equal(receipt.verified,true);
  await assert.rejects(client.send(p,approval,'fixture-key',attempts),{code:'duplicate_attempt'});assert.equal(writes,1);
});
test('calendar uncertain network outcome is never retried',async()=>{
  let writes=0;const client=new GoogleCalendarAdapter({accessToken:'fixture',fetch:async()=>{writes++;throw new Error('fixture disconnect')}});
  const p=prepareCalendar(calendarInput,1,1);const approval={confirmed:true as const,digest:p.digest,contextRevision:1,proposalVersion:1};const attempts=store();
  await assert.rejects(client.send(p,approval,'fixture-key',attempts),{code:'uncertain_send'});
  await assert.rejects(client.send(p,approval,'fixture-key',attempts),{code:'duplicate_attempt'});assert.equal(writes,1);
});

test('MCP paginated discovery includes every page and preserves session headers', async () => {
  let pages = 0;
  const client = new GBrainClient({url:'https://example.test/mcp', bearerToken:'fixture', fetch:async (_url, init) => {
    const request=JSON.parse(String(init?.body));
    if(request.method==='initialize') return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-03-26'}}),{headers:{'content-type':'application/json','mcp-session-id':'fixture-session'}});
    assert.equal(new Headers(init?.headers).get('mcp-session-id'),'fixture-session');
    assert.equal(new Headers(init?.headers).get('mcp-protocol-version'),'2025-03-26');
    if(request.method==='notifications/initialized') return new Response(null,{status:202});
    pages++;
    return fixture({jsonrpc:'2.0',id:request.id,result:{tools:[{name:pages===1?'first':'second',inputSchema:{type:'object'}}],...(pages===1?{nextCursor:'fixture-cursor'}:{})}});
  }});
  assert.deepEqual((await client.listTools()).map(t=>t.name),['first','second']); assert.equal(pages,2);
});
test('MCP accepts fragmented SSE RPC response with preceding notification', async () => {
  const client=new GBrainClient({url:'https://example.test/mcp',bearerToken:'fixture',fetch:async(_url,init)=>{
    const request=JSON.parse(String(init?.body));
    if(request.method==='notifications/initialized') return new Response(null,{status:202});
    const result=request.method==='initialize'?{protocolVersion:'2025-03-26'}:{tools:[]};
    const frames=`data: ${JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{level:'info'}})}\n\ndata: ${JSON.stringify({jsonrpc:'2.0',id:request.id,result})}\n\n`;
    return new Response(chunks(frames),{headers:{'content-type':'text/event-stream'}});
  }});
  assert.deepEqual(await client.listTools(),[]);
});

test('calendar attempt claim survives a new store instance and uncertain outcome', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FileCalendarAttemptStore } = await import('../src/integrations/calendar-runtime.ts');
  const directory = await mkdtemp(join(tmpdir(), 'glance-calendar-fixture-'));
  try {
    const first = new FileCalendarAttemptStore(directory);
    assert.equal(await first.claim('fixture-unique-action', 'fixture-digest'), true);
    assert.equal(await new FileCalendarAttemptStore(directory).claim('fixture-unique-action', 'changed-digest'), false);
    await first.finish('fixture-unique-action', 'uncertain');
    assert.equal(await new FileCalendarAttemptStore(directory).claim('fixture-unique-action', 'fixture-digest'), false);
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('calendar runtime never converts an unconfirmed proposal into approval', async () => {
  const { createCalendarSender } = await import('../src/integrations/calendar-runtime.ts');
  const sender = createCalendarSender({GOOGLE_CALENDAR_ACCESS_TOKEN:'fixture-token'});
  await assert.rejects(sender.sendCalendar({meetingId:'fixture',idempotencyKey:'fixture',correctionEpoch:0,proposal:{id:'fixture-action',proposalVersion:1,status:'proposed',title:calendarInput.title,description:calendarInput.description,start:calendarInput.start,end:calendarInput.end,timeZone:calendarInput.timeZone,attendees:calendarInput.attendees}},new AbortController().signal),{code:'approval_required'});
});
