# harness vet: design spec

- Status: draft for owner review. The owner decisions are in section 1; D7 and D8 answered the spec's questions on 2026-11-04. Nothing is open.
- Date: 2026-11-04
- Owner: khubaibqaiser
- Inputs: two owner interviews on 2026-11-03 and 2026-11-04. The M3 code on main: `src/catalog/resolve.ts` (pin lookups through `gh`), `src/budget/measure.ts`, `src/install/facts.ts`, `src/ai/*` (the file contract and `harness validate`), and `templates/agents/staff-reviewer.md` (audit mode).
- When: first after M3. The order is vet, then the personal preset, then telemetry, then the context-budget build.

## 1. Owner decisions

| # | Decision |
|---|---|
| D1 | **Input.** A GitHub repo or tree URL, an `owner/repo` shorthand, or a `plugin@marketplace` name. Every target resolves to a commit sha, and vet checks that sha. npm, PyPI and local paths are out of v1. |
| D2 | **Judge.** The CLI runs a deterministic scan first. Then the `/harness:vet` skill has a fresh-context reviewer judge relevance, overlap and injection text. |
| D3 | **Verdict.** Every finding is reported with `file:line` and a severity, and the owner decides. A high-severity finding needs a second, explicit yes. vet says plainly that a scan can't prove an item is safe. |
| D4 | **High severity.** Hooks that run shell commands, access to secrets or dotenv files, and unpinned remote code (`@latest`, `curl \| sh`, downloads at runtime). Obfuscated code is reported as medium. |
| D5 | **Report.** A short summary in the terminal. The full report goes to `.harness/vet/<id>-<sha>.md`. |
| D6 | **Install.** On a yes, vet only prints the install command. harness doesn't track the item, so there is no manifest entry, no config change and no budget ask. |
| D7 | **Pinning (2026-11-04).** vet also prints a sha-pinned plugin entry the owner can paste into a marketplace they control. `marketplace add` installs HEAD, so vet warns with the number of commits HEAD has moved past the vetted sha. |
| D8 | **Reports in git (2026-11-04).** `.harness/vet/` reports are committed as evidence. |

## 2. Scope

**In:**
- `harness vet <target> [--json]`, which fetches and scans;
- `harness validate vet-review <file>`;
- the `/harness:vet` skill;
- a `vet` mode for the staff reviewer;
- the report file;
- tests with hostile fixture repos.

**Out:**
- installing or tracking the item (D6);
- npm, PyPI, local paths and archives (D1);
- re-vetting on update;
- a shared allow-list;
- running the item or any of its scripts, ever;
- proving safety.

## 3. Resolve and fetch

1. **Parse the target.**
   - `https://github.com/o/r`, `…/tree/<ref>/<path>` and `o/r[#ref]` give a repo, a ref (default branch when none is given) and an optional sub-path.
   - `name@market`: look the marketplace up in `claude plugin marketplace list --json` (installed marketplaces), then in harness's catalog. Read its `marketplace.json` at the marketplace's sha, and take the plugin entry's `source`. A `github` or `git-subdir` source becomes repo, path and ref. Any other source type, or a marketplace that can't be found, stops with a message naming the type.
2. **Pin.** Resolve the ref to a 40-character sha with `gh api repos/o/r/commits/<ref> --jq .sha`, reusing the `resolve.ts` error handling: a 404 means not found, and anything else means could not verify. Without `gh`, vet stops: `harness vet needs the GitHub CLI (gh).`
3. **Fetch** the tarball with `gh api repos/o/r/tarball/<sha>` into `.harness/vet/tmp/<id>-<sha>/`, then extract it in-process. vet never runs anything from the item. Limits:
   - 25 MB compressed and 5,000 files;
   - entries that are symlinks, hard links, absolute paths or contain `..` are skipped and reported as **medium**;
   - files over 1 MB are listed but not read.
4. **Scope** the scan to the sub-path, plus the repo-root files that a plugin at that path loads (`.claude-plugin/`, `.mcp.json`).
5. **Clean up.** The temporary folder is deleted when the run ends, even when it fails. Only the report stays.

## 4. The scan (deterministic, CLI)

The scan reads the manifests and plain text only. Each rule gives a severity, a rule id, `file:line` and the matched text, cut to 120 characters, with control characters escaped through `esc()`.

| Severity | Rule | What it matches |
|---|---|---|
| high | `hook-shell` | Any hook whose type runs a command, in `hooks/hooks.json`, a `plugin.json` `hooks` block or a settings fragment. Each event is listed. |
| high | `secrets` | Reads or paths in scripts and prompts: `.env*`, `~/.ssh`, `id_rsa`, `~/.aws`, `~/.config/gh`, `.netrc`, keychain or credential-store commands, `printenv` or `env` dumps sent elsewhere. |
| high | `unpinned-remote` | `npx`, `uvx`, `pipx run` or `bunx` without an exact version, or with `@latest`; `curl` or `wget` piped to a shell; `bash <(curl …)`; downloads written and then run; MCP `command` entries that fetch at launch. |
| medium | `obfuscated` | Base64 or hex blobs of 200 characters or more, `eval`, `new Function`, `atob` followed by execution, packed or minified JS over 5 KB in a skill or plugin. |
| medium | `network` | URLs and network calls in scripts or hooks, apart from links in docs. |
| medium | `mcp-server` | Each MCP server it would start, with its command or URL. |
| medium | `permissions` | `allow` rules, auto-approve hooks, `permissionDecision: "allow"` output, and `--dangerously-skip-permissions`. |
| medium | `injection-text` | In skill, agent and command text: hidden Unicode (zero-width or bidi), HTML comments, and phrases such as "ignore previous", "do not tell the user" or "system prompt". The reviewer judges these. |
| medium | `unsafe-archive` | Entries skipped under the limits in section 3. |
| low | `license` | No licence file, or a licence that isn't an OSI licence. |
| low | `telemetry` | Telemetry environment variables or SDKs, with any opt-out found. |

