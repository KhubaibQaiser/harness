import type { HarnessConfig } from '../core/config.js';
import type { GatesResult } from './metrics/gates.js';
import type { WindowRule, WindowsResult } from './windows.js';

// The rule coverage matrix (spec §5.1), computed from config and counted from the logs. Never a score: an off check is "no", not "followed".
export type RuleId = 'ask-first' | 'no-invented-data' | 'fix-everything' | 'small-prs' | 'readme-per-pr' | 'paid-ok' | 'tdd' | 'lean-context' | 'plain-communication' | 'no-ai-trailer' | 'branch-prefix';
export interface RuleDef { id: RuleId; kind: 'judgement' | 'mechanical' | 'partial' | 'measured' | 'heuristic'; checks: string[]; on: (c: HarnessConfig) => boolean; bypasses: string[] }
export interface RuleRow { def: RuleDef; enforced: 'yes' | 'partial' | 'no'; fires: number; denies: number; asks: number; blocks: number; probableFalse: number; windows: number }

const never = (): boolean => false;
const def = (id: RuleId, kind: RuleDef['kind'], checks: string[], on: RuleDef['on'], bypasses: string[] = []): RuleDef => ({ id, kind, checks, on, bypasses });
const TDD_CHECKS = ['red-first', 'test-lock', 'tamper', 'spec-gate'];

export const RULES: RuleDef[] = [
  def('ask-first', 'judgement', [], never),
  def('no-invented-data', 'partial', ['dep-verify'], (c) => c.checks.depVerify || c.checks.stop, ['a made-up number labelled "estimate" passes the heuristic']),
  def('fix-everything', 'judgement', [], never),
  def('small-prs', 'mechanical', ['pr-size'], (c) => c.checks.prSize, ['PRs from the web UI or GitHub MCP (PR-size §2 "Out")']),
  def('readme-per-pr', 'heuristic', [], never),
  def('paid-ok', 'partial', [], (c) => c.checks.guard, ['any paid command not in the list']),
  def('tdd', 'mechanical', TDD_CHECKS, (c) => c.checks.tdd, ['`harness tdd off` (a person only)', '`tdd.exempt` paths']),
  def('lean-context', 'measured', [], never, ['not enforced at run time']),
  def('plain-communication', 'judgement', [], never),
  def('no-ai-trailer', 'mechanical', [], (c) => c.preset?.git.no_ai_trailer === true, ['a message from `-F <file>` or an editor (PP §9 limit)']),
  def('branch-prefix', 'mechanical', [], (c) => (c.preset?.git.branch_prefixes.length ?? 0) > 0, ['`git branch <name>` then `git checkout <name>`', 'PP lists only the four forms']),
];

const WINDOW_RULES = new Set<string>(['ask-first', 'no-invented-data', 'fix-everything', 'readme-per-pr', 'paid-ok', 'plain-communication', 'tdd']);

export function ruleRows(config: HarnessConfig, gates: GatesResult, windows: WindowsResult): RuleRow[] {
  const count = (checks: string[], decision?: string): number =>
    Object.entries(gates.tally).reduce((a, [k, v]) => {
      const [check = '', d = ''] = k.split(' ');
      return a + (checks.includes(check) && (decision === undefined || d === decision) ? v : 0);
    }, 0);
  return RULES.map((def) => {
    const on = def.on(config);
    return {
      def, enforced: !on ? 'no' : def.kind === 'partial' ? 'partial' : 'yes',
      fires: count(def.checks), denies: count(def.checks, 'deny'), asks: count(def.checks, 'ask'), blocks: count(def.checks, 'block'),
      probableFalse: gates.falseBlocks.filter((f) => def.checks.includes(f.check)).length,
      windows: WINDOW_RULES.has(def.id) ? windows.byRule[def.id as WindowRule].total : 0,
    };
  });
}

export function enforcedLine(rows: RuleRow[]): string {
  const n = (e: RuleRow['enforced']): number => rows.filter((r) => r.enforced === e).length;
  return `${n('yes')} of ${rows.length} rules enforced deterministically, ${n('partial')} partly`;
}
