import { readFileSync, writeFileSync } from 'node:fs';
import { request } from '../integrations/qm/source-client.mjs';

const metadata = JSON.parse(readFileSync(`${process.env.HOME}/.config/glance-qm/connection.json`, 'utf8'));
const queued = await (await request('POST', '/v1/turns?async=1', {
  surface: 'web', actor: { externalId: metadata.principalIds[0] },
  conversation: { kind: 'group', channelRef: metadata.channelRef, threadRef: metadata.threadRef },
  text: 'Runtime verification: reply with exactly QM_LIVE_OK and nothing else. Do not use tools.',
})).json();
if (queued.status !== 'queued') throw new Error(`Expected queued turn, received ${queued.status}`);
console.log(`Queued real QM run: ${queued.runId}`);
const response = await request('GET', `/v1/runs/${queued.runId}/events`);
let pending = '';
let result;
const decoder = new TextDecoder();
for await (const chunk of response.body) {
  pending += decoder.decode(chunk, { stream: true });
  const frames = pending.split('\n\n');
  pending = frames.pop();
  for (const frame of frames) {
    const line = frame.split('\n').find(line => line.startsWith('data: '));
    if (!line) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === 'CUSTOM' && event.name === 'run' && event.value.status === 'done') result = event.value.result;
    if (event.type === 'RUN_ERROR') throw new Error(JSON.stringify(event));
  }
}
if (result?.status !== 'ok' || result.reply.trim() !== 'QM_LIVE_OK') throw new Error(`Live verification failed: ${JSON.stringify(result)}`);
const receipt = { verifiedAt: new Date().toISOString(), commit: metadata.qmCommit, runId: queued.runId, sessionId: result.sessionId, reply: result.reply, adminUrl: result.adminUrl };
writeFileSync(`${process.env.HOME}/.config/glance-qm/verification.json`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
