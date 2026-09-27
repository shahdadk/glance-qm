#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const commit = 'a5a36675041a85e30b9ff3632f678ba36837aabf';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configDir = join(homedir(), '.config/glance-qm');
const envPath = process.env.QM_RUNTIME_ENV || join(configDir, 'runtime.env');
const previous = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
const source = process.env.QM_SOURCE_DIR || previous.QM_SOURCE_DIR || join(homedir(), '.cache/glance-qm/qm');
const start = process.argv.includes('--start');
const installTools = process.argv.includes('--install-tools');
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/qm-bootstrap.mjs [--install-tools] [--start]\nDefault prepares pinned source, dependencies, private configuration, and sandbox image. --start starts the official runtime, provisions a shared project, and verifies a real model. --install-tools permits Homebrew Node24/Colima/Docker installation when needed.'); process.exit(0);
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: source, env, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} failed; resolve the error above before retrying.`);
  return result;
}
function has(command) { return spawnSync('/usr/bin/which', [command], { stdio: 'ignore' }).status === 0; }
let node = process.env.QM_NODE_BIN || ['/opt/homebrew/opt/node@24/bin/node', '/usr/local/opt/node@24/bin/node'].find(existsSync) || process.execPath;
let env = { ...process.env, ...previous };
const initialVersion = spawnSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout?.trim() || '0';
const needsNode = Number(initialVersion.split('.')[0]) < 24 || (Number(initialVersion.split('.')[0]) === 24 && Number(initialVersion.split('.')[1]) < 15);
if ((needsNode || !has('docker') || (process.platform === 'darwin' && !has('colima'))) && installTools) {
  if (process.platform !== 'darwin' || !has('brew')) throw new Error('Install Node>=24.15, npm>=11.10, and a Docker daemon for this operating system, then retry.');
  const tools = [...(needsNode ? ['node@24'] : []), ...(!has('docker') ? ['docker'] : []), ...(!has('colima') ? ['colima'] : [])];
  run('brew', ['install', ...tools], { cwd: root, env: { ...env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' } });
  const prefix = spawnSync('brew', ['--prefix', 'node@24'], { encoding: 'utf8' }).stdout?.trim();
  if (!prefix) throw new Error('Homebrew Node24 prefix could not be resolved.');
  node = join(prefix, 'bin/node');
} else if (needsNode) throw new Error('Node>=24.15 required. Run with --install-tools on Homebrew macOS or set QM_NODE_BIN.');
env.PATH = `${dirname(node)}:${process.env.PATH}`;
mkdirSync(configDir, { recursive: true, mode: 0o700 }); chmodSync(configDir, 0o700);
mkdirSync(dirname(source), { recursive: true });
if (!existsSync(join(source, '.git'))) {
  run('git', ['clone', '--no-checkout', '--filter=blob:none', 'https://github.com/yc-software/qm.git', source], { cwd: dirname(source) });
  run('git', ['fetch', '--depth=1', 'origin', commit]);
  run('git', ['checkout', '--detach', commit]);
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout?.trim();
if (head !== commit) throw new Error('Existing QM checkout is at a different commit. Set QM_SOURCE_DIR to a fresh directory; existing files were preserved.');
const trackedChanges = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8' });
if (trackedChanges.status !== 0 || trackedChanges.stdout.trim()) throw new Error('QM checkout has tracked changes. Preserve the live checkout and choose a fresh QM_SOURCE_DIR; bootstrap will not accept hidden patches or discard your changes.');
const npmVersion = spawnSync('npm', ['-v'], { env, encoding: 'utf8' }).stdout?.trim() || '0';
if (Number(npmVersion.split('.')[0]) < 11 || (Number(npmVersion.split('.')[0]) === 11 && Number(npmVersion.split('.')[1]) < 10)) throw new Error('npm>=11.10 is required.');
const settings = {
  QM_SOURCE_DIR: source, CORE_SIGNING_SECRET: randomBytes(32).toString('hex'), HARNESS: 'codex', CODEX_MODEL: 'gpt-5.6-sol',
  DEV_INSTANCE_ORG_ID: 'glance', DEV_INSTANCE_ADMIN_PRINCIPAL: 'glance-founder', DEV_INSTANCE_BASE_PORT: '9080',
  DEV_INSTANCE_POOL_STORE: join(configDir, 'pool'), DEV_INSTANCE_POSTGRES_CONTAINER: 'glance-qm-postgres', DEV_INSTANCE_POSTGRES_VOLUME: 'glance-qm-postgres-data', DEV_INSTANCE_POSTGRES_PORT: '55439', ...previous,
};
settings.QM_SOURCE_DIR = source;
if (process.platform === 'darwin') {
  if (!has('colima') || !has('docker')) throw new Error('Docker/Colima required; retry with --install-tools.');
  settings.DOCKER_HOST ||= `unix://${join(homedir(), '.colima/glance-qm/docker.sock')}`;
  settings.DOCKER_CONFIG ||= join(configDir, 'docker');
  mkdirSync(settings.DOCKER_CONFIG, { recursive: true, mode: 0o700 });
  if (!existsSync(join(settings.DOCKER_CONFIG, 'config.json'))) writeFileSync(join(settings.DOCKER_CONFIG, 'config.json'), '{}\n', { mode: 0o600 });
}
const quote = value => JSON.stringify(String(value));
writeFileSync(envPath, Object.entries(settings).map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n', { mode: 0o600 }); chmodSync(envPath, 0o600);
env = { ...env, ...settings, QM_RUNTIME_ENV: envPath, PATH: `${dirname(node)}:${process.env.PATH}` };
if (settings.DOCKER_HOST) delete env.DOCKER_CONTEXT;
if (spawnSync('docker', ['info'], { env, stdio: 'ignore' }).status !== 0) {
  if (process.platform !== 'darwin') throw new Error('Start the Docker daemon, then retry.');
  run('colima', ['start', 'glance-qm', '--cpu', '4', '--memory', '6', '--disk', '20', '--root-disk', '12', '--vm-type', 'vz', '--activate=false', '--ssh-config=false']);
}
run('npm', ['ci', '--no-audit', '--no-fund']);
run('bash', [join(root, 'scripts/qm-build-sandbox.sh')]);
console.log(`Prepared QM ${commit}; source: ${source}; private configuration: ${envPath}`);
if (start) {
  if (!env.OPENAI_API_KEY && !existsSync(join(homedir(), '.codex/auth.json'))) throw new Error('Supply OPENAI_API_KEY or an authorized local Codex OAuth login before starting real turns.');
  run('bash', [join(root, 'scripts/qm-runtime.sh'), 'up', '--surface', 'web']);
  run(node, [join(root, 'scripts/qm-provision.mjs')], { cwd: root });
  run(node, [join(root, 'scripts/qm-verify.mjs')], { cwd: root });
}
