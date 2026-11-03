# Platform enforcement for harness: research and options

- Date: 2026-11-03
- Status: research draft for the owner. Nothing here is decided.
- Input: `docs/reviews/2026-11-03-lead-engineer-review.md` (SEC-1..SEC-13, CON-4, MAINT-1), `templates/settings.fragment.json`, `src/hooks/dispatch.ts`, `src/checks/guard.ts`, `src/checks/protect.ts`, `src/install/merge.ts`, `src/cli/uninstall.ts`, `src/core/unattended.ts`, the specs in `docs/specs/`.
- Sources: the Claude Code docs at code.claude.com (fetched today) and the official changelog (`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`, latest entry 2.1.317). Every claim below has a source or is labelled **unverified**. No live Claude Code session, `claude -p` or Windows run was used.

Source shorthand used in the tables:

| Tag | URL |
|---|---|
| [hooks] | https://code.claude.com/docs/en/hooks |
| [perm] | https://code.claude.com/docs/en/permissions |
| [modes] | https://code.claude.com/docs/en/permission-modes |
| [sbx] | https://code.claude.com/docs/en/sandboxing |
| [set] | https://code.claude.com/docs/en/settings |
| [tools] | https://code.claude.com/docs/en/tools-reference |
| [managed] | https://code.claude.com/docs/en/managed-settings |
| [plug] | https://code.claude.com/docs/en/plugins-reference |
| [cl x.y.z] | changelog entry for that version |

## 1. Summary

- Four platform features close most of the security findings, and none of them is regex: `onFailure: "block"` on hooks (v2.1.295), a blocking `ConfigChange` hook (v2.1.49), complete `permissions.deny`/`ask` rules, and the OS sandbox with `allowUnsandboxedCommands: false`.
- With the sandbox on, the existing `Edit(...)`/`Read(...)` deny rules also become OS-level write and read denies for every shell command and its child processes, so harness may not need any `sandbox.filesystem` paths of its own ([sbx], "Read and Edit deny rules: block access"; "Paths … from both sandbox settings and permission rules are merged"). The exact path translation is **unverified**.
- The sandbox does not run on native Windows ("On native Windows, Claude Code runs commands unsandboxed" [sbx]). On a PowerShell-only Windows machine, harness can only offer hooks plus permission rules. The text checks remain the only shell-level layer there.
- Three things have no platform equivalent and stay in harness hooks: test-first (red-first, tamper, test lock), the Stop gate, and force-push or push-to-main detection. `onFailure` has no effect on `Stop` hooks [hooks], so the Stop gate still fails open if its process can't run.
- One conflict needs an owner decision before anything else. With the sandbox on, the current rule `Edit(./.harness/state/**)` would also stop the agent's own test runs from writing `.harness/state/test-results`, which breaks red-first (section 5, Q2).
- New gap found while checking the docs (not in the lead review): the `Monitor` tool runs shell commands. Bash-matching hooks only see those commands from v2.1.314 [cl 2.1.314]. Before that version, harness never sees them.

## 2. Findings mapped to platform features

"Sandboxed platforms" means macOS, Linux and WSL2 [sbx]. "Fully" means the platform enforces it whatever the command text is, on the platforms named.

