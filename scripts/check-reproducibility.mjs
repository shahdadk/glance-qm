#!/usr/bin/env node
/** Verify repository source in an isolated directory without operator credentials. */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const supported = new Set(['--working-tree', '--static-only', '--keep']);
for (const arg of args) if (!supported.has(arg)) throw new Error(`Unknown option: ${arg}`);
const working = args.has('--working-tree');
const scratch = mkdtempSync(join(tmpdir(), 'glance-qm-repro-'));
const copy = join(scratch, 'source');
mkdirSync(copy);
const failures = [];
const fail = message => { failures.push(message); console.error(`FAIL ${message}`); };
const git = (...command) => execFileSync('git', command, { cwd: root, encoding: 'utf8' });
try {
  if (working) {
    // Strict source allowlist prevents ignored runtime state, databases and recordings
    // from crossing the boundary even while the initial submission is in progress.
    const names = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))];
    for (const name of names) {
      if (!/^(?:src|test|web|scripts|integrations|docs|native)\//.test(name) && !/^(?:package(?:-lock)?\.json|tsconfig\.json|README\.md|AGENTS\.md|\.gitignore|\.env\.example)$/.test(name)) continue;
      if (/(?:^|\/)(?:\.env(?!\.example$)|\.local|node_modules|DerivedData|MetaWearablesDAT|recordings|evidence)(?:\/|$)/.test(name)) continue;
      if (!/\.(?:[cm]?[jt]sx?|json|md|sh|py|swift|plist|yml|yaml|html|css|pbxproj|xcworkspacedata|xcscheme|resolved)$/.test(name) && !/(?:^|\/)(?:gbrain|UPSTREAM-LICENSE|\.gitignore|\.env\.example)$/.test(name)) continue;
      const from = join(root, name);
      if (!existsSync(from)) continue;
      if (lstatSync(from).isSymbolicLink()) { fail(`source symlink requires review: ${name}`); continue; }
      mkdirSync(dirname(join(copy, name)), { recursive: true });
      cpSync(from, join(copy, name));
    }
    console.log('Snapshot: current source working tree (includes uncommitted source; not a commit receipt)');
  } else {
    const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: root });
    execFileSync('tar', ['-xf', '-', '-C', copy], { input: archive });
    console.log(`Snapshot: committed HEAD ${git('rev-parse', 'HEAD').trim()}`);
  }
  for (const name of ['package.json', 'package-lock.json', 'src/server/index.ts', 'src/demo.ts', 'web/vite.config.ts']) {
    if (!existsSync(join(copy, name))) fail(`missing submission file: ${name}`);
  }
  const manifest = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (/^(?:file:|link:|\/|\.\.?\/)/.test(version)) fail(`machine-local package dependency: ${name}`);
  }
  const lock = JSON.parse(readFileSync(join(copy, 'package-lock.json'), 'utf8'));
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.resolved && /^(?:file:|link:|\/|\.\.?\/)/.test(entry.resolved)) fail(`machine-local lockfile dependency: ${name}`);
  }
  // Deliberately no live-provider command. Tests and demo must stand alone.
  const inspectImports = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) inspectImports(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const content = readFileSync(path, 'utf8');
        if (/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'](?:file:|\/Users\/|\/home\/|\/tmp\/)/.test(content)) {
          fail(`machine-local source import: ${path.slice(copy.length + 1)}`);
        }
      }
    }
  };
  for (const folder of ['src', 'web', 'integrations']) if (existsSync(join(copy, folder))) inspectImports(join(copy, folder));
  const cleanHome = join(scratch, 'home');
  mkdirSync(cleanHome);
  const env = { PATH: process.env.PATH ?? '', HOME: cleanHome, CI: '1', TMPDIR: scratch, npm_config_cache: join(homedir(), '.npm') };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (!args.has('--static-only')) {
    for (const command of [['ci', '--no-audit', '--no-fund'], ['run', 'check'], ['run', 'build'], ['run', 'demo']]) {
      console.log(`\nIsolated: npm ${command.join(' ')}`);
      const result = spawnSync('npm', command, { cwd: copy, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      console.log((result.stdout ?? '').trim());
      if (result.stderr) console.error(result.stderr.trim());
      if (result.error || result.status !== 0) {
        fail(`npm ${command.join(' ')} (${result.error?.message ?? `exit ${result.status}`})`);
        if (command[0] === 'ci') break;
      }
    }
  }
  console.log(`\n${failures.length ? 'FAILED' : 'PASSED'}: ${failures.length} failure(s). No provider or hardware verification is implied.`);
  if (args.has('--keep')) console.log(`Retained isolated source: ${copy}`);
} catch (error) {
  fail(error.message);
} finally {
  if (!args.has('--keep')) rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = failures.length ? 1 : 0;
