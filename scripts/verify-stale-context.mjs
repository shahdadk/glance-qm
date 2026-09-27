import { MeetingController } from '../src/core/controller.ts';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createAmbientProviders } from '../src/integrations/ambient.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = join(homedir(), '.config/glance-qm');
const runtime = parseEnv(readFileSync(join(config, 'runtime.env'), 'utf8'));
const connection = JSON.parse(readFileSync(join(config, 'connection.json')));
const jev = parseEnv(readFileSync(join(config, 'jev.env'), 'utf8'));
const directory = join(root, '.local', `qm-role-qa-${Date.now()}`, 'meetings');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const env = { QM_BASE_URL: connection.baseUrl, QM_SOURCE_SECRET: runtime.CORE_SIGNING_SECRET, QM_PROJECT_ID: connection.projectId, QM_THREAD_REF: connection.threadRef, QM_ACTOR_EXTERNAL_ID: connection.principalIds[0], QM_MODEL: runtime.CODEX_MODEL, QM_HARNESS: 'codex', GLANCE_DECISION_MODE: 'jev-native', JEV_API_KEY: jev.JEV_API_KEY || jev.TYPESAFE_API_KEY, JEV_MODEL: jev.JEV_MODEL, GBRAIN_CONFIG_FILE: join(homedir(), '.local/share/glance-qm/gbrain-runtime/backend-oauth.json'), GBRAIN_RECALL_TOOL: 'search', GBRAIN_SAVE_SUMMARY_TOOL: 'put_page', GBRAIN_GET_PAGE_TOOL: 'get_page' };


Object.assign(env, parseEnv(readFileSync(join(config, 'exa.env'), 'utf8')), { GLANCE_INSTANT_CONTEXT: 'true' });
const providers = createAmbientProviders(env);
const controller = new MeetingController({ directory, providers });
const record = JSON.parse(readFileSync(process.env.GLANCE_CONTEXT_SNAPSHOT, 'utf8'));
const expectedFirstKind = process.env.GLANCE_EXPECT_FIRST_KIND || 'research';
if (!['research', 'cue'].includes(expectedFirstKind)) throw new Error('GLANCE_EXPECT_FIRST_KIND must be research or cue.');
record.id = `isolated-stale-context-${Date.now()}`;
const input = controller.input(record);
const signal = AbortSignal.timeout(15000);
let report;
try {
 const first = await providers.judge(input, signal);
 const authorized = Boolean(first.authorization?.verify(input));
 report = { scope: 'Read-only provider evaluation of a captured room snapshot in an isolated meeting identity; transcript and timestamps preserved.', expectedFirstKind, firstKind: first.kind, authorized, oldSourceCount: input.evidence.filter(e=>e.kind==='external').length, ...(first.kind === 'cue' ? { cue: first.text } : {}), ...(first.kind === 'quiet' ? { reason: first.reason } : {}), passed: first.kind === expectedFirstKind && authorized };
 if (first.kind === 'research' && authorized) {
  const fresh = await providers.research(first.query, signal);
  const next = { ...input, evidence: [...input.evidence.filter(e=>e.kind!=='external'), ...fresh] };
  const second = await providers.judge(next, signal);
  report = { ...report, query: first.query, freshSourceURLs: fresh.map(e=>e.url), secondKind: second.kind, cue: second.kind === 'cue' ? second.text : undefined, cueAuthorized: Boolean(second.authorization?.verify(next)) };
 }
 if (!report.passed) process.exitCode = 1;
} catch(error) { report={passed:false,error:error.message};process.exitCode=1; }
finally { await controller.close();writeFileSync(join(root,'.local/stale-context-verification.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report)); }