| Finding | Platform feature | Closes it? | Reason | Source |
|---|---|---|---|---|
| SEC-1 Hooks fail open when the dispatcher can't run | `"onFailure": "block"` on the `PreToolUse` and `UserPromptSubmit` entries; exec form (`"command": "node", "args": [...]`) so no shell sits in between | **Fully for PreToolUse/UserPromptSubmit; not at all for Stop** | A hook that can't start, exits with a code other than 0 or 2, times out or prints invalid JSON "does what exit code 2 does on that event". The field "has no effect" on `Stop`, `SubagentStop`, `TaskCompleted`, `TeammateIdle` or async hooks. `dispatch.ts:287` (`exitCode = 0` after a throw) also needs a code fix: a deny for PreToolUse, or a non-0/2 exit so that `onFailure` applies. | [hooks] "Block the action when a hook fails"; [cl 2.1.295] |
| SEC-2 PowerShell tool not matched | Add `PowerShell` to the matcher. PowerShell permission rules (`PowerShell(Remove-Item *)`) are parsed from the PowerShell AST. Sandbox covers PowerShell on sandboxed platforms only | **Partly** | The hook then sees the call (`tool_input.command`, same fields as Bash), but the guard can't parse PowerShell. Native Windows has no sandbox. Read/Edit deny rules are documented for "file commands Claude Code recognizes in Bash"; whether they apply to PowerShell commands is **unverified**. Side effect to know: on Windows with Git Bash, a scoped Bash deny rule turns the PowerShell tool off unless a `PowerShell(...)` rule exists. | [tools] "PowerShell tool", "Bash deny rules also turn off the PowerShell tool"; [perm] "PowerShell"; [sbx] |
| SEC-3 `cd <dir> && write` bypasses protect | Sandbox (with the Edit deny rules merged in). The sandbox also protects `.claude` settings files by default | **Fully on sandboxed platforms; partly elsewhere** | The OS checks the real path, so `cd` doesn't matter. Without the sandbox, Claude Code's own redirect checks still prompt on some `cd` plus redirect forms, but `bypassPermissions` allows writes to `.claude`. | [sbx] "the sandbox still denies writes to the files Claude Code loads configuration and code from"; [perm] "cd with a redirect"; [modes] protected paths table |
| SEC-4 Change detection can be switched off by the change; `update`/`init` agent-runnable | `ConfigChange` hook with `decision: "block"` for `project_settings` and `local_settings`, plus `onFailure: "block"`. Sandbox stops an agent-run harness CLI from writing `.harness/**` or `.claude/settings*.json`, because the CLI is a child of the sandboxed shell | **Mostly** | `ConfigChange` fires "for each settings-file change it detects" through the file watcher, so it fires whoever wrote the file. A blocked change "is not applied to the running session". Limits: (a) the file stays changed on disk, so the *next* session loads `disableAllHooks` and harness never runs; (b) a blocked change "surfaces no message to you or to Claude"; (c) it doesn't cover `.harness/**`. That is why the write itself must be stopped (sandbox plus Edit deny). Firing on Bash-written files is documented indirectly; it was not tested live (**unverified**, see section 6). | [hooks] "ConfigChange"; [set] "When edits take effect"; [cl 2.1.49], [cl 2.1.290] |
| SEC-5 Force-push and push-to-main bypassed | `permissions.deny` `Bash(git push --force *)` and similar; auto mode's classifier; the remote's branch protection | **Partly at best** | The docs say a `Bash(git push *)` rule doesn't stop `git -C . push …` or `git 'push' …`, so a deny rule is text matching too. Auto mode blocks force push by default, but only in auto mode, and it *allows* "Pushing to any branch … including the default branch". Server-side branch protection is the real control. It is outside Claude Code and not researched here. | [perm] "What a Bash rule doesn't match"; [modes] classifier defaults |
| SEC-6 Shell secret reads bypassed (`cat .en*`, `find -exec cat`) | Sandbox read deny, fed by the existing `Read(./**/.env*)` rules | **Fully on sandboxed platforms** for Bash, PowerShell and Monitor and their children; the Read tool stays covered by the Read deny rule | Without the sandbox, deny rules "don't apply to … a Python or Node script that opens files itself". Whether `Read(./**/.env.*)` turns into the right sandbox glob is **unverified**. Explicit `sandbox.filesystem.denyRead` entries would avoid that doubt. | [perm] "What Read and Edit rules cover"; [sbx] permission-rule table |
| SEC-7 Install gate bypassed (edit `package.json` then `npm install`, `npx`, `dlx`, `poetry add`) | Sandbox network allowlist (domains "start empty") | **Partly** | A sandboxed `npm install` to an unlisted registry host prompts in Manual and acceptEdits, is refused in `dontAsk`, and is **allowed without a prompt in `bypassPermissions`**, unless `strictAllowlist` or managed `allowManagedDomainsOnly` is on. Whether `strictAllowlist` is honoured from project settings is **unverified**. The `package.json` diff plus dep-verify stays a harness hook. | [sbx] "Hosts outside your allowed domains" |
| SEC-8 Stop gate and TDD neutered via `package.json` scripts or `vite.config.ts` | `permissions.ask` rules such as `Edit(./package.json)`, `Edit(./vite.config.*)` | **Partly** | An explicit ask rule is one of the "actions no mode auto-approves", so it prompts even in `bypassPermissions`, and `dontAsk` denies it. That covers Edit/Write/NotebookEdit. Whether *ask* rules (as opposed to deny rules) apply to recognised Bash file commands is **unverified**. The sandbox can't ask, only deny. The content check (`|| true`) stays in harness. | [modes] "Actions no mode auto-approves", dontAsk |
| SEC-9 Protect misses `ex`, `vim -es`, `awk -i`, `chmod`, `git reset/stash/apply`, `python -c` | Sandbox write deny on the protected paths | **Fully on sandboxed platforms** for content writes, deletes and renames. Whether `chmod` (a mode change) counts as a denied write is **unverified** | It is OS-level, so the program and the way it is invoked don't matter. git commands that must replace a denied file fail with "unable to unlink" / "Read-only file system", which is what we want. | [sbx] "A git command fails with unable to unlink old"; [perm] "For OS-level enforcement … enable the sandbox" |
| SEC-10 `permissions.deny` baseline incomplete | Add `Edit(./.harness/config.yaml)`, `Edit(./.harness/manifest.json)`, `Edit(./.harness/backup/**)`, `Edit(./.claude/settings.local.json)` | **Fully** for Claude's file tools and recognised Bash file commands and redirects | Deny rules hold in every mode, `bypassPermissions` included. `Write(path)`/`NotebookEdit(path)` rules never match, so `Edit(...)` is the right form (the fragment already uses it). | [perm] "Write(path) … rules never match"; [modes] "Deny rules block in every mode" |
| SEC-11 `tdd off` protected only by an env var | Sandbox write deny on `.harness/state/**` (the pause file is `.harness/state/tdd-pause.json`) | **Fully on sandboxed platforms** | An agent-run CLI can't write the pause file. This conflicts with test results living in the same folder (section 5, Q2). | [sbx] |
| SEC-12 `~/.claude/settings.json` unprotected | Sandbox protects `~/.claude` by default; `permissions.blockWritesOutsideWorkingDirectories` (v2.1.314) for the file tools, or `Edit(~/.claude/settings*.json)` deny | **Fully** (shell on sandboxed platforms; file tools on every platform) | `~/path` rules anchor at home from any settings file. `blockWritesOutsideWorkingDirectories: true` is honoured from any scope, even over managed `false`. | [sbx] "In ~/.claude … most of its contents"; [perm] "Block file-tool reads and writes outside the working directories"; [set] "Exceptions to managed settings precedence" |
| SEC-13 dep-verify trusts repo `.npmrc` | None needed; it is a code fix (`--registry=https://registry.npmjs.org`) | **Not at all** (by a platform feature) | `.npmrc` is a Claude Code protected path (prompted in Manual/acceptEdits, allowed in bypass), but the hook runs `npm view` outside the sandbox and reads the file regardless. | [modes] protected paths list; [sbx] "hooks … run with your full access" |
| CON-4 Spec requires `sandbox-settings` for unattended modes | The sandbox, launched for one run with `--settings '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false}}'` or committed in project settings; `failIfUnavailable: true` to exit instead of running unsandboxed | **Fully on sandboxed platforms** | `dangerouslyDisableSandbox` retries run without a prompt in `bypassPermissions`, so `allowUnsandboxedCommands: false` is mandatory, not optional. `failIfUnavailable` in a *committed* file would stop Claude Code at startup on native Windows (Windows effect, section 4). | [sbx] "dangerouslyDisableSandbox", "failIfUnavailable"; [cl 2.1.83] |
| MAINT-1 Regex arms race | All of the above | **Partly** | The regex layer can be frozen as a seatbelt on sandboxed platforms. It stays the only shell layer on native Windows, and the only force-push and TDD layer anywhere. | (synthesis) |
| BUG-3/BUG-4 `rm -rf ~/`, `find ~ -delete` | Sandbox write scope (cwd, temp dir, added dirs only); Claude Code's built-in critical-path `rm` protection | **Fully on sandboxed platforms** for the sandbox part | Writes outside the working directory fail. The built-in `rm` check covers recognised `rm`/`rmdir` critical paths in every mode, but `find -delete` is not named there. | [sbx] "Default write scope"; [modes] "Actions no mode auto-approves" |
| New: MON-1 `Monitor` tool commands unseen | v2.1.314 makes Bash-matching hooks run on Monitor commands ("can block or ask, but not approve"). Sandbox covers Monitor | **Fully from 2.1.314 for hook visibility** | Before 2.1.314, harness hooks never see Monitor commands. The `tool_name` the hook then receives (`Bash` or `Monitor`) is **unverified**. `dispatch.ts`/`guard.ts` check `tool_name === 'Bash'` in places, so this needs a test. | [cl 2.1.314]; [tools] "Monitor tool"; [sbx] |

