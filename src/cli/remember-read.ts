// The read-only `harness remember` output (spec §5): `list` now; `check` joins it in Task 7.
import type { HarnessConfig } from '../core/config.js';
import { shown } from '../core/decision-file.js';
import { readDecisions } from '../core/decisions.js';

const STATUS_WIDTH = 8; // `superseded` overflows by design and still gets one space

/** One line per valid decision, sorted by id. `cfg` feeds the staleness column, which Task 7 fills in. */
export function list(root: string, cfg: HarnessConfig, today: string): string[] {
  void cfg;
  return readDecisions(root, today).decisions
    .map((d) => `${d.id}  ${d.status.padEnd(STATUS_WIDTH)} confirmed ${d.verified_on}  ${d.paths.map(shown).join(', ')}`)
    .sort();
}
