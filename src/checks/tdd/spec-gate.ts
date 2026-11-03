// A feature in features.json may only become `passes: true` when each criterion names a test that just passed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toRepoPath } from '../../core/paths.js';
import type { Check } from '../../hooks/dispatch.js';
import { editTarget, isShell } from '../../hooks/edit-target.js';
import { fileWriteTargets } from '../guard.js';
import { newestFresh, readResults, resultsDir } from './results.js';
import { afterContent } from './tamper.js';

type Feature = { id?: unknown; passes?: unknown; criteria?: unknown };
const FILE = 'features.json';

const features = (text: string): Feature[] | null => {
  try {
    const f = (JSON.parse(text) as { features?: unknown })?.features;
    return Array.isArray(f) ? f : null;
  } catch {
    return null;
  }
};

export const specGate: Check = {
  name: 'specGate',
  events: ['PreToolUse'],
  pure: true,
  run(ctx) {
    if (!ctx.config.checks.tdd) return { kind: 'allow' };
    const { tool_name, tool_input = {} } = ctx.input;
    const deny = (reason: string) => ({ kind: 'deny' as const, reason, check: 'spec-gate' });
    if (isShell(tool_name)) {
      const cmd = tool_input.command;
      const hit = typeof cmd === 'string' && fileWriteTargets(cmd).some((t) => toRepoPath(ctx.root, t) === FILE);
      return hit ? deny('Edit features.json with the Edit or Write tool so the spec gate can check it.') : { kind: 'allow' };
    }
    const p = editTarget(ctx.input);
    if (p === null || toRepoPath(ctx.root, p) !== FILE) return { kind: 'allow' };

    let current = '';
    try {
      current = readFileSync(resolve(ctx.root, p), 'utf8');
    } catch {
      // missing file: nothing passing yet
    }
    const afterText = afterContent(ctx.input, current);
    const after = features(afterText);
    if (!after) {
      try {
        JSON.parse(afterText);
      } catch {
        return deny('features.json would be invalid JSON.');
      }
      return { kind: 'allow' };
    }
    const seen = new Set<unknown>();
    for (const f of after) {
      if (typeof f?.id !== 'string' || !f.id || seen.has(f.id)) return deny(`features.json has a missing or duplicate feature id: ${typeof f?.id === 'string' && f.id ? f.id : '(missing)'}.`);
      seen.add(f.id);
    }
    for (const f of after) if (f.passes !== undefined && typeof f.passes !== 'boolean') return deny(`${String(f.id)} has a non-boolean passes value.`);
    const wasPassing = new Set((features(current) ?? []).filter((f) => f.passes === true).map((f) => f.id));
    const fresh = newestFresh(readResults(ctx.root, resultsDir(ctx.root, ctx.config)), ctx.state.startedAt);

    const reasons: string[] = [];
    for (const f of after) {
      if (f.passes !== true || wasPassing.has(f.id)) continue;
      const criteria = Array.isArray(f.criteria) ? (f.criteria as { text?: unknown; test?: unknown }[]) : [];
      const why = (() => {
        if (!criteria.length) return 'no criteria.';
        for (const c of criteria) {
          const r = (() => {
            const t = typeof c?.test === 'string' ? c.test : '';
            const i = t.indexOf('::');
            if (i < 0) return 'no test named';
            const hit = fresh.get(toRepoPath(ctx.root, t.slice(0, i)) ?? '')?.tests.find((x) => x.fullName === t.slice(i + 2));
            return !hit ? 'test not found' : hit.status !== 'passed' ? 'test not passing' : '';
          })();
          if (r) return `${String(c?.text)} → ${r}.`;
        }
        return '';
      })();
      if (why) reasons.push(`${String(f.id)} can't be marked passing: ${why}`);
    }
    return reasons.length ? deny(reasons.join('; ')) : { kind: 'allow' };
  },
};