## 3. Minimum Claude Code version per feature

Current `MIN_CLAUDE_CODE` is `2.1.285` (`src/core/min-claude.ts:2`), and the Claude Code installed on this machine is also 2.1.285 (`claude --version`). The latest changelog entry is 2.1.317.

| Feature | Needs | Source |
|---|---|---|
| `ConfigChange` hook, blocking | 2.1.49 | [cl 2.1.49] |
| `if` field on hook handlers | 2.1.85 | [cl 2.1.85] |
| PowerShell tool exists (tool name `PowerShell`) | 2.1.84 (preview) | [cl 2.1.84] |
| Exec form (`args`) for hooks | 2.1.139 | [cl 2.1.139] |
| Sandbox `failIfUnavailable` | 2.1.83 | [cl 2.1.83] |
| Sandbox `allowUnsandboxedCommands` | 2.0.30 | [cl 2.0.30] |
| Sandbox deny-glob fixes (trailing slash bypass; braces; brackets; macOS symlinked folders) | 2.1.224, 2.1.299, 2.1.304, 2.1.309 | changelog entries of those versions |
| Input-redirect checks against Read rules | 2.1.257 | [perm] "Redirections" |
| `bypassPermissions` ignored as `defaultMode` from project/local settings | 2.1.257 | [set] "The file can't set that value" |
| `tee` targets checked against Edit rules | 2.1.269 | [perm] "Redirections" |
| `ConfigChange` no longer fired mid-command by sandboxed Bash on Linux when settings files are absent (bug fix) | 2.1.290 | [cl 2.1.290] |
| Admin-required sandbox semantics | 2.1.285 | [sbx] |
| **`onFailure: "block"`** | **2.1.295** | [hooks]; [cl 2.1.295] |
| **Bash-matching hooks see `Monitor` commands**; `blockWritesOutsideWorkingDirectories` | **2.1.314** | [cl 2.1.314]; [perm] |

