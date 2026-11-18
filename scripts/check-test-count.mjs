// Fails CI when the suite silently shrinks: a project's passed-test count below its floor, or a test file that failed to load.
// Usage: node scripts/check-test-count.mjs [vitest-json-report | dir of shard reports] [floor-json] [platform]
// A directory is searched for *.json reports (one per CI shard) and their counts are summed against the full-suite floor.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [reportPath = 'node_modules/.cache/test-report.json', floorPath = '.github/test-floor.json', platform = process.platform] = process.argv.slice(2);
// Floors are per platform: some tests skip on Windows, so its passed count differs.
const floor = JSON.parse(readFileSync(floorPath, 'utf8'))[platform];
if (!floor) { console.error(`no floor for ${platform} in ${floorPath}; add one (the passed counts of a full ${platform} run)`); process.exit(1); }
const reports = statSync(reportPath).isDirectory() ? readdirSync(reportPath, { recursive: true }).filter((n) => n.endsWith('.json')).map((n) => join(reportPath, n)) : [reportPath];
const files = reports.flatMap((r) => { const t = JSON.parse(readFileSync(r, 'utf8')).testResults; return Array.isArray(t) ? t : []; });
if (files.length === 0) { console.error(`${reportPath}: no test results; did the run write the JSON report?`); process.exit(1); }

const projectOf = (name) => { const p = name.replaceAll('\\', '/'); return p.includes('/test/e2e/') ? 'e2e' : p.includes('/test/perf/') ? 'perf' : 'unit'; };
const passed = {};
const problems = [];
const seen = new Set();
for (const f of files) {
  // shards split by file, so a file twice means a report was counted twice, which could hide a shrunken suite
  if (seen.has(f.name)) problems.push(`in more than one report: ${f.name}`);
  seen.add(f.name);
  const results = f.assertionResults ?? [];
  // vitest reports a file that throws at import as failed with no test results
  if (f.status === 'failed' && results.length === 0) problems.push(`load error: ${f.name}${f.message ? ` (${String(f.message).split('\n')[0]})` : ''}`);
  passed[projectOf(f.name)] = (passed[projectOf(f.name)] ?? 0) + results.filter((r) => r.status === 'passed').length;
}
for (const [project, min] of Object.entries(floor)) {
  const n = passed[project] ?? 0;
  if (n < min) problems.push(`${project}: ${n} passed, floor is ${min}`);
}
if (problems.length) {
  console.error(`Test count check failed:\n- ${problems.join('\n- ')}\nIf tests were removed on purpose, lower ${floorPath} in the same PR.`);
  process.exit(1);
}
console.log(`Test count ok: ${Object.entries(floor).map(([p, min]) => `${p} ${passed[p]} (floor ${min})`).join(', ')}`);
