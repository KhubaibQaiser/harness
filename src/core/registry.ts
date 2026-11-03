/** Latest published version of `pkg` on npm, or null on any failure. Sends nothing but the package name. */
export async function latestVersion(pkg: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return null;
    const v = ((await res.json()) as { version?: unknown } | null)?.version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