Implication: SEC-1 alone needs `MIN_CLAUDE_CODE` ≥ 2.1.295. Closing MON-1 and using the outside-directory write block needs 2.1.314. Raising the floor to 2.1.314 also brings in every sandbox glob fix listed above. What an older Claude Code does with an unknown hook field such as `onFailure` (ignore it, warn, or drop the hook entry) is **unverified**. `doctor` today only warns when the version is old (`src/cli/doctor.ts:72`); it doesn't stop anything.

## 4. Design approaches

These parts are the same in all three approaches, because they are cheap and have no UX cost:
- `onFailure: "block"` on PreToolUse and UserPromptSubmit, with exec form (`"command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"]`) so a missing shell or a quoting problem can't be the failure.
- `dispatch.ts` main exits non-0/2 (or emits a deny) on a throw.
- `Bash|PowerShell|Monitor|Read|Grep|Edit|Write|MultiEdit|NotebookEdit` matcher.
- The SEC-10 deny rules.
- A `ConfigChange` entry.
- The text checks keep running as the backup.

### Approach A: platform-first everywhere (sandbox on by default)

What it adds: `init` merges `"sandbox": { "enabled": true, "allowUnsandboxedCommands": false }` into `.claude/settings.json`, and lets the Edit/Read deny rules supply the paths. It falls back to explicit `sandbox.filesystem.denyWrite`/`denyRead` if the translation proves wrong. The text checks are frozen as the seatbelt and keep their tests.

- Turning it on and off: an init question (default on) records `sandbox: on|off` in `config.yaml`, and `harness update` re-merges. A person can override it for themselves with `"sandbox": {"enabled": false}` in `.claude/settings.local.json`, or with `/sandbox`. A local scalar wins over project [set]. The agent can't do the same: sandboxed shells can't write settings files [sbx], the Edit deny rule covers the file tools, and `ConfigChange` blocks the change in the running session.
- Uninstall stays byte-identical: harness adds the `sandbox` keys only when the user doesn't have them, and records each as a structural block (for example `{"set":["sandbox","enabled"],"value":true}`), the same way it records `{"deny":…}` blocks today (`merge.ts:46`, `uninstall.ts:46-62`). If the file's hash still matches, uninstall restores the backup as today. Otherwise it removes only the recorded keys and drops parents left empty that did not exist before init (`uninstall.ts:64-71` already does this for `hooks`/`permissions`). The e2e byte-identity test needs a fixture with and without an existing `sandbox` key. `update` must re-record hook groups whose shape changes (adding `onFailure`), or uninstall's deep-equality match misses them.
- Windows effect: native Windows runs unsandboxed with no error (as long as `failIfUnavailable` is not committed), so it gets hooks, permission rules and text checks only. That should be said plainly in the README. WSL2 gets the full sandbox. Linux and WSL2 need `bubblewrap` and `socat` installed [sbx], so `doctor` should check for them.
- Trade-offs:
  - It changes everyone's prompts. With the sandbox on, `autoAllowBashIfSandboxed` (default `true`) runs sandboxed commands without a prompt [perm "How permissions interact with sandboxing"]. That is fewer prompts, and it may surprise people. Setting it to `false` keeps today's prompts.
  - Network: domains start empty, so the first `npm install` or `git push` over HTTPS prompts, and `dontAsk` refuses it.
  - On macOS, `git push` over SSH fails inside the sandbox [sbx troubleshooting].
  - It is committed to a shared file, so it applies to teammates too.

