import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readStopRecord } from '../../src/checks/stop/record.js';
import { makeRepo } from '../install/helpers.js';
import { realSrtVersion, SRT_ON } from '../srt-real.js';
import { report } from './overhead.js';

// What the sandbox adds to a Stop: four `node -e 0` steps in a repo with a large node_modules, wrapped in a real srt and unwrapped.
// Runs only in the stop-srt CI job (HARNESS_E2E_SRT=1); fails at import there when srt is missing or old, skips (touching nothing) otherwise.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.mjs');
const SRT = SRT_ON ? realSrtVersion() : '';
const PACKAGES = 2000;
const RUNS = 5;
const BUDGET_MS = 2000; // the estimated target (spec §14); the first CI numbers set the real budget

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe.skipIf(!SRT_ON)('Stop gate overhead of srt', () => {
  const made: string[] = [];
  afterAll(() => made.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  let home = '';
  let env: NodeJS.ProcessEnv = {};
  beforeAll(() => { // not at collection time: a skipped file never runs afterAll, so nothing may be created before a test runs
    home = mkdtempSync(join(tmpdir(), 'h-srt-perf-home-'));
    made.push(home);
    env = { ...process.env, HARNESS_PLAIN_INIT: '1', HOME: home, USERPROFILE: home };
    for (const k of ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'HARNESS_SANDBOX']) delete env[k];
  });

  /** A started session; `off` writes sandbox: off into the config before the session's first hook, the only point the gate honours it. */
  const session = (off: boolean): string => {
    const root = realpathSync(makeRepo({ 'package.json': '{"name":"p"}\n', '.gitignore': 'node_modules\n', 'src/a.ts': 'export const a = 1;\n' }));
    made.push(root);
    for (let i = 0; i < PACKAGES; i++) {
      const dir = join(root, 'node_modules', `pkg-${i}`, 'a/b/c');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.js'), 'module.exports = 0;\n');
    }
    const cfg = join(home, off ? 'off.yaml' : 'on.yaml');
    const steps = ['s1', 's2', 's3', 's4'].map((n) => `    - name: ${n}\n      run: ["node", "-e", "0"]\n`).join('');
    writeFileSync(cfg, `${off ? 'sandbox: off\n' : ''}stop:\n  steps:\n${steps}`);
    const i = spawnSync('node', [CLI, 'init', '--config', cfg, '--yes'], { cwd: root, encoding: 'utf8', env });
    expect(i.status, i.stdout + i.stderr).toBe(0);
    hook(root, 'UserPromptSubmit');
    mkdirSync(join(root, 'coverage'), { recursive: true }); // after the session's first hook, so it is fresh
    writeFileSync(join(root, 'coverage/coverage-final.json'), '{}');
    writeFileSync(join(root, 'work.dat'), 'x'); // a non-doc change, so the Stop runs the steps
    cold.push(hook(root, 'Stop').ms); // one discarded warm-up Stop; the first wrapped one pays srt's one-time cost, so it is logged apart
    return root;
  };
  const hook = (root: string, event: string) => {
    const t0 = performance.now();
    const r = spawnSync('node', [join(root, '.harness/hooks/dispatch.mjs')], { cwd: root, encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: event, session_id: 's1', cwd: root, prompt: 'go' }) });
    expect(r.status, r.stderr).toBe(0);
    return { ms: performance.now() - t0, out: r.stdout };
  };
  const cold: number[] = [];
  const times = (root: string, check: (out: string) => void) =>
    Array.from({ length: RUNS }, () => {
      const r = hook(root, 'Stop');
      check(r.out);
      return r.ms;
    });

  test(`wrapped Stop adds under ${BUDGET_MS} ms to the unwrapped one`, () => {
    const off = times(session(true), (out) => expect(out).toContain('ran without the sandbox')); // an allow that says it was unwrapped
    const root = session(false);
    const on = times(root, (out) => expect(out ? JSON.parse(out).decision : 'allow').toBe('allow'));
    expect(readStopRecord(root)).toMatchObject({ outcome: 'ran', srt: SRT });
    const [w, u] = [median(on), median(off)];
    writeSync(2, `[perf] stop-srt ${process.platform} srt ${SRT}: wrapped median ${w.toFixed(0)} ms, unwrapped median ${u.toFixed(0)} ms (runs ${on.map(Math.round)} / ${off.map(Math.round)}; discarded cold first Stops: unwrapped ${cold[0]!.toFixed(0)} ms, wrapped ${cold[1]!.toFixed(0)} ms)\n`);
    report('stop-srt', { overhead: w - u, total: w });
    expect(w - u).toBeLessThan(BUDGET_MS);
  }, 600_000);
});