**Context cost.** The always-loaded text is skill and agent names and descriptions, and command descriptions. It is measured with `measure.ts` (characters / 4, the same estimate as the budget). A `SessionStart` or `UserPromptSubmit` hook that prints text is flagged as unmeasured injected context.

**Output.** `--json` prints `{ target, repo, sha, path, kind, findings[], context: { tokens, unmeasured[] }, files }`. Without the flag, it prints the terminal summary from section 6.

## 5. The review (AI, skill)

- **Steps.** `/harness:vet <target>` first runs `harness vet <target> --json` and `harness scan`. Then a fresh-context staff reviewer, in vet mode, reads:
  - the scan JSON;
  - the flagged files at their lines (read-only, inside the temporary folder);
  - the facts;
  - the installed items, from `harness explain`.
- **File.** The reviewer writes `vet-review.json`: `{ relevance: "high|medium|low|none", why, overlaps: [{ id, how }], injection: [{ file, line, verdict: "benign|suspicious", why }], recommendation: "install|install-with-care|skip", summary }`. `harness validate vet-review` checks the file, with one retry, the same as the other AI files. Every `injection` entry must match a scan finding, and every `overlaps` id must be an installed item.
- **Rule.** The reviewer never lowers a scan severity. It can only add context.

## 6. Report and verdict

**Terminal summary** (at most 12 lines):
- the target, resolved as `repo@sha[:path]`;
- the count of findings by severity;
- each high finding on its own line;
- the context estimate;
- relevance and overlaps;
- the recommendation;
- `Full report: .harness/vet/<id>-<sha>.md`.

**Report file.** The summary, every finding grouped by severity, the reviewer's notes, and the exact install command. It ends with the fixed caveat line:

> A scan can't prove an item is safe. It checks for known risky patterns only; read the high findings yourself before you install.

**Verdict.**
- The skill asks with AskUserQuestion. The options are "Show the install command", "Skip" and "Open the report".
- When any high finding is present, the first yes leads to a second question that names each high finding. Only a yes to that prints the command.
- `.harness/vet/` holds reports only and stays in git unless `.gitignore` excludes it.

## 7. Guard and safety

- vet writes only under `.harness/vet/`. The guard treats `harness vet` as allowed for the agent, because it changes no settings and installs nothing.
- The tarball is untrusted data. It is never imported, required or executed, and no interpreter runs with it as the working directory (the scratch rule).
- Extraction applies the limits in section 3 before any file is written.
- vet sends no data anywhere except the `gh` API calls for the repo it was given.

## 8. Testing

- **Fixture repos** under `test/fixtures/vet/`, served through a fake `gh` exec:
  - a clean skill;
  - a plugin with a shell hook;
  - a script that reads env files;
  - an `npx …@latest` MCP server;
  - `curl | sh`;
  - a base64 `eval`;
  - zero-width text in a SKILL.md;
  - a tar with a `../` entry and a symlink;
  - an oversized archive;
  - a marketplace entry with an unsupported source.
- **Each rule** has a positive and a negative test.
- **Other tests:** the summary stays within 12 lines; the caveat line is present; `--json` matches the shape in section 4; the temporary folder is gone after both success and failure; `validate vet-review` rejects an invented overlap id and an injection entry with no matching finding; the second-yes rule holds in the skill text.

## 9. Size and cost

- **New code:** about 600 lines: `src/vet/{target,fetch,scan,report}.ts` and `src/cli/vet.ts`. This is an estimate.
- **Skill:** under 40 lines. Its context is the skill's name and description, so it stays small.
- **AI cost:** each vet costs one reviewer run in the owner's session. The CLI scan costs no tokens.

## 10. The printed install (D6, D7)

After the yes, vet prints the commands and a pinned entry:

1. `claude plugin marketplace add <o/r>` and `claude plugin install <name>@<marketplace> --scope project`.
2. A warning when HEAD has moved: `HEAD is <n> commits past the vetted <sha7>; marketplace add installs HEAD, not what was vetted.` vet counts the commits with `gh api repos/o/r/compare/<sha>...<ref>`. When HEAD equals the vetted sha, there is no warning.
3. A sha-pinned plugin entry for a marketplace the owner controls:
   - a `github` source: `{ "name": "<name>", "source": { "source": "github", "repo": "<o/r>", "sha": "<sha>" } }`;
   - a `git-subdir` source: `{ "name": "<name>", "source": { "source": "git-subdir", "url": "<o/r>", "path": "<path>", "sha": "<sha>" } }`.

The field names follow the Claude Code marketplace reference ("Plugin sources"). The plan checks them against that page before writing the code. The same text goes into the report file.
