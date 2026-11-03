// Jest reporter installed by harness (do not edit; harness update replaces it).
// Writes each test file's result to Jest's --outputFile, which the harness TDD gate reads. Unlike --json, it creates
// the folder first: .harness/state/ is gitignored, so it never exists on a fresh clone.
const { mkdirSync, renameSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

class HarnessResults {
  constructor(globalConfig) {
    this.outputFile = globalConfig.outputFile;
  }

  onRunComplete(_contexts, results) {
    if (!this.outputFile) return;
    const file = resolve(this.outputFile);
    const json = {
      testResults: results.testResults.map((r) => ({
        name: r.testFilePath,
        status: r.numFailingTests > 0 || r.testExecError || r.failureMessage ? 'failed' : 'passed',
        assertionResults: r.testResults.map((a) => ({ fullName: a.fullName, status: a.status })),
      })),
    };
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(json));
      renameSync(`${file}.tmp`, file); // the TDD gate never reads a half-written file
    } catch (e) {
      process.stderr.write(`harness: could not write ${file}: ${e.message}\n`);
    }
  }
}

module.exports = HarnessResults;
