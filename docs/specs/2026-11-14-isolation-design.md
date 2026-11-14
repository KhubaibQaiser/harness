# Isolation hardening: design

- Status: revision 4, for the owner's review, 2026-11-14. No code. The review file (`.superpowers/sdd/isolation/spec-review.md`, local) covers two rounds:
  - revision 1 (050c8da): 6 Critical, 13 Important, 16 Minor;
  - revision 2 (72748bb): 9 Important, 9 Minor;
  - revision 3 (d391055): 1 Critical, 2 Important, 8 Minor.

  §18 maps every finding to its fix.
- Research: [`../research/2026-11-14-isolation.md`](../research/2026-11-14-isolation.md), cited below as "R§n". Its sources were fetched on 2026-11-14; URLs are repeated where a design choice rests on them.
- `srt` facts are from its README, read on 2026-11-14 at https://github.com/anthropics/sandbox-runtime. The `anthropic-experimental/sandbox-runtime` URL redirects there. Cited as "srt README".
- Owner decisions: I0 to I18, the coordinator's rulings, and one live finding, in `.superpowers/sdd/isolation/decisions.md` (local, not committed). They bind; §1 lists them.
- Prior work, treated as shipped: the unattended launch fix (I1), first committed as 9a98f50 on `fix/unattended-launch-strict` and shipped in #231 with `--allowedTools "Bash,Edit,Write"` and `HARNESS_UNATTENDED=1`. It includes its review fix rounds: Claude Code login denies, the release note, the managed `allowManagedDomainsOnly` false deny, plan mode, a missing `permission_mode`, I10's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, and the `HARNESS_CLAUDE_CONFIG_DIR` ruling. "The launch JSON" below means that command's `--settings` value. This spec adds to the launch line (§6.4, §1 live finding) but doesn't redesign it.
- Sequencing (I0, I12): the Stop-gate `srt` PRs (§4, PS1 and PS2) land right after the done contract's PR 3. Everything else lands after the done contract ([`2026-11-13-done-contract-design.md`](2026-11-13-done-contract-design.md)) is complete.

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
| Live | On 2.1.322, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` forces the default permission mode ("Declare allowedTools explicitly"). `bypassPermissions` is ignored under the scrub, so launches need `--allowedTools`. | §6.4, §7.3 |
| I16 | If `srt` runs in Docker only in weaker nested mode, ship it and report it in doctor and status. No `SYS_ADMIN` and no unconfined seccomp. A custom seccomp profile that allows only user namespaces needs an owner yes. | §7.7 |
| I17 | Keep the read block on in the container. L4 measures the denial rate, and the owner decides with numbers. | §7.7, §8.6 |
| I18 | `container-smoke` is a **required** check, over the recommendation that it not be required. | §12.3 |
| Q4 | Launches use `--allowedTools "Bash,Edit,Write"` plus `HARNESS_UNATTENDED=1`, shipped in #231. | §6.4, §7.3 |
| Q5 | Done-contract PR 6 installs `srt` and the `ubuntu-24.04` `sysctl`. | §4.6 |
| R2-I1 | The Stop wrap is never skipped on a probe. It skips only on the cached, trusted container verdict that `srt` already wraps the process. The preflight is behavioural, and the I12 limit is stated. | §4.1, §4.2, §4.4 |
| R2-I2 | Steps get no loopback by default. A person-only `stop.allow_local: true` opts in, documented with the macOS risk. | §4.3, §10.1 |
| R2-I3 | An `srt` that degrades with a warning, for example with no seccomp helper, fails the preflight. | §4.4 |
| R2-I6 | `harness-refs` binds only App-created refs. Dependabot, `gh-pages` and release-please are exempt by actor or pattern. Narrowed by R3-C1 and R3-I2 below. | §5.3 |
| R3-C1 | No bot branch patterns in `harness-refs`. Bots are exempt by app identity only (bypass actors), so the App and everyone else are bound on `gh-pages`, `dependabot/**`, `renovate/**` and release branches. | §5.3 |
| R3-I1 | The publish job never copies a file the agent wrote through the filesystem. `pr-body.md` comes from the bundle's tree after verify; a symlink or non-regular blob is refused, and the size is capped. | §6.6 |
| R3-I2 | No `github-actions` bypass. A workflow that must push protected refs uses a protected environment with required reviewers. Doctor flags `contents: write` workflows that can run on agent pushes. | §5.3 |
| Q1 (rev 3) | Accept that an agent-run `harness verify` inside the sandbox exits not done and asks the person to run it. | §4.2 |
| R2-I7 | Detect headless `-p` if Claude Code exposes a hook-visible signal (such as `CLAUDE_CODE_ENTRYPOINT`, to verify live); otherwise it is a documented limit. A follow-up to #231. | §10.5, L0 |

The research or the review recommended otherwise on four of these:
- I3 (R§12 Q2);
- I6 (R§12 Q6);
- I14 drops the inner sandbox that the research proposed (R§11 B2);
- I18 makes `container-smoke` required (§12.3).

Their risks are stated where they are designed: §7.7, §8.6 and §12.3.

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
- **Contents write beyond refs.** The App can start `repository_dispatch` workflows and change release assets. Doctor flags both; no ruleset covers them (§5.7).
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

**The Stop wrap (I12) has the same shape.** It holds against an agent with no unsandboxed write: `sandbox: always`, the container, or CI. In an attended session with the sandbox off, one write past the guard's text checks can defeat it, for example a purpose-built `srt` shim on a user-writable `PATH` (§4.1, R2-I1). Linux rows that rely on I12 inherit this.

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

**What I12 holds against.** It holds against an agent with no unsandboxed write: `sandbox: always`, the harness container, or CI. In an attended session with the sandbox off (the default `sandbox: unattended`), a single write that gets past the guard's text checks defeats it. An example is an `srt` shim placed in a user-writable global prefix (nvm, volta, a user-owned `/opt/homebrew`). The behavioural preflight (§4.4) catches a plain shim, but not one written against harness's own preflight (R2-I1). §2.4 and §14 state this.

### 4.2 How steps are wrapped: one `srt` call per run

- The wrap lives in the shared step runner (`src/checks/stop/runner.ts`), so Stop steps and verify's command runs are both covered.
- **Per run** (a Stop run, or one verify):
  1. Write the `srt` settings (§4.3) and a plan to `.harness/state/srt-<nonce>.json` and `.harness/state/plan-<nonce>.json`. That folder is protected by protect, `denyWrite` and ConfigChange. The plan lists each step's command, arguments, absolute working directory and time limit. Both files are new for every run and deleted afterwards.
  2. Run `srt --settings <abs settings> node <harness step runner> <abs plan> <nonce>` **once**.
     - `srt` reads the settings once, at start, so nothing can change them between steps (R2-I8). The step runner is harness's own file from harness's install, never from the repo.
     - The argument form (the README shows it both as an argv and as one string) is pinned by a test (srt README "As a CLI tool").
  3. **Inside, the step runner:**
     - runs the behavioural preflight (§4.4) first;
     - runs each step with its time limit, capturing its output;
     - writes one JSON line per check and step to stdout, tagged with the nonce.

     The outer runner enforces `stop.timeout_s` on the whole call.

     **Result lines are checked strictly (R3-M3).** It accepts exactly one line per expected check and step, in plan order, each with the nonce, and rejects the run on a missing, extra or out-of-order line. The nonce isn't secret from step code (on Linux the runner is visible under `/proc`), so the plan and settings files are also on the steps' `denyRead`. Forging a line gains nothing that editing a test doesn't.
- **Which `srt`:** the binary on the hooks' `PATH`.
  - Its real path must lie outside the repo and every `allowWrite` root (srt README "Where This Package Is Installed").
  - `srt --version` must be at least the pinned `SRT_MIN`, which moves only with a harness release.
  - Harness doesn't bundle `srt`. The person installs the `@anthropic-ai/sandbox-runtime` package globally, at the pin. That one install also provides Claude Code's Linux seccomp filter (https://code.claude.com/docs/en/sandboxing, "Set up Linux and WSL2").
- **The wrap is never skipped on a probe (R2-I1).** The one case without a second wrap is the harness container. There, a nested `srt` fails with EPERM (srt README "The command stays in the namespaces made for it"), and the session's cached, trusted container verdict (§7.5) shows `srt` already wraps the whole process. No file probe, environment variable or write result is consulted.
- **From inside another fence.** Running `harness verify` from the agent's sandboxed Bash, or from any other fence, makes the nested `srt` fail. The preflight then exits "not done", saying: `harness verify can't run its checks inside another sandbox. Ask the person to run harness verify in their own terminal, or ! harness verify (outside the sandbox on macOS, and on Linux without the env scrub).` On Linux with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` set, `!` commands are sandboxed too (https://code.claude.com/docs/en/sandboxing "What runs outside the sandbox"), so the person's own terminal is the route there (R3-M4). The Q1 ruling accepts this.

### 4.3 The `srt` settings for steps

All keys and the `literal` entry form were checked against the srt README "Configuration Options":

```json
{
  "network": { "allowedDomains": [], "allowLocalBinding": false },
  "filesystem": {
    "allowWrite": [ {"path": "<repo realpath>", "literal": true}, "<os temp dir>", "/tmp", "<stop.allow_write…>" ],
    "denyWrite": [ "<each protected path, absolute, literal>", {"path": "<token base>", "literal": true}, {"path": "<canary>", "literal": true} ],
    "denyRead": [ {"path": "<token base>", "literal": true}, {"path": "<canary>", "literal": true}, {"path": "<plan and settings files>", "literal": true} ]
  },
  "credentials": { "files": [ "<§8.3 list, mode deny>" ], "envVars": [ "<§8.3 list, mode deny>" ] }
}
```

- **Absolute, literal paths (R2-I8).** Every repo-derived path is the repo's `realpath`, joined and written as a `{"path", "literal": true}` entry. Then glob characters in a repo's path are never read as a pattern, and a step in `packages/x` gets the same roots as one at the top. `credentials.files` takes no `literal` form, so a credential path with glob characters is left out and doctor names it.
- **Protected paths.** Harness's `denyWritePaths()`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks`, `.claude/skills`, `.devcontainer` and the CODEOWNERS paths. `srt`'s mandatory denies already cover `.git/hooks`, `.git/config`, `.vscode`, `.idea`, shell startup files, `.gitconfig`, `.mcp.json`, `.claude/commands` and `.claude/agents` (srt README "Mandatory Deny Paths").
- **The token base** is denied for both reads and writes. On macOS the OS temp dir is `DARWIN_USER_TEMP_DIR`, the parent of the token base, so without the write deny a step could swap `git-credential` or pre-create the broker's names (R2-M1).
- **Network: none.**
  - `allowedDomains: []` means no network (srt README). `stop.allowed_domains` adds hosts.
  - **Loopback is off (R2-I2).** `allowLocalBinding: false` is the default. On macOS, `true` opens every service on the host's loopback, including Claude Code's own sandbox proxy (which allows any host in `bypassPermissions` without `strictAllowlist`), debug ports, and "a local proxy or forwarder that carries traffic off the machine" (srt README "Local servers on Windows", which says macOS behaves the same).
  - The person can opt in with `stop.allow_local: true` (person-only, §10.1); doctor then shows the risk.
  - On Linux the setting is ignored. Each step has its own loopback, so servers a step starts itself work, but host services (a database, a dev server) are unreachable from steps on Linux whatever the setting. A suite that needs a host service runs in CI or with `sandbox: off`.
- **Unix sockets** stay blocked (srt README "Unix Socket Settings"). This blocks D-Bus (Secret Service), `SSH_AUTH_SOCK` and VS Code's IPC too.
- **Reads.** Unrestricted except the credential denies, the token base and the canary. The I3 home-wide block is not applied to steps, so toolchains under home work. On Linux, a deny path that doesn't exist when `srt` starts hides nothing; the lists are rebuilt for every run.
- **Credentials.** `srt`'s own `credentials.files` and `credentials.envVars` with `mode: "deny"`, rendered from the §8.3 lists.
- **No `allowRead`.** It has the opposite precedence in `srt` from Claude Code's, so `srt` settings have their own renderer and never write it.

### 4.4 Preflight: behavioural, and fail closed (R2-I3)

Inside the single `srt` call, before any step, the step runner checks that the fence holds. Each name is random per run.

| Check | Must |
|---|---|
| Write the `denyWrite` canary (a file the outer runner created under `.harness/state/`) | Fail. The outer runner also checks afterwards that the file is unchanged |
| Read the `denyRead` canary (a file the outer runner created in the OS temp dir with a random value) | Fail |
| Connect to a Unix socket the outer runner listens on, in the OS temp dir | Fail. The outer runner also checks that no connection arrived |
| An HTTPS connection to `example.com` | Fail |
| Linux: `bwrap --unshare-user --ro-bind / / true` (bubblewrap is a dependency of `srt`) | Fail, so step code can't unshare and drop the binds |

The preflight also fails when:
- **`srt` writes any warning to stderr,** for example no seccomp helper (Unix sockets unrestricted), no `--disable-userns` (bubblewrap older than 0.8), or bubblewrap older than 0.5 (srt README "Platform-Specific Dependencies", "Unix Socket Settings");
- the outer runner's own checks see a change or a connection;
- a result line lacks the nonce, or `srt` exits non-zero before the step runner reports.

Each line names the check that failed. A plain shim fails it.

| Case | What happens |
|---|---|
| `srt` missing, inside the repo or a write root, older than the pin, or the preflight fails | No step runs. Stop blocks with the message below; the block counts toward `stop.max_attempts`. A `stop-srt-unavailable` event is logged with the failed check. |
| Attempts run out on that cause | The Stop gate lets the agent stop, by its existing rule. The done ledger and `harness status` record `checks never ran (srt unavailable)`, never a pass (R2-M6). |
| A step fails inside `srt` | The same as a failing step today. The output tail includes `srt`'s "Operation not permitted" lines. |
| `sandbox: off` | Steps run unwrapped, as today. `stop-unwrapped` is logged once per session, and doctor shows a note. |
| `harness verify` (attended or `--ci`) | The same rules. A verify that can't wrap exits "not done" (exit 1) with the message. |

Message:
`Stop gate: the checks run inside sandbox-runtime (srt), and srt <is not installed | is inside the repo or a writable folder (<path>) | is <ver>, older than <pin> | failed its check: <check> (<first line>)>. Install @anthropic-ai/sandbox-runtime@<pin> globally, outside the repo (Linux also needs bubblewrap 0.8 or newer, socat and ripgrep; macOS needs ripgrep), then stop again. To run the checks unsandboxed instead, set sandbox: off in .harness/config.yaml (logged).`

The Stop hook itself fails open by Claude Code's design (done contract §2.3). Fail closed here means the gate never runs steps unwrapped, and verify never passes without the wrap.

### 4.5 Windows

`srt`'s Windows backend is an alpha with an elevated install (srt README "Windows (alpha)"), and harness doesn't use it.

- **Attended native Windows:** steps run unwrapped, as today. Doctor gives a warning: `Stop steps run without a sandbox on native Windows: the project's tests run with your full access. Use WSL2 or the harness dev container for a sandboxed Stop gate.` This is an exception to I12, listed in §14 for the owner to acknowledge.
- **Unattended native Windows:** no step runs, and Stop blocks with `Stop steps don't run unsandboxed in an unattended run on native Windows. Run in WSL2 or the harness dev container, or set sandbox: off (logged).`
- **WSL2:** Linux rules.

### 4.6 Machines that can't run `srt`

- Linux needs `bubblewrap` (0.8 or newer for the preflight), `socat` and `ripgrep`. Ubuntu 24.04 and later need `kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile (srt README "Ubuntu 24.04+ note").
- macOS needs `ripgrep`.
- Doctor finds each case and prints the fix; until then the Stop gate blocks. Attended Linux users whose Stop gate worked unwrapped see this change, so it goes in the release note under "Breaking".
- **CI:** done-contract PR 6's `harness-verify` workflow installs `srt` at the pin and runs the `sysctl` line on `ubuntu-24.04` (Q5 ruling).

### 4.7 Performance

- A Stop run pays `srt`'s start-up **once**: the proxy, the sandbox profile or bubblewrap mounts, and on Linux a `ripgrep` scan for mandatory-deny files, to depth 3, in every `allowWrite` root, `/tmp` and the OS temp dir included (srt README "Linux search depth"). The preflight then adds its five checks.
- PS2 adds a perf case to `pnpm test:perf`: a Stop run of four steps on a repo fixture with a large `node_modules`, wrapped and unwrapped, on Linux and macOS CI. The budget is set from the first measurement (target: no more than 2 s added per Stop run, an estimate) (R2-M5).
- The overhead counts against `stop.timeout_s`. The Stop gate runs once per stop, not per tool call.

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

**Owner bypass (C4).** `github.protect.owner_bypass: auto` adds the `User` bypass in `pull_request` mode for user-owned repos. It also adds it for org repos with exactly one collaborator who has write access (`GET /repos/{o}/{r}/collaborators?permission=push`), so a one-person org doesn't lock itself out (R2-M9). Otherwise it leaves the bypass out. `on` and `off` force it.
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

**Update branch.** Ask the agent to run `gh pr update-branch <n>` with the App token, so the App stays the last pusher. Under `require_last_push_approval`, that push needs a **new** owner approval; the earlier one no longer counts. There is no deadlock, because the owner can approve the App's push (R2-M2).

**Required check.** The `required_status_checks` rule is added only when the `harness-verify` CI item (done contract §4.7) is installed.
- `integration_id` comes from a real check run: `GET /repos/{o}/{r}/commits/{default}/check-runs?check_name=harness-verify`, field `app.id` (R§5.5, https://docs.github.com/en/rest/checks/runs).
- The source app must have `statuses:write`; GitHub Actions does.
- With the item installed but no check run yet, protect exits 1 (§11.2).

**An approval authorizes the merge.** The App's Contents write reaches the merge API (R§0.8), so once the owner approves and the check passes, the App can merge its own PR, auto-merge included. Doctor and the docs say so, and L5 tests merging before and after approval.

### 5.3 Ruleset `harness-refs`: tags and other branches (C5, R2-I6, R3-C1, R3-I2)

```json
[
  { "name": "harness-refs-tags", "target": "tag", "enforcement": "active",
    "conditions": { "ref_name": { "include": ["~ALL"], "exclude": [] } },
    "bypass_actors": [ "<owner User, always>", "<DeployKey, always>", "<exempt bot actors, always>" ],
    "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ] },
  { "name": "harness-refs-branches", "target": "branch", "enforcement": "active",
    "conditions": { "ref_name": { "include": ["~ALL"], "exclude": ["~DEFAULT_BRANCH", "refs/heads/agent/**"] } },
    "bypass_actors": [ "<owner User, always>", "<DeployKey, always>", "<exempt bot actors, always>" ],
    "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ] }
]
```

**Two rulesets.** GitHub rulesets target either branches or tags, so `harness-refs` is two rulesets with these names. Both are managed like `harness`.

**Bound by ref, exempt by identity only (R3-C1 ruling).** A ruleset binds every actor on the refs it targets, except its bypass actors. The only exclusions are the default branch (covered by `harness`) and the agent prefix. No bot branch pattern is ever excluded, so the App, and everyone not listed, is bound on `gh-pages`, `dependabot/**`, `renovate/**`, `release-please--**`, `changeset-release/**` and every other branch.

The bypass actors:
- **The owner** (`User`, `always`).
- **Deploy keys** (`DeployKey`, `always`), for workflows that must push protected refs (below).
- **Bots, by app identity** (`Integration`, `always`). Each id is read from `GET /apps/<slug>`, never hard-coded:
  - `dependabot`, when the default branch has `.github/dependabot.yml`;
  - `renovate`, when the default branch has `renovate.json`, `.github/renovate.json5` or a `renovate` key in `package.json`.

  On 2026-11-14 the API returned 29110 and 2740. Detection reads these files from the **default branch** through `GET /repos/{o}/{r}/contents/<path>?ref=<default>`, never from the working tree, where the agent could plant them (R3-M8). Self-hosted Renovate, or a tool that pushes with a PAT, is added by hand as an actor in `github.protect.exempt`, never as a branch pattern.
- **Humans on org repos:** the Write role (`RepositoryRole`), if L6 confirms it doesn't cover an App.

Every bypass actor is shown in protect's diff, with the file that triggered it.

**No `github-actions` bypass (R3-I2 ruling).**
- Every workflow's `GITHUB_TOKEN` acts as `github-actions`, including workflows that run agent code. So that identity is never a bypass actor.
- **A workflow that must push a protected ref** (a `gh-pages` deploy, release-please or changesets creating tags or release branches) pushes with a deploy key. The key is stored as a secret of a protected environment with required reviewers, so a person approves each such run.
- Protect lists those workflows in its output, with this fix, because they stop pushing once `harness-refs` is active.
- Pages deployed with `actions/deploy-pages`, which publishes an artifact and pushes no branch, is unaffected.
- `DeployKey` bypass on personal repos is checked in L6.

**Prefix.** `github.agent_prefix` (default `agent/`) sets the excluded branch pattern. The agent's branches must start with it, and GitHub's rejection of any other branch names the ruleset.

**Tags and releases.** Only the owner, deploy keys and exempt bots create, move or delete tags, so the App can't trigger a tag-based publish. The App can still create releases and edit release assets (§5.7).

**Doctor flags:**
- **Fix:** a workflow with `contents: write` (or `write-all`) that runs on an event the agent can cause: `push` to a non-default branch, `pull_request`, `pull_request_target`, or `workflow_run` of such a workflow. That workflow hands agent code a write token (R3-I2).
- **Fix:** an auto-merge or auto-approve workflow that keys on the PR's author or `head_ref` (for example `github.event.pull_request.user.login == 'dependabot[bot]'`) rather than on `github.actor`. The App can push commits onto a bot's PR branch only where `harness-refs` is off, but the check must not rest on that (R3-C1).
- **Note:** release and deploy triggers (`push: tags`, `release`, `push` to non-default branches) that use no protected environment, since a tag the owner pushes still builds whatever is on that commit.

**L6** checks that the App's pushes to `dependabot/x` and `gh-pages` are refused, that a Dependabot PR still works, and that a deploy-key push from an approved environment works.

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
| `repository_dispatch` triggers; release-asset publishing | fix or note (§5.7) |

- **Identity.** Doctor prints which identity `gh` used: `owner <login>`, or `App <slug>[bot]` when `GH_CONFIG_DIR` points at a token folder. The App can't read Administration, so its read-back is "unknown", not "missing".
- **Branch protection.** The existing `branchProtection` check stays; either a branch protection rule or the ruleset counts as "protected".
- **Untrusted output.** All `gh` output is treated as in `doctor-protection.ts`: size limits, control characters stripped, an args array, never a shell.
- **Status line:** `Server side: rulesets ok | drift | missing | unknown | unavailable (private repo without Pro)`.

### 5.6 Private repos without Pro (I8)

- **Detection.** `visibility` is `private` and the rulesets API returns 403 with an upgrade message. A 403 without that context is "unknown".
- **Protect** exits 1 and changes nothing (§11.2).
- **Doctor** prints a statement, not a fix: `Server-side protection is unavailable: GitHub needs Pro, Team or Enterprise for rulesets on private repos. Nothing on GitHub stops a merge; harness's local layers stay on, and they can be bypassed.`
- **What remains.** The App still gives the agent its own identity. Without rulesets, its Contents write can merge and tag through the API (R§0.8), and only the guard's text checks stop that.

### 5.7 Contents write beyond refs (R2-I5)

GitHub's permissions table for Apps lists these endpoints under Contents write (https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps, read on 2026-11-14), and no ruleset covers them:
- **`POST /repos/{o}/{r}/dispatches`.** It starts `repository_dispatch` workflows on the default branch, with a `client_payload` the App chooses. A workflow that puts `client_payload` into a script is an injection point.
- **`POST /repos/{o}/{r}/releases`, `PATCH` and `DELETE /repos/{o}/{r}/releases/assets/{id}`.** The App can create releases, and upload, replace or delete assets on releases that are already published. Whoever downloads the binary then runs agent-supplied code.

What harness does:
- **Doctor flags `repository_dispatch` triggers.** A fix when the workflow uses `github.event.client_payload` inside `run:`; a note otherwise.
- **Doctor flags repos that publish release assets** (`softprops/action-gh-release`, `gh release upload`, `actions/upload-release-asset`). It recommends GitHub's immutable releases, which lock a published release's assets and tag (https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases). That page doesn't say which plans offer them, so doctor gives a note, not a fix.
- **Delete and recreate.** Contents write can also delete a release and create a new one, with new assets, on an **existing owner tag**. Immutable releases may stop that; whether the tag can be reused after the release is deleted is checked in L6 (R3-M6).
- **Dispatch needs no injection to matter.** `repository_dispatch` workflows can be fired at will, even when their payload is never interpolated, which matters for any workflow with side effects.
- **L6** has the App dispatch an event, upload an asset, and delete and recreate a release on an owner tag, with and without immutable releases, before and after the fixes.
- **§2.3 and §14** list both routes.

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
  claude -p "…" --allowedTools "Bash,Edit,Write" --settings '<launch JSON>'
```

- With the scrub, the session stays in the default permission mode (live finding). So harness detects the run as unattended through `HARNESS_UNATTENDED`, and tools outside `--allowedTools` are denied in `-p`.
- The tool list is the Q4 ruling, shipped in #231.
- For push runs, the launch JSON adds `github.com` and `api.github.com` to `allowedDomains`.

### 6.5 Reaching the broker

- **Host.** The agent's tree only reads the token folder. The base is outside the read block's roots, so nothing needs allowing.
- **The sandbox's own write area.** The research says it includes the per-user temp dir (R§2.1), while the review reads it as `/tmp/claude-<uid>` (env-vars doc). On macOS the token base sits under `DARWIN_USER_TEMP_DIR`, so L2 checks whether sandboxed Bash can write it.
  - If it can, `harness github broker --env` also prints the base for the person to add to the launch JSON's `denyWrite`.
  - The broker's hash check on `git-credential` and its `lstat` checks catch a swap within 60 seconds either way.
- **Container.** The host folder is bind-mounted read-only at `/run/harness/gh`. Only `srt-push.json` lets the tree read it (§7.3).

### 6.6 CI: an agent job and a publish job (I13, R2-I4, R3-I1)

The key and the token never enter a job that runs repo or agent code.

**After the agent step, the workspace is hostile.** Every later step follows no symlink, reads no file the agent wrote, and runs git only after checking that the repo's config and hooks are unchanged. Nothing the agent wrote travels except git objects in the bundle (R3-I1).

```yaml
jobs:
  agent:                                  # runs the agent; holds no key and no token
    permissions: { contents: read }
    outputs: { base: "${{ steps.base.outputs.sha }}" }
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false, fetch-depth: 0 }   # checkout v6 otherwise keeps the token in a file under $RUNNER_TEMP
      - id: base                          # before the agent runs
        run: |
          echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
          sha256sum .git/config > "$RUNNER_TEMP/git-config.sha"; ls -la .git/hooks > "$RUNNER_TEMP/git-hooks.list"
      - run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # ubuntu-24.04: Claude's sandbox and srt need it
      - run: <install harness and sandbox-runtime globally, at their pins>
      - run: <the §6.4 launch, without the push lines, and without github.com>
      - run: |                            # hostile workspace from here on
          sha256sum -c "$RUNNER_TEMP/git-config.sha" && diff <(ls -la .git/hooks) "$RUNNER_TEMP/git-hooks.list"
          out=$(mktemp -d "$RUNNER_TEMP/agent-out.XXXXXX")
          git -c core.hooksPath=/dev/null -c core.fsmonitor= bundle create "$out/agent.bundle" \
            "${{ steps.base.outputs.sha }}..HEAD"
          echo "OUT=$out" >> "$GITHUB_ENV"
      - uses: actions/upload-artifact@<sha>
        with: { name: agent-out, path: "${{ env.OUT }}/agent.bundle", retention-days: 1 }
  publish:                                # runs no repo code
    needs: agent
    permissions: {}
    steps:
      - run: <install harness globally, at its pin>        # before any agent data arrives
      - uses: actions/download-artifact@<sha>             # a release bundling @actions/artifact 2.1.2 or later (CVE-2024-42471)
        with: { name: agent-out, path: in/ }
      - env: { HARNESS_APP_KEY: "${{ secrets.HARNESS_APP_KEY }}" }
        run: |
          printf '%s' "$HARNESS_APP_KEY" | env -u HARNESS_APP_KEY harness github publish \
            --repo "$GITHUB_REPOSITORY" --branch "agent/run-${{ github.run_id }}" \
            --base "${{ needs.agent.outputs.base }}" --bundle in/agent.bundle --key-stdin
```

**The PR body travels in git.** The agent commits it as `.harness/pr-body.md` on its branch, and publish reads it from the verified commit (step 6). No file is copied through the filesystem. The file lands in the PR diff, under the `/.harness/` CODEOWNERS line, and each later PR overwrites it. This is a spec point the owner can overrule (§15).

**What `harness github publish` does.** It is person-only, like every `harness github` subcommand, and the publish job runs it directly, not through an agent.
1. **Mint.** One token, as the broker does, with the same installation check.
   - The token reaches git through `GIT_CONFIG_*`, as an `http.https://github.com/.extraHeader` with a basic auth header, and reaches the API in memory.
   - It is never in a URL, argv or a file (R3-M1).
2. **Empty repo.** `git init` in a fresh temporary folder, with `fetch.fsckObjects=true`, `transfer.fsckObjects=true`, `core.hooksPath=/dev/null` and `core.fsmonitor=` (empty). This job parses pack data the agent made, and it never checks out a work tree.
3. **Check the base.**
   - The `--base` commit comes from the agent job's output, so it is not trusted.
   - `GET /repos/{o}/{r}/compare/{base}...{default}` must report `identical` or `ahead`, which means the default branch contains the base.
   - Then `git fetch --depth=1 https://github.com/<o>/<r> <base>`.
4. **Check the bundle (R3-M1).**
   - The header must list **exactly one** prerequisite, equal to `--base`. This rules out a full-history bundle, which has none.
   - `git bundle verify` must pass.
   - `git bundle list-heads` must show exactly one ref.
5. **Fetch** only that ref into `refs/harness/incoming`, then check:
   - `refs/harness/incoming^{commit}` resolves, so a tag-only bundle fails clearly;
   - `git merge-base --is-ancestor <base> refs/harness/incoming` passes.
6. **Read the body from the tree (R3-I1 ruling).**
   - `git ls-tree refs/harness/incoming -- .harness/pr-body.md` must show one blob of mode `100644`. A symlink (`120000`), a submodule or any other mode is refused.
   - Its size, from `git cat-file -s`, must be under 64 KB.
   - Its content, from `git cat-file blob`, must be valid UTF-8.
7. **Check the branch name** starts with `github.agent_prefix`.
8. **Push** `<incoming commit sha>:refs/heads/<branch>`, an explicit refspec over HTTPS. Never `--tags`, `--mirror` or `--follow-tags`.
9. **Open or update the PR.**
   - The body is untrusted. Harness removes closing keywords (`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` and `resolved`, each followed by `#n`, `owner/repo#n` or an issue URL, R3-M2) and @-mentions.
   - It keeps the 64 KB cap.
10. **Revoke** the token.

**What can't come through.**
- **Hooks:** a bundle carries none, and publish never checks out.
- **Workflow files:** the server refuses them, because the App has no Workflows permission.
- **Tags, and branches outside the prefix:** `harness-refs` refuses them.
- **Files the agent wrote outside git:** only the bundle file crosses jobs, and it is created in a fresh `$RUNNER_TEMP` folder after the config and hooks checks.

**Costs.** A CI agent can't push mid-run or read PR comments. There is no token in the agent job, so there is nothing to refresh.

**The artifact** is readable by anyone who can read the repo's Actions. It holds only the agent's commits, which are about to be public on the PR anyway.

**Doctor flags:**
- a workflow that runs `claude` after a checkout without `persist-credentials: false`, read from the workflow's `with:`;
- a workflow that passes `HARNESS_APP_KEY` to a job that checks out code;
- a step after the agent step that reads workspace files, other than the documented bundle step;
- `actions/cache`, or a setup action's `cache:`, in a job that runs `claude` (R2-M8).

**Tested by** an e2e that fetches a range bundle into an empty repo through these steps (§12.2), and by L7.

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
      --allowedTools "Bash,Edit,Write" --settings "$(cat /etc/harness/claude$P.json)"
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
  - No `allowNestedUserNamespaces` and no `allowAllUnixSockets`. `enableWeakerNestedSandbox` is set only if L4 shows Docker needs it (I16).
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
- **Proved:** unattended shell calls are allowed without Claude Code's sandbox (I14). The Stop runner uses this cached verdict, and nothing else, to skip its second wrap (§4.2).
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
3. **Docker may force the weaker mode (I16).** `srt`'s bubblewrap needs user namespaces, and Docker's default seccomp or AppArmor profile may refuse them. If `srt` then runs only with `enableWeakerNestedSandbox`, which "considerably weakens security" (srt README), harness ships it that way.
   - Doctor and status show `srt in weaker nested mode`.
   - Harness adds no `SYS_ADMIN` and no unconfined seccomp profile.
   - A custom seccomp profile that allows only user namespaces needs an owner yes.
   - L4 records which mode runs.
4. **Hostname filtering only,** with the same domain-fronting limit as before.
5. **Claude Code's login is in the volume.** Hooks and MCP servers can read it, and `api.anthropic.com` is always allowed (R§3.2).
6. **I3 inside the container.** With Claude Code's sandbox off, the read block makes recognized file-reading commands outside the working directories, and any command the parser can't trace, prompt even in `bypassPermissions`. In `-p` they are denied (the review, citing the permission-modes doc). A repo's `true` can't be lifted for the container alone. I17 keeps the block on. L4 measures the denial rate, and the owner decides with those numbers.

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

The VS Code names are pinned in L4. With the sandbox on, denying them in attended sessions means the agent can't push with the owner's VS Code session. The denies apply to sandboxed commands only, so with the sandbox off (the attended default under `sandbox: unattended`) the agent can still reach VS Code's askpass (R2-M3). Without the App launch, git still uses the owner's own configured helpers (for example osxkeychain).

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
   - the container under I14 (§7.7 point 6), where I17 keeps the block on and the owner decides with L4's numbers.

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
| `stop.allow_write` | `[]` | Extra writable paths for Stop steps inside `srt`, such as a tool cache outside the repo. Config validation refuses (R2-I9): a protected path; the home folder itself; `~/.claude`; login-start folders (`~/Library/LaunchAgents`, `~/.config/systemd/user`, `~/.config/autostart`); any folder on `PATH` or above one; `srt`'s own install prefix; and the token base. |
| `stop.allow_local` | `false` | Person-only (protected config; update asks interactively before setting it, and an unattended update leaves it unchanged). `true` sets `allowLocalBinding` for Stop steps. On macOS that opens every service on the host's loopback, Claude Code's sandbox proxy included. On Linux it has no effect. Doctor and status show it when on (R2-I2). |
| `isolation.block_reads` | `true` | Writes the read block in every mode (I3). `false` is person-only: update asks interactively before removing it, and SessionStart, doctor and status show it loudly (I15). |
| `isolation.credentials.allow` | `[]` | §8.3 entries harness leaves off its deny lists. Each must be a §8.3 entry. |
| `isolation.network.ecosystems` | `"auto"` | `auto`, or a list from `npm`, `python`, `rust`, `go`, `ruby`, `java`, `containers`. |
| `isolation.network.allow` | `[]` | Extra hosts for the repo allowlist and the container. GitHub hosts, `*`, and anything matching `example.com` are refused. |
| `isolation.container` | `"off"` | `off`, `available` (files written; verdict shown and accepted), or `required` (unattended shell needs the verdict). `--container` sets `required`. |
| `github.app.id` | `0` | This repo's agent App id. `0` means none. Not a secret. |
| `github.app.slug` | `""` | From the manifest conversion. |
| `github.app.key_stored_at` | `""` | ISO date the key was stored, for doctor's key age. |
| `github.agent_prefix` | `"agent/"` | Branch prefix the App may create and update under (`harness-refs`). It must match `^[a-z0-9-]+/$`. |
| `github.protect.owner_bypass` | `"auto"` | `auto` (on for user-owned repos, and for org repos with one write collaborator), `on` or `off`: the owner's `pull_request` bypass on the `harness` ruleset (C4). |
| `github.protect.exempt` | `{add: [], remove: []}` | Bot bypass actors (app slugs) to add to, or remove from, what protect detects for `harness-refs` (§5.3). Actors only; branch patterns are not accepted (R3-C1). `github-actions` is refused (R3-I2). |
| `project.codeowners` | `[]` | Changed: the owners written to the CODEOWNERS block (§5.4). Was input only. |

The generated table in `docs/reference.md` picks these up from `src/core/config.ts`.

### 10.2 Commands

| Command | Who | What |
|---|---|---|
| `harness github protect [--dry-run] [--yes]` | Person only | §5.1 |
| `harness github app create [--org <org>]` | Person only | §6.1 |
| `harness github app store-key` | Person only | §6.2 (key on stdin) |
| `harness github broker [--repo <o/r>] [--env] [--check]` | Person only | §6.3 |
| `harness github publish --repo --branch --base --bundle --key-stdin` | Person, or the CI publish job (never through an agent) | §6.6 |
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
- Stop sandbox: `srt` found, outside writable roots, at least the pin; the last preflight's result per check; the Linux and macOS dependencies; `stop.allow_local`; Windows warning.
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
Stop sandbox: srt <ver>                                  (or: UNAVAILABLE - stop gate blocks; last stop: checks never ran | off - logged)
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
  2. Attended: allow. Unattended now also covers `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` in the hook's environment, which a scrubbed `-p` launch keeps in default mode, and a headless signal if L0 finds one (R2-I7). Without either, a host `-p` run that sets neither variable is judged attended; that is a documented limit (§14). When the scrub variable alone makes a session unattended, SessionStart prints: `harness: this session is treated as unattended because CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 is set; questions become denies and the unattended gates apply. Unset it in your shell profile for interactive work.` (R3-M5)
  3. `win32`: deny.
  4. The container verdict, when `isolation.container` isn't `off`: proved allows; `required` and not proved denies.
  5. `HARNESS_SANDBOX=1`, or the settings confirmed (with the launch fix's strict rule): allow. On Linux, when `github.app.id` is set, Claude Code's seccomp filter must also be present (review I7). Harness detects it as the `apply-seccomp` binary that the globally installed `@anthropic-ai/sandbox-runtime` ships for this architecture, which is the install the Claude Code docs name (https://code.claude.com/docs/en/sandboxing). The path is pinned in P11 and confirmed in L2 against `/sandbox` showing no Dependencies tab (R2-M4).
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
| Verify inside another fence | `harness verify can't run its checks inside another sandbox. Ask the person to run harness verify in their own terminal, or ! harness verify (outside the sandbox on macOS, and on Linux without the env scrub).` |
| Config, `stop.allow_write` refused | `stop.allow_write can't list <path>: <it is a protected path | it is your home folder | programs there run at login | it is on PATH | srt is installed there | it holds the GitHub token folder>. Choose a folder only your tests write, such as a cache folder.` |
| Publish, base not on the default branch | `The agent job's base <sha> is not on <default branch> (compare: <status>). Nothing was pushed.` |
| Publish, bad bundle | `The agent's bundle <has <n> refs, not one | needs <sha>, not the base <sha> | failed git bundle verify: <first line>>. Nothing was pushed.` |
| Publish, branch outside the prefix | `The branch <name> doesn't start with <github.agent_prefix>, so harness-refs would refuse it. Nothing was pushed.` |
| Config, GitHub or probe host in an allowlist | `<key> can't list <host>: GitHub is reachable only in runs that push (harness-run --push), and example.com must stay unreachable for the container check.` |

## 12. Testing

### 12.1 Unit (no network, no `claude`)

- **Stop wrap:**
  - `srt` settings render, with every key name from the README;
  - `allowRead` never written;
  - the protected-path union;
  - the argument form;
  - one `srt` call per run, with absolute `literal` paths;
  - result lines: missing, extra, out of order, or without the nonce, each rejected;
  - plan and settings files new per run and deleted after;
  - the step runner's nonce-tagged results;
  - each preflight check failing on its own, and any `srt` stderr warning failing it;
  - a shim that runs the command unwrapped fails the preflight;
  - each §4.4 row (missing, inside the repo, old, failing preflight, step failure, `off` logged, attempts exhausted recorded as never ran);
  - Windows attended and unattended;
  - no second wrap only with a proved container verdict, and never from a probe;
  - verify inside another fence exits not done with the `!` message;
  - `stop.allow_write` validation for each refused class;
  - `stop.allow_local` default off.
- **Rulesets:**
  - all builders, with owner bypass `auto` (user, org with one and with several write collaborators), `on` and `off`;
  - `harness-refs` bypass actors from each detection, read from the default branch through a stubbed contents API, never the working tree (ids from a stubbed `GET /apps/<slug>`);
  - no branch pattern beyond the default branch and the agent prefix in any ruleset;
  - no `github-actions` actor in any ruleset, and `github.protect.exempt` refusing patterns and `github-actions`;
  - the doctor fixes for `contents: write` workflows on agent-reachable events, and auto-merge keyed on the PR author;
  - the required-check rule with and without the item;
  - normalised compare;
  - workflow permissions;
  - protect against a stub `gh` (POST, PUT, no-op, drift, `--dry-run`, 403 private, 403 without admin, no check run, no CODEOWNERS, malformed answers), writing nothing on errors.
- **CODEOWNERS:** create and merge in each of the three places; owner validation; the block moved back to last; uninstall.
- **Doctor read-back:** every §5.5 row, and the identity line.
- **Doctor §5.7:** `repository_dispatch` with and without `client_payload` in `run:`, release-asset actions.
- **Unattended detection:** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` counts; the headless signal, once L0 names it.
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
- **Publish:**
  - the base check through compare (`identical`, `ahead`, `behind`, `diverged`);
  - a bundle prerequisite other than the base, zero prerequisites, and two;
  - two refs in the bundle, and a single tag ref;
  - an incoming head the base isn't an ancestor of;
  - `.harness/pr-body.md` as a symlink blob, a submodule, missing, over 64 KB, and not UTF-8;
  - the token never in argv or a URL (asserted on spawned commands);
  - the explicit refspec, and no tags pushed;
  - `fsckObjects` on;
  - the body stripped of every closing keyword form, including `closed`, `fixed`, `resolved` and `owner/repo#n`, and of @-mentions;
  - prefix check, no hooks run, revoke.
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
- publish from a range bundle (`<base>..HEAD`) into an empty repo, fetching the base first, as the CI job does (R2-I4);
- the Stop gate wrapped by a real `srt` on Linux and macOS CI runners, in one call, with steps in the root and in a subfolder, and a test that writes `.harness/config.yaml`, reads a fake `~/.aws/credentials` and connects to a host-side TCP server, all failing;
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

  **It is a required check (I18).**
  - **Rollout.** P18 adds the job, and the owner makes it required once it has passed on `main`.
  - **Never skipped.** It has no path filter and no `if:`, so it runs on every PR.
  - **The risk.** Because it is required, an `srt` or Docker change on GitHub's runners blocks every PR until it is fixed. The review recommended a non-required job for that reason, and the owner chose required.
  - **Break-glass.** It is the same as for the rulesets: the owner removes the requirement, fixes the job, then restores it.

### 12.4 Live batches (owner's subscription)

They run from the Terminal panel, with scripts in `harness-wt/live`. Each batch needs a yes and records the Claude Code and `srt` versions.

| Batch | Where | Checks | Gates |
|---|---|---|---|
| L0 unattended detection (#231 follow-up) | macOS, Linux | **The headless `-p` signal (R2-I7).** In the hook's environment for `claude -p`, an interactive session and an SDK run, record `CLAUDE_CODE_ENTRYPOINT` and any other variable Claude Code sets. Check whether `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` reaches hooks under the scrub, and that a scrubbed `-p --allowedTools "Bash,Edit,Write"` run without `HARNESS_UNATTENDED` is judged unattended once the fix lands | P0b |
| LS Stop in `srt` | macOS; Linux (Ubuntu 24.04 with and without the `sysctl`) | See below | PS1, PS2 |
| L1 read block | macOS; Linux; WSL2 if available | With the block and the sandbox on: nvm or volta `node -v`, pyenv, `cargo`, `~/.local/bin`, `npm ci` and `pnpm install` from cache, Playwright, `gh auth status` (keyring and file), an HTTPS push with the App helper, an SSH push, the Read tool on a home file, then Fix A and Fix B, recording which lifts each. **With the sandbox off:** the prompt rate in an attended session, and the denial rate of a scripted `-p` task (review I6) | P14 |
| L2 credentials and keys | macOS; Linux | The full §8.3 lists are accepted without warnings; each present path fails `cat` in Bash; the variables are absent; **macOS:** a `-T ""` item prompts for `security` too, and sandboxed Bash can't read it silently; reading the broker's memory from unsandboxed code of the same uid fails without debugger rights; sandboxed Bash can or can't write `DARWIN_USER_TEMP_DIR`; **Linux:** `secret-tool lookup` from sandboxed Bash with and without the seccomp filter (review I7) | P3, P10, P11 |
| L3 broker on the host | macOS | `app create` for one repo on a scratch public repo (the person edits the name); the broker mints; an attended agent pushes `agent/x` and opens a PR as `<slug>[bot]`; `GIT_TRACE` shows only the harness helper; VS Code's terminal askpass isn't used; `gh` doesn't migrate the folder; a 2.5-hour run with pushes every 20 minutes crosses about 3 refreshes and old tokens are revoked; SIGHUP from a closed terminal revokes; a second broker is refused; a killed broker gives the §11.2 messages | P11, P12 |
| L4 container and `srt` | Docker Desktop on macOS; Docker on Linux (host uid 1000 and not 1000) | `srt` runs in the unprivileged container, recording whether `enableWeakerNestedSandbox` is needed under Docker's seccomp and AppArmor profiles (I16), and that doctor and status report it; the Stop gate skips its second wrap only on the proved verdict; `.git/hooks`, `.devcontainer` and user settings writes fail; `example.com` is refused; a `--push` run pushes with the App token; a run without push can't reach `github.com` or read the token; the VS Code setting names turn off git config copying and helper forwarding; `git credential fill` returns nothing and `ssh-add -l` fails; the read block's denial rate in `-p` with the sandbox off; `updateRemoteUserUID` and a re-created token folder keep the mount readable; Claude Code starts and finishes a run with the user-config `denyWrite` entries (plugins, settings) in place | P17, P18 |
| L5 end to end | Container, unattended `-p` | With the done contract on: the run pushes and opens a PR; before approval the App can't merge (`gh api -X PUT …/merge` is refused) or push a tag, a workflow change, or a branch outside `agent/`; it can't post a `harness-verify` status; after the owner approves, the App *can* merge, which is documented; the owner merges through the bypass | Release |
| L6 protect | Scratch public repo (personal), and one org repo | See below | P6, P7, P8 |
| L7 CI | Public scratch repo, GitHub-hosted | The agent job runs with the `sysctl` and no key; agent code (Bash, a Stop step and a hook) finds no key or token in env, files or processes; the publish job fetches the base, verifies and fetches the one-ref range bundle, and pushes with the explicit refspec; a bundle with a second ref, a tag or a wrong prerequisite is refused; a hook file planted in the bundle doesn't run; closing keywords in the body are stripped; **`.harness/pr-body.md` committed as a symlink to `~/.claude/.credentials.json` is refused, and nothing from outside git reaches the artifact (R3-I1)**; a `.git/config` change by the agent fails the bundle step; doctor flags a workflow without `persist-credentials: false` and a `cache:` in the agent job | P13 |
| L8 Windows | Native Windows, if the owner has a machine | An unattended PowerShell call is denied with the message; `off` allows and logs; attended Stop runs unwrapped with the doctor warning; the read block's roots and prompt rate | P1 (with no machine: CI only, and a known limit) |

**LS in full:**
- A real Stop gate in an attended session.
- A planted test that tries each of these; each must fail:
  - writing `.harness/config.yaml`;
  - reading `~/.aws`;
  - reaching `example.com`;
  - connecting to `$SSH_AUTH_SOCK` and to D-Bus;
  - running `security find-generic-password -s harness-probe` against a dummy item;
  - connecting to a database on the host's loopback, on both platforms, with `stop.allow_local` off (on macOS it connects once it is on).
- A server the test starts itself works on Linux, and on macOS only with `stop.allow_local`.
- **The R2-I1 tricks.** Each still wraps, or fails the preflight:
  - `.harness/state/<name>` as a symlink to a read-only system path;
  - `chflags uchg` on `.harness/state`;
  - an `srt` shim earlier on `PATH` that answers `--version` and execs the command.
- **The R2-I3 cases:** `srt` without its seccomp helper, and bubblewrap older than 0.8, each failing the preflight on its warning.
- The agent's `harness verify` from sandboxed Bash exits not done with the `!` message.
- The overhead on a large repo.
- `srt` missing gives the §4.4 message.

**L6 in full:**
- Apply, re-apply as a no-op, hand-edit, see the drift, restore.
- A personal repo accepts the `User` bypass in `pull_request` mode, and the owner merges their own PR.
- `gh pr update-branch` by the App needs a new owner approval.
- `harness-refs` refuses App tags and non-prefix branches.
- The App's pushes to `dependabot/x` and `gh-pages` are refused (R3-C1).
- A Dependabot PR still works under it.
- A `gh-pages` push with a deploy key from an approved protected environment works, while a `GITHUB_TOKEN` push is refused (R3-I2).
- `DeployKey` bypass is accepted on a personal repo.
- A release deleted and recreated on an owner tag, with and without immutable releases (R3-M6).
- The org Write-role bypass doesn't cover the App.
- Workflow permissions are set and read back.
- The App's `repository_dispatch` and release-asset upload work before the doctor fixes, and doctor flags them.
- CODEOWNERS errors and a 404 are shown.

## 13. Rollout

- **Size.** Each PR is cut from `main`, stays within 400 non-test lines and 20 files, and updates the README and release notes in the same PR. Sizes are estimates.
- **Order.** Each PR depends only on earlier rows.
- **Settings never ahead of their enforcement.** The read block lands after the broker that supplies its fixes, and the container verdict lands before the templates that set `required` (review I9).

| # | PR | After | Live gate | Size (est.) |
|---|---|---|---|---|
| P0 | Launch fix (I1, I10, Q4): prior work, shipped in #231 | — | — | done |
| P0b | Unattended detection follow-up to #231: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` counts as unattended, plus the headless signal if L0 finds one; documented limit otherwise (R2-I7) | P0 | L0 | ~80 |
| PS1 | Stop steps and verify runs in one `srt` call (§4.2, §4.3). PS1 owns the credential-list module and the protected-path source, and P3 and P5 extend them (R3-M7). It covers the plan, the step runner, absolute literal paths, fail closed, `stop.allowed_domains`, `stop.allow_write` validation, `stop.allow_local`, Windows, "Breaking" note | Done-contract PR 3 | LS | ~360 |
| PS2 | The behavioural preflight (§4.4), the "checks never ran" record, doctor and status Stop-sandbox lines, perf case | PS1 | LS | ~280 |
| — | *The rest of the done contract (its PRs 4 to 7) lands here. Its PR 6 adds `srt` and the `sysctl` to `harness-verify` (Q5 ruling)* | | | |
| P1 | Native Windows deny, the `off` logging branch, doctor fix, "Breaking" note (0.3.0) | Done contract | L8 | ~140 |
| P2 | Guard: `PERSON_ONLY.github` and the §10.5 checks; protect: `.devcontainer/`, CODEOWNERS, token base | P1 | — | ~260 |
| P3 | Credential and env deny lists (§8.3), extending PS1's list module: `mergeSettings`, `credentials.allow`, restore on update | P2 | L2 | ~240 |
| P4 | Ecosystem allowlist: `isolation.network.*`, renderers, `doctor --launch-hosts`, `NETWORK_NOTE`, validation | P3 | — | ~250 |
| P5 | CODEOWNERS block: init, update, uninstall, kept last | P2 | — | ~180 |
| P6 | Protect core: the `harness` ruleset, owner bypass, idempotent compare, required check | P5 | L6 | ~340 |
| P7 | Protect: `harness-refs` (tags, prefix, bot actors detected from the default branch, `DeployKey`, `github.protect.exempt`), Actions workflow permissions, `github.agent_prefix`, the R3-I2 and R3-C1 doctor fixes | P6 | L6 | ~350 |
| P8 | Doctor and status read-back, drift, private without Pro, identity line, release-trigger and §5.7 flags | P7 | L6 | ~340 |
| P9 | `harness github app create`: manifest, callback, per-repo App, config keys | P2 | — | ~280 |
| P10 | Key storage: macOS `security -i` with `-T ""`, Secret Service, plain-file refusal, `store-key`, rotation runbook | P9 | L2 | ~230 |
| P11 | Broker core: token base and `lstat` chain, `O_EXCL` writes, installation check, mint, `git-credential`, `hosts.yml` and `config.yml`, `--env`, the §6.4 launch docs (C6), the Linux seccomp requirement in `sandbox-required` | P10 | L2, L3 | ~380 |
| P12 | Broker lifecycle: refresh, revoke, lock, signals, heartbeat, `last_error`, helper hash, supervisor docs; doctor and status identity lines | P11 | L3 | ~300 |
| P13 | CI: `harness github publish` with the base and bundle checks, the two-job docs, doctor workflow and cache checks | P12 | L7 | ~360 |
| P14 | Read block default, `isolation.block_reads` (I15), toolchain fix lines | P12 | L1 | ~280 |
| P15 | Doctor credential report and the App-key line | P3, P14 | — | ~260 |
| P16 | Container verdict: `isolation.container` (all three values), marker check, SessionStart probe, status line | P2 | — | ~300 |
| P17 | Container templates and renderers: Dockerfile, `devcontainer.json` (C6 settings, I4 paths), `srt` and Claude settings | P4, P11, P16 | L4 | ~350 |
| P18 | `harness-run`, `/harness:init --container`, update and uninstall of the files, user-settings hash, `container-smoke` job (made required after it passes on `main`, I18) | P17 | L4 | ~320 |
| P19 | Known limits and reference wrap-up; L5; release | All | L5 | ~150 |

PS1 and PS2 ship in the same release, so no release has the wrap without the behavioural preflight. P11, PS1 and P13 are the closest to 400 lines. If one grows past, the split is: P11's docs and `sandbox-required` change move into P12; PS1's Windows rows move into PS2; P13's doctor checks become their own PR.

## 14. Known limits

- **Server side.**
  - It binds only on GitHub, only where rulesets are available, and only until a repo admin changes them.
  - A private repo without Pro has no binding layer (I8).
  - The owner bypass (C4) lets the owner merge without approval or the check.
  - Push rulesets aren't used (R§5.1).
- **Approval authorizes the App's merge.** Once the owner approves and the check passes, the App can merge.
- **Contents write beyond refs.** The App can fire `repository_dispatch` workflows at will, and can change release assets or delete and recreate a release on an existing tag. Doctor flags these, and immutable releases help where the plan offers them (§5.7).
- **`harness-refs` exemptions** are by app identity only. An undetected bot, or self-hosted Renovate, is refused until its actor is added to `github.protect.exempt`. Workflows that push protected refs with `GITHUB_TOKEN` (`gh-pages`, release-please tags) stop working until they move to a deploy key in a protected environment (§5.3). Doctor lists them.
- **Deploy keys are bypass actors.** Any deploy key with write access on the repo bypasses `harness-refs`, so a write deploy key must live only in a protected environment with required reviewers. Doctor lists the repo's write deploy keys.
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
  - I12 holds only against an agent with no unsandboxed write: an `srt` shim written against harness's preflight, on a user-writable `PATH`, defeats it in attended sandbox-off sessions;
  - no loopback unless `stop.allow_local`; on Linux, host services are unreachable from steps whatever the setting;
  - attended native Windows is an exception to I12, for the owner to acknowledge;
  - verify from inside another fence can't wrap and exits not done, so the person runs it in their own terminal or with `!` (the rev 3 Q1 ruling);
  - attended native Windows runs them unwrapped.
- **`srt`:** a beta, the only fence in the container (I14), fencing only its own process tree, possibly in its weaker mode under Docker (I16, reported), and hostname-only.
- **Bind mount.** Files outside the protected paths reach the host (§7.6).
- **The read block** costs toolchains under home until Fix A or B is added, makes unsandboxed Bash prompt (and `-p` deny), binds every teammate, and its Windows roots are undocumented (§8.6).
- **Credential list.** It is incomplete by nature, and can't cover keychain or keyring IPC.
- **Detection.** The person who launches a run can fake every container signal and `HARNESS_SANDBOX=1`. A host `-p` run that sets neither `HARNESS_UNATTENDED` nor the scrub, on a Claude Code with no headless signal, is judged attended (R2-I7).
- **`container-smoke` is required** (I18): a runner-side change can block every PR until fixed.
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
10. Owner bypass `auto`: on for user repos and for org repos with one write collaborator. Org repos get a Write-role bypass on `harness-refs-branches`.
11. CODEOWNERS paths: `/.github/`, `/.harness/`, `/.claude/`, `/.devcontainer/`, `/AGENTS.md`, `/CLAUDE.md` and the CODEOWNERS files, with the block kept last.
12. The container lives in `.devcontainer/harness/`. The `-push` and non-push files are baked into the image, so changing the allowlist needs a rebuild.
13. `isolation.container` has three values; `--container` sets `required`.
14. The probe host is fixed to `example.com`.
15. Stop steps get no home read block, no network, no loopback and blocked Unix sockets, in one `srt` call per run. `stop.allowed_domains`, `stop.allow_write` and `stop.allow_local` are the escape hatches.
16. `sandbox: off` also runs Stop steps unwrapped (logged).
17. Harness doesn't bundle `srt`; it must be installed globally outside the repo.
18. VS Code's askpass and IPC variables are denied in attended sessions too.
19. Browser profile folders are left off the credential list; the read block covers them.
20. No command assembles the launch line. `--env` and `doctor --launch-hosts` print parts.
21. `harness-refs` exempts bots by app identity only, detected from the default branch (`dependabot.yml`, Renovate config), with ids from `GET /apps/<slug>`, plus `github.protect.exempt` actors. Deploy keys are bypass actors, for workflows that push protected refs from a protected environment.
22. Publish trusts no input from the agent job: the base is checked through the compare API, and the bundle must have exactly that prerequisite and one ref.
23. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` in a hook's environment counts as unattended, even in a session a person watches.
24. The PR body is committed as `.harness/pr-body.md` on the agent branch, so it is in the PR diff and is overwritten by each later PR.

## 16. Open questions

None. Revision 2's Q1 to Q5 were closed by I16, I17, I18 and the Q4 and Q5 rulings.

Revision 3's Q1 (agent-run verify with the sandbox on) is ruled: accept it. An agent-run `harness verify` inside the sandbox exits "not done" and asks the person to run it. This matches done contract §4.4, where the person runs verify. The cost if this is wrong is one extra step for the person in attended sessions (§4.2).

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
| I6 prompts without sandbox | §8.1, §8.2, §8.6, §7.7 point 6; L1, L4, L8; I17 |
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
| Minor 16 | §12.3; I18 (now required) |

### Revision 2 review

| Finding | Fix |
|---|---|
| R2-I1 probe and shim | No probe; skip only on the container verdict; behavioural preflight; I12 limit stated (§4.1, §4.2, §4.4, §2.4, §14); LS tricks |
| R2-I2 loopback | `allowLocalBinding: false`, person-only `stop.allow_local`, Linux host-service note (§4.3, §10.1); LS host database |
| R2-I3 degraded `srt` | Warnings fail; behavioural checks (§4.4); LS |
| R2-I4 publish job | Base output and compare check, bundle checks, explicit refspec, body path, `fetch-depth: 0` (§6.6); e2e, L7 |
| R2-I5 Contents write | §5.7, §2.3, §14; L6 |
| R2-I6 bots | Superseded by R3-C1 and R3-I2 (§5.3) |
| R2-I7 detection | §10.5 step 2, P0b, L0, §14 |
| R2-I8 settings re-read, relative paths | One `srt` call, absolute literal paths (§4.2, §4.3) |
| R2-I9 `allow_write` | Validation list (§10.1) |
| R2-M1 token base writable | Stop `denyWrite` (§4.3); launch JSON per L2 (§6.5) |
| R2-M2 update-branch | §5.2 |
| R2-M3 VS Code denies | §8.3 |
| R2-M4 seccomp detection | §10.5 step 5 |
| R2-M5 performance | §4.7 |
| R2-M6 attempts exhausted | §4.4, §10.4 |
| R2-M7 publish hardening | §6.6 (install first, artifact pin, `fsckObjects`, body sanitising) |
| R2-M8 cache poisoning | §6.6 doctor flag |
| R2-M9 org bypass | §5.2, §10.1 |

### Revision 3 review

| Finding | Fix |
|---|---|
| R3-C1 bot branch patterns | Patterns removed; bots exempt by app identity only, detected from the default branch; auto-merge keyed on the PR author is a doctor fix (§5.3, §10.1); L6 |
| R3-I1 post-agent paths | Body from the bundle tree, mode and size checked; no filesystem copy; hostile-workspace rule, config and hooks check before the bundle step (§6.6); L7 |
| R3-I2 `github-actions` bypass | Removed; deploy keys in protected environments; `contents: write` workflows on agent-reachable events are a doctor fix (§5.3, §14); L6 |
| R3-M1 bundle checks | Exactly one prerequisite, ancestor check, `^{commit}`, token through `GIT_CONFIG_*` only (§6.6) |
| R3-M2 closing keywords | Full keyword list and `owner/repo#n` (§6.6) |
| R3-M3 forged result lines | Strict line checking; plan and settings on `denyRead` (§4.2, §4.3) |
| R3-M4 `!` under the scrub | Message adds the person's own terminal (§4.2, §11.2) |
| R3-M5 scrub surprise | SessionStart note (§10.5) |
| R3-M6 release recreate, dispatch | §5.7, §14; L6 |
| R3-M7 PS1 module ownership | §13 |
| R3-M8 detection source | Default branch through the API (§5.3) |
