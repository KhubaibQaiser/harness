import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadCatalog } from '../catalog/load.js';
import { loadConfig } from '../core/config.js';
import { writeAtomic } from '../core/atomic.js';
import { readEvents } from '../core/events.js';
import { defaultExec } from '../core/exec.js';
import { readTiming } from '../core/timing.js';
import { detect } from '../install/detect.js';
import { selectedIds } from '../install/plan.js';
import { packageDir } from '../core/package-dir.js';
import { buildExport, exportProblems, type Known } from '../report/export.js';
import { NO_SESSIONS, renderReport, type ReportData } from '../report/html.js';
import { readEvalResults } from '../report/evals.js';
import { enforcedLine, ruleRows } from '../report/rules.js';
import { locateSessions, type GitRun } from '../report/locate.js';
import { gatesAcc } from '../report/metrics/gates.js';
import { installedSkills, skillSpecs, skillsAcc } from '../report/metrics/skills.js';
import { alwaysLoaded, usageAcc } from '../report/metrics/usage.js';
import { TESTED } from '../report/transcript.js';
import { runSession } from '../report/turns.js';
import { COUNTERS, windowsAcc } from '../report/windows.js';
import { insideClaude } from './claude-only.js';
import type { CliEnv } from './index.js';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0-dev';
export const USAGE = 'Usage: harness report [--days N] [--open] [--export]';
const DEFAULT_DAYS = 14, DAY = 86_400_000, DATE_LEN = 10;
const REPORTS = '.harness/reports';
const BAD_ARGS = 2, INDENT = 2, SEP_LEN = 2, MAX_DAYS = 3650;

export type ReportEnv = CliEnv & {
  home?: string; git?: GitRun; now?: () => number; open?: (path: string) => void;
  /** Test seam only (the refusal path can't be reached with real data): replaces the export builder. */
  buildExport?: typeof buildExport;
};

function parseArgs(args: string[]): { days: number; open: boolean; exp: boolean } | null {
  const r = { days: DEFAULT_DAYS, open: false, exp: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--open') r.open = true;
    else if (a === '--export') r.exp = true;
    else if (a === '--days' && /^[1-9]\d*$/.test(args[i + 1] ?? '') && Number(args[i + 1]) <= MAX_DAYS) r.days = Number(args[++i]);
    else return null;
  }
  return r;
}

/** The opener per platform. The path is always one array element; Windows uses explorer.exe, never cmd, so `&` in a path means nothing. */
export function openCommand(platform: NodeJS.Platform, path: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [path]];
  if (platform === 'win32') return ['explorer.exe', [path]];
  return ['xdg-open', [path]];
}
function defaultOpen(path: string): void {
  const [cmd, argv] = openCommand(process.platform, path);
  spawn(cmd, argv, { stdio: 'ignore', detached: true, shell: false }).on('error', () => undefined).unref();
}

const num = (v: string): number[] => v.split('.').map(Number);
const cmp = (a: string, b: string): number => num(a).reduce((d, x, i) => d || x - (num(b)[i] ?? 0), 0);
const untested = (versions: string[]): string[] =>
  versions.filter((v) => !/^\d+\.\d+\.\d+$/.test(v) || cmp(v, TESTED.min) < 0 || cmp(v, TESTED.max) > 0);

/** Export ids: catalog ids and the rule names; every other name becomes `other`. */
export const exportKnown = (): Known => ({ ids: new Set([...loadCatalog().catalog.items.map((i) => i.id), ...Object.keys(COUNTERS)]) });

