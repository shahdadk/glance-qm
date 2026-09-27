import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function runtimeConfig() {
  const envFile = process.env.QM_RUNTIME_ENV || `${process.env.HOME}/.config/glance-qm/runtime.env`;
  const local = parseEnv(readFileSync(envFile, 'utf8'));
  const secret = process.env.QM_SIGNING_SECRET || local.CORE_SIGNING_SECRET;
  if (!secret || secret.length < 32) throw new Error('QM source signing secret is missing or too short');
  return { baseUrl: process.env.QM_BASE_URL || 'http://localhost:9081', secret, envFile };
}

export async function request(method, path, value, { baseUrl, secret } = runtimeConfig()) {
  const body = value === undefined ? '' : JSON.stringify(value);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${method}\n${path}\n${body}`).digest('hex')}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': signature }, ...(body ? { body } : {}) });
  if (!response.ok) throw new Error(`QM ${method} ${path} returned ${response.status}: ${(await response.text()).slice(0, 1200)}`);
  return response;
}
