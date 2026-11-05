import { findPreset } from '../catalog/presets.js';
import { harnessIgnore } from '../install/harnessignore.js';
import type { Facts } from '../install/detect.js';
import { type App, defaults, esc, type HarnessConfig, relPathProblem } from '../core/config.js';
import { validateConfig } from '../core/config-io.js';

export interface Answers {
  scope: { paths: string[] } | { text: string };
  project: Omit<HarnessConfig['project'], 'scope_paths'>;
  apps: App[];
  unattended: HarnessConfig['unattended'];
  tdd: { paths: string[]; diff_coverage: number };
  preset: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// A path from the interview is a trust boundary: the repo's own files only, never secrets, never harness state.
function pathProblem(p: unknown, ignored: (rel: string) => boolean): string | null {
  if (typeof p !== 'string' || p === '') return 'must be a non-empty string';
  const bad = relPathProblem(p);
  if (bad) return `"${esc(p)}" ${bad}`;
  const segs = p.split('/');
  if (segs.some((s) => /^\.env(\..*)?$/i.test(s) || /\.env$/i.test(s)))return `"${esc(p)}" must not be a dotenv file`;
  if (/^(\.\/)*\.harness(\/|$)/i.test(p)) return `"${esc(p)}" must not be inside .harness/`;
  if (ignored(p.replace(/^(\.\/)+/, ''))) return `"${esc(p)}" is ignored by .harnessignore`;
  return null;
}

export function validateAnswers(raw: unknown, facts: Facts): { ok: true; answers: Answers } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['answers: must be a mapping'] };
  const errors: string[] = [];
  const ignored = harnessIgnore(facts.root);
  for (const k of Object.keys(raw)) if (!['scope', 'project', 'apps', 'unattended', 'tdd', 'preset'].includes(k)) errors.push(`${esc(k)}: unknown key`);

  const paths = (list: unknown, at: string) => {
    if (!Array.isArray(list)) return errors.push(`${at}: must be a list of paths`);
    list.forEach((p, i) => {
      const bad = pathProblem(p, ignored);
      if (bad) errors.push(`${at}[${i}]: ${bad}`);
    });
  };
  const scope = raw.scope;
  if (isObj(scope) && Object.keys(scope).length === 1 && Array.isArray(scope.paths)) paths(scope.paths, 'scope.paths');
  else if (!(isObj(scope) && Object.keys(scope).length === 1 && typeof scope.text === 'string')) errors.push('scope: must be { paths: [...] } or { text: "..." }');

  // The config table checks project, apps, unattended and tdd, so the range rules stay in one place.
  const tdd = raw.tdd;
  for (const k of ['project', 'unattended', 'tdd'] as const) if (!isObj(raw[k])) errors.push(`${k}: must be a mapping`);
  if (isObj(tdd)) {
    for (const k of Object.keys(tdd)) if (k !== 'paths' && k !== 'diff_coverage') errors.push(`tdd.${esc(k)}: unknown key`);
    paths(tdd.paths, 'tdd.paths');
  }
  // The interview always writes full objects, so a missing key is an error rather than a silent default.
  const missing: string[] = [];
  const need = (k: 'project' | 'unattended' | 'tdd', keys: string[]) => {
    if (isObj(raw[k])) for (const n of keys) if (!Object.hasOwn(raw[k], n)) missing.push(`${k}.${n}`);
  };
  const d = defaults();
  need('project', Object.keys(d.project).filter((n) => n !== 'scope_paths'));
  need('unattended', Object.keys(d.unattended));
  need('tdd', ['paths', 'diff_coverage']);
  errors.push(...missing.map((m) => `${m}: required`));
  const project = isObj(raw.project) ? { ...raw.project, scope_paths: [] } : {};
  const v = validateConfig({ project, apps: raw.apps, unattended: raw.unattended, tdd: isObj(tdd) ? { paths: tdd.paths, diff_coverage: tdd.diff_coverage } : {} });
  if (!v.ok) errors.push(...v.errors.filter((e) => !missing.some((m) => e.startsWith(`${m}:`))));
  else if (isObj(raw.project) && 'scope_paths' in raw.project) errors.push('project.scope_paths: unknown key');

  if (Array.isArray(raw.apps)) {
    const dirs = new Set(facts.apps.map((a) => a.dir));
    raw.apps.forEach((a, i) => {
      if (isObj(a) && typeof a.dir === 'string' && !dirs.has(a.dir)) errors.push(`apps[${i}].dir: no app at "${esc(a.dir)}" in this repo`);
    });
  }
  const preset = raw.preset ?? null;
  if (preset !== null && (typeof preset !== 'string' || !findPreset(preset, facts.root))) errors.push(`preset: "${esc(String(preset))}" is not a shipped or repo preset (harness preset list shows them)`);
  if (errors.length) return { ok: false, errors };
  const c = (v as { config: HarnessConfig }).config;
  const { scope_paths: _drop, ...p } = c.project;
  return { ok: true, answers: { scope: raw.scope as Answers['scope'], project: p, apps: c.apps, unattended: c.unattended, tdd: { paths: c.tdd.paths, diff_coverage: c.tdd.diff_coverage }, preset: preset as string | null } };
}

/** Never changes sandbox, tdd.results_dir or checks (ruling 15). */
export function answersToConfig(base: HarnessConfig, a: Answers): HarnessConfig {
  const c = structuredClone(base);
  c.project = { ...a.project, scope_paths: 'paths' in a.scope ? [...a.scope.paths] : [] };
  c.apps = structuredClone(a.apps);
  c.unattended = { ...a.unattended };
  c.tdd.paths = [...a.tdd.paths];
  c.tdd.diff_coverage = a.tdd.diff_coverage;
  return c;
}

/** The answers a config already holds, in the shape of an answers file (the base a partial update file goes over). */
export function configToAnswers(c: HarnessConfig): Record<string, unknown> {
  const { scope_paths, ...project } = c.project;
  return { scope: { paths: scope_paths }, project, apps: c.apps, unattended: c.unattended, tdd: { paths: c.tdd.paths, diff_coverage: c.tdd.diff_coverage }, preset: c.preset?.id ?? null };
}
