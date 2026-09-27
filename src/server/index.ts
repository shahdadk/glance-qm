import { resolve } from 'node:path';
import { MeetingController } from '../core/controller.js';
import { createAmbientProviders } from '../integrations/ambient.js';
import { createApp } from './app.js';
import { loadOperatorToken } from './auth.js';

const localDirectory = resolve(process.env.GLANCE_LOCAL_DIR ?? '.local');
const token = process.env.GLANCE_OPERATOR_TOKEN ?? await loadOperatorToken(resolve(localDirectory, 'operator-token'));
if (token.length < 32) throw new Error('GLANCE_OPERATOR_TOKEN must contain at least 32 characters.');
const debounceMs = Number(process.env.GLANCE_AMBIENT_DEBOUNCE_MS ?? 450);
if (!Number.isInteger(debounceMs) || debounceMs < 100 || debounceMs > 2000) throw new Error('GLANCE_AMBIENT_DEBOUNCE_MS must be an integer between 100 and 2000.');
const controller = new MeetingController({ directory: resolve(localDirectory, 'meetings'), providers: createAmbientProviders(process.env), debounceMs, maxWaitMs: Math.max(2000, debounceMs) });
await controller.recover();
const runtime = createApp({ controller, token, memorableConfigured: Boolean(process.env.MEMORABLE_API_KEY), ...(process.env.GLANCE_ALLOWED_ORIGINS ? { allowedOrigins: process.env.GLANCE_ALLOWED_ORIGINS.split(',').map(origin => origin.trim()) } : {}) });
const port = Number(process.env.PORT ?? 8790);
const host = process.env.HOST ?? '127.0.0.1';
runtime.server.listen(port, host, () => {
  console.log(`Glance QM backend listening at http://${host}:${port}`);
  console.log(`Local single-operator authentication; token file: ${resolve(localDirectory, 'operator-token')}`);
  console.log(`Provider mode: ${controller.providers.mode}; QM: ${controller.providers.configured.qm ? 'configured' : 'unconfigured'}; GBrain: ${controller.providers.configured.gbrain ? 'configured' : 'unconfigured'}`);
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void runtime.close().then(() => process.exit(0), () => process.exit(1));
});
