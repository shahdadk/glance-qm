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
  const result=await createAmbientProviders({...fixtureEnv,GLANCE_DECISION_MODE:'jev',JEV_API_KEY:'fixture-key'}).judge(fixtureInput,new AbortController().signal);
  expect(result).toMatchObject({kind:'cue',text:'Second cue'});expect(jevCalls).toBe(1);
  expect(result.authorization?.verify({...fixtureInput,anchor:{...fixtureInput.anchor,capturedAt:999}})).toBe(true);
  expect(result.authorization?.verify({...fixtureInput,anchor:{...fixtureInput.anchor,correctionEpoch:1}})).toBe(false);
});

test('QM threads separate meetings and document tasks without changing project scope',async()=>{
  const requests: Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init?:RequestInit)=>{
    if(String(url).includes('async=1')){requests.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({runId:'fixture-run'}),{headers:{'content-type':'application/json'}});}
    const latest=requests.at(-1);const reply=String(latest?.text).startsWith('Prepare')?{content:'# Fixture document',receipt:{id:'invented-receipt'},url:'https://invented.example/doc'}:{kind:'quiet',reason:'Fixture quiet'};
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
