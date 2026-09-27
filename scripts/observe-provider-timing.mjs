import { appendFileSync, openSync, closeSync, chmodSync } from 'node:fs';
const path = process.env.GLANCE_PROVIDER_TIMING_FILE;
if (!path) throw new Error('An isolated timing output file is required.');
const fd = openSync(path, 'a', 0o600); closeSync(fd); chmodSync(path, 0o600);
const original = globalThis.fetch;
let sequence = 0;
const log = value => appendFileSync(path, JSON.stringify(value) + '\n');
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const provider = url.hostname === 'api.typesafe.ai' ? 'jev' : url.hostname === 'api.exa.ai' ? 'exa' : url.pathname === '/v1/turns' ? 'qm' : undefined;
  if (!provider) return original(input, init);
  const id = ++sequence; const start = Date.now();
  let phase = provider; let tentative = false;
  if (provider === 'jev') {
    try {
      const body = JSON.parse(init?.body || '{}');
      const kinds = body.state?.candidates?.map(candidate => candidate.payload?.kind) || [];
      phase = kinds.includes('research') ? 'jev_lookup' : kinds.includes('cue') ? 'jev_cue_authorize' : 'jev_rank';
      tentative = Object.values(body.questions || {}).some(question => /tentative partial speech/.test(question.instructions || ''));
    } catch {}
  }
  log({ id, provider, phase, tentative, event: 'start', at: start });
  try {
    const response = await original(input, init);
    const bytes = await response.clone().arrayBuffer();
    let choices;
    if (provider === 'jev') { try { const body = JSON.parse(Buffer.from(bytes).toString()); choices = Object.values(body.answers || {}).filter(answer => answer.type === 'choice').map(answer => ({ choice: answer.choice, confidence: answer.confidence, chosenProbability: answer.probabilities?.[answer.choice] })); } catch {} }
    log({ id, provider, phase, tentative, event: 'complete', at: Date.now(), status: response.status, elapsedMs: Date.now() - start, ...(choices ? { choices } : {}) });
    return response;
  } catch (error) { log({ id, provider, phase, tentative, event: 'error', at: Date.now(), error: error?.name || 'Error' }); throw error; }
};
