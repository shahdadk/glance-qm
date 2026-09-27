import { afterEach, test, expect, vi } from 'vitest';
import { createAmbientProviders } from '../src/integrations/ambient.ts';
import type { AmbientInput } from '../src/core/providers.ts';
const fixtureInput: AmbientInput = { anchor: { meetingId:'fixture-meeting',revision:1,correctionEpoch:0,finalCount:1,capturedAt:1 }, meeting:{id:'fixture-meeting',title:'Labeled integration fixture',participants:[]}, evidence:[{id:'transcript:fixture-segment:1',text:'We should check the budget.',label:'Fixture transcript',kind:'transcript'}], recentTranscript:[{id:'fixture-segment',text:'We should check the budget.',isFinal:true,revision:1,capturedAt:'2026-09-27T12:00:00Z'}],operatorMessages:[] };
const fixtureEnv={GLANCE_DECISION_MODE:'qm',QM_BASE_URL:'http://localhost:9081',QM_SOURCE_SECRET:'fixture-secret',QM_PROJECT_ID:'fixture-project',QM_THREAD_REF:'fixture-thread'};
function modelReply(reply: unknown) {
  vi.stubGlobal('fetch', vi.fn(async(url: string|URL)=>String(url).includes('async=1')?new Response(JSON.stringify({runId:'fixture-run'}),{headers:{'content-type':'application/json'}}):new Response(`data: ${JSON.stringify({type:'CUSTOM',name:'run',value:{status:'done',result:{status:'ok',reply:JSON.stringify(reply)}}})}\n\ndata: ${JSON.stringify({type:'RUN_FINISHED',runId:'fixture-run'})}\n\n`,{headers:{'content-type':'text/event-stream'}})));
}
afterEach(()=>vi.unstubAllGlobals());
test('ambient missing credentials reports unavailable without fixture fallback',async()=>{
  const p=createAmbientProviders({});expect(p.mode).toBe('unconfigured');
  await expect(p.judge(fixtureInput,new AbortController().signal)).rejects.toMatchObject({code:'not_configured'});
});
test('ambient judgment rejects fabricated source attribution from real-provider shape',async()=>{
  modelReply({kind:'cue',text:'Budget needs review',topic:'budget',evidenceIds:['invented-id']});
  await expect(createAmbientProviders(fixtureEnv).judge(fixtureInput,new AbortController().signal)).rejects.toMatchObject({code:'protocol_error'});
});
test('ambient accepts a schema-checked judgment grounded in exact input segment',async()=>{
  modelReply({kind:'cue',text:'Budget needs review',topic:'budget',evidenceIds:['transcript:fixture-segment:1']});
  const result=await createAmbientProviders(fixtureEnv).judge(fixtureInput,new AbortController().signal);
  expect(result).toMatchObject({kind:'cue',evidenceIds:['transcript:fixture-segment:1']});
});
test('ambient summary rejects prose and invalid arrays',async()=>{
  modelReply({text:'Fixture summary',decisions:'invented-array',openQuestions:[],owners:[],nextSteps:[]});
  await expect(createAmbientProviders(fixtureEnv).summarize(fixtureInput,new AbortController().signal)).rejects.toMatchObject({code:'protocol_error'});
});

