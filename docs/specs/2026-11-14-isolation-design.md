# Isolation hardening: design

- Status: revision 2, for the owner's review, 2026-11-14. No code. Revision 1 (050c8da) was reviewed adversarially (6 Critical, 13 Important, 16 Minor; `.superpowers/sdd/isolation/spec-review.md`, local). §18 maps every finding to its fix.
- Research: [`../research/2026-11-14-isolation.md`](../research/2026-11-14-isolation.md), cited below as "R§n". Its sources were fetched on 2026-11-14; URLs are repeated where a design choice rests on them.
- `srt` facts are from its README, read on 2026-11-14 at https://github.com/anthropics/sandbox-runtime. The `anthropic-experimental/sandbox-runtime` URL redirects there. Cited as "srt README".
- Owner decisions: I0 to I15, the coordinator's rulings, and one live finding, in `.superpowers/sdd/isolation/decisions.md` (local, not committed). They bind; §1 lists them.
- Prior work, treated as shipped: the unattended launch fix, commit 9a98f50 on `fix/unattended-launch-strict` (I1). It includes its review fix rounds: Claude Code login denies, the release note, the managed `allowManagedDomainsOnly` false deny, plan mode, a missing `permission_mode`, I10's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, and the `HARNESS_CLAUDE_CONFIG_DIR` ruling. "The launch JSON" below means that command's `--settings` value. This spec adds to the launch line (§6.4, §1 live finding) but doesn't redesign it.
- Sequencing (I0, I12): the Stop-gate `srt` PR (§4) lands right after the done contract's PR 3. Everything else lands after the done contract ([`2026-11-13-done-contract-design.md`](2026-11-13-done-contract-design.md)) is complete.

## 1. Owner decisions

