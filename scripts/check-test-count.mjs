// Fails CI when the suite silently shrinks: a project's passed-test count below its floor, or a test file that failed to load.
// Usage: node scripts/check-test-count.mjs [vitest-json-report] [floor-json]
import { readFileSync } from 'node:fs';

const [reportPath = 'node_modules/.cache/test-report.json', floorPath = '.github/test-floor.json'] = process.argv.slice(2);
const floor = JSON.parse(readFileSync(floorPath, 'utf8'));
const files = JSON.parse(readFileSync(reportPath, 'utf8')).testResults;
if (!Array.isArray(files) || files.length === 0) { console.error(`${reportPath}: no test results; did the run write the JSON report?`); process.exit(1); }

const projectOf = (name) => { const p = name.replaceAll('\\', '/'); return p.includes('/test/e2e/') ? 'e2e' : p.includes('/test/perf/') ? 'perf' : 'unit'; };
const passed = {};
const problems = [];
for (const f of files) {
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