test('Jev selects the second QM candidate and binds authorization to current context',async()=>{
  const candidates=[
    {id:'first',description:'First grounded cue',payload:{kind:'cue',text:'First cue',topic:'budget',evidenceIds:['transcript:fixture-segment:1']}},
    {id:'second',description:'Second grounded cue',payload:{kind:'cue',text:'Second cue',topic:'budget',evidenceIds:['transcript:fixture-segment:1']}},
  ];
  let jevCalls=0;
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    if(String(url).includes('typesafe.ai')){
      jevCalls++;const request=JSON.parse(String(init?.body));expect(Object.keys(request.questions.action.criteria)).toEqual(['first','second','__hold__']);
      return new Response(JSON.stringify({model:'jev-1.13.0',answers:{action:{type:'choice',choice:'second',probabilities:{first:0,second:1,__hold__:0},confidence:1}},usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}});
    }
    if(String(url).includes('async=1'))return new Response(JSON.stringify({runId:'fixture-run'}),{headers:{'content-type':'application/json'}});
    return new Response(`data: ${JSON.stringify({type:'CUSTOM',name:'run',value:{status:'done',result:{status:'ok',reply:JSON.stringify({candidates})}}})}\n\ndata: ${JSON.stringify({type:'RUN_FINISHED'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }));
  const result=await createAmbientProviders({...fixtureEnv,GLANCE_DECISION_MODE:'jev-native',JEV_API_KEY:'fixture-key'}).judge(fixtureInput,new AbortController().signal);
  expect(result).toMatchObject({kind:'cue',text:'Second cue'});expect(jevCalls).toBe(1);
  expect(result.authorization?.verify({...fixtureInput,anchor:{...fixtureInput.anchor,capturedAt:999}})).toBe(true);
  expect(result.authorization?.verify({...fixtureInput,anchor:{...fixtureInput.anchor,correctionEpoch:1}})).toBe(false);
});

test('QM threads separate meetings and document tasks without changing project scope',async()=>{
  const requests: Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    if(String(url).includes('async=1')){requests.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({runId:'fixture-run'}),{headers:{'content-type':'application/json'}});}
    const latest=requests.at(-1);const reply=String(latest?.text).includes('TASK_ID=')?{content:'# Fixture document',receipt:{id:'invented-receipt'},url:'https://invented.example/doc'}:{kind:'quiet',reason:'Fixture quiet'};
    return new Response(`data: ${JSON.stringify({type:'CUSTOM',name:'run',value:{status:'done',result:{status:'ok',reply:JSON.stringify(reply)}}})}\n\ndata: ${JSON.stringify({type:'RUN_FINISHED'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }));
  const providers=createAmbientProviders(fixtureEnv);const signal=new AbortController().signal;
  await providers.judge(fixtureInput,signal);
  await providers.judge({...fixtureInput,anchor:{...fixtureInput.anchor,meetingId:'second-meeting'},meeting:{...fixtureInput.meeting,id:'second-meeting'}},signal);
  const doc=await providers.prepareDocument({id:'fixture-task',meetingId:fixtureInput.anchor.meetingId,title:'Fixture document',instructions:'Prepare a test-only draft',origin:fixtureInput.anchor,evidence:fixtureInput.evidence},signal);
  const conversations=requests.map(r=>r.conversation as {threadRef:string;channelRef:string});
  expect(new Set(conversations.map(c=>c.threadRef)).size).toBe(3);expect(conversations.every(c=>c.channelRef==='web-project-fixture-project')).toBe(true);
  expect(doc.content).toBe('# Fixture document');expect(doc.receipt.id).toBe('fixture-run');expect(doc.url).toBeUndefined();expect(doc.receipt.url).toBeUndefined();
});

test('rolling summaries and ambient judgments use separate QM conversations',async()=>{
  const requests: Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    if(String(url).includes('async=1')){requests.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({runId:'fixture-run'}),{headers:{'content-type':'application/json'}});}
    const reply=requests.length===1?{text:'Fixture summary',decisions:[],openQuestions:[],owners:[],nextSteps:[]}:{kind:'quiet',reason:'Fixture quiet'};
    return new Response(`data: ${JSON.stringify({type:'CUSTOM',name:'run',value:{status:'done',result:{status:'ok',reply:JSON.stringify(reply)}}})}\n\ndata: ${JSON.stringify({type:'RUN_FINISHED'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }));
  const providers=createAmbientProviders(fixtureEnv);const signal=new AbortController().signal;
  await providers.summarize(fixtureInput,signal);
  await providers.judge(fixtureInput,signal);
  const conversations=requests.map(r=>r.conversation as {threadRef:string;channelRef:string});
  expect(conversations[0]!.threadRef).not.toBe(conversations[1]!.threadRef);
  expect(conversations[0]!.channelRef).toBe(conversations[1]!.channelRef);
});

test('fast ambient judge configuration does not change the document model',async()=>{
  const requests: Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    if(String(url).includes('async=1')){requests.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({runId:'fixture-run'}),{headers:{'content-type':'application/json'}});}
    const reply=requests.length===1?{kind:'quiet',reason:'Fixture quiet'}:{content:'# Fixture document'};
    return new Response(`data: ${JSON.stringify({type:'CUSTOM',name:'run',value:{status:'done',result:{status:'ok',reply:JSON.stringify(reply)}}})}\n\ndata: ${JSON.stringify({type:'RUN_FINISHED'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }));
  const p=createAmbientProviders({...fixtureEnv,QM_MODEL:'gpt-5.6-sol',QM_JUDGE_MODEL:'gpt-6-luna',QM_JUDGE_THINKING_LEVEL:'low',QM_JUDGE_FAST_MODE:'true'});const signal=new AbortController().signal;
  await p.judge(fixtureInput,signal);await p.prepareDocument({id:'fixture-task',meetingId:'fixture-meeting',title:'Fixture',instructions:'Prepare fixture',origin:fixtureInput.anchor,evidence:fixtureInput.evidence},signal);
  expect(requests[0]).toMatchObject({model:'gpt-6-luna',thinkingLevel:'low',fastMode:true,skipMemory:true,readOnly:true});
  expect(requests[1]?.model).toBe('gpt-5.6-sol');expect(requests[1]?.fastMode).not.toBe(true);
});

test('document preparation retrieves scoped memory and preserves its exact evidence',async()=>{
  let documentRequest='';
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    if(String(url).includes('memory.test')) {
      const request=JSON.parse(String(init?.body));
      if(request.method==='notifications/initialized') return new Response(null,{status:202});
      let result: unknown;
      if(request.method==='initialize') result={protocolVersion:'2025-03-26'};
      else if(request.method==='tools/list') result={tools:[{name:'search',inputSchema:{type:'object',properties:{query:{type:'string'},source_id:{type:'string'},limit:{type:'number'}},required:['query','source_id']}}]};
      else {expect(request.params.arguments.source_id).toBe('glance-demo');result={content:[{type:'text',text:JSON.stringify([
        {id:'memory-allowed',source_id:'glance-demo',slug:'chan-glance-demo/product',title:'Prior constraint',chunk_text:'The initial experience must work without an account.'},
        {id:'memory-denied',source_id:'other-source',slug:'private/product',title:'Private',chunk_text:'Must not enter the document.'},
      ])}]};}
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
    }
    if(String(url).includes('async=1')){documentRequest=JSON.parse(String(init?.body)).text;return new Response(JSON.stringify({runId:'fixture-run'}),{headers:{'content-type':'application/json'}});}
    return new Response(`data: ${JSON.stringify({type:'CUSTOM',name:'run',value:{status:'done',result:{status:'ok',reply:JSON.stringify({content:'# Grounded draft'})}}})}\n\ndata: ${JSON.stringify({type:'RUN_FINISHED'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }));
  const providers=createAmbientProviders({...fixtureEnv,GBRAIN_MCP_URL:'https://memory.test/mcp',GBRAIN_BEARER_TOKEN:'fixture',GBRAIN_RECALL_TOOL:'search'});
  const result=await providers.prepareDocument({id:'task-context',meetingId:'fixture-meeting',title:'Prepare the product specification',instructions:'Turn the agreed needs into a draft',origin:fixtureInput.anchor,evidence:fixtureInput.evidence},new AbortController().signal);
  expect(documentRequest).toContain('memory-allowed');expect(documentRequest).not.toContain('memory-denied');
  expect(result.evidence?.map(e=>e.id)).toEqual(['transcript:fixture-segment:1','memory-allowed']);
  expect(result.receipt.id).toBe('fixture-run');
});

test('semantic task cancellation requires an existing task and exact source evidence',async()=>{
  modelReply({kind:'cancel_task',taskId:'invented-task',evidenceIds:['transcript:fixture-segment:1']});
  await expect(createAmbientProviders(fixtureEnv).judge(fixtureInput,new AbortController().signal)).rejects.toMatchObject({code:'protocol_error'});
  modelReply({kind:'cancel_task',taskId:'current-task',evidenceIds:['transcript:fixture-segment:1']});
  const input={...fixtureInput,purpose:'finalization' as const,meeting:{...fixtureInput.meeting,tasks:[{id:'current-task',title:'Current draft',status:'running' as const}]}};
  await expect(createAmbientProviders(fixtureEnv).judge(input,new AbortController().signal)).resolves.toMatchObject({kind:'cancel_task',taskId:'current-task'});
});

test('decision modes accept canonical names and the legacy alias but reject unknown modes',()=>{
  expect(createAmbientProviders({GLANCE_DECISION_MODE:'jev-native'}).decisionMode).toBe('jev-native');
  expect(createAmbientProviders({GLANCE_DECISION_MODE:'jev'}).decisionMode).toBe('jev-native');
  expect(createAmbientProviders({GLANCE_DECISION_MODE:'qm'}).decisionMode).toBe('qm-only');
  expect(()=>createAmbientProviders({GLANCE_DECISION_MODE:'jev-naitve'})).toThrow(/GLANCE_DECISION_MODE must be/);
});

test('research uses Exa only and returns attributed public source evidence',async()=>{
  const calls: string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    calls.push(String(url));expect(new Headers(init?.headers).get('x-api-key')).toBe('fixture-exa-key');
    expect(JSON.parse(String(init?.body)).query).toBe('Node.js stream backpressure');
    return new Response(JSON.stringify({results:[{url:'https://nodejs.org/api/stream.html',title:'Streams',text:'Writers should respect backpressure.'}]}),{headers:{'content-type':'application/json'}});
  }));
  const providers=createAmbientProviders({EXA_API_KEY:'fixture-exa-key'});
  expect(providers.configured.exa).toBe(true);
  const sources=await providers.research!('Node.js stream backpressure',new AbortController().signal);
  expect(sources).toMatchObject([{kind:'external',url:'https://nodejs.org/api/stream.html',text:'Writers should respect backpressure.'}]);
  expect(calls).toEqual(['https://api.exa.ai/search']);
});

test('research without Exa credentials fails explicitly without any fallback',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(createAmbientProviders({}).research!('Public topic',new AbortController().signal)).rejects.toMatchObject({code:'unconfigured'});
  expect(fetch).not.toHaveBeenCalled();
});

test('judge explicitly distinguishes a backend research request from already having sources',async()=>{
  let prompt='';
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    if(String(url).includes('async=1')){prompt=JSON.parse(String(init?.body)).text;return new Response(JSON.stringify({runId:'fixture-run'}),{headers:{'content-type':'application/json'}});}
    const reply={kind:'research',query:'Node.js current LTS official release',evidenceIds:['transcript:fixture-segment:1']};
    return new Response(`data: ${JSON.stringify({type:'CUSTOM',name:'run',value:{status:'done',result:{status:'ok',reply:JSON.stringify(reply)}}})}\n\ndata: ${JSON.stringify({type:'RUN_FINISHED'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }));
  const input={...fixtureInput,evidence:fixtureInput.evidence.filter(e=>e.kind!=='external')};
  await expect(createAmbientProviders({...fixtureEnv,EXA_API_KEY:'fixture-key'}).judge(input,new AbortController().signal)).resolves.toMatchObject({kind:'research'});
  expect(prompt).toContain('BACKEND_RESEARCH_CAPABILITY: available');expect(prompt).toContain('prior external evidence is NOT required');
  await createAmbientProviders(fixtureEnv).judge(input,new AbortController().signal);
  expect(prompt).toContain('BACKEND_RESEARCH_CAPABILITY: unavailable');expect(prompt).not.toContain('BACKEND_RESEARCH_CAPABILITY: available');
});

test.each([
  ['Garry Tan','Y Combinator'],
  ['Fei-Fei Li','Stanford University'],
])('public introduction permits grounded research without a question: %s',async(name,organization)=>{
  const text=`I'm ${name}, from ${organization}.`;
  const input={...fixtureInput,recentTranscript:[{...fixtureInput.recentTranscript[0]!,text}],evidence:[{...fixtureInput.evidence[0]!,text}]};
  let prompt='';
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    if(String(url).includes('async=1')){prompt=JSON.parse(String(init?.body)).text;return new Response(JSON.stringify({runId:'fixture-public-intro'}),{headers:{'content-type':'application/json'}});}
    const reply={kind:'research',query:`${name} ${organization} official biography background education`,evidenceIds:['transcript:fixture-segment:1']};
    return new Response(`data: ${JSON.stringify({type:'CUSTOM',name:'run',value:{status:'done',result:{status:'ok',reply:JSON.stringify(reply)}}})}\n\ndata: ${JSON.stringify({type:'RUN_FINISHED'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }));
  const result=await createAmbientProviders({...fixtureEnv,EXA_API_KEY:'fixture'}).judge(input,new AbortController().signal);
  expect(result).toMatchObject({kind:'research',evidenceIds:['transcript:fixture-segment:1']});
  const instructions=prompt.split('SOURCE_ID_CATALOG=')[0]!;
  expect(instructions).toContain('name-only introduction');expect(instructions).toContain('sources support the name AND');
  expect(instructions).not.toContain(name);expect(instructions).not.toContain(organization);
});

test.each([true,false])('overlength cue gets exactly one bounded repair; valid=%s',async(valid)=>{
  const short='Possible public match: Jane Example leads Example Institute.';
  const long=`${short} Her public biography describes previous professional work and documented projects, while the spoken introduction alone does not authenticate the identity of the person currently speaking.`;
  expect(long.length).toBeGreaterThan(180);
  let qmSubmissions=0;let jevCalls=0;
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    if(String(url).includes('typesafe.ai')){
      jevCalls++;const request=JSON.parse(String(init?.body));const payload=request.questions.action.criteria.profile.payload;
      expect(payload.evidenceIds).toEqual(['transcript:fixture-segment:1']);expect(payload.kind).toBe('cue');expect(payload.detail).toContain(long);
      return new Response(JSON.stringify({model:'jev-1.13.0',answers:{action:{type:'choice',choice:'profile',probabilities:{profile:1,__hold__:0},confidence:1}},usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}});
    }
    if(String(url).includes('async=1')){qmSubmissions++;return new Response(JSON.stringify({runId:qmSubmissions===1?'initial':'repair'}),{headers:{'content-type':'application/json'}});}
    const reply=String(url).includes('/initial/')?{candidates:[{id:'profile',description:'Fixture profile',payload:{kind:'cue',text:long,topic:'Public context',evidenceIds:['transcript:fixture-segment:1']}}]}:{repairs:[{id:'profile',text:valid?short:'Jane Example won a Nobel Prize.'}]};
    return new Response(`data: ${JSON.stringify({type:'CUSTOM',name:'run',value:{status:'done',result:{status:'ok',reply:JSON.stringify(reply)}}})}\n\ndata: ${JSON.stringify({type:'RUN_FINISHED'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }));
  const operation=createAmbientProviders({...fixtureEnv,GLANCE_DECISION_MODE:'jev-native',JEV_API_KEY:'fixture'}).judge(fixtureInput,new AbortController().signal);
  if(valid){const result=await operation;expect(result).toMatchObject({kind:'cue',text:short});expect(result.authorization?.receiptId).toMatch(/^jev:/);expect(jevCalls).toBe(1);}
  else {await expect(operation).rejects.toMatchObject({code:'protocol_error'});expect(jevCalls).toBe(0);}
  expect(qmSubmissions).toBe(2);
});

test('QM-only mode never publishes an unreviewed overlength repair',async()=>{
  let submissions=0;
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL)=>{
    if(String(url).includes('async=1')){submissions++;return new Response(JSON.stringify({runId:'fixture-long'}),{headers:{'content-type':'application/json'}});}
    const reply={kind:'cue',text:'The plan did not save money. '.repeat(9),topic:'Fixture',evidenceIds:['transcript:fixture-segment:1']};
    return new Response(`data: ${JSON.stringify({type:'CUSTOM',name:'run',value:{status:'done',result:{status:'ok',reply:JSON.stringify(reply)}}})}\n\ndata: ${JSON.stringify({type:'RUN_FINISHED'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  }));
  await expect(createAmbientProviders(fixtureEnv).judge(fixtureInput,new AbortController().signal)).rejects.toMatchObject({code:'protocol_error'});
  expect(submissions).toBe(1);
});

test('instant context is explicitly opt-in and absent from the default provider surface',()=>{
  expect(createAmbientProviders({...fixtureEnv,GLANCE_DECISION_MODE:'jev-native'}).prefetch).toBeUndefined();
  expect(createAmbientProviders({...fixtureEnv,GLANCE_DECISION_MODE:'jev-native',GLANCE_INSTANT_CONTEXT:'false'}).prefetch).toBeUndefined();
  expect(()=>createAmbientProviders({...fixtureEnv,GLANCE_INSTANT_CONTEXT:'true'})).toThrow(/requires jev-native/);
});

test('opt-in partial lookup tolerates ASR spelling and final publication gets a fresh Jev receipt',async()=>{
  let gates=0;let searches=0;let qmCalls=0;
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    if(String(url).includes('typesafe.ai')){
      gates++;const request=JSON.parse(String(init?.body));if(!request.questions.action) return new Response(JSON.stringify({model:'fixture',answers:Object.fromEntries(Object.entries(request.questions).map(([key,raw])=>{const q=raw as {type:string;criteria:Record<string,unknown>};return [key,q.type==='choice'?{type:'choice',choice:Object.keys(q.criteria)[0],probabilities:Object.fromEntries(Object.keys(q.criteria).map((id,index)=>[id,index===0?1:0])),confidence:1}:{type:'noul',noul:1}];})),usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}});const ids=Object.keys(request.questions.action.criteria);const chosen=ids.find(id=>id!=='__hold__')!;
      return new Response(JSON.stringify({model:'jev-1.13.0',answers:{action:{type:'choice',choice:chosen,probabilities:Object.fromEntries(ids.map(id=>[id,id===chosen?1:0])),confidence:1}},usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}});
    }
    if(String(url).includes('api.exa.ai')){searches++;return new Response(JSON.stringify({results:[{url:'https://example.org/profile',title:'Garry Tan — fixture public profile',text:'Garry Tan leads a public technology organization.'}]}),{headers:{'content-type':'application/json'}});}
    qmCalls++;throw new Error('No QM expected for eligible native fixture');
  }));
  const p=createAmbientProviders({...fixtureEnv,GLANCE_DECISION_MODE:'jev-native',GLANCE_INSTANT_CONTEXT:'true',JEV_API_KEY:'fixture',EXA_API_KEY:'fixture'});
  const partial={id:'intro-partial',revision:1,text:"Hi, I'm Gary Tan from y culminator.",isFinal:false,capturedAt:'2026-09-27T12:00:00Z'};
  const sources=await p.prefetch!({...fixtureInput,partialTranscript:[partial]},new AbortController().signal);
  expect(sources).toHaveLength(1);expect(sources[0]?.kind).toBe('external');expect(sources[0]).not.toHaveProperty('authorization');
  const final={...fixtureInput,recentTranscript:[{...partial,isFinal:true,revision:2}],evidence:[{id:'transcript:intro-partial:2',label:'Final intro',text:partial.text,kind:'transcript' as const},...sources]};
  const decision=await p.judge(final,new AbortController().signal);
  expect(decision.kind).toBe('cue');expect(decision.authorization?.verify(final)).toBe(true);expect(decision.authorization?.verify({...final,anchor:{...final.anchor,correctionEpoch:1}})).toBe(false);
  expect(gates).toBe(3);expect(searches).toBe(1);expect(qmCalls).toBe(0);
});

test('instant Jev hold never falls through to QM',async()=>{
  let calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    calls++;expect(String(url)).toContain('typesafe.ai');const request=JSON.parse(String(init?.body));const ids=Object.keys(request.questions.action.criteria);
    return new Response(JSON.stringify({model:'jev-1.13.0',answers:{action:{type:'choice',choice:'__hold__',probabilities:Object.fromEntries(ids.map(id=>[id,id==='__hold__'?1:0])),confidence:1}},usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}});
  }));
  const text="I'm Alex Johnson.";const input={...fixtureInput,recentTranscript:[{...fixtureInput.recentTranscript[0]!,text}],evidence:[{...fixtureInput.evidence[0]!,text}]};
  const p=createAmbientProviders({...fixtureEnv,GLANCE_DECISION_MODE:'jev-native',GLANCE_INSTANT_CONTEXT:'true',JEV_API_KEY:'fixture',EXA_API_KEY:'fixture'});
  expect((await p.judge(input,new AbortController().signal)).kind).toBe('quiet');expect(calls).toBe(1);
});