| # | Decision | Where |
|---|---|---|
| I0 | Spec now, build after the done contract. Native Windows unattended runs deny shell unless in WSL2 or a container. | §9, §13 |
| I1 | Launch fix: `strictAllowlist`, allowlist and credential denies in `--settings`; `sandbox-required` enforces `strictAllowlist` under `bypassPermissions`. | Prior work |
| I2 | Agent identity is a per-owner GitHub App: Contents, Pull requests and Metadata only; 1-hour, one-repo tokens. | §6 |
| I3 | `permissions.blockReadsOutsideWorkingDirectories` on by default in **every** mode. Needs a live check and documented fixes. | §8 |
| I4 | Server-side setup is a separate owner-run `harness github protect`; the guard denies it to the agent; doctor reads it back. | §5 |
| I5 | The container bind-mounts the workspace. Its "Claude Code's sandbox on inside" part is **replaced by I14**. | §7 |
| I6 | The container boundary is `srt`, not iptables. The owner accepts that it is a beta. | §7 |
| I7 | `github.com` is allowed only for runs that push, with the App token. Refresh for runs lasting days. | §6.4, §7.4 |
| I8 | A private repo without Pro gets a plain doctor statement; the local layers stay. | §5.6 |
| I9 | Tokens come from a broker outside the agent. The App key stays out of the sandbox and container. Tokens reach the agent through a git credential helper and `gh`, re-minted automatically. | §6 |
| I10 | Unattended launches set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. Ruling: hooks read `HARNESS_CLAUDE_CONFIG_DIR` when the scrub removes `CLAUDE_CONFIG_DIR`. | Prior work, §7.2 |
| I11 | The native Windows deny ships in the next minor release; doctor gives the fix; `sandbox: off` is the logged escape. | §9 |
| I12 | Stop-gate steps run inside `srt`, with harness's `denyWrite`, the credential denies, and no network (allowlist from config). Its own small PR, right after done-contract PR 3. | §4 |
| I13 | The App key lives only where agent code can't run: outside the container; in CI, a separate minting job that runs no repo code; on a macOS host, a keychain item with no trusted apps, read once at broker start. Linux refuses a plain key file. One App installation per repo; the broker refuses `repository_selection: all`. | §2.4, §6 |
| I14 | Inside the container, `srt` is the only fence. Claude Code's inner sandbox is off, because nesting voids `srt`'s write fence (srt README). `srt` carries `denyWritePaths()` plus `.git/hooks`, `.git/config` and `.vscode`. | §7 |
| I15 | Keep the `isolation.block_reads` off switch, person-only. It lives in the protected harness config, and doctor and status show it loudly when off. | §8.1 |
| C2 | Token files live in a per-uid private base: `$XDG_RUNTIME_DIR` on Linux, `DARWIN_USER_TEMP_DIR` on macOS. Every path component is `lstat`-verified, and writes use `O_EXCL\|O_NOFOLLOW`. | §6.3 |
| C4 | An owner `User` bypass in `pull_request` mode, on by default for user-owned repos, plus a documented break-glass. | §5.2 |
| C5 | A second ruleset, `harness-refs`: tags are owner-only, and the App may create and update branches only under a configurable prefix (default `agent/`). | §5.3 |
| C6 | The launch and `harness-run` unset the askpass, SSH agent and VS Code git variables. They set `GIT_ASKPASS` and `SSH_ASKPASS` to `/bin/false` and `core.sshCommand=false`. `devcontainer.json` turns off git config copying and credential forwarding (setting names pinned in L4). | §6.4, §7.2 |
| Live | On 2.1.322, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` forces the default permission mode ("Declare allowedTools explicitly"). `bypassPermissions` is ignored under the scrub, so launches need `--allowedTools`. | §6.4, §7.3, §16 Q4 |

The research recommended otherwise on three of these:
- I3 (R§12 Q2);
- I6 (R§12 Q6);
- I14 drops the inner sandbox that the research proposed (R§11 B2).

Their risks are stated where they are designed: §7.7 and §8.6.

## 2. Threat model

### 2.1 The actor

A Claude Code agent that has drifted or been prompt-injected (OWASP ASI01, R§8, https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/).

- It runs as the user's uid, with every tool the session allows, attended or unattended.
- **Agent-controlled code** means:
  - every command the agent runs;
  - every file it writes that something later executes, such as tests, package scripts, build config or git hooks;
  - which covers the Stop gate's steps, which run the project's own commands.
- It can't change harness's hook code or Claude Code's settings mid-session (protect, `denyWrite`, ConfigChange).

Out of scope:
- the person who launches the run, who can fake every signal (R§3.4);
- kernel or sandbox escapes;
- a compromised Claude Code, `srt`, npm registry or GitHub;
- a person who approves a bad PR.

### 2.2 What the agent wants, and which layer answers

| Goal | A: server side | B: container | C: attended local, plus the Stop gate in `srt` (§4) |
|---|---|---|---|
| Land code on the default branch without a person | **Stops it**: PR required, code-owner review, last-push approval, required `harness-verify` pinned to its app; Actions can't approve | No effect | Guard denies push to main and `gh pr merge` (a text check) |
| Fake the verify result | **Stops it**: no Statuses or Checks permission; check pinned by `integration_id` | No effect | No effect |
| Ship through a release or deploy path (tags, release branches) | **Stops it**: `harness-refs`, where tags are owner-only and the App writes only under `agent/` | No effect | No effect |
| Loosen CI or harness config | **Stops the merge**: no Workflows permission; CODEOWNERS on `.github/`, `.harness/`, `.claude/`, `.devcontainer/` | `.devcontainer/` and harness files are read-only inside `srt` | Protect, `denyWrite`, ConfigChange |
| Steal the user's credentials | No effect | **Stops it**: no host credentials, VS Code's bridges cut (C6) | Read block, credential and env denies, guard. Unsandboxed Bash and keychain IPC are gaps (§2.4) |
| Get the App key | — | **Stops it** (I13) | Depends on the host: see §2.4 |
| Act as the owner on GitHub | Gives the agent its own identity | Only the App token, push runs only; askpass and SSH cut (C6) | Askpass and SSH agent variables denied; helper overrides denied (a text check) |
| Exfiltrate code or secrets | No effect | Hostname allowlist; GitHub only on push runs | Network allowlist; strict in unattended runs (I1); no network for Stop steps (I12) |
| Plant code that later runs on the host | Merges need review | **Partly**: protected paths only (§7.6) | Protected paths in the sandbox and in `srt` |
| Damage outside the repo | No effect | **Stops it**: only the workspace is mounted | Sandbox write rules for Bash; `srt` write rules for Stop steps |

### 2.3 What no layer stops

- **Exfiltration over an allowed host.** Proxies decide on the hostname without inspecting TLS, so domain fronting works (R§2.4, https://code.claude.com/docs/en/sandboxing "Security limitations"; srt README "Security Limitations").
- **Misuse of the App token inside its scope.** For up to an hour the agent can push under `agent/`, open, close and comment on PRs, and write misleading PR text. The token reaches the agent on push runs by design.
- **Code outside the fence on the host.** Hooks, MCP servers, LSP servers and WebFetch run outside Claude Code's sandbox there (R§2.4). In the container they run inside `srt`.
- **What a person does:** approving a bad PR, using the C4 bypass or break-glass, setting `sandbox: off`, or running agent-written code on the host later.

### 2.4 Is the App key out of reach of agent-controlled code?

"Out of reach of agent-controlled code" holds only where I13 holds:

| Where the agent runs | Holds? | Residual |
|---|---|---|
| Harness container | **Yes.** The key and the broker stay on the host; only the token folder is mounted, and only `--push` runs can read it | The host row applies to any other session on that host |
| CI, with the agent job and a separate publish job (§6.6) | **Yes.** The agent job holds no key and no token; the publish job runs no repo code | The publish job's own pinned actions and harness version (supply chain) |
| macOS host | **Yes, unless the person clicks Allow.** The item has no trusted apps, so every read raises a keychain prompt; the broker reads it once at start | The person allowing a prompt that agent code raised. Agent code reading the broker's memory would need debugger rights: L2 confirms |
| Linux host | **Only when no agent code runs unsandboxed there:** `sandbox: always` with Claude Code's seccomp filter (it blocks the D-Bus socket), and Stop steps in `srt` (I12, which blocks Unix sockets) | Otherwise, any unsandboxed process of the uid reads Secret Service silently: Bash in attended sessions under the default `sandbox: unattended`, agent-planted code the person runs later, and `/proc/<broker>/mem` where `ptrace_scope` is 0. Doctor and status say "App key reachable by unsandboxed code" (§10.4) |
| Native Windows, or Linux without Secret Service | No host key; use the container or CI | — |

**The token is not the key.** On push runs it reaches the agent by design: for one repo, for one hour, with Contents and Pull requests write, and for branches under `agent/` only.

### 2.5 The binding layer

**Layer A binds.** It is the only layer that holds whatever happens on the machine, because GitHub enforces it and the agent's identity can't change it.

Layers B and C, and the Stop gate's `srt`, shrink the blast radius on a machine the user controls, and the user can turn them off. Where Layer A is unavailable (a private repo without Pro, I8), nothing binds, and doctor says so in those words.

## 3. Components at a glance

| Layer | Component | New or changed |
|---|---|---|
| — | Stop steps (and verify's command runs) inside `srt` (I12) | Stop runner |
| A | `harness github protect`: rulesets `harness` and `harness-refs`, Actions workflow permissions | New command |
| A | CODEOWNERS block from `project.codeowners` | Init, update and uninstall |
| A | Read-back of rulesets, workflow permissions and CODEOWNERS | Doctor, status |
| A | `harness github app create`, `harness github app store-key` | New commands |
| A | `harness github broker` (mints, refreshes, revokes) | New command |
| A | CI publish job (docs) | Docs, doctor |
| B | `/harness:init --container`: `.devcontainer/harness/` with `srt` as the only fence | New install output |
| B | Container verdict in `sandbox-required`; `isolation.container` | Changed check |
| C | Read block, credential and env denies, ecosystem allowlist in `.claude/settings.json` | `mergeSettings` |
| C | Credential and toolchain report | Doctor |
| — | Native Windows deny | `sandbox-required` |
| — | Guard and protect additions | Guard, protect |

## 4. Stop steps inside `srt` (I12)

### 4.1 The hole it closes

The Stop gate runs the project's lint, type check, test and build commands with `execFileSync` from a hook. Hooks run outside Claude Code's sandbox (R§2.4), so a `conftest.py` or a `package.json` script the agent just wrote runs with the user's full access: credentials, the network, the keychain, and harness's own files.

The done contract's `harness verify` reuses the same runner (done contract §4.4 step 3), so it has the same hole.

### 4.2 How steps are wrapped

- The wrap lives in the shared step runner (`src/checks/stop/runner.ts`), so Stop steps and verify's command runs are both covered.
- **Per Stop run:**
  1. Write the `srt` settings (§4.3) to `.harness/state/srt-stop.json`. That folder is protected by protect, `denyWrite` and ConfigChange. The file is regenerated on every run, never reused.
  2. **Preflight:** `srt --settings <file> true` must exit 0 within 15 seconds. This separates "`srt` can't run" from "a step failed".
  3. **Each step:** `srt --settings <file> <command> <args…>` replaces `<command> <args…>`, with the same time limits, environment, working directory and output capture as today. The exact argument form, which the README shows both as an argv and as one string, is pinned by a test (srt README "As a CLI tool").
- **Which `srt`:** the binary found on the hooks' `PATH`.
  - Its real path must not lie inside the repo or any `allowWrite` root. A copy the sandboxed command can rewrite "runs the result unsandboxed" next time (srt README "Where This Package Is Installed").
  - `srt --version` must be at least the version harness pins (`SRT_MIN`, moved only by a harness release).
  - Harness doesn't bundle `srt`; the person installs it globally (`npm install -g @anthropic-ai/sandbox-runtime@<pin>`).
- **Already fenced: no second wrap.** A nested `srt` is refused, with EPERM, inside another bubblewrap or `srt` (srt README "The command stays in the namespaces made for it"), and a Seatbelt profile can't be applied inside another. Two cases hit this:
  - the harness container, where the Stop hook already runs inside `srt`;
  - the agent running `harness verify` from sandboxed Bash.

  The runner detects them by behaviour. Before wrapping, it writes `.harness/state/.fence-probe`:
  - The write fails with EPERM (macOS Seatbelt) or EROFS (a Linux read-only bind). Only a fence that carries harness's `denyWrite` produces these, so the commands run unwrapped inside that fence, which also carries the credential denies and that fence's network allowlist.
  - The write fails with EACCES, which a `chmod` produces. That is not a fence, so the runner wraps as usual.
  - The write succeeds. The runner deletes the probe file and wraps.

  Known limits (§14):
  - In the container, steps use the run's `srt` settings, which may allow registry hosts and, on push runs, GitHub.
  - An unsandboxed agent that can make its own read-only mount, inside a user namespace, could fake the probe. Agent-run verify is not the binding verdict; CI is.

### 4.3 The `srt` settings for steps

All keys were checked against the srt README "Configuration Options":

```json
{
  "network": { "allowedDomains": [], "allowLocalBinding": true },
  "filesystem": {
    "allowWrite": [".", "<os temp dir>", "/tmp"],
    "denyWrite": ["<denyWritePaths()>", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks", ".claude/skills", ".devcontainer", "<CODEOWNERS paths>"],
    "denyRead": ["<token base>"]
  },
  "credentials": { "files": [ "<§8.3 list, mode deny>" ], "envVars": [ "<§8.3 list, mode deny>" ] }
}
```

- **Network.** None by default: `allowedDomains: []` means "no network access" (srt README). `stop.allowed_domains` (§10.1) adds hosts, for example a test that needs a registry.
  - `allowLocalBinding: true` lets tests start and reach local servers on macOS. On Linux it is ignored, because the sandbox's own loopback always works there.
  - Unix sockets stay blocked by default (srt README "Unix Socket Settings"). This also blocks D-Bus (Secret Service), `SSH_AUTH_SOCK` and VS Code's IPC.
- **Writes.**
  - The repo, the OS temp dir and `/tmp`, plus `stop.allow_write` for tool caches outside the repo (Go's build cache, for example).
  - `srt` always lets the child write its stdio, `/tmp/claude`, `~/.npm/_logs` and `~/.claude/debug`.
  - Its mandatory denies already cover `.git/hooks`, `.git/config`, `.vscode`, `.idea`, shell startup files, `.gitconfig`, `.mcp.json`, `.claude/commands` and `.claude/agents` (srt README "Mandatory Deny Paths"). Harness adds the paths those miss: its `denyWritePaths()`, `.claude/settings*.json`, `.claude/hooks`, `.claude/skills`, `.devcontainer` and CODEOWNERS.
- **Reads.** Unrestricted except the credential denies and the token base (§6.3). The I3 home-wide read block is not applied to steps, so toolchains under home keep working.
  - On Linux, a `denyRead` or credential path that doesn't exist when the step starts hides nothing (srt README "Path Syntax (Linux)"). The list is rebuilt for each run, so a credential created mid-session is covered from the next Stop run on.
- **Credentials.** `srt` has its own `credentials.files` and `credentials.envVars` with `mode: "deny"` (srt README "Other Configuration"). Harness renders the §8.3 lists into them from the same source as `.claude/settings.json`.
- `allowRead` has the opposite precedence in `srt` from Claude Code's (it wins over `denyRead`). Harness renders `srt` settings with their own function, never the Claude Code one, and writes no `allowRead`.

### 4.4 When `srt` is missing or fails: fail closed

| Case | What happens |
|---|---|
| `srt` not found, inside the repo or a write root, too old, or the preflight fails or times out | No step runs. Stop blocks with the message below; the block counts toward `stop.max_attempts`. A `stop-srt-unavailable` event is logged. |
| A step fails inside `srt` | The same as a failing step today. The output tail includes `srt`'s "Operation not permitted" lines, so a fence hit is visible. |
| `sandbox: off` | Steps run unwrapped, as today. A `stop-unwrapped` event is logged once per session, and doctor shows a note (I11's escape, applied here). |
| `harness verify` (attended or `--ci`) | The same rules. A verify that can't wrap is "not done" (exit 1) with the same message. |

Message:
`Stop gate: the checks run inside sandbox-runtime (srt), and srt <is not installed | is inside the repo or a writable folder (<path>) | is <ver>, older than <pin> | did not start: <first line of its error>>. Install it outside the repo with npm install -g @anthropic-ai/sandbox-runtime@<pin> (Linux also needs bubblewrap, socat and ripgrep; macOS needs ripgrep), then stop again. To run the checks unsandboxed instead, set sandbox: off in .harness/config.yaml (logged).`

The Stop hook itself fails open by Claude Code's design (done contract §2.3). Fail closed here means the gate never runs steps unwrapped, and verify never passes without the wrap.

### 4.5 Windows

`srt`'s Windows backend is an alpha with an elevated install (srt README "Windows (alpha)"). Harness doesn't use it.

- **Attended native Windows:** steps run unwrapped, as today. Doctor gives a warning: `Stop steps run without a sandbox on native Windows: the project's tests run with your full access. Use WSL2 or the harness dev container for a sandboxed Stop gate.`
- **Unattended native Windows:** no step runs, and Stop blocks with `Stop steps don't run unsandboxed in an unattended run on native Windows. Run in WSL2 or the harness dev container, or set sandbox: off (logged).` Under I0, unattended shell is denied there anyway.
- **WSL2:** Linux rules.

### 4.6 Machines that can't run `srt`

- **Linux** needs `bubblewrap`, `socat` and `ripgrep`. Ubuntu 24.04 and later need `kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile (srt README "Ubuntu 24.04+ note").
- **macOS** needs `ripgrep`.
- Doctor finds each case and prints the fix. Until it is fixed, the Stop gate blocks (§4.4). This is a behaviour change for attended Linux users whose Stop gate worked unwrapped, so it goes in the release note under "Breaking".
- **CI:** done-contract PR 6's `harness-verify` workflow must install `srt` at the pin, and on `ubuntu-24.04` run the `sysctl` line, or verify exits "not done". This is flagged to the owner as a change to the done-contract plan (§16 Q5).

### 4.7 Performance

- Each wrapped command pays `srt`'s start-up: the proxy, the sandbox profile or bubblewrap mounts, and on Linux a `ripgrep` scan for mandatory-deny files down to depth 3 (srt README "Linux search depth"). A Stop run pays it once for the preflight and once per step.
- The cost is unmeasured. The PR adds a perf case to `pnpm test:perf`, a Stop run of four trivial steps wrapped and unwrapped, and sets the budget from the first measurement on CI (target: no more than 1.5 s added per Stop run, an estimate).
- The overhead counts against `stop.timeout_s`. The Stop gate runs once per stop, not per tool call, so hook latency per tool call is unchanged.

## 5. Layer A: server-side protection

### 5.1 `harness github protect [--dry-run] [--yes]`

- **Who runs it.** The owner, in their own terminal, with their own `gh` login. That login needs the admin role on the repo. The guard denies it to the agent in every mode (§10.5).
- **Order.** Commit and merge the CODEOWNERS block (§5.4) **before** the first protect. Protect warns and asks when the default branch has no harness block.
- **Repo.** It reads the repo, default branch, visibility and owner type with `gh repo view --json nameWithOwner,defaultBranchRef,visibility,owner` and `gh api users/<owner> --jq .type`, validated with the safe-name patterns of `doctor-protection.ts`.
- **Writes go through `gh api`.** `gh ruleset` can't write rulesets (R§0.10, https://cli.github.com/manual/gh_ruleset; https://docs.github.com/en/rest/repos/rules). For each of the two rulesets, `harness` and `harness-refs`:
  1. `GET /repos/{o}/{r}/rulesets?includes_parents=false`, then pick the entry by `name` with `source_type == "Repository"`.
  2. `GET /repos/{o}/{r}/rulesets/{id}`, then compare the fields harness sets. Fields GitHub adds (`id`, `node_id`, `_links`, `created_at`, `updated_at`, `current_user_can_bypass`, `source`) are ignored.
  3. Equal: print `<name> ruleset on <o>/<r> is up to date`. Different: print the field diff and ask (unless `--yes`), then PUT. Missing: print it, ask, then POST.
  4. Re-read and compare. A mismatch exits 1.
- **Actions workflow permissions.** `PUT /repos/{o}/{r}/actions/permissions/workflow` with `{"default_workflow_permissions": "read", "can_approve_pull_request_reviews": false}`. Otherwise a `github-actions[bot]` approval, triggered by agent code in a same-repo workflow, could satisfy the approval rule. It is read, compared and set the same way.
- **Other behaviour.**
  - `--dry-run` stops after the diffs.
  - Rulesets with other names are never touched. A hand-edited harness ruleset is drift, and protect restores it after showing the diff.
  - JSON goes to `gh api --input -` on stdin.

### 5.2 Ruleset `harness`: the default branch

```json
{
  "name": "harness", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [ { "actor_type": "User", "actor_id": "<owner id>", "bypass_mode": "pull_request" } ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true, "require_last_push_approval": true,
        "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true, "do_not_enforce_on_create": false,
        "required_status_checks": [ { "context": "harness-verify", "integration_id": "<app id>" } ] } }
  ]
}
```

The rules and why they bind are in R§5.2 (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets). The review confirmed the field names against the REST docs, and PR P6 pins them in a test.

**Owner bypass (C4).** `github.protect.owner_bypass: auto` adds the `User` bypass in `pull_request` mode for user-owned repos, and leaves it out for org repos. `on` and `off` force it.
- **What it allows.** The owner can merge any PR without the approval or check, but can't push straight to the branch. It ends three deadlocks:
  - the owner's own PRs, which they can't approve themselves;
  - CI being down;
  - "Update branch" making the owner the last pusher.
- **What it doesn't allow.** The App can't use it. A stolen owner token could already approve the App's PRs, so the extra risk is small.
- L6 checks that a personal repo accepts a `User` bypass.

**Break-glass (documented).** With the bypass off, or when the rules themselves are wrong:
1. In the web UI, set the ruleset's enforcement to Disabled.
2. Merge.
3. Run `harness github protect` again, which shows the drift and restores it.

**Update branch.** Ask the agent to run `gh pr update-branch <n>` with the App token, so the App stays the last pusher and the owner's approval still counts.

**Required check.** The `required_status_checks` rule is added only when the `harness-verify` CI item (done contract §4.7) is installed.
- `integration_id` comes from a real check run: `GET /repos/{o}/{r}/commits/{default}/check-runs?check_name=harness-verify`, field `app.id` (R§5.5, https://docs.github.com/en/rest/checks/runs).
- The source app must have `statuses:write`; GitHub Actions does.
- With the item installed but no check run yet, protect exits 1 (§11.2).

**An approval authorizes the merge.** The App's Contents write reaches the merge API (R§0.8), so once the owner approves and the check passes, the App can merge its own PR, auto-merge included. Doctor and the docs say so, and L5 tests merging before and after approval.

### 5.3 Ruleset `harness-refs`: tags and other branches (C5)

```json
[
  { "name": "harness-refs-tags", "target": "tag", "enforcement": "active",
    "conditions": { "ref_name": { "include": ["~ALL"], "exclude": [] } },
    "bypass_actors": [ { "actor_type": "User", "actor_id": "<owner id>", "bypass_mode": "always" } ],
    "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ] },
  { "name": "harness-refs-branches", "target": "branch", "enforcement": "active",
    "conditions": { "ref_name": { "include": ["~ALL"], "exclude": ["~DEFAULT_BRANCH", "refs/heads/agent/**"] } },
    "bypass_actors": [ { "actor_type": "User", "actor_id": "<owner id>", "bypass_mode": "always" } ],
    "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ] }
]
```

- GitHub rulesets target either branches or tags, so `harness-refs` is two rulesets with these names. Both are managed like `harness`.
- **Prefix.** `github.agent_prefix` (default `agent/`) sets the excluded branch pattern. The agent's branches must start with it, and GitHub's rejection of any other branch names the ruleset.
- **Tags and releases.** Only the owner creates, moves or deletes tags, so a tag-triggered publish can't build agent code. The App can still create a draft release object through the API, but not the tag it needs (L6 confirms).
- **Org repos.** Other collaborators also need to push branches outside `agent/`. On org repos, protect adds a `RepositoryRole` bypass for the Write role. L6 checks that this doesn't cover the App (an `Integration` actor). If it does, org repos get `harness-refs-tags` only, with a doctor note.
- **Doctor flags release and deploy triggers:** workflows on `push: tags`, `release`, or `push` to non-default branches that use no protected environment, since a tag the owner pushes still builds whatever is on that commit.

### 5.4 CODEOWNERS from `project.codeowners`

- `project.codeowners` changes from "input only" to the owners harness writes. Each entry must match `^@[A-Za-z0-9-]+(/[A-Za-z0-9._-]+)?$`. The interview proposes the repo owner's login when the list is empty.
- **Where it goes.** Init, update and sync write a marked block, recorded in the manifest, into the first of `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` that exists. GitHub reads only the first (R§5.3, https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners). With none, it creates `.github/CODEOWNERS`.
  ```
  # harness:start (managed by harness; edit project.codeowners instead)
  /.github/ @owner
  /.harness/ @owner
  /.claude/ @owner
  /.devcontainer/ @owner
  /AGENTS.md @owner
  /CLAUDE.md @owner
  /CODEOWNERS @owner
  /docs/CODEOWNERS @owner
  # harness:end
  ```
- **The block must stay last,** because the last matching line wins. Update moves it back to the end, and doctor gives a fix when a line follows it.
- **Removal.** Uninstall removes the block. An empty `project.codeowners` writes none, and protect then notes that code-owner review has no owners.
- **Locked locally.** The CODEOWNERS file joins protect's table and `denyWrite`. Any change goes through code-owner review, because PRs use the base branch's copy.

### 5.5 Doctor read-back and drift

Doctor builds the desired rulesets with protect's own function, then reads:

| Read | Result |
|---|---|
| Each ruleset equals the desired one | ok: `<name> ruleset is active and matches` |
| Fields differ / missing / `enforcement` not `active` | fix: `<name> ruleset <differs: fields \| is missing \| is <state>>` → `run harness github protect in your own terminal` |
| Workflow permissions differ | fix: `GitHub Actions can approve pull requests or write by default` → same fix |
| `gh` missing, not signed in, no read access | note: `server-side protection unknown (<reason>)` |
| Private repo, rulesets unavailable | statement (§5.6) |
| `GET /repos/{o}/{r}/codeowners/errors` lists errors | fix, one per error with path and line. This endpoint reports **syntax** errors on the default branch only |
| That endpoint returns 404 | fix: `no CODEOWNERS file on <branch>` → `merge the harness CODEOWNERS block` |
| `GET /repos/{o}/{r}/collaborators/{u}/permission` below `write` for an owner | fix: `<owner> can't own code (no write access); GitHub skips them silently` |
| Release or deploy workflows without a protected environment | note (§5.3) |

- **Identity.** Doctor prints which identity `gh` used: `owner <login>`, or `App <slug>[bot]` when `GH_CONFIG_DIR` points at a token folder. The App can't read Administration, so its read-back is "unknown", not "missing".
- **Branch protection.** The existing `branchProtection` check stays; either a branch protection rule or the ruleset counts as "protected".
- **Untrusted output.** All `gh` output is treated as in `doctor-protection.ts`: size limits, control characters stripped, an args array, never a shell.
- **Status line:** `Server side: rulesets ok | drift | missing | unknown | unavailable (private repo without Pro)`.

### 5.6 Private repos without Pro (I8)

- **Detection.** `visibility` is `private` and the rulesets API returns 403 with an upgrade message. A 403 without that context is "unknown".
- **Protect** exits 1 and changes nothing (§11.2).
- **Doctor** prints a statement, not a fix: `Server-side protection is unavailable: GitHub needs Pro, Team or Enterprise for rulesets on private repos. Nothing on GitHub stops a merge; harness's local layers stay on, and they can be bypassed.`
- **What remains.** The App still gives the agent its own identity. Without rulesets, its Contents write can merge and tag through the API (R§0.8), and only the guard's text checks stop that.

## 6. Layer A: agent identity

### 6.1 The App: one per repo (I2, I13)

`harness github app create [--org <org>]` runs the manifest flow (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest; the review fetched and confirmed the fields):

1. **Local server.** It starts an HTTP server on `127.0.0.1` on a random port, with a random `state` value. The flow must finish within one hour, and harness times out after 10 minutes.
2. **Form.** It opens a local page that POSTs the manifest form to `https://github.com/settings/apps/new?state=<state>`, or to `/organizations/<org>/settings/apps/new`.
3. **Manifest:**
   ```json
   {
     "name": "<login>-<repo>-harness",
     "url": "https://github.com/KhubaibQaiser/harness",
     "hook_attributes": { "url": "https://github.com/KhubaibQaiser/harness", "active": false },
     "redirect_url": "http://127.0.0.1:<port>/callback",
     "public": false,
     "default_permissions": { "contents": "write", "pull_requests": "write", "metadata": "read" },
     "default_events": []
   }
   ```
   The name is a suggestion cut to 34 characters. The person may edit it on GitHub's page, so harness uses the `slug` that the conversion returns.
4. **Callback.**
   - A wrong `state` or a timeout exits 1 (§11.2).
   - Harness calls `POST /app-manifests/{code}/conversions` and keeps `id`, `slug` and `pem`. It discards `webhook_secret` and `client_secret`.
   - The callback page never shows the `code`.
5. **Store.** It stores `pem` (§6.2), writes `github.app.id`, `github.app.slug` and `github.app.key_stored_at` to `.harness/config.yaml`, and opens `https://github.com/apps/<slug>/installations/new`.
6. **Install.** The owner installs the App on **only this repo**. Harness polls `GET /repos/{o}/{r}/installation` with the App JWT for up to 10 minutes, then runs the §6.3 installation check.

**Permissions** (R§5.4, https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens):
- **Granted:** Contents write, Pull requests write, Metadata read.
- **Not granted:** Issues, Workflows, Administration, Commit statuses, Checks, Actions, Secrets, Variables, Environments, Webhooks.
- Without Workflows, pushes touching `.github/workflows` are refused (https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app). Without Statuses and Checks, the App can't fake `harness-verify`.
- It is a separate PR author, so the owner can approve (R§5.3). It is not the official Claude GitHub App (R§5.4, https://code.claude.com/docs/en/github-actions).

**Why one App per repo (I13).** An App installs once per account, and its key mints tokens for every repo in that installation. One App per repo, installed on that repo alone, limits a leaked key to one repo. `--repo` on the broker is not a boundary by itself.

### 6.2 Where the key lives (I13)

| Where | Store | Notes |
|---|---|---|
| macOS host | Login keychain, generic password, service `harness-github-app`, account `<app id>`, **no trusted apps** | Written with `security -i`, with the command on stdin and the PEM base64-encoded inside it, so the key is never in argv. `-T ""` leaves the access list empty, so every read prompts, `security` included. The broker reads it once at start, after the person clicks Allow (not Always Allow). L2 verifies both. |
| Linux host | Secret Service (`secret-tool store`, which reads the secret from stdin) | **A plain key file is refused.** Without Secret Service, use the container or CI. The §2.4 residual applies. |
| Native Windows | Not supported: `app create` and `store-key` exit 1 with "Use WSL2 with Secret Service, the dev container, or CI" | — |
| Container | **Never inside.** The broker runs on the host | — |
| CI | Repository or environment secret `HARNESS_APP_KEY`, used only by the publish job (§6.6) | — |

- **Never** in an environment variable, a command-line argument, the repo or a log.
- **JWT.** Harness signs the App JWT with `node:crypto` (RS256, `iat` 60 seconds in the past, 9-minute expiry), with no new dependency.

**Rotation runbook (documented).** GitHub creates App keys only in its web UI.
1. Generate a new key on the App's settings page.
2. Run `harness github app store-key < new.pem`, which replaces the stored key, sets `key_stored_at`, and asks you to delete the file.
3. Delete the old key on GitHub.
4. Restart every broker.

Doctor shows the key's age from `key_stored_at`, with a note after 180 days.

### 6.3 The broker: `harness github broker [--repo <o/r>] [--env]`

The broker is a separate long-running process that the person starts outside the agent's session. It is the only host code that reads the key.

**Token base and folder (C2).**
- **Base:** `$XDG_RUNTIME_DIR/harness/gh` on Linux and `$(getconf DARWIN_USER_TEMP_DIR)harness/gh` on macOS. Both are per uid and 0700, and neither is under a root the read block closes (R§0.3). Linux without `XDG_RUNTIME_DIR` exits 1.
- **Folder:** `<base>/<owner>-<repo>/`.
- **Verification.** At start, before every write, and on every loop, each component from the base's parent down is checked with `lstat`: a directory, not a symlink, owned by the uid, and not writable by group or others. Missing components are created with a plain `mkdir` (never `-p`) at 0700, then re-checked. Any failure exits 1 (§11.2).
- **Writes.** Each file is opened `O_CREAT|O_EXCL|O_NOFOLLOW` under a temporary name inside the verified folder, given its mode with `fchmod`, written, `fsync`ed, then renamed into place.
- **Never removed.** The broker never removes the folder itself, so a container's bind mount stays valid.
- `XDG_RUNTIME_DIR` is removed at the last logout, so headless Linux hosts need `loginctl enable-linger` (documented).

**Files in the folder:**

| File | Contents | Mode |
|---|---|---|
| `hosts.yml` | `gh`'s multi-account format: `github.com: {users: {<slug>[bot]: {oauth_token}}, user: <slug>[bot], oauth_token, git_protocol: https}` | 0600 |
| `config.yml` | `version: "1"`, so `gh` never tries to migrate the folder (it may be mounted read-only) | 0600 |
| `token` | The bare token | 0600 |
| `expires` | Expiry, in epoch seconds | 0600 |
| `meta.json` | `{repo, app_slug, permissions, expires_at, minted_at, heartbeat_at, last_error, broker_pid}`, no token | 0600 |
| `git-credential` | A POSIX `sh` helper of about ten lines (§6.4). Its hash is re-verified on every loop, and it is rewritten if it differs | 0700 |

**Single instance.** A `flock`ed `broker.lock` in the folder. A second broker for the same repo exits 1 (§11.2).

**Installation check (I1, I13), on start and on every mint:**
- `GET /repos/{o}/{r}/installation` with the JWT. `.permissions` must equal exactly `{contents: write, pull_requests: write, metadata: read}`, and `repository_selection` must be `selected`.
- `GET /installation/repositories` with the new token must list exactly this one repo.
- The token response's `permissions` must equal `{contents: write, pull_requests: write, metadata: read}`.
- Any mismatch, including an Issues or Workflows permission added later in the web UI, `all`, or a second repo, deletes the token files, writes `last_error`, and exits 1.

**Minting.** `POST /app/installations/{id}/access_tokens` with `{"repositories": ["<name>"], "permissions": {"contents": "write", "pull_requests": "write"}}` (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

**Refresh for runs lasting days (I7).**
- **Timing.** A 60-second loop re-mints when less than 15 minutes are left, so it mints about every 45 minutes. A laptop that wakes from sleep catches up within a minute.
- **Swap.** After the atomic swap, the broker revokes the previous token with `DELETE /installation/token`, called with the old token.
- **Failures.** A failed mint retries with backoff (5 s, doubling to 5 minutes) and writes `last_error`. At expiry it deletes `hosts.yml` and `token`, keeps retrying, and never extends a token past GitHub's expiry.
- **Heartbeat.** Every loop updates `heartbeat_at`.

**Lifecycle.**
- SIGINT, SIGTERM and SIGHUP each revoke the current token, delete the token files (not the folder), release the lock and exit 0.
- For runs lasting days, the docs give a supervisor: a launchd agent on macOS, a `systemd --user` unit with `enable-linger` on Linux, or tmux. With a launchd agent the keychain prompt appears on each start.

**Logging.** Each mint, failure and revoke goes to stderr and to `.harness/logs` (`token-minted`, `token-mint-failed`, `token-revoked`), with time and expiry. The token is never logged.

**`--env`** prints the environment block for the launcher (§6.4), including `HARNESS_GH_DIR=<folder>`, and exits. It prints no secret.

### 6.4 How the agent uses the token, and closing the other credential routes (C6)

The launcher (the person's documented command, or `harness-run`) sets:

```sh
unset SSH_AUTH_SOCK GIT_ASKPASS SSH_ASKPASS VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_ASKPASS_NODE \
      VSCODE_GIT_ASKPASS_EXTRA_ARGS VSCODE_GIT_IPC_HANDLE REMOTE_CONTAINERS_IPC REMOTE_CONTAINERS_SOCKETS
export GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0=credential.helper                     GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=core.askPass                          GIT_CONFIG_VALUE_1=/bin/false
export GIT_CONFIG_KEY_2=core.sshCommand                       GIT_CONFIG_VALUE_2=false
# push runs only:
export GH_CONFIG_DIR="$HARNESS_GH_DIR" GIT_CONFIG_COUNT=4
export GIT_CONFIG_KEY_3=credential.https://github.com.helper  GIT_CONFIG_VALUE_3="$HARNESS_GH_DIR/git-credential"
```

(Push runs raise `GIT_CONFIG_COUNT` to 4 for the harness helper.)

- **Helpers.** The empty `credential.helper` resets git's helper list, so the owner's helpers (osxkeychain, GCM, `store`, a helper forwarded by VS Code) are never asked (https://git-scm.com/docs/gitcredentials).
- **Askpass and SSH.** `core.askPass` and `GIT_ASKPASS` stop the VS Code askpass fallback, which git consults after the helpers whatever `GIT_TERMINAL_PROMPT` says. `core.sshCommand=false` also defeats `url.*.insteadOf` rewrites to SSH.
- **The scrub.** It keeps `GIT_CONFIG_*` (review, env-vars doc).
- **Confirmation.** L3 checks with `GIT_TRACE`. The VS Code variable names are pinned in L4.
- **`git-credential`** answers `get` only. It compares `expires` with `date +%s`. With 5 minutes or more left, it prints `username=x-access-token` and the token. Otherwise it prints the §11.2 message for the missing, expired or nearly expired case, and exits 1.
- **`gh`** reads `hosts.yml` on each call, so refreshed tokens reach a running session. `GH_TOKEN` stays denied.
- **Commit authorship** is unchanged. The App is the pusher and the PR author.
- **Fail closed.** A broker that is down leaves a stale token within an hour. git and `gh` then fail visibly, and nothing falls back to the owner's credentials.

**The documented host launch.** This is the launch fix's line plus the live finding, with `HARNESS_UNATTENDED=1` because the scrub hides `bypassPermissions`:

```sh
harness github broker --repo o/r            # in another terminal, for push runs
eval "$(harness github broker --env --repo o/r)"   # push runs only
<the §6.4 env block>
HARNESS_UNATTENDED=1 HARNESS_SANDBOX=1 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 \
  claude -p "…" --allowedTools "Bash Read Edit Write Glob Grep" --settings '<launch JSON>'
```

- With the scrub, the session stays in the default permission mode (live finding). So harness detects the run as unattended through `HARNESS_UNATTENDED`, and tools outside `--allowedTools` are denied in `-p`.
- The tool list is a draft, confirmed by the launch fix's round-2 live check (§16 Q4).
- For push runs, the launch JSON adds `github.com` and `api.github.com` to `allowedDomains`.

### 6.5 Reaching the broker

- **Host.** The agent's tree only reads the token folder. The base is outside the read block's roots, so nothing needs allowing.
- **The sandbox's own write area.** The research says it includes the per-user temp dir (R§2.1), while the review reads it as `/tmp/claude-<uid>` (env-vars doc). On macOS the token base sits under `DARWIN_USER_TEMP_DIR`, so L2 checks whether sandboxed Bash can write it.
  - If it can, `harness github broker --env` also prints the base for the person to add to the launch JSON's `denyWrite`.
  - The broker's hash check on `git-credential` and its `lstat` checks catch a swap within 60 seconds either way.
- **Container.** The host folder is bind-mounted read-only at `/run/harness/gh`. Only `srt-push.json` lets the tree read it (§7.3).

### 6.6 CI: an agent job and a publish job (I13)

The key and the token never enter a job that runs repo or agent code.

```yaml
jobs:
  agent:                                  # runs the agent; holds no key and no token
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }   # checkout v6 keeps the token in a file under $RUNNER_TEMP otherwise
      - run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # ubuntu-24.04: Claude's sandbox and srt need it
      - run: npm i -g @khubaibqaiser/harness@<pin> @anthropic-ai/sandbox-runtime@<pin>
      - run: <the §6.4 launch, without the push lines, and without github.com>
      - run: git bundle create agent.bundle "origin/${{ github.event.repository.default_branch }}..HEAD"
      - uses: actions/upload-artifact@<sha>
        with: { name: agent-out, path: "agent.bundle\n.harness/tmp/pr-body.md", retention-days: 1 }
  publish:                                # runs no repo code
    needs: agent
    permissions: {}
    steps:
      - uses: actions/download-artifact@<sha>
        with: { name: agent-out }
      - run: npm i -g @khubaibqaiser/harness@<pin>
      - env: { HARNESS_APP_KEY: "${{ secrets.HARNESS_APP_KEY }}" }
        run: |
          printf '%s' "$HARNESS_APP_KEY" | env -u HARNESS_APP_KEY harness github publish \
            --repo "$GITHUB_REPOSITORY" --branch "agent/run-${{ github.run_id }}" \
            --bundle agent.bundle --body pr-body.md --key-stdin
```

- **`harness github publish`** (person-only, like every `harness github` subcommand) does this:
  1. Mints one token as the broker does, with the same installation check.
  2. `git init`s an empty repo and fetches the bundle.
  3. Checks the branch name starts with `github.agent_prefix`.
  4. Pushes the branch over HTTPS with the token.
  5. Opens or updates the PR with the body file.
  6. Revokes the token.

  It never checks out a work tree and never runs hooks, scripts or package managers. A bundle carries no hooks.
- **Costs.** A CI agent can't push mid-run or read PR comments. There is no token in the agent job, so there is nothing to refresh.
- **The artifact** is readable by anyone who can read the repo's Actions. It holds only the agent's commits and PR body, which are about to be public on the PR anyway.
- **Doctor flags:**
  - a workflow that runs `claude` after a checkout without `persist-credentials: false` (read from the workflow's `with:`);
  - a workflow that passes `HARNESS_APP_KEY` to a job that checks out code.

## 7. Layer B: the container

### 7.1 `/harness:init --container`

- Sets `isolation.container: required` (§10.1) and writes `.devcontainer/harness/`, a named configuration, so an existing `.devcontainer/` is left alone.
- Files: `devcontainer.json`, `Dockerfile`, `srt.json`, `srt-push.json`, `claude.json`, `claude-push.json` and `harness-run`. They are recorded in the manifest, re-rendered by update, and removed by uninstall or by `isolation.container: off` plus update.
- `.devcontainer/**` joins protect's table, `denyWrite`, `srt`'s `denyWrite` and the CODEOWNERS block. A change takes effect only when a person rebuilds the image.

### 7.2 Derived from Anthropic's reference (R§3.1)

| Reference | Harness | Why |
|---|---|---|
| `FROM node:20` | `node:22-bookworm-slim@sha256:<digest>` | Harness needs Node 22.11 |
| `CLAUDE_CODE_VERSION=latest` | Pinned to the live-checked version, never below `MIN_CLAUDE_CODE`, with `DISABLE_AUTOUPDATER=1` | R§3.2, https://code.claude.com/docs/en/devcontainer |
| iptables, ipset, `NET_ADMIN`, `NET_RAW`, sudoers, `init-firewall.sh` | **Removed** | I6 |
| — | `bubblewrap`, `socat`, `ripgrep`; `@anthropic-ai/sandbox-runtime@<pin>` and `@khubaibqaiser/harness@<pin>`, installed globally outside `/workspace` | srt README "Platform-Specific Dependencies", "Where This Package Is Installed" |
| `USER node`, named volume for `/home/node/.claude` | Kept | `--dangerously-skip-permissions` refuses root |
| `CLAUDE_CONFIG_DIR=/home/node/.claude` | **Kept**, plus `HARNESS_CLAUDE_CONFIG_DIR=/home/node/.claude` | The I10 ruling. With the variable set, `.claude.json` lives inside that folder, so it survives rebuilds |
| — | The Dockerfile creates `/home/node/.claude/` and `/home/node/.claude/.claude.json`, owned by `node` | On Linux, `srt` write grants apply only to paths that exist |
| No host credential mounts | Kept, plus VS Code's bridges turned off: `customizations.vscode.settings` with `"dev.containers.copyGitConfig": false` and `"dev.containers.gitCredentialHelperConfigLocation": "none"` (C6; names pinned in L4) | VS Code forwards the host's helper and SSH agent by default. `harness-run` also resets helpers and unsets the variables (§6.4), whatever these settings do |
| Workspace bind mount | Kept (I5) | §7.6 |
| — | Token folder, read-only: `${localEnv:HARNESS_GH_DIR}` → `/run/harness/gh` | §6.5 |
| — | `initializeCommand` checks that `HARNESS_GH_DIR` is set and is a verified folder (it runs `harness github broker --env --check`); otherwise it fails with the fix | A missing bind source fails the container start anyway |
| — | Root-owned marker `/etc/harness/container`: `{"harness":"<ver>","image":"harness-devcontainer"}`, mode 0644 | §7.5 |
| — | `ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | Drops the telemetry hosts (R§6.1). It also stops feature-flag fetching, which may turn some Claude Code features off; documented |

- `<digest>` and `<pin>` are filled in by each harness release, and pins move only then. A unit test fails the release when the Claude Code pin is below `MIN_CLAUDE_CODE`.
- **Linux Docker.** If the host uid isn't 1000, the 0700 token folder is readable only when `updateRemoteUserUID` maps the `node` user to it. L4 checks this.

### 7.3 `srt` as the only fence (I6, I14)

```
docker container (no added capabilities, no host credentials, VS Code bridges off)
└─ srt --settings /etc/harness/srt[-push].json      ← the only fence, for the whole process tree (I14)
   └─ claude -p … (Claude Code's sandbox off)
      ├─ hooks, MCP servers, LSP servers, WebFetch, Stop steps   ← all inside srt
      └─ Bash                                                    ← inside srt
```

- **`harness-run [--push] -- <claude args>`,** root-owned at `/usr/local/bin/harness-run`, runs:
  ```sh
  <§6.4 env block; push lines only with --push, using HARNESS_GH_DIR=/run/harness/gh>
  exec env HARNESS_CONTAINER=1 HARNESS_UNATTENDED=1 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 \
    srt --settings /etc/harness/srt$P.json claude "$@" \
      --allowedTools "Bash Read Edit Write Glob Grep" --settings "$(cat /etc/harness/claude$P.json)"
  ```
  - It no longer sets `HARNESS_SANDBOX=1`, because Claude Code's sandbox is off. `sandbox-required` relies on the container verdict instead (§7.5).
  - The build copies the settings from `.devcontainer/harness/` to `/etc/harness/`, root-owned.
- **`srt.json`** (keys checked against the srt README):
  - `network.allowedDomains`: the Claude Code hosts for the login (`api.anthropic.com`, plus `claude.ai` and `platform.claude.com` for a subscription; R§6.1, https://code.claude.com/docs/en/network-config), the ecosystem hosts (§8.4) and `isolation.network.allow`.
  - `filesystem.allowWrite`: `/workspace`, `/home/node/.claude`, `/tmp`.
  - `filesystem.denyWrite`, covering harness's files and the paths the mandatory denies miss:
    - under `/workspace`: `denyWritePaths()`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks`, `.claude/skills` and `.devcontainer`;
    - under `/home/node/.claude` (I5 of the review: a run can't plant user-level config for later runs): `settings.json`, `settings.local.json`, `hooks`, `plugins`, `skills`, `agents`, `commands` and `CLAUDE.md`.
  - `filesystem.denyRead`: `/run/harness/gh`. A run without `--push` can't read the token.
  - `credentials`: the §8.3 lists, in `srt`'s own `credentials` key, minus Claude Code's own login (§8.3).
  - **Mandatory denies:** `.git/hooks`, `.git/config`, `.vscode`, `.idea`, shell startup files, `.gitconfig`, `.mcp.json`, `.claude/commands` and `.claude/agents` (srt README "Mandatory Deny Paths"). On Linux, a mandatory-deny path that doesn't exist yet is blocked too.
  - **Unix sockets** are blocked (the default), which also cuts VS Code's IPC and any forwarded SSH agent.
  - No `allowNestedUserNamespaces`, no `allowAllUnixSockets`, and `enableWeakerNestedSandbox` only if L4 shows Docker needs it (§16 Q1).
- **`srt-push.json`:** the same, plus `github.com` and `api.github.com`, and without the `/run/harness/gh` deny.
- **`claude.json` and `claude-push.json`:** the launch JSON with `sandbox.enabled: false` (I14), the read block (I3), the credential lists, and `permissions` for the tool set.
- **Linux deny lists** are built at launch (srt README). A path created mid-run is covered from the next launch. Pinned by a test, with the argument form.
- **User settings check.** Doctor inside the container compares a hash of `/home/node/.claude/settings.json` with the one recorded at image build, and gives a fix on a mismatch.

### 7.4 The allowlist, and GitHub for push runs only (I7)

- **One source,** `.harness/config.yaml`: `isolation.network.ecosystems` and `isolation.network.allow` (§10.1). Separate renderers produce the repo's `sandbox.network.allowedDomains` (§8.4), the `srt` files and the container's `--settings`.
- **GitHub only in the `-push` files.** Clone and fetch happen on the host, through the bind mount.
- **Refused by config validation:** a host in `isolation.network.allow` that matches `github.com`, `*.github.com`, `*.githubusercontent.com` or `*`, or any pattern that would match `example.com` (such as `*.com`), with the §11.2 message.
- **Changes need a rebuild.** Changing the allowlist means update, then an image rebuild. Doctor inside the container compares `/etc/harness/srt.json` with the rendered file and flags a stale image.

### 7.5 Proving an unattended run is in the container

`sandbox-required` gains a `container` verdict, computed when `isolation.container` is `available` or `required`. All of these must hold (R§3.4, R§11 B3):

1. **Launcher claim.** `HARNESS_CONTAINER=1` comes from the launcher. One set by a settings file's `env` is ignored, as for `HARNESS_SANDBOX`.
2. **Not root.** `process.getuid() !== 0`.
3. **Marker.** `/etc/harness/container` is a regular file owned by uid 0, not writable by the current uid (`access(W_OK)` fails), and parses with the expected keys.
4. **Egress probe.** At SessionStart (`session-setup`), an HTTPS HEAD to `https://example.com` with a 3-second timeout must fail, and the result is cached in session state.
   - Hooks run inside `srt` here, so the probe tests `srt`'s fence.
   - Config validation keeps `example.com` out of every allowlist.

**Outcomes.**
- **Proved:** unattended shell calls are allowed without Claude Code's sandbox (I14). The Stop runner's fence probe sees `srt` and doesn't wrap again (§4.2).
- **`required` and not proved:** a deny naming the failed signal (§11.2).
- **`available` and not proved:** the run falls through to the existing sandbox checks.

These signals resist a non-root agent, which can't create root-owned files or lift `srt`'s network fence. They don't resist the person who launches the run, as with `HARNESS_SANDBOX=1`.

### 7.6 Bind-mount risks (I5)

Everything the agent writes in `/workspace` appears on the host and may run there later (R§0.6).

| Vector | Covered by |
|---|---|
| `.git/hooks`, `.git/config`, `.vscode`, `.idea`, shell startup files, `.gitconfig`, `.mcp.json`, `.claude/commands`, `.claude/agents` | `srt`'s mandatory denies |
| `.harness/`, `.claude/settings*.json`, `.claude/hooks`, `.claude/skills`, `.devcontainer/`, CODEOWNERS | `srt` `denyWrite`, protect |
| `package.json` scripts, `Makefile`, `.husky/`, `.envrc` (direnv runs it on `cd`), test config, `conftest.py`, `node_modules/.bin` | **Not covered.** They run on the host when the person runs them. On a Linux host, that code can also read the App key (§2.4) |
| `.github/workflows` | The App can't push them (§6.1) |

Mitigations:
- `harness status` on the host lists changes, since the session began, to `.envrc`, `.husky/**`, `package.json`, `Makefile`, `.github/**`, `.git/hooks/**` and `.vscode/**`. This extends today's "Harness files last changed during a session" line.
- The docs say: review the diff before running anything from a container run on the host.
- Cloning into a volume would remove the vector, but it was declined in I5.

### 7.7 I6 and I14 risks, stated plainly

1. **One fence.** `srt` is a research preview, and with I14 it is the only fence in the container. A bug in it leaves the agent's tree with the container's open network and write access to the bind mount. The research's design (R§11 B2) had iptables and the inner sandbox as two more fences.
2. **It fences only its own process tree.** VS Code's server, extensions, lifecycle commands and `devcontainer exec` shells not started through `harness-run` have open egress.
3. **Docker may force the weaker mode.** `srt`'s bubblewrap needs user namespaces. Docker's default seccomp or AppArmor profile may refuse them, which can force `enableWeakerNestedSandbox`, which "considerably weakens security" (srt README). L4 decides (§16 Q1).
4. **Hostname filtering only,** with the same domain-fronting limit as before.
5. **Claude Code's login is in the volume.** Hooks and MCP servers can read it, and `api.anthropic.com` is always allowed (R§3.2).
6. **I3 inside the container.** With Claude Code's sandbox off, the read block makes recognized file-reading commands outside the working directories, and any command the parser can't trace, prompt even in `bypassPermissions`. In `-p` they are denied (the review, citing the permission-modes doc). A repo's `true` can't be lifted for the container alone. L4 measures the denial rate (§16 Q2).

## 8. Layer C: attended sessions

### 8.1 The read block, in every mode (I3, I15)

- Init, update and sync write `permissions.blockReadsOutsideWorkingDirectories: true` into `.claude/settings.json` in every `sandbox` mode, recorded as a set block (R§0.3, R§2.2, https://code.claude.com/docs/en/settings-reference).
- **What it does.**
  - Read, Grep, Glob and LSP refuse paths outside the working directories.
  - With the sandbox on, sandboxed commands lose `/Users`, `/home`, `/root`, `/Volumes`, `/mnt`, `/media`, `/run/media` and `/srv`. The working directories, the session temp folder, the needed parts of `~/.claude` and the global git config are re-opened, while `~/.git-credentials` stays blocked.
  - With the sandbox **off**, recognized file-reading Bash commands outside the working directories, and commands the parser can't trace, prompt in every mode, and are denied in `-p` (§8.6).
- Requires v2.1.257; `MIN_CLAUDE_CODE` is 2.1.295.
- A `true` in any settings file applies, and no user setting can lift it.
- **The off switch (I15): `isolation.block_reads: false`, person-only.**
  - It lives in `.harness/config.yaml`, which is protected by protect, `denyWrite`, ConfigChange and CODEOWNERS on `/.harness/`. In sessions with the sandbox off, only the guard's text checks protect it, as for every config key.
  - Update asks for an interactive yes before removing the read block. `--yes` alone doesn't remove it, and an unattended update keeps it.
  - While it is off, a SessionStart note in every session says `Reads outside the repo are NOT blocked (isolation.block_reads: false)`. Doctor gives a fix line, and status shows it in capitals.

### 8.2 What breaks, and the fixes

| Breaks | Why | Fix, in the person's `~/.claude/settings.json` |
|---|---|---|
| Toolchains in `~/.nvm`, `~/.volta`, `~/.fnm`, `~/.pyenv`, `~/.rbenv`, `~/.asdf`, `~/.local/share/mise`, `~/.cargo`, `~/.rustup`, `~/.bun`, `~/.deno`, `~/.local/bin`, `/home/linuxbrew` (sandbox on) | The binary can't be read | Fix A, else Fix B |
| Caches: `~/.npm`, `~/.cache/pip`, pnpm's store, `~/go/pkg/mod`, `~/.m2/repository`, `~/.gradle/caches`, Playwright browsers (sandbox on) | Installs refetch or fail; Playwright finds no browsers | The same, or move the cache into the repo |
| git over SSH | `~/.ssh` is blocked and denied; it already fails on macOS (R§2.4); `SSH_AUTH_SOCK` is denied | HTTPS with the App helper (§6.4) |
| `gh` with a plaintext `hosts.yml` | `~/.config/gh` is blocked and denied | The App's `GH_CONFIG_DIR`. Otherwise `isolation.credentials.allow: ["~/.config/gh"]`, then Fix A, which exposes the owner's token |
| `gh` with keyring storage | It reads `~/.config/gh/hosts.yml` for the user name | The same `allow` entry, then Fix A for `~/.config/gh/hosts.yml`, which holds no token under keyring storage |
| Private registries through `~/.npmrc`, `~/.pypirc` or `~/.netrc` | Blocked and denied | `isolation.credentials.allow`, then Fix A; this exposes the token |
| The Read tool on other folders, for example a linked worktree reading its main checkout's local notes | The file-tool block | `permissions.additionalDirectories` for that folder. Doctor suggests it when the repo is a linked worktree |
| Bash with the sandbox off: `cat ~/x`, subshells, several `cd`s | Prompts in every mode; denied in `-p` (§8.6) | Answer the prompt, turn on `sandbox: always`, or Fix B |

- **Fix A (read-only):** `"sandbox": {"filesystem": {"allowRead": ["~/.nvm"]}}`. Repository `allowRead` entries stop counting under the block (R§2.2), which implies user-level ones still count. L1 confirms.
- **Fix B (documented fallback):** `"permissions": {"additionalDirectories": ["~/.nvm"]}`. It makes the folder a working directory, so writes are allowed too.
- **Doctor finds the breakage** without probing the sandbox. It resolves `node`, `python3`, `ruby`, `cargo`, `go`, `java`, `bun`, `deno` and the Stop steps' commands on PATH, checks the known cache folders, and prints the exact Fix A line for each one under a blocked root.
- **Ordering.** The SSH and `gh` fixes depend on the broker (P11 and P12), so the read block ships after them (§13).

### 8.3 Credential and environment denies

The read block doesn't apply under `filesystem.disabled` or `allowManagedReadPathsOnly`, when the start path contains a glob character, or outside its roots (R§4). So init, update and sync also write `sandbox.credentials` deny entries in every mode, one block per entry. Deny entries can't be removed by another scope (R§2.2, https://code.claude.com/docs/en/sandboxing). The same lists go into the Stop gate's `srt` settings (§4.3), the container's `srt` files, and the launch JSON's documented list.

**`files`** (each `mode: "deny"`; Linux-safe, with no leading `/**`):
```
~/.ssh  ~/.aws  ~/.config/gcloud  ~/.azure  ~/.kube  ~/.docker/config.json
~/.npmrc  ~/.yarnrc.yml  ~/.bunfig.toml  ~/.config/pnpm  ~/Library/Preferences/pnpm
~/.pypirc  ~/.config/pip  ~/.config/pypoetry  ~/Library/Application Support/pypoetry  ~/.local/share/uv/credentials
~/.config/gh  ~/.config/hub  ~/.git-credentials  ~/.config/git/credentials  ~/.gcm/store  ~/.password-store  ~/.netrc
~/Library/Keychains  ~/.local/share/keyrings  ~/.local/share/kwalletd
~/.cargo/credentials.toml  ~/.gem/credentials  ~/.m2/settings.xml  ~/.gradle/gradle.properties
~/.terraformrc  ~/.terraform.d/credentials.tfrc.json  ~/.vault-token  ~/.config/op  ~/.config/anthropic
~/.claude/.credentials.json
/mnt/c/Users            (WSL2's C: drive; a missing path has no effect elsewhere)
```

**`envVars`** (each `mode: "deny"`):
```
NPM_TOKEN NODE_AUTH_TOKEN YARN_NPM_AUTH_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
GOOGLE_APPLICATION_CREDENTIALS AZURE_CLIENT_SECRET ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
GITHUB_TOKEN GH_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN CARGO_REGISTRY_TOKEN GEM_HOST_API_KEY
VAULT_TOKEN TF_TOKEN_app_terraform_io HARNESS_APP_KEY
SSH_AUTH_SOCK GIT_ASKPASS SSH_ASKPASS VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_EXTRA_ARGS
VSCODE_GIT_IPC_HANDLE REMOTE_CONTAINERS_IPC REMOTE_CONTAINERS_SOCKETS
```

The VS Code names are pinned in L4. Denying them in attended sessions means the agent can't push with the owner's VS Code session. Without the App launch, git still uses the owner's own configured helpers (for example osxkeychain).

**Claude Code's own login is exempt inside the container.** There `srt` fences Claude Code itself, so the container's `srt` lists leave out `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `~/.claude/.credentials.json`, or Claude Code couldn't sign in. The scrub still strips those variables from Bash, hooks and MCP servers (https://code.claude.com/docs/en/env-vars), and the residual is §7.7 point 5. The Stop gate's `srt` lists keep them, because steps never need them.

**Removal (review I10).** Only `isolation.credentials.allow` removes an entry. Update restores any other deletion, with a note naming it, and doctor reports a missing entry as a fix. Harness can't tell who deleted an entry.

**What the list can't cover** (R§4):
- keychain and keyring IPC;
- WSL interop;
- the Read tool (the read block covers it);
- on Linux, a listed file that appears after the run starts.

### 8.4 Network allowlist per ecosystem

`isolation.network.ecosystems: auto` uses the ecosystems init's scan finds from lockfiles and manifests, or the person lists them. Hosts come from R§6.2 (https://docs.github.com/en/copilot/reference/copilot-allowlist-reference):

| Ecosystem | Hosts |
|---|---|
| `npm` | `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com`, `nodejs.org` |
| `python` | `pypi.org`, `files.pythonhosted.org` |
| `rust` | `index.crates.io`, `static.crates.io`, `static.rust-lang.org` |
| `go` | `proxy.golang.org`, `sum.golang.org` |
| `ruby` | `rubygems.org`, `index.rubygems.org` |
| `java` | `repo.maven.apache.org`, `repo1.maven.org`, `services.gradle.org`, `plugins.gradle.org` |
| `containers` | `ghcr.io`, `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` |

- **Where.** Written to `sandbox.network.allowedDomains` in `.claude/settings.json`, one block per host, plus `isolation.network.allow`. GitHub hosts are never written (I7). `NETWORK_NOTE` changes to name the hosts.
- **Unattended launches.** Under an admin-required launch, the repo list is ignored (R§0.4). `harness doctor --launch-hosts` prints the same list as JSON for the launch JSON's `allowedDomains`. It prints only; no command assembles the launch line.
- **Stop steps.** The ecosystem hosts don't go to Stop steps, which have no network unless `stop.allowed_domains` says so (I12).

### 8.5 Doctor credential report

A new doctor section, "Credentials the agent could reach". It never opens or reads a credential file and never prints a value.

- **Files.** `lstat` only, for each §8.3 path: present or absent. For present ones, the cover: `read block`, `credentials deny`, `both` or `none`, computed from the effective settings layers.
- **Variables.** Names only, matching `/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ASKPASS|_SOCK)/i` or the §8.3 list, from doctor's own environment. It says the session's environment can't be seen.
- **IPC routes.**
  - `gh auth status` storage, `keyring` or `file`, never `--show-token`.
  - `SSH_AUTH_SOCK` set.
  - VS Code askpass variables set.
  - Linux: whether Claude Code's seccomp filter is present. Without it, Unix sockets, D-Bus included, are open to sandboxed Bash (review I7). It is a fix when `github.app.id` is set.
  - macOS: keychain reachability, stated from L2's result.
  - WSL2: `/mnt/c` with interop on.
- **The App key** (§2.4). One line: where it is stored, whether I13 holds on this host, and the key's age.
- **Each line** names what denying it breaks (§8.2, R§4). It ends with `n present, n covered, n not covered`.

### 8.6 I3 risks, stated plainly

The research recommended `sandbox: always` only, after a live check (R§12 Q2). The owner chose every mode. The costs:

1. **Toolchains on macOS.** `sandbox: always` is the default there, so every nvm, volta, pyenv, rustup or Linuxbrew user loses their toolchain in the sandbox until Fix A or B. Stop steps are unaffected, because they run in `srt` without the home block (§4.3).
2. **Without the sandbox, Bash prompts and `-p` denies.** Recognized file-reading commands outside the working directories, and any command the parser can't trace, prompt even in `bypassPermissions` and are denied in `-p`. That hits:
   - every attended session under the default `sandbox: unattended`;
   - native Windows;
   - I11's `sandbox: off` escape;
   - the container under I14 (§7.7 point 6).

   The review called revision 1's "the breakage is small" wrong, and it was. L1, L4 and L8 measure the denial rate.
3. **It binds every teammate.** A teammate who can't use Fix A ends up with Fix B, which also grants writes.
4. **Windows roots** for the file-tool block are undocumented (L8).
5. **It is new** (v2.1.257), and its re-open list may change.

The gate: P14 ships only after L1 passes on macOS and Linux, after the broker PRs, with L1's findings written into §8.2 and the docs in the same PR.

## 9. Native Windows (I0, I11)

- **The change.** `sandboxVerdict` on `win32` turns from `unavailable` (log and allow) into `deny` for unattended shell calls (Bash, PowerShell, Monitor), unless `sandbox: off`. `HARNESS_SANDBOX=1` doesn't lift it, and neither does `HARNESS_CONTAINER=1`.
- **WSL2 and the container are structural exceptions,** not claims. They rest on `process.platform` of the hook process, which is `linux` in both. Only a hook command a person edits (for example `wsl.exe node …`) could fake that, and that person is out of scope.
- **`sandbox: off` is the logged escape.** `sandboxRequired.run` returns before any logging for `off` today, so a new branch logs `sandbox-off-unattended` once per session on `win32` before allowing. `harness stats` counts it, and doctor shows a note.
- **Attended native Windows** sessions are unchanged. The Stop gate runs unwrapped with a doctor warning (§4.5).
- **Doctor on `win32`:** fix `unattended shell commands are denied on native Windows (no Claude Code sandbox)` → `run Claude Code in WSL2, or in the harness dev container (/harness:init --container); or set sandbox: off in .harness/config.yaml to keep the text checks only (logged)`.
- **Release:**
  - P1 ships in 0.3.0 (its first beta), under "Breaking" in `docs/release-notes/unreleased.md`, and isn't held for the rest of the spec.
  - The README's "native Windows keeps the text checks" sentences change in the same PR.
  - `srt`'s Windows alpha is noted as prior art only.

## 10. Config, commands, init, doctor, status, guard

### 10.1 Config keys (`.harness/config.yaml`)

| Key | Default | What it does |
|---|---|---|
| `stop.allowed_domains` | `[]` | Hosts Stop steps (and verify's command runs) may reach inside `srt`. Empty means no network (I12). GitHub hosts and wildcards matching `example.com` are refused. |
| `stop.allow_write` | `[]` | Extra writable paths for Stop steps inside `srt`, such as a tool cache outside the repo. It can't name a protected path. |
| `isolation.block_reads` | `true` | Writes the read block in every mode (I3). `false` is person-only: update asks interactively before removing it, and SessionStart, doctor and status show it loudly (I15). |
| `isolation.credentials.allow` | `[]` | §8.3 entries harness leaves off its deny lists. Each must be a §8.3 entry. |
| `isolation.network.ecosystems` | `"auto"` | `auto`, or a list from `npm`, `python`, `rust`, `go`, `ruby`, `java`, `containers`. |
| `isolation.network.allow` | `[]` | Extra hosts for the repo allowlist and the container. GitHub hosts, `*`, and anything matching `example.com` are refused. |
| `isolation.container` | `"off"` | `off`, `available` (files written; verdict shown and accepted), or `required` (unattended shell needs the verdict). `--container` sets `required`. |
| `github.app.id` | `0` | This repo's agent App id. `0` means none. Not a secret. |
| `github.app.slug` | `""` | From the manifest conversion. |
| `github.app.key_stored_at` | `""` | ISO date the key was stored, for doctor's key age. |
| `github.agent_prefix` | `"agent/"` | Branch prefix the App may create and update under (`harness-refs`). It must match `^[a-z0-9-]+/$`. |
| `github.protect.owner_bypass` | `"auto"` | `auto` (on for user-owned repos), `on` or `off`: the owner's `pull_request` bypass on the `harness` ruleset (C4). |
| `project.codeowners` | `[]` | Changed: the owners written to the CODEOWNERS block (§5.4). Was input only. |

The generated table in `docs/reference.md` picks these up from `src/core/config.ts`.

### 10.2 Commands

| Command | Who | What |
|---|---|---|
| `harness github protect [--dry-run] [--yes]` | Person only | §5.1 |
| `harness github app create [--org <org>]` | Person only | §6.1 |
| `harness github app store-key` | Person only | §6.2 (key on stdin) |
| `harness github broker [--repo <o/r>] [--env] [--check]` | Person only | §6.3 |
| `harness github publish --repo --branch --bundle --body --key-stdin` | Person, or the CI publish job (never through an agent) | §6.6 |
| `harness doctor --launch-hosts` | Anyone (print only) | §8.4 |
| `/harness:init --container` | Through the skill | §7.1 |
| `harness-run [--push] -- <claude args>` | Person, inside the container | §7.3 |

### 10.3 Init and update

- **Interview:** confirm `project.codeowners`. With `--container`, confirm the container and push runs.
- **`mergeSettings`** adds the read block, the credential and env denies, and the ecosystem hosts, each as recorded blocks. Update restores deleted credential entries (§8.3), and asks before honouring `isolation.block_reads: false` (§8.1).
- **Files:** the CODEOWNERS block, and `.devcontainer/harness/` unless the container is `off`.
- **Protected paths:** protect's table and `denyWrite` gain `.devcontainer/` and the CODEOWNERS file.
- **Unwritable values:** `isolation.container: required` is accepted only once P16's verdict exists, which the rollout order guarantees (§13).

### 10.4 Doctor and status

**Doctor gains these sections:**
- Stop sandbox: `srt` found, outside writable roots, at least the pin; preflight result; the Linux and macOS dependencies; Windows warning.
- Server side (§5.5), with the identity used.
- Agent identity:
  - the App configured;
  - the installation check result;
  - `meta.json`: a broker counts as running when `heartbeat_at` is under 2 minutes old; it is failing when `last_error` is set, and stopped otherwise;
  - token expiry.
- Read block, the off switch, and the toolchain fix lines (§8.1, §8.2).
- Credentials and the App key (§8.5).
- Container: on the host, whether the files are present and the image is current; inside, the four signals, the user settings hash and the `srt.json` comparison.
- Native Windows (§9).
- CI workflows (§6.6) and release triggers (§5.3).

**Status gains:**
```
Stop sandbox: srt <ver>                                  (or: UNAVAILABLE - stop gate blocks | off - logged)
Server side: rulesets ok
Agent identity: <slug>[bot], token fresh until 14:05 UTC (or: no App | broker failing: <last_error> | broker stopped)
App key: reachable only with a prompt                    (or: REACHABLE BY UNSANDBOXED CODE on this host)
Reads outside the repo: blocked                          (or: NOT BLOCKED - isolation.block_reads is false)
Container: required; this session: proved                (or: available | off; not proved: <signal>)
```

### 10.5 Guard, protect and `sandbox-required`

- **`PERSON_ONLY.github`:** `kind: 'deny'` for every subcommand, `publish` included. The publish job runs harness directly, never through an agent, so no exception is needed. It uses the same token walk as `tdd off`, so `harness.cmd`, `npx` and wrapper spellings are covered.
- **New guard checks, in every mode.** Helper overrides ask in attended sessions instead of denying.
  - keychain and keyring reads: `security find-generic-password`, `find-internet-password`, `dump-keychain`, `export`, `-i`, and `secret-tool lookup|search`;
  - requests to `/app/installations/*/access_tokens` and `/app-manifests/` through `gh api`, `curl`, `wget`, or a fetch in an inline script;
  - credential-route overrides:
    - `git -c credential.*`, `-c core.askPass`, `-c core.sshCommand`;
    - `git config credential.*`;
    - `GIT_CONFIG_*`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GH_CONFIG_DIR`, `GIT_SSH_COMMAND` or `SSH_AUTH_SOCK` set inline;
    - running `$GIT_ASKPASS` or `$VSCODE_GIT_ASKPASS_*` directly;
  - writes to the token base, matched after resolving relative paths and symlinks (`realpath` of the target's parent). The spellings `/private/var/folders/…` and `$XDG_RUNTIME_DIR/…` are both covered.
- **Protect:** `.devcontainer/**`, the CODEOWNERS paths, and the token base.
- **`sandbox-required`**, in this order:
  1. `off`: allow, logging on `win32`.
  2. Attended: allow.
  3. `win32`: deny.
  4. The container verdict, when `isolation.container` isn't `off`: proved allows; `required` and not proved denies.
  5. `HARNESS_SANDBOX=1`, or the settings confirmed (with the launch fix's strict rule): allow. On Linux, when `github.app.id` is set, Claude Code's seccomp filter must also be present (review I7).
  6. Otherwise: deny.

## 11. Failure modes

### 11.1 Rules

- **Fail fast and closed.** Protect, `app create`, `store-key`, the broker, publish and the Stop wrap exit 1, or block, on any API error, wrong permissions, unexpected JSON, an unsafe folder, a missing key or a missing `srt`, and they print the cause. Each ruleset write is one PUT or POST.
- **Never suppress errors.** A `gh`, API or `srt` failure shows its first line, cleaned. Doctor shows "unknown" with the reason, never "ok".
- **Verdicts deny on doubt.** A probe that didn't run, an unreadable marker, missing session state, or a failed preflight denies or blocks.
- **Nothing falls back** to the owner's credentials, unsandboxed steps, the inner sandbox, or an unfenced network. The only exception is the person's logged `sandbox: off`.

### 11.2 Messages

| When | Message |
|---|---|
| Stop wrap unavailable | §4.4 |
| Unattended Stop on native Windows | §4.5 |
| Unattended shell on native Windows | `Unattended shell commands are denied on native Windows: Claude Code has no sandbox there. Run Claude Code in WSL2 or in the harness dev container (/harness:init --container), or set sandbox: off in .harness/config.yaml to keep the text checks only (logged).` |
| Container required, not proved | `This repo requires unattended runs in the harness dev container (isolation.container: required), and this run is not proved to be in one: <signal>. Start it with harness-run inside the dev container, or ask the person to set isolation.container: available.` |
| Linux unattended, App set, no seccomp filter | `Unattended run on Linux without Claude Code's seccomp filter: sandboxed commands can reach Unix sockets, including Secret Service, which holds this repo's App key. Install the filter (harness doctor shows how), or run in the harness dev container.` |
| Agent runs `harness github …` | `Only a person can run harness github <sub>: it changes GitHub settings or handles the App key. Ask them to run it in their own terminal.` |
| Keychain or keyring read | `Reading the OS keychain or Secret Service is denied: they hold your credentials and the App key. Pushes use the token the broker provides.` |
| Token mint request | `Minting GitHub App tokens is denied to the agent: only harness github broker, outside the session, mints them.` |
| Credential-route override | `Changing git's or gh's credentials, askpass or SSH command is denied: pushes must use the harness App token.` |
| `git-credential`, missing | `harness: no GitHub App token for <o/r>. The person must run harness github broker outside the agent; pushes fail until then.` |
| `git-credential`, expired | `harness: the GitHub App token for <o/r> expired at HH:MM UTC. The broker is not refreshing it (see harness doctor); pushes fail until it does.` |
| `git-credential`, nearly expired | `harness: the GitHub App token for <o/r> expires at HH:MM UTC (under 5 minutes left), so it is not used. The broker refreshes it within a minute if it is running; push again then.` |
| Broker, wrong installation | `The GitHub App <slug> has <list> (<selection>, <n> repos) on <o/r>; harness needs exactly Contents write, Pull requests write and Metadata read, installed on this repo only. Fix the App's permissions or installation on GitHub, then start the broker again.` |
| Broker, App not installed or suspended | `The GitHub App <slug> is <not installed on | suspended for> <o/r>. Install or unsuspend it at https://github.com/apps/<slug>, then start the broker again.` |
| Broker, JWT rejected | `GitHub rejected the App's signed request (<status>: <first line>). If the message mentions the time, fix this machine's clock; otherwise check github.app.id and the stored key.` |
| Broker, lock held | `Another broker (pid <n>) already serves <o/r>. Stop it first, or use the one that is running.` |
| Broker, unsafe folder | `<path> is not safe for tokens (<owned by uid N | mode 0755 | a symlink | missing XDG_RUNTIME_DIR>). Fix or remove it, then start the broker again.` |
| Broker, no key | `No key for the GitHub App <id> in <the keychain | Secret Service>. Run harness github app create, or harness github app store-key with the key on stdin.` |
| Broker or `store-key`, plain key file on Linux | `Harness doesn't keep the App key in a file: any process of your uid could read it. Use Secret Service (secret-tool), the dev container or CI.` |
| Keychain write failed | `Could not store the App key in the <keychain | Secret Service> (<first line>). Nothing was stored; the key from GitHub is lost, so generate a new one on the App's page and run harness github app store-key.` |
| `app create`, timeout or wrong `state` | `The GitHub App setup <timed out after 10 minutes | returned an unexpected state value>. Nothing was stored. Run harness github app create again; delete any half-made App at https://github.com/settings/apps.` |
| Protect, private repo without Pro | `Rulesets need GitHub Pro, Team or Enterprise on private repos. Nothing was changed. Harness's local layers stay on; harness doctor lists them.` |
| Protect, no admin role | `Your gh login can't change rulesets on <o/r> (<HTTP status>: <first line>). It needs the admin role. Nothing was changed.` |
| Protect, no verify run yet | `No harness-verify check run on <branch> yet, so the required check can't be pinned to its app. Run the workflow once (open any PR), then run harness github protect again.` |
| Protect, no CODEOWNERS | `<branch> has no CODEOWNERS file, so code-owner review requires nobody. Merge the harness CODEOWNERS block first (harness doctor shows it), or answer yes to continue without it.` |
| Config, GitHub or probe host in an allowlist | `<key> can't list <host>: GitHub is reachable only in runs that push (harness-run --push), and example.com must stay unreachable for the container check.` |

## 12. Testing

### 12.1 Unit (no network, no `claude`)

- **Stop wrap:**
  - `srt` settings render, with every key name from the README;
  - `allowRead` never written;
  - the protected-path union;
  - the argument form;
  - the preflight;
  - each §4.4 row (missing, inside the repo, old, failing preflight, step failure, `off` logged);
  - Windows attended and unattended;
  - the fence probe: EPERM and EROFS run unwrapped inside the fence, while EACCES and a successful write still wrap.
- **Rulesets:**
  - both builders, with owner bypass `auto`, `on` and `off` for user and org owners;
  - the required-check rule with and without the item;
  - normalised compare;
  - workflow permissions;
  - protect against a stub `gh` (POST, PUT, no-op, drift, `--dry-run`, 403 private, 403 without admin, no check run, no CODEOWNERS, malformed answers), writing nothing on errors.
- **CODEOWNERS:** create and merge in each of the three places; owner validation; the block moved back to last; uninstall.
- **Doctor read-back:** every §5.5 row, and the identity line.
- **App create:** state check, timeout, `slug` from the conversion, secrets discarded, `code` never echoed.
- **Key storage:**
  - the `security -i` command built with no PEM in argv (asserted on the spawned argv) and `-T ""`;
  - `secret-tool` on stdin;
  - the Linux plain-file refusal;
  - `store-key`.
- **JWT:** sign and verify against a test key; `iat` skew.
- **Broker,** with a fake clock and a stub API:
  - the `lstat` chain for each component (owner, mode, symlink, missing `XDG_RUNTIME_DIR`);
  - `O_EXCL|O_NOFOLLOW` writes;
  - the folder never removed;
  - the lock;
  - mint, refresh at T-15 minutes, catch-up after sleep;
  - revoke after a swap, backoff, deletion at expiry;
  - SIGINT, SIGTERM and SIGHUP;
  - the installation check (extra permission, `all`, two repos, suspended, 404);
  - the `git-credential` hash re-check;
  - `heartbeat_at` and `last_error`;
  - `--env` printing no secret.
- **`git-credential` run by `sh`:** fresh, nearly expired, expired, missing, a non-`get` action.
- **Publish:** bundle fetch into an empty repo, prefix check, no hooks run (a planted hook file in the bundle has no effect), revoke.
- **Guard:**
  - `PERSON_ONLY.github` in every `tdd off` spelling;
  - each §10.5 check, including `realpath` spellings of the token base;
  - the attended ask for overrides.
- **`sandbox-required`:** every step of the §10.5 order, each container signal failing, the probe missing from state, a settings-env `HARNESS_CONTAINER` ignored, and the Linux seccomp requirement.
- **`mergeSettings`:**
  - the read block, the credential and env entries, and the ecosystem hosts, each added and recorded;
  - the `block_reads` removal asking;
  - `credentials.allow`;
  - a hand-deleted entry restored with a note;
  - uninstall.
- **Doctor credential report:** a filesystem spy proves only `lstat` is called; the cover is computed from the layers.
- **Container render:**
  - the pins, with Claude Code at least `MIN_CLAUDE_CODE`;
  - no capabilities, sudo or credential mounts;
  - VS Code bridge settings present;
  - `CLAUDE_CONFIG_DIR` and `HARNESS_CLAUDE_CONFIG_DIR` set;
  - `srt` `denyWrite` covering the workspace and user-config paths;
  - the push variant differs by exactly the two GitHub hosts and the token-folder deny;
  - inner `sandbox.enabled: false`;
  - config validation refusing GitHub hosts and wildcards matching `example.com`.

### 12.2 End to end

Temp repos with a stub `gh` and a stub GitHub API on a local port (a test-only base URL that the production build ignores):
- protect twice, the second a no-op;
- `app create` through the callback;
- the broker feeding a real `git push` to a local bare remote through the helper, with a global helper configured that must not be asked;
- publish from a bundle;
- the Stop gate wrapped by a real `srt` on Linux and macOS CI runners, with a test that writes `.harness/config.yaml` and reads a fake `~/.aws/credentials`, both failing;
- init and update with `--container`, then uninstall;
- the Windows deny on `windows-latest`.

### 12.3 CI matrix

- **Existing:** `test` on `macos-latest` and `windows-latest` (Node 22), and the single-run jobs on `ubuntu-latest`. All new unit and e2e tests run on all three.
  - `ubuntu-latest` and `macos-latest` install `srt` at the pin for the Stop-wrap e2e. `ubuntu-latest` runs the `sysctl` step.
  - Windows covers the `win32` deny, unwrapped attended Stop, `harness.cmd` spellings, and paths in the credential report.
- **New job `container-smoke` on `ubuntu-latest`, without `claude` or paid calls.** It builds the image from the e2e fixture, then checks inside it:
  - `srt` starts;
  - `example.com` is refused and `registry.npmjs.org` allowed;
  - the marker passes;
  - writes to `/workspace/.devcontainer`, `/workspace/.git/hooks` and `/home/node/.claude/settings.json` fail;
  - the non-push variant can't read `/run/harness/gh`;
  - `git credential fill` for github.com returns nothing.

  It is a **non-required** job that stays red when it fails. It is never skipped and never marked green (review Minor 16). That needs an owner ruling (§16 Q3).

### 12.4 Live batches (owner's subscription)

They run from the Terminal panel, with scripts in `harness-wt/live`. Each batch needs a yes and records the Claude Code and `srt` versions.

| Batch | Where | Checks | Gates |
|---|---|---|---|
| LS Stop in `srt` | macOS; Linux (Ubuntu 24.04 with and without the `sysctl`) | A real Stop gate in an attended session; a planted test that tries to write `.harness/config.yaml`, read `~/.aws`, reach `example.com`, connect to `$SSH_AUTH_SOCK` and D-Bus, and run `security find-generic-password -s harness-probe` (a dummy item), each failing; a local test server still works; the agent's `harness verify` from sandboxed Bash on macOS and Linux runs unwrapped through the fence probe; a `chmod -w .harness/state` doesn't skip the wrap; the overhead is measured; `srt` missing gives the §4.4 message | PS |
| L1 read block | macOS; Linux; WSL2 if available | With the block and the sandbox on: nvm or volta `node -v`, pyenv, `cargo`, `~/.local/bin`, `npm ci` and `pnpm install` from cache, Playwright, `gh auth status` (keyring and file), an HTTPS push with the App helper, an SSH push, the Read tool on a home file, then Fix A and Fix B, recording which lifts each. **With the sandbox off:** the prompt rate in an attended session, and the denial rate of a scripted `-p` task (review I6) | P14 |
| L2 credentials and keys | macOS; Linux | The full §8.3 lists are accepted without warnings; each present path fails `cat` in Bash; the variables are absent; **macOS:** a `-T ""` item prompts for `security` too, and sandboxed Bash can't read it silently; reading the broker's memory from unsandboxed code of the same uid fails without debugger rights; sandboxed Bash can or can't write `DARWIN_USER_TEMP_DIR`; **Linux:** `secret-tool lookup` from sandboxed Bash with and without the seccomp filter (review I7) | P3, P10, P11 |
| L3 broker on the host | macOS | `app create` for one repo on a scratch public repo (the person edits the name); the broker mints; an attended agent pushes `agent/x` and opens a PR as `<slug>[bot]`; `GIT_TRACE` shows only the harness helper; VS Code's terminal askpass isn't used; `gh` doesn't migrate the folder; a 2.5-hour run with pushes every 20 minutes crosses about 3 refreshes and old tokens are revoked; SIGHUP from a closed terminal revokes; a second broker is refused; a killed broker gives the §11.2 messages | P11, P12 |
| L4 container and `srt` | Docker Desktop on macOS; Docker on Linux (host uid 1000 and not 1000) | `srt` runs in the unprivileged container, recording whether `enableWeakerNestedSandbox` is needed under Docker's seccomp and AppArmor profiles; a nested `srt` from the Stop gate is not attempted; `.git/hooks`, `.devcontainer` and user settings writes fail; `example.com` is refused; a `--push` run pushes with the App token; a run without push can't reach `github.com` or read the token; the VS Code setting names turn off git config copying and helper forwarding; `git credential fill` returns nothing and `ssh-add -l` fails; the read block's denial rate in `-p` with the sandbox off; `updateRemoteUserUID` and a re-created token folder keep the mount readable; Claude Code starts and finishes a run with the user-config `denyWrite` entries (plugins, settings) in place | P17, P18, §16 Q1, Q2 |
| L5 end to end | Container, unattended `-p` | With the done contract on: the run pushes and opens a PR; before approval the App can't merge (`gh api -X PUT …/merge` is refused) or push a tag, a workflow change, or a branch outside `agent/`; it can't post a `harness-verify` status; after the owner approves, the App *can* merge, which is documented; the owner merges through the bypass | Release |
| L6 protect | Scratch public repo (personal), and one org repo | Apply, re-apply as a no-op, hand-edit then drift then restore; a personal repo accepts the `User` bypass in `pull_request` mode; the owner merges their own PR; `gh pr update-branch` by the App keeps the owner's approval valid; `harness-refs` refuses App tags and non-prefix branches; the org Write-role bypass doesn't cover the App; workflow permissions are set and read back; CODEOWNERS errors and a 404 are shown | P6, P7, P8 |
| L7 CI | Public scratch repo, GitHub-hosted | The agent job runs with the `sysctl` and no key; agent code (Bash, a Stop step and a hook) finds no key or token in env, files or processes; the publish job pushes and opens the PR from the bundle; a hook file planted in the bundle doesn't run; doctor flags a workflow without `persist-credentials: false` | P13 |
| L8 Windows | Native Windows, if the owner has a machine | An unattended PowerShell call is denied with the message; `off` allows and logs; attended Stop runs unwrapped with the doctor warning; the read block's roots and prompt rate | P1 (with no machine: CI only, and a known limit) |

## 13. Rollout

- **Size.** Each PR is cut from `main`, stays within 400 non-test lines and 20 files, and updates the README and release notes in the same PR. Sizes are estimates.
- **Order.** Each PR depends only on earlier rows.
- **Settings never ahead of their enforcement.** The read block lands after the broker that supplies its fixes, and the container verdict lands before the templates that set `required` (review I9).

| # | PR | After | Live gate | Size (est.) |
|---|---|---|---|---|
| P0 | Launch fix (I1, I10, live-finding round 2): prior work | — | — | done |
| PS | Stop steps and verify runs in `srt` (§4), doctor Stop-sandbox lines, perf case, "Breaking" note | Done-contract PR 3 | LS | ~300 |
| — | *The rest of the done contract (its PRs 4 to 7) lands here. Its PR 6 adds `srt` and the `sysctl` to `harness-verify` (§4.6)* | | | |
| P1 | Native Windows deny, the `off` logging branch, doctor fix, "Breaking" note (0.3.0) | Done contract | L8 | ~140 |
| P2 | Guard: `PERSON_ONLY.github` and the §10.5 checks; protect: `.devcontainer/`, CODEOWNERS, token base | P1 | — | ~260 |
| P3 | Credential and env deny lists (§8.3): `mergeSettings`, `credentials.allow`, restore on update; shared with PS's renderer | P2 | L2 | ~240 |
| P4 | Ecosystem allowlist: `isolation.network.*`, renderers, `doctor --launch-hosts`, `NETWORK_NOTE`, validation | P3 | — | ~250 |
| P5 | CODEOWNERS block: init, update, uninstall, kept last | P2 | — | ~180 |
| P6 | Protect core: the `harness` ruleset, owner bypass, idempotent compare, required check | P5 | L6 | ~340 |
| P7 | Protect: `harness-refs` (tags, prefix), Actions workflow permissions, `github.agent_prefix` | P6 | L6 | ~260 |
| P8 | Doctor and status read-back, drift, private without Pro, identity line, release-trigger flags | P7 | L6 | ~300 |
| P9 | `harness github app create`: manifest, callback, per-repo App, config keys | P2 | — | ~280 |
| P10 | Key storage: macOS `security -i` with `-T ""`, Secret Service, plain-file refusal, `store-key`, rotation runbook | P9 | L2 | ~230 |
| P11 | Broker core: token base and `lstat` chain, `O_EXCL` writes, installation check, mint, `git-credential`, `hosts.yml` and `config.yml`, `--env`, the §6.4 launch docs (C6), the Linux seccomp requirement in `sandbox-required` | P10 | L2, L3 | ~380 |
| P12 | Broker lifecycle: refresh, revoke, lock, signals, heartbeat, `last_error`, helper hash, supervisor docs; doctor and status identity lines | P11 | L3 | ~300 |
| P13 | CI: `harness github publish`, the two-job docs, doctor workflow checks | P12 | L7 | ~280 |
| P14 | Read block default, `isolation.block_reads` (I15), toolchain fix lines | P12 | L1 | ~280 |
| P15 | Doctor credential report and the App-key line | P3, P14 | — | ~260 |
| P16 | Container verdict: `isolation.container` (all three values), marker check, SessionStart probe, status line | P2 | — | ~300 |
| P17 | Container templates and renderers: Dockerfile, `devcontainer.json` (C6 settings, I4 paths), `srt` and Claude settings | P4, P11, P16 | L4 | ~350 |
| P18 | `harness-run`, `/harness:init --container`, update and uninstall of the files, user-settings hash, `container-smoke` job | P17 | L4 | ~320 |
| P19 | Known limits and reference wrap-up; L5; release | All | L5 | ~150 |

P11 is the closest to 400 lines. If it grows past, its docs and the `sandbox-required` change move into P12.

## 14. Known limits

- **Server side.**
  - It binds only on GitHub, only where rulesets are available, and only until a repo admin changes them.
  - A private repo without Pro has no binding layer (I8).
  - The owner bypass (C4) lets the owner merge without approval or the check.
  - Push rulesets aren't used (R§5.1).
- **Approval authorizes the App's merge.** Once the owner approves and the check passes, the App can merge.
- **Personal repos.** Per-path required reviewers are unavailable, so code-owner review stands in. CODEOWNERS silently skips owners without write access; doctor reports it.
- **The token reaches the agent** on push runs: one repo, one hour, Contents and Pull requests write, branches under `agent/` only. It can still overwrite or delete its own `agent/` branches and act on any PR.
- **The App key** (§2.4):
  - **Linux host:** readable by any unsandboxed process of the uid unless every agent process is fenced.
  - **macOS:** protected by a prompt the person can wrongly allow.
- **Outside Claude Code's sandbox on the host:** hooks, MCP servers, LSP servers and WebFetch. Stop steps are now in `srt`.
- **Stop steps in `srt`:**
  - Unix sockets are blocked, so testcontainers-style tests fail;
  - the network is off unless configured;
  - on Linux, a credential file created mid-session is covered from the next Stop run;
  - in the container, and when the agent runs verify from sandboxed Bash, steps run inside that fence and its network allowlist, not the Stop settings;
  - the fence probe can be faked by an unsandboxed agent that makes its own read-only mount;
  - attended native Windows runs them unwrapped.
- **`srt`:** a beta, the only fence in the container (I14), fencing only its own process tree, possibly in its weaker mode under Docker, and hostname-only.
- **Bind mount.** Files outside the protected paths reach the host (§7.6).
- **The read block** costs toolchains under home until Fix A or B is added, makes unsandboxed Bash prompt (and `-p` deny), binds every teammate, and its Windows roots are undocumented (§8.6).
- **Credential list.** It is incomplete by nature, and can't cover keychain or keyring IPC.
- **Detection.** The person who launches a run can fake every container signal and `HARNESS_SANDBOX=1`.
- **Native Windows.** Unattended shell is denied; attended sessions keep text checks and run Stop steps unwrapped; no key storage.
- **CI.** The agent can't push mid-run or read PR comments; the publish job pushes once.
- **Container login.** Claude Code's login is in the volume, and `api.anthropic.com` is always reachable.
- **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`** in the container also stops feature-flag fetching.
- **`CLAUDE_CONFIG_DIR` without the mirror.** Anyone who sets `CLAUDE_CONFIG_DIR` without `HARNESS_CLAUDE_CONFIG_DIR` has user-settings protection watching the wrong file (I10 ruling).

## 15. Spec points the owner can overrule

1. Token transport is a file folder under the per-uid base, not a socket or helper process.
2. The broker is a separate long-running process, not a hook.
3. Refresh at 15 minutes before expiry, checked every 60 seconds. The helper refuses a token with under 5 minutes left. The old token is revoked after each swap.
4. Git helpers, askpass and the SSH command are reset through `GIT_CONFIG_*` env, never by writing git config files.
5. `gh` gets the token through `GH_CONFIG_DIR/hosts.yml`, not `GH_TOKEN`.
6. The installation check requires exact permissions, `selected`, and one repo, every mint.
7. The suggested App name is `<login>-<repo>-harness`.
8. CI pushes through a separate publish job from a git bundle. A CI agent can't push mid-run.
9. The required check is added only when the `harness-verify` item is installed; with the item but no run, protect exits 1.
10. Owner bypass `auto` is off for org repos. Org repos get a Write-role bypass on `harness-refs-branches`.
11. CODEOWNERS paths: `/.github/`, `/.harness/`, `/.claude/`, `/.devcontainer/`, `/AGENTS.md`, `/CLAUDE.md` and the CODEOWNERS files, with the block kept last.
12. The container lives in `.devcontainer/harness/`. The `-push` and non-push files are baked into the image, so changing the allowlist needs a rebuild.
13. `isolation.container` has three values; `--container` sets `required`.
14. The probe host is fixed to `example.com`.
15. Stop steps get `allowLocalBinding: true`, no home read block, no network, and blocked Unix sockets. `stop.allowed_domains` and `stop.allow_write` are the escape hatches.
16. `sandbox: off` also runs Stop steps unwrapped (logged).
17. Harness doesn't bundle `srt`; it must be installed globally outside the repo.
18. VS Code's askpass and IPC variables are denied in attended sessions too.
19. Browser profile folders are left off the credential list; the read block covers them.
20. No command assembles the launch line. `--env` and `doctor --launch-hosts` print parts.
21. The draft `--allowedTools` list is `Bash Read Edit Write Glob Grep`, pending the launch fix's round 2.

## 16. Open questions

1. **What if `srt` runs in Docker only with `enableWeakerNestedSandbox` (L4)?** **Recommended:** ship it, show "`srt` in weaker mode" in doctor and status, and add no `SYS_ADMIN` or unconfined seccomp profile.
   - If `srt` can't run at all under Docker's default profiles, a custom seccomp profile that allows only user namespaces is the next step, and needs an owner yes.
2. **The read block inside the container (L4, review I6).** With Claude Code's sandbox off (I14), the block makes unsandboxed Bash reads outside the working directories, and untraceable commands, deny in `-p`. A repo's `true` can't be lifted for the container alone. **Recommended:** keep I3 as decided and measure the denial rate in L4. If it blocks ordinary tasks, the owner chooses between accepting it and `isolation.block_reads: false` for container-first repos (with I15's loud reporting).
3. **`container-smoke` red but not required (review Minor 16).** **Recommended:** a non-required job that stays red when it fails, never skipped. The owner rules on whether a red non-required job may stay red while PRs merge.
4. **`--allowedTools` under the scrub (live finding).** The launch fix's round 2 is still running. **Recommended:** adopt its confirmed list in P0's docs, and update §6.4, §7.3 and §15 point 21 to match before P11 and P18. If round 2 shows the scrub breaks unattended detection other than through `HARNESS_UNATTENDED`, the launch fix carries that fix, not this spec.
5. **Done-contract PR 6 must install `srt` (§4.6).** The wrap in the shared runner makes `harness verify --ci` need `srt` and, on `ubuntu-24.04`, the `sysctl` step. **Recommended:** add both lines to done-contract PR 6. Otherwise every `--ci` verify exits "not done" (§4.4).

## 17. Not in scope

- `srt` around the whole Claude Code process on the host (outside the container).
- Cloning into a container volume (declined in I5).
- `srt`'s Windows backend.
- Push rulesets.
- TLS termination or credential masking.

## 18. Review findings addressed

| Finding | Fix |
|---|---|
| C1 key reachable by agent code | I12 (§4), I13 (§2.4, §6.1, §6.2, §6.6), guard (§10.5), LS, L2, L7 |
| C2 predictable token path | Per-uid base, `lstat` chain, `O_EXCL\|O_NOFOLLOW` (§6.3); guard `realpath` (§10.5) |
| C3 nesting voids `srt` | I14 (§7.3, §7.5, §7.7) |
| C4 owner lockout | Owner `pull_request` bypass, break-glass, update-branch (§5.2); L6 |
| C5 tags and release paths | `harness-refs` (§5.3); doctor release triggers; L6 |
| C6 VS Code bridges | §6.4 env block, §7.2 settings, §8.3 env denies; L3, L4 |
| I1 wrong object checked | Installation check every mint (§6.3) |
| I2 lifecycle | SIGHUP, lock, revoke, heartbeat, `last_error`, helper hash, supervisor (§6.3); doctor (§10.4) |
| I3 PEM in argv | `security -i` on stdin, `-T ""` (§6.2) |
| I4 `CLAUDE_CONFIG_DIR` | Kept, with the mirror; files pre-created (§7.2) |
| I5 volume planting | `srt` `denyWrite` on user config; hash check (§7.3) |
| I6 prompts without sandbox | §8.1, §8.2, §8.6, §7.7 point 6; L1, L4, L8; §16 Q2 |
| I7 Linux sockets | Doctor fix, `sandbox-required` requirement (§10.5); L2 |
| I8 Actions approvals | Workflow permissions in protect, doctor (§5.1, §5.5); L6 |
| I9 rollout | §13 order and splits |
| I10 deletions | Only `credentials.allow` removes (§8.3) |
| I11 off switch | I15 (§8.1) |
| I12 rotation | Runbook, `store-key`, key age (§6.2) |
| I13 CI facts | Publish job removes broker races and refresh counts; `sysctl`; checkout v6 comment; doctor reads `with:` (§6.6) |
| Minor 1 | §6.1 step 3 and 4 |
| Minor 2 | L3, about 3 refreshes |
| Minor 3 | §11.2 rows |
| Minor 4 | §5.4 kept last |
| Minor 5 | §5.5 rows |
| Minor 6 | §10.5 `realpath` |
| Minor 7 | §7.4, §10.1 validation |
| Minor 8 | §9 |
| Minor 9 | §6.3 files; L3, L4 |
| Minor 10 | §4.3, §7.3 |
| Minor 11 | §7.2; L4 |
| Minor 12 | §5.2; L5 |
| Minor 13 | §5.5 identity |
| Minor 14 | §7.2, §14 |
| Minor 15 | §8.2 worktree row |
| Minor 16 | §12.3; §16 Q3 |