### Approach B: platform hooks and rules always; sandbox required for unattended runs only (recommended)

This matches the original spec §7.3/§11. Interactive sessions get the shared parts above. The sandbox is opt-in for them (`sandbox: unattended|always|off`, default `unattended`).

For unattended runs there are two layers:
1. Every unattended launch that harness owns or documents passes `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false}}'`. `--settings` sits above project and local settings [set]. `failIfUnavailable` makes the run exit instead of running unsandboxed [sbx].
2. In the hooks, when `isUnattended()` is true and harness can't confirm a sandbox (native Windows by `process.platform`, or a project or local settings file that doesn't enable it), deny `Bash|PowerShell|Monitor` writes outside a small allowlist. A hook can't see `--settings` or the live sandbox state; whether hook input carries it is **unverified**. So this check is a heuristic, and it fails closed.

- Turning it on and off: `config.yaml` `sandbox:` key plus `harness update`. Interactive users can still run `/sandbox` themselves. The unattended deny can be relaxed only by a person (the config file is denied to the agent).
- Uninstall: with `unattended` (the default), nothing new goes into `settings.json` apart from the shared parts, so the current byte-identity mechanism is enough. With `always`, it works as in A.
- Windows effect: unattended runs on native Windows are fail-closed for shell writes. Interactive Windows is the same as A.
- Trade-offs: no UX change for interactive users by default, and the strongest guarantee goes where nobody watches (CON-4). Interactive sessions keep the text-check gaps (SEC-3/6/9) unless the person opts in. The second layer adds a small amount of new code.

### Approach C: no sandbox, platform rules and hooks only

Only the shared parts, plus `ask` rules for test-config files (SEC-8). The sandbox is documented as a manual step the user can take.

- Turning it on and off: nothing new. Uninstall: unchanged mechanism. Windows: identical behaviour on all platforms.
- Trade-offs: the least work and no UX cost. But SEC-3, SEC-6, SEC-9 and SEC-11 stay closed only by text matching, so it can't honestly be called enforcement, and CON-4 stays open. It is effectively the lead review's "seatbelt" framing with SEC-1/2/4/10 fixed.

### Recommendation

**B**, with a one-line README promise: "Enforced by Claude Code's sandbox in unattended runs on macOS, Linux and WSL2; a seatbelt elsewhere."
- It closes CON-4 and the unattended half of SEC-3/6/7/9/11, where the risk is highest.
- It keeps interactive UX unchanged unless the person opts into `always` (which becomes A).
- It treats Windows honestly by failing closed when unattended.
- Raise `MIN_CLAUDE_CODE` to 2.1.314 in the same change.

Before building any of this, run one paid live check, only with owner approval: does `ConfigChange` block a Bash-written `disableAllHooks`, and does the Edit-deny-to-sandbox translation of `./**/.env.*` and `./.harness/**` work?

## 5. Open questions for the owner

**Q1. Default sandbox mode.**
- (a) `unattended` (recommended): CON-4 with no interactive UX change.
- (b) `always`: closes the shell gaps for everyone, but changes prompts and network behaviour for teammates.
- (c) `off`: no change, keeps the seatbelt label.

**Q2. Test results live in `.harness/state/test-results`, which the agent's sandboxed test run must write, while `.harness/state/**` must be closed to the agent (SEC-11, BUG-2 state).**
- (a) Move results to a separate folder such as `.harness/results/` that stays writable, and deny the rest of `.harness/state/**` (recommended). It is a small config and path change, and forging results stays possible, as it is today (`config.ts:138` already warns about it).
- (b) Keep one folder, and carve the results out with a `!` negation in the deny rule. That relies on negation semantics that need checking ([perm] "Special characters and ! negation").
- (c) Have a PostToolUse hook, which runs outside the sandbox, copy the results in. That is unforgeable by the agent only if the runner writes somewhere the hook trusts. More code.

