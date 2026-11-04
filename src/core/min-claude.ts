import { execFileSync } from 'node:child_process';
import { syncCommand } from '../checks/stop/runner.js';

// onFailure (2.1.295), Monitor in Bash hooks and the sandbox glob fixes (2.1.314): spec D5.
export const MIN_CLAUDE_CODE = '2.1.314';

// `claude` is a Node program and can take seconds to start on a busy machine; a short limit read as "not installed".
const VERSION_TIMEOUT_MS = 15_000;

export function claudeVersion(): string | null {
  try {
    const [file, args, opts] = syncCommand('claude', ['--version']);
    const v = execFileSync(file, args, { ...opts, encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    return /\d+\.\d+\.\d+/.exec(v)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** True when dotted version `a` is older than `b` (numeric per part, so 2.1.9 < 2.1.10). */
export function olderThan(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
