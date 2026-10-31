import type { Ctx } from '../../hooks/dispatch.js';
import type { Decision } from '../../hooks/types.js';
import type { Exec } from './gate.js';

// Task 15 replaces this body with the diff-coverage check; a below-threshold result is a `block` with its report.
export function coverageGate(_ctx: Ctx, _exec: Exec): Decision {
  return { kind: 'allow' };
}
