/** The newest of `pkg`'s `latest` and `beta` tags on npm, or null on any failure. Sends nothing but the package name. */
export async function latestVersion(pkg: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/-/package/${pkg.replace('/', '%2f')}/dist-tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return null;
    const tags = (await res.json()) as { latest?: unknown; beta?: unknown } | null;
    const [latest, beta] = [tags?.latest, tags?.beta];
    if (typeof latest !== 'string') return typeof beta === 'string' ? beta : null; // a beta tag alone still answers
    return typeof beta === 'string' && newer(beta, latest) ? beta : latest;
  } catch {
    return null;
  }
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** True when semver `a` has higher precedence than `b` (prerelease rules: 1.0.0-beta.10 > 1.0.0-beta.2, 1.0.0 > 1.0.0-beta). False if either is not semver. */
export function newer(a: string, b: string): boolean {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  if (!x[4] || !y[4]) return !x[4] && !!y[4]; // a release outranks its prereleases
  const p = x[4].split('.'), q = y[4].split('.');
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    const [m, n] = [/^\d+$/.test(p[i]!), /^\d+$/.test(q[i]!)];
    if (m && n) return Number(p[i]) > Number(q[i]);
    if (m !== n) return n; // numeric identifiers rank below alphanumeric ones
    return p[i]! > q[i]!;
  }
  return p.length > q.length;
}
