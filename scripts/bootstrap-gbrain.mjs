#!/usr/bin/env node
/** Reproduce the pinned official service. Secrets are generated, never printed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(repo,'integrations/gbrain/runtime.json'),'utf8'));
const args=new Set(process.argv.slice(2));
for(const arg of args)if(!['--dry-run','--no-start','--build-cli'].includes(arg))throw new Error(`Unknown option ${arg}`);
const runtime=path.resolve(process.env.GLANCE_GBRAIN_RUNTIME||path.join(os.homedir(),'.local/share/glance-qm/gbrain-runtime'));
const source=path.resolve(process.env.GLANCE_GBRAIN_SOURCE||path.join(os.homedir(),'.local/share/glance-qm/gbrain-source'));
const port=Number(process.env.GLANCE_GBRAIN_PORT||manifest.httpPort);
const pgPort=Number(process.env.GLANCE_GBRAIN_PG_PORT||manifest.postgresPort);
for(const n of [port,pgPort])if(!Number.isInteger(n)||n<1024||n>65535)throw new Error('Ports must be integers between 1024 and 65535');
const container=process.env.GLANCE_GBRAIN_PG_CONTAINER||manifest.container;
const volume=process.env.GLANCE_GBRAIN_PG_VOLUME||manifest.volume;
if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container)||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(volume))throw new Error('Invalid dedicated Docker resource name');
const baseUrl=`http://127.0.0.1:${port}`;
const plan={repository:manifest.repository,commit:manifest.commit,source,runtime,postgresImage:manifest.postgresImage,container,volume,pgPort,baseUrl,sourceId:manifest.source,clients:manifest.clients,keywordOnly:true,buildLinuxArm64:args.has('--build-cli'),start:!args.has('--no-start')};
if(args.has('--dry-run')){console.log(JSON.stringify(plan,null,2));process.exit(0);}
process.umask(0o077);fs.mkdirSync(runtime,{recursive:true,mode:0o700});fs.chmodSync(runtime,0o700);
const log=path.join(runtime,'bootstrap.log');
const bun=process.env.BUN_BIN||(fs.existsSync(path.join(os.homedir(),'.local/bin/bun'))?path.join(os.homedir(),'.local/bin/bun'):'bun');
const docker=process.env.DOCKER_BIN||'docker';
const env={...process.env,GBRAIN_HOME:runtime};
const dockerEnv={...process.env};
if(!dockerEnv.DOCKER_HOST&&!dockerEnv.DOCKER_CONTEXT){
 const socket=path.join(os.homedir(),'.colima/glance-qm/docker.sock');
 if(fs.existsSync(socket))dockerEnv.DOCKER_HOST=`unix://${socket}`;
}
if(!dockerEnv.DOCKER_CONFIG&&dockerEnv.DOCKER_HOST){
 const configDir=path.join(runtime,'docker');fs.mkdirSync(configDir,{recursive:true,mode:0o700});
 if(!fs.existsSync(path.join(configDir,'config.json')))fs.writeFileSync(path.join(configDir,'config.json'),'{}\n',{mode:0o600});
 dockerEnv.DOCKER_CONFIG=configDir;
}
function run(command,argv,{cwd=repo,environment=env,allowFailure=false,label=command}={}){
 const r=spawnSync(command,argv,{cwd,env:environment,encoding:'utf8',maxBuffer:32*1024*1024});
 // Command output can include one-time secrets. Keep it in a private file only.
 fs.appendFileSync(log,`\n[${label}] exit ${r.status}\n${r.stdout||''}${r.stderr||''}`,{mode:0o600});
 if((r.error||r.status!==0)&&!allowFailure)throw new Error(`${label} failed; inspect private ${log} (do not publish it)`);
 return r;
}
function gb(argv,options={}){return run(bun,['src/cli.ts',...argv],{cwd:source,label:`gbrain ${argv[0]}`, ...options});}
function dock(argv,options={}){return run(docker,argv,{environment:dockerEnv,label:`docker ${argv[0]}`,...options});}
function secretFile(filename,content){fs.writeFileSync(path.join(runtime,filename),content,{mode:0o600});fs.chmodSync(path.join(runtime,filename),0o600);}
function quote(s){return "'"+String(s).replaceAll("'","'\\''")+"'";}
run('git',['--version'],{label:'Git prerequisite'});const bv=run(bun,['--version'],{label:'Bun prerequisite'}).stdout.trim();
const [major,minor,patch]=bv.split('.').map(Number);if(major<1||(major===1&&(minor<3||(minor===3&&patch<11))))throw new Error('Bun >=1.3.11 required');
dock(['info'],{label:'Docker daemon prerequisite'});
if(!fs.existsSync(source)){
 fs.mkdirSync(path.dirname(source),{recursive:true});run('git',['clone','--no-checkout','--filter=blob:none',manifest.repository,source],{label:'Clone pinned GBrain source'});
 run('git',['checkout','--detach',manifest.commit],{cwd:source,label:'Checkout pinned GBrain source'});
}else{
 const head=run('git',['rev-parse','HEAD'],{cwd:source}).stdout.trim();
 if(head!==manifest.commit)throw new Error('Existing GBrain checkout is at a different commit; use a fresh GLANCE_GBRAIN_SOURCE');
 if(run('git',['status','--porcelain','--untracked-files=no'],{cwd:source}).stdout.trim())throw new Error('Existing GBrain checkout has tracked modifications; refusing to overwrite it');
}
run(bun,['install','--frozen-lockfile'],{cwd:source,label:'Install exact GBrain dependencies'});
const pgEnv=path.join(runtime,'postgres.env');
if(!fs.existsSync(pgEnv))secretFile('postgres.env',`POSTGRES_USER=gbrain\nPOSTGRES_DB=gbrain\nPOSTGRES_PASSWORD=${crypto.randomBytes(24).toString('hex')}\n`);
const password=fs.readFileSync(pgEnv,'utf8').match(/^POSTGRES_PASSWORD=([^\r\n]+)$/m)?.[1];
if(!password)throw new Error('Dedicated postgres.env has no password');
env.GBRAIN_DATABASE_URL=`postgresql://gbrain:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/gbrain`;
const existing=dock(['inspect',container],{allowFailure:true});
if(existing.status===0){
 const d=JSON.parse(existing.stdout)[0];
 const mount=d.Mounts?.find(m=>m.Destination==='/var/lib/postgresql/data');
 const binding=d.HostConfig?.PortBindings?.['5432/tcp']?.[0];
 if(mount?.Name!==volume||binding?.HostPort!==String(pgPort)||binding?.HostIp!=='127.0.0.1')throw new Error('Existing container does not match dedicated volume/loopback port; refusing to modify it');
 if(!d.State.Running)dock(['start',container]);
}else{
 dock(['pull',manifest.postgresImage]);
 dock(['run','-d','--name',container,'--restart','unless-stopped','--memory','768m','-p',`127.0.0.1:${pgPort}:5432`,'--env-file',pgEnv,'-v',`${volume}:/var/lib/postgresql/data`,manifest.postgresImage]);
}
let ready=false;for(let i=0;i<60;i++){
 if(dock(['exec',container,'pg_isready','-U','gbrain','-d','gbrain'],{allowFailure:true}).status===0){ready=true;break;}
 await new Promise(r=>setTimeout(r,500));
}if(!ready)throw new Error('Dedicated GBrain PostgreSQL did not become ready');
secretFile('host.env',Object.entries({GBRAIN_HOME:runtime,GBRAIN_DATABASE_URL:env.GBRAIN_DATABASE_URL,GLANCE_GBRAIN_SOURCE:source,GLANCE_GBRAIN_PORT:String(port),BUN_BIN:bun}).map(([k,v])=>`export ${k}=${quote(v)}`).join('\n')+'\n');
const cfg=path.join(runtime,'.gbrain/config.json');
if(fs.existsSync(cfg))gb(['init','--migrate-only']);
else gb(['init','--non-interactive','--db-only','--no-embedding']);
gb(['config','set','search.mode','conservative']);gb(['config','set','search.mcp_keyword_only','true']);
const add=gb(['sources','add',manifest.source,'--name','Glance QM shared demo memory'],{allowFailure:true});
if(add.status!==0&&!/already registered/.test(add.stdout+add.stderr))throw new Error('GBrain source creation failed; inspect private bootstrap log');
for(const [name,prefixes] of Object.entries(manifest.clients)){
 const filename=`${name}-oauth.json`;const saved=path.join(runtime,filename);
 if(fs.existsSync(saved)){
  const c=JSON.parse(fs.readFileSync(saved,'utf8'));
  gb(['auth','rescope-client',c.clientId,'--source',manifest.source,'--federated-read',manifest.source,'--bound-slug-prefixes',prefixes.join(',')]);
  secretFile(filename,JSON.stringify({...c,url:`${baseUrl}/mcp`,tokenUrl:`${baseUrl}/token`},null,2)+'\n');
 }else{
  const result=gb(['auth','register-client',`glance-demo-${name}`,'--grant-types','client_credentials','--scopes','read write','--source',manifest.source,'--federated-read',manifest.source,'--bound-slug-prefixes',prefixes.join(',')]);
  const out=result.stdout+result.stderr;
  const clientId=out.match(/Client ID:\s*(gbrain_cl_\S+)/)?.[1];const clientSecret=out.match(/Client Secret:\s*(gbrain_cs_\S+)/)?.[1];
  if(!clientId||!clientSecret)throw new Error('Client registered but parsing failed; recover from private bootstrap log before retrying');
  secretFile(filename,JSON.stringify({url:`${baseUrl}/mcp`,tokenUrl:`${baseUrl}/token`,clientId,clientSecret},null,2)+'\n');
 }
}
secretFile('service.json',JSON.stringify({port,source,commit:manifest.commit,container,volume},null,2)+'\n');
if(args.has('--build-cli')){
 const output=path.join(runtime,'gbrain-linux-arm64');
 run(bun,['build','--compile','--no-compile-autoload-bunfig','--target=bun-linux-arm64','--outfile',output,'src/cli.ts'],{cwd:source,label:'Compile official sandbox CLI'});
 const bundle=path.join(runtime,'tool');fs.mkdirSync(bundle,{recursive:true,mode:0o700});
 for(const file of ['gbrain','loopback-proxy.mjs','tool.json','SKILL.md'])fs.copyFileSync(path.join(repo,'integrations/gbrain',file),path.join(bundle,file));
 fs.copyFileSync(output,path.join(bundle,'gbrain-bin'));fs.chmodSync(path.join(bundle,'gbrain'),0o755);fs.chmodSync(path.join(bundle,'gbrain-bin'),0o755);
}
if(!args.has('--no-start')){
 run('python3',[path.join(repo,'scripts/gbrain-service.py'),'start'],{environment:{...env,GLANCE_GBRAIN_RUNTIME:runtime},label:'Start isolated GBrain HTTP'});
 const c=JSON.parse(fs.readFileSync(path.join(runtime,'backend-oauth.json'),'utf8'));
 const tokenResponse=await fetch(c.tokenUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:c.clientId,client_secret:c.clientSecret}),signal:AbortSignal.timeout(10000)});
 if(!tokenResponse.ok)throw new Error(`OAuth verification failed (HTTP ${tokenResponse.status}); service port may belong to a different instance`);
 const token=await tokenResponse.json();if(typeof token.access_token!=='string')throw new Error('OAuth verification returned no access token');
 const initialized=await fetch(c.url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${token.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'glance-qm-bootstrap',version:'1'}}}),signal:AbortSignal.timeout(10000)});
 if(!initialized.ok)throw new Error(`Authenticated MCP verification failed (HTTP ${initialized.status})`);
 await initialized.body?.cancel();
}
console.log(JSON.stringify({status:'ready',baseUrl,credentialFile:path.join(runtime,'backend-oauth.json'),source:manifest.source,keywordOnly:true,started:!args.has('--no-start'),...(args.has('--build-cli')?{cliBundle:path.join(runtime,'tool')}:{})},null,2));
