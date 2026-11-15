import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  const sockDirs: string[] = [];
  let HOME = '';
  let env: NodeJS.ProcessEnv = {};
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), 'h-srt-home-'));
    made.push(HOME);
    // Attended, like the other e2e files, with a temp home so nothing reads the real one. HOME is also where the planted read step looks.
    env = { ...process.env, HARNESS_PLAIN_INIT: '1', HOME, USERPROFILE: HOME };
    for (const k of ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'HARNESS_SANDBOX']) delete env[k];
  });
  afterAll(() => {
    made.splice(0).forEach(cleanup);
    // The socket folder is under /tmp, outside the run folder that global-tmp.ts checks; a hard kill would leave it.
    for (const d of sockDirs) expect(existsSync(d), d).toBe(false);
  });

  const node = (code: string) => ['node', '-e', code];
  const OK = ['s1', 's2', 's3', 's4'].map((name) => ({ name, run: node('0') }));

  /** A repo with the overlay's steps, installed through the CLI. */
  const session = (steps: { name: string; run: string[] }[]): string => {
    const root = build(npmVitest());
    const cfgDir = mkdtempSync(join(tmpdir(), PREFIX));
    made.push(root, cfgDir);
    const cfg = join(cfgDir, 'answers.yaml');
    writeFileSync(cfg, `stop:\n  steps:\n${steps.map((s) => `    - name: ${s.name}\n      run: ${J(s.run)}\n`).join('')}`);
    const i = spawnSync('node', [CLI, 'init', '--config', cfg, '--yes'], { cwd: root, encoding: 'utf8', env });
    expect(i.status, i.stdout + i.stderr).toBe(0);
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
  // Coverage is written after the session's first hook (like install.e2e) so it is fresh, and an untracked non-doc file keeps the change list non-empty
  // whatever init gitignores, so the Stop never takes the docs-only allow without running the steps.
  const start = async (root: string) => {
    await hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    mkdirSync(join(root, 'coverage'), { recursive: true });
    writeFileSync(join(root, 'coverage/coverage-final.json'), '{}');
    writeFileSync(join(root, 'work.dat'), 'x');
  };
  const stop = async (root: string, cwd = root) => {
    const r = await hook(root, { hook_event_name: 'Stop', cwd });
    return { ...r, decision: (r.out?.decision as string | undefined) ?? 'allow', reason: (r.out?.reason as string | undefined) ?? '' };
  };

  test('four passing steps allow and the record shows every check ok; the record is rewritten once per Stop', async () => {
    const root = session(OK);
    await start(root);
    const first = await stop(root);
    expect(first.decision, first.reason).toBe('allow');
    const a = readStopRecord(root);
    expect(a).toMatchObject({ outcome: 'ran', srt: SRT });
    expect(Object.keys(a!.checks)).toHaveLength(linux ? 5 : 4);
    expect(Object.values(a!.checks).every((v) => v === 'ok')).toBe(true);
    // Limit: the record is written once per wrapped attempt, so a newer ts shows one attempt per Stop, not the number of srt processes
    // (a PATH shim that counts them is refused by the gate). The process count is not proven here.
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

  // Every planted step prints BLOCKED:<code> and exits 10 only when its attack was refused, and exits 0 when it got through. Anything else (a crash, a
  // timeout, a wrong path that is not an accepted code) fails the match below, and a preflight, settings or srt-exit failure has no "planted failed".
  const ATTACK = (body: string) => `const fs=require('fs');const B=(c)=>{console.log('BLOCKED:'+c);process.exit(10)};${body}`;
  const connectAttack = (target: string) => `const s=require('net').connect(${target});s.on('connect',()=>process.exit(0));s.on('error',(e)=>B(e.code));s.setTimeout(3000,()=>{console.log('TIMEOUT');process.exit(3)})`;
  const planted = async (name: string, script: string, blocked: RegExp, before?: (root: string) => void): Promise<string> => {
    const root = session([...OK.slice(0, 1), { name: 'planted', run: node(script) }]);
    await start(root);
    before?.(root); // right before the Stop, outside srt
    const r = await stop(root);
    expect(r.decision, `${name}: ${r.reason}`).toBe('block');
    expect(r.reason, name).toContain('planted failed');
    expect(r.reason, name).toMatch(blocked);
    expect(r.reason, name).not.toContain('sandbox-runtime'); // a step failure, not srt being unavailable
    expect(readStopRecord(root), name).toMatchObject({ outcome: 'ran' });
    return root;
  };

  test('threat: a step edits .harness/config.yaml (config tamper)', async () => {
    // The overlay writes the step's own command into the config, so compare bytes before and after the Stop instead of searching for a word.
    let before = Buffer.alloc(0);
    const root = await planted('config write', ATTACK(`try{fs.appendFileSync('.harness/config.yaml','\\n# tampered\\n');process.exit(0)}catch(e){B(e.code)}`), /BLOCKED:(EPERM|EROFS|EACCES)/, (r) => (before = readFileSync(join(r, '.harness/config.yaml'))));
    expect(before.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, '.harness/config.yaml')).equals(before)).toBe(true);
  });

  test('threat: a step reads the cloud credentials file under HOME (credential theft; srt may mask the file as empty)', async () => {
    const f = join(HOME, '.aws/credentials');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '[default]\naws_secret_access_key = fake\n');
    // Only the fake file's real content is a leak; an empty read is the mask, and a throw is a plain deny.
    // srt 0.0.83 on Linux hides the denied file, so the step sees ENOENT; that is accepted here only because the file is shown to exist outside srt first.
    await planted('credential read', ATTACK(`try{const c=fs.readFileSync(${J(f)},'utf8');if(c.includes('aws_secret_access_key'))process.exit(0);B('masked-empty')}catch(e){B(e.code)}`), /BLOCKED:(masked-empty|EPERM|EACCES|ENOENT)/, () => expect(readFileSync(f, 'utf8')).toContain('aws_secret_access_key'));
  });

  test('threat: a step connects to a TCP service on host loopback (host service reach)', async () => {
    let hit = false;
    const server = createServer((c) => ((hit = true), c.destroy()));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as { port: number };
      await planted('loopback tcp', ATTACK(connectAttack(`${port},'127.0.0.1'`)), /BLOCKED:(ECONNREFUSED|EPERM|EACCES|ENETUNREACH)/);
      expect(hit).toBe(false); // nothing arrived at the host's server
    } finally {
      server.close();
    }
  });

  test('threat: a step reaches https://example.com (network egress; denied only if this machine can reach it unsandboxed)', async (ctx) => {
    // Control, outside srt: with no internet a denial proves nothing, so skip with the reason in the log.
    const up = await fetch('https://example.com', { method: 'HEAD', signal: AbortSignal.timeout(8000) }).then(
      () => true,
      (e) => (console.log(`[stop-srt] egress case skipped, example.com is unreachable here: ${e}`), false),
    );
    if (!up) return ctx.skip();
    await planted('egress', ATTACK(`fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(()=>process.exit(0),(e)=>B((e.cause&&e.cause.code)||e.name))`), /BLOCKED:(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EPERM|EACCES)/);
  });

  test('threat: a step connects to a unix socket the test listens on in the temp folder (outer runner socket)', async () => {
    const dir = mkdtempSync('/tmp/h-e2e-'); // short: macOS limits a socket path to 103 bytes
    sockDirs.push(dir);
    made.push(dir);
    const sock = join(dir, 's.sock');
    let hit = false;
    const server: Server = createServer((c) => ((hit = true), c.destroy()));
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      // ENOENT would mean the fence hides /tmp rather than refusing the connect; the printed exists= shows which, and a wrong path is visible.
      const log = `console.log('exists='+fs.existsSync(${J(sock)}));`;
      await planted('unix socket', ATTACK(log + connectAttack(J(sock))), /exists=(true|false)[\s\S]*BLOCKED:(EPERM|EACCES|ECONNREFUSED|ENOENT)/);
      expect(hit).toBe(false);
    } finally {
      server.close();
    }
  });

  // Threat: forged results. The step has the nonce (it can list the plan file) but not the seal, and it kills the runner. It records in a repo file what
  // happened, because the runner's stdout is lost when it dies. Either the write was denied (the step fails) or the runner died or its output was
  // rejected; never an allow, and never a settings or preflight failure.
  test.skipIf(!linux)("threat: a step forges a full nonce-tagged result set on its parent's stdout and SIGTERMs the parent (result forgery)", async () => {
    const forge = [
      "const fs=require('fs');",
      "const n=fs.readdirSync('.harness/state').find((f)=>/^plan-[0-9a-f]{32}\\.json$/.test(f)).slice(5,37);",
      'const L=(o)=>JSON.stringify({nonce:n,...o});',
      "const ls=['write canary','read canary','unix socket','network','user namespace'].map((name)=>L({kind:'check',name,ok:true}));",
      "ls.push(L({kind:'step',label:'s1',status:0,timedOut:false,ms:1}),L({kind:'step',label:'planted',status:0,timedOut:false,ms:1}),L({kind:'end',seal:'0'.repeat(64)}));",
      "try{fs.writeFileSync('/proc/'+process.ppid+'/fd/1',ls.join('\\n')+'\\n')}catch(e){fs.writeFileSync('forge-marker','forge-write-denied:'+e.code);console.log('BLOCKED:'+e.code);process.exit(10)}",
      "fs.writeFileSync('forge-marker','forge-write-ok');",
      "try{process.kill(process.ppid,'SIGTERM')}catch(e){console.log('BLOCKED:'+e.code);process.exit(10)}",
    ].join('');
    const root = session([...OK.slice(0, 1), { name: 'planted', run: node(forge) }]);
    await start(root);
    const r = await stop(root);
    const marker = readFileSync(join(root, 'forge-marker'), 'utf8'); // missing = the forgery never ran, so the case fails instead of passing vacuously
    console.log(`[stop-srt] forgery: ${marker}`);
    expect(r.decision, r.reason).toBe('block');
    const rec = readStopRecord(root);
    if (marker === 'forge-write-ok') {
      // The runner died or its lines were rejected: srt-unavailable with a result-line or srt-exit reason, no check ever accepted, and not a step failure.
      expect(rec).toMatchObject({ outcome: 'unavailable', checks: {} });
      expect(['result lines', 'srt exit']).toContain(rec!.reason);
      expect(r.reason).toContain('sandbox-runtime');
      expect(r.reason).not.toContain('planted failed');
    } else {
      expect(marker).toMatch(/^forge-write-denied:/); // the fence refused the write: the step itself failed
      expect(rec).toMatchObject({ outcome: 'ran' });
      expect(r.reason).toContain('planted failed');
    }
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
