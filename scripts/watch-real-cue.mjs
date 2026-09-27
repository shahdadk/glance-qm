import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
const meetingId = process.env.GLANCE_OBSERVE_MEETING || '18e5795a-e92d-474d-8300-c1921164d40b';
const token = readFileSync(new URL('../.local/operator-token', import.meta.url), 'utf8').trim();
const observations = [];
const seenFinals = new Set();
let initialized = false;
let seenCue;
const record = value => { observations.push(value); console.log(JSON.stringify(value)); };
const ws = new WebSocket(`ws://127.0.0.1:8790/api/meetings/${meetingId}/events`);
const timer = setTimeout(() => ws.close(), Number(process.env.GLANCE_OBSERVE_MS || 90000));
ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
ws.on('message', raw => {
  const event = JSON.parse(raw.toString());
  if (event.type !== 'snapshot') return;
  const value = event.payload;
  const finals = value.transcript.filter(segment => segment.isFinal);
  if (!initialized) { for (const segment of finals) seenFinals.add(segment.id); seenCue = value.cue?.id; initialized = true; record({ event: 'observing', at: Date.now(), meetingId, status: value.status, existingFinals: finals.length }); return; }
  for (const segment of finals) if (!seenFinals.has(segment.id)) {
    seenFinals.add(segment.id);
    record({ event: 'new_final', observedAt: Date.now(), segmentId: segment.id, capturedAt: segment.capturedAt, characters: segment.text.length, publicNameDetected: /\bgar?ry\s+tan\b/i.test(segment.text) });
  }
  if (value.cue && value.cue.id !== seenCue) {
    seenCue = value.cue.id;
    const receipt = value.decisionReceipts?.filter(receipt => receipt.kind === 'cue').at(-1);
    const latest = finals.at(-1);
    record({ event: 'cue_snapshot', observedAt: Date.now(), cueId: value.cue.id, characters: value.cue.text.length, externalSourceURLs: value.cue.evidence.filter(evidence => evidence.kind === 'external' && evidence.url).map(evidence => { const url = new URL(evidence.url); return url.origin + url.pathname; }), finalCueReceiptId: receipt?.receiptId, receiptAcceptedAt: receipt?.acceptedAt, latestFinalId: latest?.id, latestFinalCapturedAt: latest?.capturedAt, finalToObservedCueMs: latest ? Date.now() - Date.parse(latest.capturedAt) : undefined });
  }
});
ws.on('close', code => {
  clearTimeout(timer);
  writeFileSync(new URL('../.local/real-cue-observation.json', import.meta.url), JSON.stringify({ completedAt: new Date().toISOString(), meetingId, closeCode: code, observations, scope: 'Read-only backend WebSocket observation. Confirm segment IDs against native logs before claiming physical speech verification. No transcript or cue text logged.' }, null, 2) + '\n', { mode: 0o600 });
});
ws.on('error', () => { console.error('Real-room observation connection failed.'); clearTimeout(timer); process.exitCode = 1; });
