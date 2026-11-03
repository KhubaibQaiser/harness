# Platform enforcement: design spec

- Status: draft for owner review. The design decisions are made (section 1); this spec turns them into build steps.
- Date: 2026-11-03
- Owner: khubaibqaiser
- Inputs: [`../research/2026-11-03-platform-enforcement.md`](../research/2026-11-03-platform-enforcement.md) (approach B, its sources and section numbers are cited as "R§n"), `docs/reviews/2026-11-03-lead-engineer-review.md` (finding IDs), [`2026-11-01-harness-beta-design.md`](2026-11-01-harness-beta-design.md).
- Amends: the beta spec §5.3, §5.4 (results path), §7 and §10. Where they disagree, this spec wins.

## 1. Owner decisions (2026-11-03)

| # | Decision |
|---|---|
| D1 | Approach B. Platform hooks and permission rules are always on. The regex and text checks stay as a backup. |
| D2 | Sandbox mode, default `unattended`: required in CI and unattended runs, optional when a person is watching. Native Windows has no sandbox; it keeps hooks, rules and text checks, and the docs say so plainly. |
| D3 | Test results move to `.harness/results/`. The rest of `.harness/state/**` stays fully denied, including to the sandbox. |
| D4 | `onFailure: "block"` on every matched PreToolUse tool, on UserPromptSubmit and on ConfigChange (ConfigChange added on review, §15). `doctor` checks that the hooks' Node and shell work. Stop can't use `onFailure`, so the Stop gate still fails open: a known limit. |
| D5 | `MIN_CLAUDE_CODE` = 2.1.314. `doctor` fails below it. |
| D6 | A `ConfigChange` hook blocks only changes to harness's own hook entries, harness's own deny rules (removing or narrowing them; added on review, §15), `disableAllHooks` and the `sandbox` settings. It logs an event and shows a notice at the next prompt. Other edits, such as "Always allow" clicks, stay free. |
| D7 | `autoAllowBashIfSandboxed: false` wherever harness turns the sandbox on, so no existing prompt disappears. |
| D8 | Keep the force-push guard. Add deny rules for the Bash and PowerShell force-push and push-to-main forms. The README recommends GitHub branch protection as the real stop. |
| D9 | Managed settings: the README documents an optional snippet only. `init` stays repo-only; uninstall stays byte-identical. |
| D10 | Add the PowerShell tool to the hook matchers (SEC-2). |

Section 15 records the decisions the owner made after reviewing this spec's first draft.

## 2. Settings fragment

