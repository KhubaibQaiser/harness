import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readStopRecord } from '../../src/checks/stop/record.js';
import { realSrtVersion, SRT_ON } from '../srt-real.js';
import { DISPATCH, PREFIX, build, cleanup, npmVitest } from './fixtures.js';

// The first tests against a real srt (everything else uses fakes). Runs only in the stop-srt CI job, with HARNESS_E2E_SRT=1.
// With the flag and no usable srt this file fails at import; without the flag it skips and touches nothing.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.mjs');
const SRT = SRT_ON ? realSrtVersion() : '';
const linux = process.platform === 'linux';
const J = JSON.stringify;

describe.skipIf(!SRT_ON)('Stop gate inside real srt', () => {
  const made: string[] = [];
  let HOME = '';
  let env: NodeJS.ProcessEnv = {};
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), 'h-srt-home-'));
    made.push(HOME);
    // Attended, like the other e2e files, with a temp home so nothing reads the real one. HOME is also where the planted read step looks.
    env = { ...process.env, HARNESS_PLAIN_INIT: '1', HOME, USERPROFILE: HOME };
    for (const k of ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'HARNESS_SANDBOX']) delete env[k];
  });
  afterAll(() => made.splice(0).forEach(cleanup));

  const node = (code: string) => ['node', '-e', code];
  const OK = ['s1', 's2', 's3', 's4'].map((name) => ({ name, run: node('0') }));

  /** A repo with the overlay's steps, installed through the CLI, with the session started and fresh coverage in place. */
  const session = (steps: { name: string; run: string[] }[]): string => {
    const root = build(npmVitest());
    const cfgDir = mkdtempSync(join(tmpdir(), PREFIX));
    made.push(root, cfgDir);
    const cfg = join(cfgDir, 'answers.yaml');
    writeFileSync(cfg, `stop:\n  steps:\n${steps.map((s) => `    - name: ${s.name}\n      run: ${J(s.run)}\n`).join('')}`);
    const i = spawnSync('node', [CLI, 'init', '--config', cfg, '--yes'], { cwd: root, encoding: 'utf8', env });
    expect(i.status, i.stdout + i.stderr).toBe(0);
    mkdirSync(join(root, 'coverage'), { recursive: true });
    writeFileSync(join(root, 'coverage/coverage-final.json'), '{}');
    return root;
  };

  /** One hook call, asynchronous so a server in this process can answer a step while the Stop runs. */
  const hook = (root: string, input: Record<string, unknown>) =>
    new Promise<{ out: any; ms: number; err: string }>((resolve, reject) => {
      const t0 = Date.now();
      const c = spawn('node', [join(root, DISPATCH)], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (err += d));
      c.on('error', reject);
      c.on('close', (code) => (code === 0 ? resolve({ out: out ? JSON.parse(out) : null, ms: Date.now() - t0, err }) : reject(new Error(`hook exited ${code}: ${out}${err}`))));
      c.stdin.end(JSON.stringify({ session_id: 's1', cwd: root, ...input }));
    });
  const start = (root: string) => hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  const stop = async (root: string, cwd = root) => {
    const r = await hook(root, { hook_event_name: 'Stop', cwd });
    return { ...r, decision: (r.out?.decision as string | undefined) ?? 'allow', reason: (r.out?.reason as string | undefined) ?? '' };
  };

  test('four passing steps allow, run in one srt call, and the record shows every check ok', async () => {
    const root = session(OK);
    await start(root);
    const first = await stop(root);
    expect(first.decision, first.reason).toBe('allow');
    const a = readStopRecord(root);
    expect(a).toMatchObject({ outcome: 'ran', srt: SRT });
    expect(Object.keys(a!.checks)).toHaveLength(linux ? 5 : 4);
    expect(Object.values(a!.checks).every((v) => v === 'ok')).toBe(true);
    // One srt process per Stop: the record is written once per wrapped attempt, so a second Stop gives exactly one newer record.
    await new Promise((r) => setTimeout(r, 5));
    expect((await stop(root)).decision).toBe('allow');
    expect(readStopRecord(root)!.ts > a!.ts).toBe(true);
  });

  test('a hook whose cwd is a subfolder runs the steps from the repo root', async () => {
    const root = session([{ name: 'at-root', run: node("process.exit(require('fs').existsSync('package.json')?0:1)") }]);
    await start(root);
    const r = await stop(root, join(root, 'src'));
    expect(r.decision, r.reason).toBe('allow');
    expect(readStopRecord(root)).toMatchObject({ outcome: 'ran' });
  });

  // Each planted step exits 1 when its attempt is refused and 0 when it got through, so a block with "planted failed" means the fence held.
  const planted = async (name: string, script: string): Promise<{ root: string; reason: string }> => {
    const root = session([...OK.slice(0, 1), { name: 'planted', run: node(script) }]);
    await start(root);
    const r = await stop(root);
    expect(r.decision, name).toBe('block');
    expect(r.reason, name).toContain('planted failed');
    expect(r.reason, name).not.toContain('sandbox-runtime'); // a step failure, not srt being unavailable
    expect(readStopRecord(root), name).toMatchObject({ outcome: 'ran' });
    return { root, reason: r.reason };
  };

  test('threat: a step edits .harness/config.yaml (config tamper)', async () => {
    const probe = await planted('config write', `try{require('fs').appendFileSync('.harness/config.yaml','\\n# tampered\\n')}catch{process.exit(1)}`);
    expect(readFileSync(join(probe.root, '.harness/config.yaml'), 'utf8')).not.toContain('tampered');
  });

  test('threat: a step reads ~/.aws/credentials (credential theft)', async () => {
    const f = join(HOME, '.aws/credentials');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '[default]\naws_secret_access_key = fake\n');
    await planted('credential read', `try{require('fs').readFileSync(${J(f)})}catch{process.exit(1)}`);
  });

  test('threat: a step connects to a TCP service on host loopback (host service reach)', async () => {
    let hit = false;
    const server = createServer((c) => ((hit = true), c.destroy()));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as { port: number };
      await planted('loopback tcp', `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).setTimeout(3000,()=>process.exit(1))`);
      expect(hit).toBe(false); // nothing arrived at the host's server
    } finally {
      server.close();
    }
  });

  test('threat: a step reaches https://example.com (network egress; CI has network, so this proves it is denied)', async () => {
    await planted('egress', `fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(()=>process.exit(0),()=>process.exit(1))`);
  });

  test('threat: a step connects to a unix socket the test listens on in the temp folder (outer runner socket)', async () => {
    const dir = mkdtempSync('/tmp/h-e2e-'); // short: macOS limits a socket path to 103 bytes
    made.push(dir);
    const sock = join(dir, 's.sock');
    let hit = false;
    const server: Server = createServer((c) => ((hit = true), c.destroy()));
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      await planted('unix socket', `require('net').connect(${J(sock)}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).setTimeout(3000,()=>process.exit(1))`);
      expect(hit).toBe(false);
    } finally {
      server.close();
    }
  });

  // Threat: forged results. The step has the nonce (it can list the plan file) but not the seal, and it kills the runner, so the Stop must not allow.
  test.skipIf(!linux)('threat: a step forges a full nonce-tagged result set on its parent\'s stdout and SIGTERMs the parent (result forgery)', async () => {
    const forge = [
      "const fs=require('fs');",
      "const n=fs.readdirSync('.harness/state').find((f)=>/^plan-[0-9a-f]{32}\\.json$/.test(f)).slice(5,37);",
      'const L=(o)=>JSON.stringify({nonce:n,...o});',
      "const ls=['write canary','read canary','unix socket','network','user namespace'].map((name)=>L({kind:'check',name,ok:true}));",
      "ls.push(L({kind:'step',label:'s1',status:0,timedOut:false,ms:1}),L({kind:'step',label:'planted',status:0,timedOut:false,ms:1}),L({kind:'end',seal:'0'.repeat(64)}));",
      "try{fs.writeFileSync('/proc/'+process.ppid+'/fd/1',ls.join('\\n')+'\\n')}catch{}",
      "try{process.kill(process.ppid,'SIGTERM')}catch{}",
    ].join('');
    const root = session([...OK.slice(0, 1), { name: 'planted', run: node(forge) }]);
    await start(root);
    const r = await stop(root);
    expect(r.decision, r.reason).toBe('block'); // whatever the reason: it must never allow
  });

  test('evidence for the live batch: the record, the srt version and the Stop time are printed', async () => {
    const root = session(OK);
    await start(root);
    const r = await stop(root);
    expect(r.decision, r.reason).toBe('allow');
    const rec = readStopRecord(root);
    expect(rec).toMatchObject({ outcome: 'ran', srt: SRT });
    // console.log so the CI log shows it (the perf file uses stderr for the same reason).
    console.log(`[stop-srt] ${process.platform} srt ${SRT}: Stop took ${r.ms} ms; checks ${J(rec!.checks)}`);
  });
});
