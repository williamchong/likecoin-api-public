#!/usr/bin/env node
/**
 * Driver for the likecoin-api-public Express server.
 *
 * Two modes, because there are two useful layers:
 *
 *   smoke  Boots the real server (src/index.ts) with CI=1 and probes it over
 *          HTTP. Proves the process starts, routes are mounted, middleware
 *          works. Firestore is stubbed out to {} under CI, so any handler
 *          that reads the database returns 500 — that is expected.
 *
 *   req    Drives a single endpoint through test/api/axiosist.ts, which
 *          rebuilds the app on the in-memory Firestore stub seeded from
 *          test/data/*.json. This is the layer where business logic is
 *          actually reachable. Implemented by generating a throwaway vitest
 *          file, because the stub is installed via vi.mock in test/setup.ts
 *          and only exists inside the vitest runtime.
 *
 * Run from the repo root:
 *   node .claude/skills/run-likecoin-api/driver.mjs smoke
 *   node .claude/skills/run-likecoin-api/driver.mjs req GET /users/id/testerman/min
 *   node .claude/skills/run-likecoin-api/driver.mjs req GET /likernft/book/user/plus-reading/report --user testerman
 *   node .claude/skills/run-likecoin-api/driver.mjs req POST /users/email/verify --body '{"email":"a@b.co"}'
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = Number(process.env.PORT || 3000);
const BASE = `http://127.0.0.1:${PORT}`;

// Paths worth probing on a cold boot. `db` is the marker for "this handler
// needs Firestore, so 500 under CI=1 is the correct answer, not a failure".
const SMOKE_ROUTES = [
  { path: '/healthz', expect: 200 },
  { path: '/', expect: 302 },
  { path: '/misc/price', expect: 200 },
  { path: '/no-such-route', expect: 404 },
  { path: '/users/id/testing/min', expect: 500, db: true },
];

function log(...a) { process.stdout.write(`${a.join(' ')}\n`); }

async function waitForHealthz(isDead = () => false, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDead()) return false;
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function smoke() {
  // If anything already answers on the port, the child would die with
  // EADDRINUSE while we happily probe the stale server. Refuse up front.
  try {
    await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1000) });
    log(`FAIL: something already listens on ${BASE} — kill it first (pkill -f "tsx src/index.ts")`);
    process.exitCode = 1;
    return;
  } catch { /* connection refused = port free, proceed */ }

  log('booting: CI=1 IS_TESTNET=true npx tsx src/index.ts');
  // CI=1 is load-bearing: src/util/firebase.ts calls admin.initializeApp() at
  // import time unless it is set, and config/serviceAccountKey.json is a
  // tracked placeholder whose credential fields are empty strings.
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: REPO,
    env: { ...process.env, CI: '1', IS_TESTNET: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  // exitCode stays null on signal deaths, so track exit explicitly.
  let exited = false;
  child.on('exit', () => { exited = true; });

  // A dead child can coexist with a passing /healthz if another server already
  // owns the port (EADDRINUSE) — that would probe the wrong process.
  const up = await waitForHealthz(() => exited);
  if (exited || !up) {
    log(exited
      ? 'FAIL: server process exited before answering /healthz (port already in use?)'
      : 'FAIL: server never answered /healthz');
    log(serverLog);
    if (!exited) child.kill('SIGKILL');
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const r of SMOKE_ROUTES) {
    const res = await fetch(BASE + r.path, { redirect: 'manual' });
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 90);
    const ok = res.status === r.expect;
    if (!ok) failed += 1;
    const note = r.db ? '  (needs Firestore; 500 is expected under CI=1)' : '';
    log(`${ok ? 'ok  ' : 'FAIL'} ${String(res.status).padEnd(4)} ${r.path.padEnd(28)} ${body}${note}`);
  }

  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (exited) { resolve(undefined); return; }
    const t = setTimeout(resolve, 5000);
    child.on('exit', () => { clearTimeout(t); resolve(undefined); });
  });
  if (!exited) child.kill('SIGKILL');
  log(failed ? `\n${failed} route(s) off expectation` : '\nsmoke ok');
  if (failed) process.exitCode = 1;
}

function parseReqArgs(argv) {
  const [method, path, ...rest] = argv;
  if (!method || !path) {
    log('usage: driver.mjs req <METHOD> <path> [--user <id>] [--wallet <addr>] [--body <json>]');
    log('note: <path> is the production path (/users/...). The driver adds the');
    log('      /api prefix that test/api/axiosist.ts mounts routes under.');
    process.exit(1);
  }
  const opts = { method: method.toUpperCase(), path };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i].replace(/^--/, '');
    opts[k] = rest[i + 1];
  }
  return opts;
}

async function req(argv) {
  const o = parseReqArgs(argv);
  const outDir = mkdtempSync(join(tmpdir(), 'likeapi-driver-'));
  const outFile = join(outDir, 'result.json');
  const scratch = join(REPO, 'test/api/__driver.test.ts');

  const claims = [];
  if (o.user) claims.push(`user: ${JSON.stringify(o.user)}`);
  if (o.wallet) claims.push(`wallet: ${JSON.stringify(o.wallet)}`);
  const auth = claims.length ? `jwtSign({ ${claims.join(', ')} })` : 'undefined';
  const body = o.body ? o.body : 'undefined';

  // The scratch file lives in test/api/ so that ./axiosist and ./jwt resolve
  // and test/setup.ts (which installs the Firestore stub) applies.
  writeFileSync(scratch, `import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import axiosist from './axiosist';
import { jwtSign } from './jwt';

it('driver', async () => {
  const token = ${auth};
  const data = ${body};
  const res = await axiosist.request({
    method: ${JSON.stringify(o.method)},
    url: ${JSON.stringify(`/api${o.path}`)},
    headers: token ? { Authorization: \`Bearer \${token}\` } : {},
    data,
  }).catch((err: any) => err.response ?? { status: 0, data: String(err) });
  writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ status: res.status, data: res.data }, null, 2));
});
`);

  log(`${o.method} /api${o.path}${auth === 'undefined' ? '' : '  (authenticated)'}`);
  let code;
  try {
    code = await new Promise((r) => {
      const p = spawn('npx', ['vitest', 'run', 'test/api/__driver.test.ts', '--reporter=dot'], {
        cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'],
      });
      p.on('exit', r);
    });
  } finally {
    // Must not survive: it sits in test/**/*.test.ts, so a leftover copy
    // would be picked up by `npm run test` and `npm run lint`.
    rmSync(scratch, { force: true });
  }
  if (existsSync(outFile)) {
    log(readFileSync(outFile, 'utf8'));
  } else {
    log(`no result captured (vitest exited ${code})`);
    process.exitCode = 1;
  }
  rmSync(outDir, { recursive: true, force: true });
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'smoke') await smoke();
else if (mode === 'req') await req(rest);
else {
  log('usage: driver.mjs smoke');
  log('       driver.mjs req <METHOD> <path> [--user <id>] [--wallet <addr>] [--body <json>]');
  process.exitCode = 1;
}