`templates/settings.fragment.json` becomes:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash|PowerShell|Monitor|Read|Grep|Edit|Write|MultiEdit|NotebookEdit",
      "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"], "timeout": 10, "onFailure": "block" }] }],
    "PostToolUse": [{ "matcher": "Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit",
      "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"], "timeout": 10 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"], "timeout": 10, "onFailure": "block" }] }],
    "ConfigChange": [{ "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"], "timeout": 10, "onFailure": "block" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"], "timeout": 600 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"], "timeout": 10 }] }]
  },
  "permissions": {
    "deny": [
      "Read(./.env)", "Read(./.env.*)", "Read(./**/.env)", "Read(./**/.env.*)",
      "Edit(./.harness/hooks/**)", "Edit(./.harness/state/**)", "Edit(./.harness/logs/**)", "Edit(./.harness/backup/**)",
      "Edit(./.harness/config.yaml)", "Edit(./.harness/manifest.json)",
      "Edit(./.claude/settings.json)", "Edit(./.claude/settings.local.json)",
      "Bash(git push *--force*)", "Bash(git push * -f*)", "Bash(git push * +*)",
      "Bash(git push * main)", "Bash(git push * main *)", "Bash(git push *:main*)",
      "Bash(git push * master)", "Bash(git push * master *)", "Bash(git push *:master*)",
      "PowerShell(git push *--force*)", "PowerShell(git push * -f*)", "PowerShell(git push * +*)",
      "PowerShell(git push * main)", "PowerShell(git push * main *)", "PowerShell(git push *:main*)",
      "PowerShell(git push * master)", "PowerShell(git push * master *)", "PowerShell(git push *:master*)"
    ]
  }
}
```

- **Exec form** (`command` + `args`, needs 2.1.139, R§3): no shell sits between Claude Code and Node, so a missing shell or a quoting problem can't be the failure (R§4 shared parts).
- **`onFailure: "block"`** on PreToolUse, UserPromptSubmit and ConfigChange (D4). A ConfigChange hook that fails then blocks the change instead of letting it through. Stop, PostToolUse and SessionEnd don't get it.
- **`Monitor`** is in the PreToolUse matcher because from 2.1.314 Bash-matching hooks see Monitor commands (R§2 MON-1). It is not in PostToolUse: Monitor runs long, and no PostToolUse check needs it.
- **No `.harness/results/**` deny rule.** Deny rules merge into the sandbox (R§1), and the agent's test runs must write there (D3).
- **Push rules** are text rules too (R§2 SEC-5): `git -C . push`, `-uf` clusters and a bare `git push` from `main` still pass them. `main`/`master` match the guard's list (CON-3 is out of scope).

`sandbox: always` (section 4) also merges this block, key by key, into `.claude/settings.json`:

```json
{ "sandbox": { "enabled": true, "allowUnsandboxedCommands": false, "autoAllowBashIfSandboxed": false } }
```

`failIfUnavailable` is never committed: it would stop Claude Code at startup on native Windows (R§4 A).

## 3. Hooks and dispatcher

### 3.1 Failure handling (SEC-1, CON-1, DX-1)

- `dispatch.ts` `main()`: a top-level throw or unparseable stdin on PreToolUse prints a deny (`harness dispatcher failed: <message>`); on every other event it sets `process.exitCode = 1`. Exit 1 is neither 0 nor 2, so `onFailure` applies on UserPromptSubmit and ConfigChange (R§2 SEC-1). The current `exitCode = 0` goes.
- An entry-path that can't be resolved also exits 1 (today it exits 0 silently).
- **Hook environment record.** On every UserPromptSubmit the dispatcher writes `.harness/state/hook-env.json`: `{ ts, node: process.version, execPath: process.execPath, platform: process.platform }`. Hooks run outside the sandbox (R§2 SEC-13), so the write is allowed. `doctor` and `status` read it (section 8).
- **Self-test.** `node .harness/hooks/dispatch.mjs --self-test` prints `ok <node version>` and exits 0 without reading stdin.

### 3.2 PowerShell and Monitor (SEC-2, MON-1)

- A helper `isShell(tool_name)` returns true for `Bash`, `PowerShell` and `Monitor`. Every `tool_name === 'Bash'` test in `dispatch.ts`, `guard.ts`, `protect.ts` and `spec-gate.ts` uses it. `test-lock.ts` has no test-run detection of its own: it reads the results files. Monitor and PowerShell carry the command in `tool_input.command` (R§2 SEC-2); Monitor's `tool_name` is unverified (R5).
- The guard and protect run their existing word rules on PowerShell text. They don't parse PowerShell syntax.
- **PowerShell path rule.** A PowerShell command whose text contains, case-insensitively, `.harness`, `.claude` or `.env` asks; in an unattended run it is denied (the dispatcher already turns an ask into a deny). This is the review's SEC-2 fix.

### 3.3 `ConfigChange` (SEC-4, D6)

- **Baseline.** The harness-files snapshot (`src/core/harness-files.ts`) gains, per settings file (user `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`), a *guarded view*: the hook groups that run the dispatcher, the harness deny rules present in the file (the rules the manifest's `{"deny": …}` blocks record), `disableAllHooks`, the whole `sandbox` object and the `env` keys (each value as a hash). It is taken with the existing session baseline, and `sandbox-required` (3.4) reads the user, project and local sandbox values from it. The user file is `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set.
- **Decision.** On `ConfigChange` from the user, project or local settings source, the dispatcher reads the changed file and blocks (`decision: "block"`) when its guarded view differs from the baseline's (for deny rules: a harness rule present in the baseline is missing or its text changed, which covers removing and narrowing; an added rule is not a block), unless the file's fingerprint equals the last harness CLI record (`readRepoSnapshot(root).cli`). Any other source, and any change outside the guarded view, is allowed.
- **After a block.** It logs `config-change-blocked` with the file and the changed parts (`hooks`, `deny`, `disableAllHooks`, `sandbox`, `env`) and stores a pending notice in the session state. The next UserPromptSubmit shows it once through the existing `withNotice` (systemMessage plus additionalContext). Claude Code shows nothing itself (R§2 SEC-4).
- **The file stays changed on disk.** The next session loads it (R§2 SEC-4 limit a). Change detection also reports it at the next prompt and Stop, as today; the two messages are joined into one notice.
- `ConfigChange` is in the dispatcher's `EVENTS` list already, but no check handles it yet. It is a new check, `config-change`, in the registry.

### 3.4 Unattended sandbox requirement (D2, CON-4)

A new PreToolUse check, `sandbox-required`, `failClosed: true`, for shell tools (`isShell`). It allows when any of these is true:
- `sandbox` config is `off`;
- the run is attended (`isUnattended` is false);
- `process.platform === 'win32'` (native Windows has no sandbox: owner decision D2, confirmed on review, §15); it logs `sandbox-unavailable` once per session;
- the sandbox is confirmed: the effective `sandbox.enabled` is `true` and `sandbox.allowUnsandboxedCommands` is `false`, read with Claude Code's precedence from the managed settings files on disk and the local, project and user views in the session baseline (3.3; a file written mid-session doesn't count, and no baseline denies), and on Linux `bwrap` and `socat` are on the hook's PATH (R§4 A);
- `HARNESS_SANDBOX=1` is set. Only the person who launches the run can set it: the hook inherits Claude Code's environment, not the agent's shell. A `HARNESS_SANDBOX` set by a settings file's `env` (in the session baseline) is ignored. It stands for the documented `--settings` launch, which a hook can't see (R§4 B, R2).

Otherwise it denies: "Unattended run without Claude Code's sandbox. Start it with the command in the README (Unattended runs and CI), or set `sandbox: off` in `.harness/config.yaml`." Only a person can do either, because the config and settings files are denied to the agent.

The documented unattended launch (README):

```sh
HARNESS_SANDBOX=1 claude -p "…" --settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":false}}'
```

`--settings` sits above project and local settings, and `failIfUnavailable` makes the run exit instead of running unsandboxed (R§4 B).

### 3.5 Guard (SEC-4)

`init` and `update` join `PERSON_ONLY` as `ask`, with `--dry-run` and `--check` still allowed to the agent (review SEC-4 fix). Otherwise the regex layer is frozen: no new rules beyond sections 3.2 and 3.5 (MAINT-1).

## 4. Sandbox modes

| `sandbox` | Interactive session | Unattended run | Written to `.claude/settings.json` |
|---|---|---|---|
| `unattended` (default) | No sandbox unless the person turns it on before the session starts (the settings, the documented `--settings`, or `always`); a mid-session change, `/sandbox` included, takes effect in the next session | Required (3.4) | Nothing |
| `always` | Sandbox on for everyone using the repo | Required (3.4); confirmed by the committed keys | The `sandbox` block in section 2 |
| `off` | No sandbox | Not required; text checks only | Nothing |

Under `always` the network allowlist starts empty, so the first `npm install` or HTTPS `git push` prompts, and on macOS `git push` over SSH fails inside the sandbox (R§4 A). Harness adds no allowed domains; the README says how.

On sandboxed platforms (macOS, Linux, WSL2), the existing `Edit(...)`/`Read(...)` deny rules become OS-level write and read denies for every shell command and its children (R§1). That is what closes SEC-3, SEC-6, SEC-9 and SEC-11 where the sandbox runs. The exact translation is unverified (R3).

## 5. Results migration (D3)

- **Default.** `tdd.results_dir` defaults to `.harness/results`. `.gitignore` gets `.harness/results/` (a new `mergeGitignore` line).
- **Protect.** `.harness/results/**` joins protect's `PROTECTED` list for Claude's file tools and for shell write targets named in the command text, so the agent can't write results with Edit or `echo >`. It gets no permission rule (section 2). A test runner the agent starts, or a script, can still forge results, as it can today (R§5 Q2a).
- **Red-first, test-lock, spec-gate** read `resultsDir(config)` already, so they follow the new default. Their tests and fixtures change path only.
- **Jest reporter** (`templates/hooks/jest-results.cjs`) keeps creating the folder; its comment changes to `.harness/results/`.
- **Vitest and Jest config edits.** On `update`, when a package's test config holds the result path built from the old default (`resultPath(pkg, root, '.harness/state/test-results')`), `testConfigChange` replaces that string with the new path. This covers Vitest's `outputFile.json` and Jest's `--outputFile=` in the script or config. Today these cases return `manual` (Vitest: path differs) or `none` (Jest: reporter present), so this is a new branch in each. The same substitution is applied to that file's recorded blocks and to the `from` text of its formatted hunks in the manifest, so uninstall still removes them exactly.
- **Config.** `update` rewrites `tdd.results_dir` in `.harness/config.yaml` only when its value is exactly `.harness/state/test-results`. It is a one-line edit shown in the diff, and the only exception to "update never writes the config". The manifest hash for the config is replaced only if the old hash matched.
- **Old folder.** `.harness/state/test-results/` is left in place; it is gitignored, and uninstall removes `.harness/` as today.
- **Doctor** reports any package whose test config still points under `.harness/state` (section 8).

## 6. Installer

### 6.1 Merge (`mergeSettings`)

- **Hook identity.** A harness hook is one whose `command`, or any `args` entry, contains `.harness/hooks/dispatch.mjs`. The `have` set that skips duplicates keys on `command` plus `args`, so another tool's `node` exec-form hook is never mistaken for ours.
- **Replace in place.** When the current file holds a harness group equal to a recorded manifest block (`{event, group}`) but not equal to the fragment's group, `mergeSettings` replaces it at the same index and returns the old block as `dropped`. A harness group that matches no recorded block (the person edited it) is left as is, with a note; `doctor` then flags it (section 8).
- **New deny rules** are added and recorded as today (`{"deny": …}`).
- **Sandbox keys** (`always` only): each key from section 2 is added only when absent, and recorded as `{"set":["sandbox","enabled"],"value":true}`. A key the person already set is left alone, with a note when its value differs (for example, a committed `autoAllowBashIfSandboxed: true`). When the mode leaves `always`, `update` removes the recorded `set` blocks.
- `mergeSettings` takes the sandbox mode as a parameter; `planChanges` passes `config.sandbox`.

### 6.2 Manifest

No new fields. Settings blocks gain the `{"set":[…],"value":…}` kind. `update` drops a settings block only when `mergeSettings` returns it as `dropped`, or when it removes a `set` block (today settings blocks are always kept).

### 6.3 Update of an existing install

One `harness update` brings an install from the previous release to this one, in one transaction:
1. Hook groups replaced in place (6.1), including the new matchers, exec form and `onFailure`.
2. The `ConfigChange` group and the new deny rules added.
3. `.gitignore` gains `.harness/results/`.
4. The results path migrated (section 5).
5. The dispatcher replaced.

A Claude Code older than 2.1.314 isn't refused by `update`: `doctor` fails on it (section 8).

### 6.4 Uninstall

- Removes `set` blocks by key path and value. A `sandbox` object left empty that wasn't there before init is removed, like `hooks` and `permissions` today (`uninstall.ts` `had()`).
- Hook groups are matched by deep equality as today; 6.1 keeps the recorded blocks equal to what is in the file.
- **Byte-identical:** after `init` → `update` → `uninstall`, and after `init` → `uninstall`, every fixture is byte-identical to before `init` (section 12).

## 7. Config

| Key | Default | Rule |
|---|---|---|
| `sandbox` | `"unattended"` | must be one of unattended, always, off |
| `tdd.results_dir` | `".harness/results"` | must not be inside `.harness/state` (the sandbox denies it there) |

- An existing config without `sandbox` gets the default through the overlay; no migration is needed.
- A `results_dir` inside `.harness/state` is an error: the config is invalid and edits and Stop fail closed, as for any invalid key. `update` migrates the old default (section 5), so only a custom path hits this.
- The warning `tdd.results_dir is outside .harness/state` changes to: outside `.harness/results`, "protect doesn't cover it; the agent can write test results there with its file tools".
- `config.example.yaml`, `serializeConfig` and the README config table (generated) gain `sandbox`.

## 8. `doctor` and `status`

**`doctor`** adds or changes these lines. `fix` lines count as problems (exit 1); `note` lines don't.

| Check | Output |
|---|---|
| Claude Code version | `fix Claude Code <v> is older than 2.1.314: update Claude Code` (unchanged form, new floor) |
| Hook-side Node | From `hook-env.json`: `ok hooks run Node <v>`; `fix hooks run Node <v>, older than 22.11: …`; with no record, `note no hook has run here yet: start a Claude Code session, send a prompt, then run harness doctor again` |
| Dispatcher runs | Spawns the PreToolUse hook exactly as `settings.json` defines it (exec form, no shell) with `--self-test`: `ok dispatcher runs`, or `fix the dispatcher does not run (<stderr>): …`. A harness entry still in shell form is run through the platform shell and gets `fix … run harness update` |
| Hook shape | `fix PreToolUse/UserPromptSubmit/ConfigChange hook has no onFailure "block": run harness update` (also when the person edited the group) |
| Wired events | Now 6 events, including `ConfigChange`; matches `args` as well as `command` |
| Sandbox | `ok sandbox: unattended (required for unattended runs)`; on native Windows `note no sandbox on native Windows: hooks, permission rules and text checks only`; on Linux under `unattended`/`always` without `bwrap` or `socat`: `note` for `unattended`, `fix` for `always` |
| Results path | `fix <pkg> writes test results under .harness/state, which the sandbox denies: run harness update` |
| ConfigChange | The last `config-change-blocked` event, as for harness-files changes |

**`status`** adds:
- `Enforcement: sandbox <mode> (<macOS|Linux|WSL2: available | native Windows: not available>)`
- `Hook failure: blocks tool calls and prompts; the Stop gate fails open`
- `Hooks run Node <v> (<ts>)` from `hook-env.json`, or `not recorded yet`
- The last blocked settings change, if any.

## 9. README

- One plain line at the top: "Enforced by Claude Code's sandbox in unattended runs on macOS, Linux and WSL2, and in every session with `sandbox: always`. Elsewhere, and on native Windows always, the guard and protect checks are a seatbelt." (R§4 B)
- **Unattended runs and CI:** the launch command in 3.4, and what `HARNESS_SANDBOX=1` asserts.
- **Windows:** native Windows has no sandbox; it gets hooks, permission rules and text checks. The guard does not parse PowerShell. WSL2 gets the full sandbox.
- **Force push:** turn on GitHub branch protection for the default branch; harness's rules are text rules.
- **Managed settings (optional):** a snippet with `sandbox.enabled: true` and `allowUnsandboxedCommands: false` for the platform paths in R§5 Q8. It leaves out harness hooks, because a managed hook runs in every repo and `onFailure: "block"` would then block repos without harness. `init` never writes it.
- CON-1: the "fails closed" line is rewritten per section 11.
- Known limits: section 11.

## 10. Finding map

"Sandboxed" = macOS, Linux, WSL2 with the sandbox on (unattended runs by default; every session under `always`). "Unsandboxed" = interactive sessions under `unattended`, `off`, and native Windows.

| Finding | Closed by | Sandboxed | Unsandboxed | Native Windows |
|---|---|---|---|---|
| SEC-1 dispatcher fails open | Platform: `onFailure` + 3.1 | Closed (PreToolUse, UserPromptSubmit) | Same | Same |
| SEC-1 Stop gate | Known limit | Fails open | Same | Same |
| SEC-2 PowerShell unmatched | Matcher + 3.2 path rule + PowerShell deny rules | Closed; sandbox also covers PowerShell | Guard backup (no PowerShell parsing) | Guard backup |
| SEC-3 `cd` + write | Sandbox write deny (Edit rules) | Closed | Edit rules on recognised commands + protect backup; partly open | Same as unsandboxed |
| SEC-4 detection switched off | Platform: `ConfigChange` with `onFailure: "block"` (3.3); sandbox; guard `PERSON_ONLY` (3.5) | Closed for the running session | Running session closed; next session loads the change (limit) | Same as unsandboxed |
| SEC-5 force push / push to main | Deny rules + guard backup; branch protection recommended | Partly (text rules) | Same | Same |
| SEC-6 shell secret reads | Sandbox read deny (Read rules) | Closed | Read rules on recognised commands + guard backup; partly open | Same as unsandboxed |
| SEC-7 install gate | Sandbox network allowlist | Partly: prompts, or refused in `dontAsk`; allowed in `bypassPermissions` (R§2) | Guard backup; open as in the review | Same |
| SEC-8 test script / vite config | Known limit (out of scope, section 14) | Open | Open | Open |
| SEC-9 protect write gaps | Sandbox write deny | Closed (`chmod` unverified, R4) | Protect backup; open | Same |
| SEC-10 deny baseline | Rules (section 2); `ConfigChange` blocks removing or narrowing them mid-session (3.3) | Closed | Closed for file tools and recognised commands; removal blocked for the running session | Same |
| SEC-11 `tdd off` by script | Sandbox write deny on `.harness/state/**` | Closed | Env check backup; open | Same |
| SEC-12 user settings | Sandbox protects `~/.claude`; `ConfigChange` covers `disableAllHooks`/`sandbox` in user settings | Closed for shell writes | File tools: open (limit) | Same |
| SEC-13 `.npmrc` | Known limit here (code fix, out of scope) | Open | Open | Open |
| CON-4 sandbox for unattended | 3.4 + documented launch | Closed | n/a | Exempt by D2 (limit) |
| MON-1 Monitor unseen | Floor 2.1.314 + matcher | Closed | Closed | Closed |
| MAINT-1 regex arms race | Regex frozen (3.5) | Backup only | Still the shell layer | Still the shell layer |

## 11. Known limits (README)

- The Stop gate fails open if its process can't run (`onFailure` has no effect on Stop, R§2).
- Native Windows has no sandbox: shell commands are checked by text only, and the guard doesn't parse PowerShell.
- Interactive sessions under the default `unattended` mode keep the text-check gaps (SEC-3, SEC-6, SEC-9, SEC-11) unless the person uses `/sandbox` or `always`.
- A blocked settings change still sits on disk; the next session loads it. Change detection reports it at the next prompt and Stop.
- Force-push and push-to-main rules are text rules; branch protection is the real stop.
- `HARNESS_SANDBOX=1` is the launcher's claim; harness can't see `--settings`.
- Results in `.harness/results/` can be forged by a program the agent runs.

## 12. Test strategy

**Offline (unit and e2e; CI on three OSes):**
- `mergeSettings`: exec form, `onFailure` placement (PreToolUse, UserPromptSubmit, ConfigChange; not Stop, PostToolUse, SessionEnd), matchers, new deny rules; `have` keyed on command plus args (a foreign `node` exec hook survives); replace in place against recorded blocks; an edited group left with a note; `always` adds missing `sandbox` keys only and records `set` blocks; leaving `always` removes them.
- Uninstall: `set` blocks removed; empty `sandbox` parent dropped only when absent before init.
- **e2e byte-identity:** fixtures with and without an existing `sandbox` key; modes `unattended` and `always`; an "old install" fixture (previous fragment, old results path in Vitest inline, multi-line and Prettier-formatted configs, and Jest script and config forms) → `update` → `uninstall` gives the pre-init bytes.
- Results migration: `testConfigChange` substitution per framework; manifest blocks and hunks rewritten; config line migrated only for the exact old default; `results_dir` inside `.harness/state` rejected.
- Dispatcher: a throw on PreToolUse prints a deny; on UserPromptSubmit exits 1; `--self-test`; `hook-env.json` written on UserPromptSubmit.
- Checks: PowerShell and Monitor inputs through guard, protect, test-lock and spec-gate; the PowerShell path rule (ask, deny unattended).
- `config-change`: recorded inputs per source; block on a removed or changed harness group, a removed or changed harness deny rule, `disableAllHooks`, any `sandbox` change; allow on `permissions.allow`, on an added deny rule, on removing a deny rule harness didn't install, and on a CLI-recorded change; event logged; notice shown once at the next prompt.
- `sandbox-required`: each allow condition and the deny, with platform, env and settings files injected; precedence across managed, local, project and user.
- `doctor`/`status`: version 2.1.313 → `fix` and exit 1; hook-env missing, old, OK; self-test failing; shell-form entry; Linux without `bwrap`; win32 note.
- The latency budget test (`test/perf`) still passes with the new checks.

What offline tests can't prove: anything Claude Code itself does with these settings (R1–R8).

**Live (gated: costs money; run only with the owner's approval, as one batch, after the offline suite passes):**
1. `ConfigChange` fires for a Bash-written `.claude/settings.local.json` and a block keeps `disableAllHooks: true` out of the running session (R1).
2. `onFailure: "block"` blocks a PreToolUse call, a prompt and a settings change when `dispatch.mjs` is `chmod 000` and when `node` is missing from the hooks' PATH.
3. Exec-form `args` expand `${CLAUDE_PROJECT_DIR}` (R7).
4. With `--settings` sandbox on: `cat .en*`, `cd .claude && echo {} > settings.local.json`, `chmod 000 .harness/hooks/dispatch.mjs`, `harness tdd off` all fail; `pnpm test` writes `.harness/results/` (R3, R4).
5. A Monitor command reaches the PreToolUse hook; record its `tool_name` (R5).
6. One push-rule sample per form (`--force`, `-f`, `+ref`, `origin main`, `HEAD:main`) is denied in Bash.
7. Windows (PowerShell-only machine), if one is available: the PowerShell matcher fires, and the PowerShell deny rules apply (R6).

## 13. Open risks (unverified in R§6)

| # | Risk | How the build confirms it |
|---|---|---|
| R1 | `ConfigChange` fires for Bash-written files and the block keeps `disableAllHooks` out of the running session | Live check 1 |
| R2 | A hook can't see the sandbox state or `--settings`, so 3.4 relies on settings files and `HARNESS_SANDBOX` | Read the [hooks] input schema at build time (offline); if a field exists, use it and drop the env claim |
| R3 | `Read(./**/.env.*)` and `Edit(./.harness/**)` translate into the right sandbox paths | Live check 4. If it fails, add explicit `sandbox.filesystem.denyRead`/`denyWrite` to the launch JSON and the `always` block |
| R4 | `chmod` counts as a denied write in the sandbox | Live check 4; if not, SEC-9 `chmod` stays a known limit |
| R5 | Monitor's `tool_name` in hook input | Live check 5; `isShell` already accepts both names |
| R6 | Read, Edit and `PowerShell(...)` rules apply to PowerShell commands | Live check 7; until then the README says PowerShell rules are unverified |
| R7 | `${CLAUDE_PROJECT_DIR}` expands in exec-form `args` (the research shows this form, but no source states the expansion) | Live check 3; fallback: the shell form with `onFailure` (doctor's shell-form branch already covers it) |
| R8 | What Claude Code older than 2.1.295 does with `onFailure` | Not built for: `doctor` fails below 2.1.314. Read the changelog at build time; if older versions drop the hook entry, the README says so |
| R9 | `ConfigChange` input field names (`source`, `file_path`) and source values | Read [hooks] at build time (offline) and match the fixtures to it |
| R10 | Wildcard push rules match as written (`*` matching nothing, mid-pattern `*`) | Live check 6 |
| R11 | `strictAllowlist` from project settings | Not used by this spec |

## 14. Out of scope

- SEC-7's `package.json` dependency diff and `npx`/`dlx`/`poetry` install forms; SEC-8's ask rules and tamper's `vite.config.*`; SEC-13's `--registry` flag; BUG-1 to BUG-4; PERF-1. Separate fixes.
- CON-3 (detected default branch in the guard and push rules).
- New guard or protect regex beyond 3.2 and 3.5.
- Writing managed settings, network allowlists, or `failIfUnavailable` into the repo.
- `permissions.blockWritesOutsideWorkingDirectories` and a deny rule for `~/.claude/settings*.json` (SEC-12 file tools).
- A ground-truth corpus for guard and protect (TEST-1) and a headless schema-drift job (TEST-3).

## 15. Decisions after review (2026-11-03)

The owner ruled on the points the first draft raised. None is open.

- **C1. `onFailure` on `ConfigChange`: block.** The ConfigChange entry gets `onFailure: "block"` (D4, section 2). The research's SEC-4 closure assumed it.
- **C2. Native Windows unattended: allow with text checks.** The research's approach B would fail these runs closed. D2 stands: unattended native-Windows runs are allowed with hooks, rules and text checks, and `sandbox-required` logs `sandbox-unavailable` (3.4).
- **C3. "Node and shell" in D4: as resolved.** Hooks use the exec form, so no shell runs them. `doctor` checks the shell only for a harness entry still in shell form (section 8).
- **C4. `doctor` below the floor: as resolved.** The research said `doctor` only warns (`doctor.ts:72`). That line is already a `fix`, which exits 1, so D5 changes only the version. When `claude` isn't found, `doctor` still prints `ok`.
- **C5. Deny-rule removal: block.** `ConfigChange` also blocks removing or narrowing harness's own deny rules, measured against the session baseline. A change the harness CLI recorded is still allowed (D6, 3.3).