**Q3. `onFailure: "block"` scope.** A missing `node` on the hooks' PATH would then block every tool call.
- (a) Block on all matched PreToolUse tools and UserPromptSubmit (recommended), and add a `doctor` check of the hook-side Node.
- (b) Block only on `Bash|PowerShell|Monitor|Edit|Write|NotebookEdit`, and let `Read` continue. That re-opens secret reads when the hook fails.
- (c) Block only when unattended. That isn't expressible in settings without two hook entries and an `if` condition, so it is more complex.

**Q4. New Claude Code floor.**
- (a) 2.1.314 (recommended): `onFailure`, Monitor visibility, outside-directory write block and every sandbox glob fix.
- (b) 2.1.295: the minimum for `onFailure`; Monitor stays a known limit.
- (c) Keep 2.1.285 and document SEC-1 as open.
- Should `doctor` *fail* below the floor, or only warn as today? Recommended: fail.

**Q5. What the `ConfigChange` hook blocks.**
- (a) Block only changes that drop or alter harness hook entries, add `disableAllHooks`, or turn the sandbox off (recommended). A person's ordinary edits pass, and the block is logged plus shown at the next prompt, because Claude Code shows no message itself.
- (b) Block every `project_settings`/`local_settings` change. This also blocks the person's own mid-session edits.
- (c) Log only.

**Q6. `autoAllowBashIfSandboxed` when the sandbox is on.**
- (a) Set it to `false` (recommended for B and `always`), so turning the sandbox on never removes a prompt the person had.
- (b) Leave the default `true`, for fewer prompts.

**Q7. Force push and push to main**, which have no platform enforcement.
- (a) Keep the guard rules and recommend server-side branch protection in the README (recommended).
- (b) Also add `Bash(git push --force *)`/`-f` deny rules plus their `PowerShell(...)` twins as a second text layer. Note the Windows rule that a scoped Bash deny turns PowerShell off unless a PowerShell rule exists [tools].
- (c) Guard only.

**Q8. Teams and managed settings.** Managed hooks can't be switched off by `disableAllHooks` in user, project or local settings [hooks]. Managed `allowUnsandboxedCommands: false` makes the sandbox admin-required [sbx]. The files need admin rights (`/Library/Application Support/ClaudeCode/`, `/etc/claude-code/`, `C:\Program Files\ClaudeCode\` [managed]).
- (a) Document an optional managed-settings snippet for teams and solo users with admin rights; don't install it (recommended).
- (b) Have `init` offer to write it with sudo. That is outside the repo and breaks the byte-identical uninstall promise.
- (c) Ignore it.

## 6. What I could not verify

- **ConfigChange and Bash-written files.** The settings page says the watcher runs `ConfigChange` "for each settings-file change it detects" [set], and the 2.1.290 fix mentions sandboxed Bash triggering it. Neither was tested live. Also untested: whether blocking prevents a just-written `disableAllHooks: true` from taking effect in the running session.
- **Unknown hook fields on old versions.** What a Claude Code older than 2.1.295 does with a hook entry that has `onFailure`.
- **Deny-rule translation into the sandbox.** How `Read(./**/.env.*)` and `Edit(./.harness/**)` translate into sandbox paths, and whether `!` negation carries over.
- **`chmod` and the sandbox.** Whether a mode change (`chmod 000 .harness/hooks/dispatch.mjs`) is a denied write under the macOS and Linux sandbox.
- **Rules and PowerShell.** Whether Read/Edit deny rules, and ask rules, apply to PowerShell commands and to recognised Bash file commands (ask rules).
- **Monitor's `tool_name`.** The `tool_name` a PreToolUse hook gets for a Monitor command after 2.1.314.
- **Sandbox state in hooks.** Whether a hook can learn that the sandbox is active, or see `--settings` values.
- **`strictAllowlist`.** Whether it can be set from project settings.
- **Windows.** Anything Windows-specific, live. All Windows statements come from the docs.
- **Branch protection.** GitHub branch protection as the force-push control. I didn't research it and cite no source.
- **Unread doc sections.** The sandboxing page's "Security limitations" section and the last ~8 KB of that page didn't come through in the fetch. The hooks page's middle section was only searched for the topics above.