async function collect(root: string, cli: ReportEnv, days: number, now: number): Promise<ReportData> {
  const sinceMs = now - days * DAY;
  const git: GitRun = cli.git ?? ((a) => { const r = defaultExec('git', ['-C', root, ...a]); return { status: r.status, stdout: r.stdout }; });
  const located = await locateSessions(root, { env: cli.env, home: cli.home ?? homedir(), sinceMs, git });
  const cat = loadCatalog().catalog.items;
  const cfg = loadConfig(root).config;
  const ids = new Set(selectedIds(cfg));
  const facts = detect(root); // ponytail: detect gives frameworks repo-wide, not per package, so each package gets the whole set
  const selected = cat.filter((i) => ids.has(i.id)).map((i) => ({ id: i.id, frameworks: i.applies_when?.frameworks ?? [] }));
  const skills = skillsAcc(skillSpecs(root, installedSkills(root), facts.packages.map((k) => ({ dir: k.dir, frameworks: facts.frameworks })), selected));
  const usage = usageAcc(), windows = windowsAcc({ tddGateOn: cfg.checks.tdd, root });
  const gates = gatesAcc(readEvents(root), readTiming(root), sinceMs);
  const versions = new Set<string>();
  let unknown = 0;
  for (const s of located.sessions) {
    try {
      const st = await runSession(s, s.session, [skills, usage, windows, gates], sinceMs);
      st.versions.forEach((v) => versions.add(v));
    } catch { unknown++; }
  }
  const vs = [...versions].sort();
  const dirs = { templates: packageDir('templates'), plugin: dirname(packageDir('templates')) };
  const evals = readEvalResults(root), gr = gates.result(), wr = windows.result();
  return {
    meta: {
      generated: new Date(now).toISOString(), days, harness: VERSION, claudeVersions: vs, untested: untested(vs),
      sessions: { scanned: located.sessions.length - unknown, skipped: located.skipped as Record<string, number>, unknown },
    },
    usage: usage.result(), always: alwaysLoaded(root, dirs), skills: skills.result(), windows: wr, gates: gr, rules: ruleRows(cfg, gr, wr), ...(evals.length > 0 && { evals }),
  };
}

/** Counts only, no quoted text, no session paths. */
function summary(d: ReportData, rel: string, expRel?: string): string[] {
  const m = d.meta, t = d.usage.total, skipped = Object.values(m.sessions.skipped).reduce((a, b) => a + b, 0);
  const rel2 = d.skills.reduce((a, s) => a + s.relevantIn, 0), hit = d.skills.reduce((a, s) => a + s.invokedRelevant, 0);
  const notes = Object.entries(d.windows.notes).map(([k, v]) => `${k} ${v}`).join(', ');
  return [
    `Sessions: ${m.sessions.scanned} scanned, ${skipped} skipped, ${m.sessions.unknown} unknown (last ${m.days} days)`,
    ...(m.sessions.scanned === 0 ? [NO_SESSIONS] : []),
    `Skills invoked when relevant: ${hit} of ${rel2}; probable false blocks: ${d.gates.falseBlocks.length}`,
    `Rules enforced: ${d.rules ? enforcedLine(d.rules) : 'not computed'}`,
    `Tokens: input ${t.input}, cache write ${t.cacheWrite}, cache read ${t.cacheRead}, output ${t.output}`,
    `Windows notes: ${notes}`,
    ...(expRel ? [`Export: ${expRel}`] : []),
    `Report: ${rel}`,
  ];
}

const rootIgnores = (root: string): boolean => {
  try { return readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).includes(`${REPORTS}/`); } catch { return false; }
};

export async function report(args: string[], cli: ReportEnv): Promise<number> {
  const a = parseArgs(args);
  if (!a) return cli.out(USAGE), BAD_ARGS;
  if (insideClaude(cli.env)) return cli.out('Run harness report in your own terminal for now.'), 1;
  const now = (cli.now ?? Date.now)();
  let data: ReportData;
  try {
    data = await collect(cli.root, cli, a.days, now);
  } catch (e) {
    return cli.out(`Could not build the report: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown error'}`), 1;
  }
  const day = data.meta.generated.slice(0, DATE_LEN);
  const known = exportKnown();
  const exported = a.exp ? (cli.buildExport ?? buildExport)(data, known) : undefined;
  const problems = exported ? exportProblems(exported, known) : [];
  if (problems.length > 0) {
    // kinds only: a problem's path can carry hostile text
    cli.out(`Export refused, nothing written: ${[...new Set(problems.map((p) => p.slice(p.lastIndexOf(': ') + SEP_LEN)))].join('; ')}`);
    return 1;
  }
  const dir = join(cli.root, REPORTS), html = join(dir, `${day}.html`);
  try {
    mkdirSync(dir, { recursive: true });
    if (!rootIgnores(cli.root) && !existsSync(join(dir, '.gitignore'))) writeAtomic(join(dir, '.gitignore'), '*'); // fallback until `harness update` adds the root line
    writeAtomic(html, renderReport(data));
    if (exported) writeAtomic(join(dir, `${day}-export.json`), JSON.stringify(exported, null, INDENT) + '\n');
  } catch {
    return cli.out(`Could not write ${REPORTS}/ (check its permissions).`), 1;
  }
  summary(data, `${REPORTS}/${day}.html`, exported ? `${REPORTS}/${day}-export.json` : undefined).forEach((l) => cli.out(l));
  if (a.open) (cli.open ?? defaultOpen)(html);
  return 0;
}
