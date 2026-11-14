# Isolation hardening: research

Date: 2026-11-14. Read-only research for the isolation hardening spec. Sources were fetched today. Claude Code docs are versioned by release, and several behaviours below changed between v2.1.219 and v2.1.324. Harness's live checks ran on 2.1.322; this machine's CLI is 2.1.285.

Labels used:
- **[docs]** an official primary source, URL given.
- **[source]** read straight from code or config in an official repo.
- **[analysis]** my own reading of a primary source. It is not a vendor claim.
- **UNCONFIRMED** a secondary source only, or not found.

---

## 0. Key findings

1. **The built-in sandbox covers Bash, PowerShell and Monitor only.** Read, Edit, Write, WebFetch, hooks, MCP servers, LSP servers, mods and `!` commands all run outside it. Anthropic itself says the sandbox "is not sufficient for fully unattended runs", and that `--dangerously-skip-permissions` sessions should run in a container, a VM or the sandbox runtime. [docs] https://code.claude.com/docs/en/sandbox-environments
2. **By default the sandbox can read credentials.** It reads "the entire computer … including credential files", and "There is no built-in credential deny list". [docs] https://code.claude.com/docs/en/sandboxing
3. **There is a native setting that does most of Q3's job:** `permissions.blockReadsOutsideWorkingDirectories`.
   - When the sandbox is on, it denies sandboxed commands reads of `/Users`, `/home`, `/root`, `/Volumes`, `/mnt`, `/media`, `/run/media` and `/srv`. It then re-opens the working directories and the session temp directory.
   - The file tools (Read, Grep, Glob, LSP) are blocked too.
   - A `true` in any settings file applies, and a repository can't lift it.
   - `~/.git-credentials` stays blocked, and repository `allowRead` entries stop counting.
   - It requires v2.1.257 or later.
   - [docs] https://code.claude.com/docs/en/settings-reference (section `permissions.blockReadsOutsideWorkingDirectories`)
4. **Harness's unattended launch has two gaps that matter now.**
   - (a) With `allowUnsandboxedCommands: false` in `--settings`, the sandbox becomes "admin-required". Claude Code then **ignores the repository's `network.allowedDomains` and `excludedCommands`**, so any allowlist must travel in `--settings` itself.
   - (b) In `bypassPermissions` mode, a host outside the allowlist is **allowed without a prompt** unless `strictAllowlist` is on. `strictAllowlist` only works from user settings, managed settings or `--settings`, never from the project.
   - [docs] https://code.claude.com/docs/en/sandboxing ("Repository settings under an admin-required sandbox", "Hosts outside your allowed domains")
5. **The reference dev container's firewall works by IP address, not by hostname.** It was resolved once, at start. It also leaves several exits open:
   - outbound TCP 22 to anywhere;
   - DNS (UDP 53) to any resolver;
   - the host's /24;
   - all of GitHub's IP ranges;
   - no IPv6 rules.
   It is "a working example rather than a maintained base image". [source] https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh ; [docs] https://code.claude.com/docs/en/devcontainer
6. **A container whose workspace is bind-mounted still lets the agent plant code that runs on the host.** Examples are git hooks, `.git/config`, `.vscode` settings and package scripts. [analysis]. Claude Code's own sandbox write-protects `.git/hooks`, `.git/config` and `.vscode` in the working directory, so running the sandbox inside the container closes part of this. [docs] https://code.claude.com/docs/en/sandboxing ("Protected paths")
7. **Server side, rulesets and branch protection are free on public repos.** Private repos need Pro, Team or Enterprise Cloud. Push rulesets (file-path blocking) apply only to private and internal repos. [docs] https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
8. **Required reviews deadlock if the agent pushes as the owner.** GitHub never lets an author approve their own PR, so the owner could not approve the agent's PRs. The agent needs its own identity, a GitHub App or a machine user. Contents write alone already allows the merge API, so only rulesets stop a merge. [docs] https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
9. **The official Claude GitHub App is broad.** It has Workflows read and write, Actions read and write, and Repository hooks read and write. It is the wrong identity for a guarded agent. Anthropic itself suggests a custom app with only Contents, Issues and Pull requests. [docs] https://code.claude.com/docs/en/github-actions
10. **`gh` has no command that writes rulesets.** `gh ruleset` only lists, views and checks. Idempotent setup has to go through `gh api`: find the ruleset by name, then `PUT /repos/{o}/{r}/rulesets/{id}`, or `POST` when there is none. [docs] https://cli.github.com/manual/gh_ruleset ; https://docs.github.com/en/rest/repos/rules

---

## 1. What harness does today (origin/main 6f1c668)

Read with `git show origin/main:<path>`.

- **`src/install/merge.ts`.** Under `sandbox: always` it writes `sandbox.enabled: true`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false` and `autoAllowBashIfSandboxed: false` into `.claude/settings.json`. In every mode it also writes `sandbox.filesystem.denyWrite` from `denyWritePaths()`. No `denyRead`, no `network.*`, no `credentials` and no `permissions.blockReadsOutsideWorkingDirectories` are written. Init prints a note that the allowlist starts empty.
- **`src/checks/protect.ts` `denyWritePaths()`.** It lists `.harness/config.yaml`, `manifest.json`, `hooks`, `state`, `backup`, `tasks` and `apply.lock`, plus `.claude/settings.json` and `.claude/settings.local.json` (docs/reference.md "Sandbox").
- **`src/checks/sandbox-required.ts`.** It denies an unattended shell call unless:
  - `HARNESS_SANDBOX=1` comes from the launcher, or
  - the session-start settings layers have `sandbox.enabled === true` and `allowUnsandboxedCommands === false`, and on Linux `bwrap` and `socat` are on PATH.

  On `win32` it returns `unavailable`: it logs once and **allows** the call. It does not read `excludedCommands`, `network.*` or `strictAllowlist`.
- **`src/cli/doctor.ts`.** It reports:
  - the sandbox is off;
  - the machine can't run it;
  - a `denyWrite` path is missing;
  - `allowUnsandboxedCommands: true`;
  - `excludedCommands`;
  - `filesystem.disabled`.

  It reports nothing about credentials, network or containers.
- **`docs/reference.md`.** The documented unattended launch is `HARNESS_SANDBOX=1 claude -p … --settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":false}}'`. Known limits already admit three things:
  - the sandbox covers Bash only;
  - the network allowlist starts empty;
  - "Only CI and branch protection enforce rules for everyone".
- **Related harness research.**
  - `docs/research/2026-11-03-platform-enforcement.md` flagged `Read(./**/.env*)` → `denyRead` translation as unverified.
  - `docs/research/2026-11-13-done-contract-verdict.md` §3 C already recommends a required `harness verify` check pinned to an app, with the workflow protected by CODEOWNERS and an agent identity that can't bypass.

---

## 2. Q1: what Claude Code's sandbox enforces and what it doesn't

Main sources:
- [docs] https://code.claude.com/docs/en/sandboxing (cited below as [sbx])
- [docs] https://code.claude.com/docs/en/settings-reference (cited below as [ref])

### 2.1 Defaults

| Area | Default | Source |
|---|---|---|
| Write | Working directory and its subdirectories, `--add-dir`/`/add-dir`/`permissions.additionalDirectories`, and the per-user temp dir (`$TMPDIR` is set to it). Protected paths stay write-denied even inside writable dirs. | [sbx] "Filesystem isolation" |
| Read | "read access to the entire computer, except certain denied directories. This default still allows reading credential files" | [sbx] |
| Protected paths (write-denied) | **In the working dir and the dirs above it:** `.claude` settings files, `.claude/skills|agents|commands|hooks`, `.mcp.json`, `.claude/workflows`, `.claude/scheduled_tasks.json`. **In the working dir only:** `.bashrc`/`.zshrc` and other shell startup files, `.gitconfig`, `.vscode`, `.idea`, and `.git/hooks` and `.git/config`. **Also:** bare-repo files (`HEAD`, `objects`, `refs`, `config`), and most of `~/.claude` plus `~/.claude.json` and `.credentials.json`. | [sbx] "Protected paths" |
| Network | No direct route. Linux and WSL2 run the command in a separate network namespace; macOS Seatbelt allows only the connection to the proxy. A host-side proxy checks each **hostname** against `allowedDomains`, which "start empty". UDP, QUIC and ICMP can't leave. Tools that ignore `HTTP(S)_PROXY` (plain `ssh`, most DB drivers) can't connect at all. | [sbx] "Network isolation" |
| Local-address guard | A name that resolves only to loopback, link-local (`169.254.169.254`) or the machine's own addresses is refused. Private ranges such as `10/8` connect. | [sbx] "Hostnames that resolve to local addresses" |
| `sandbox.enabled` | `false` | [ref] |
| `sandbox.failIfUnavailable` | `false`, which falls back to running unsandboxed | [ref] |
| `sandbox.allowUnsandboxedCommands` | `true` | [ref] |
| `sandbox.autoAllowBashIfSandboxed` | `false`. "Before v2.1.324, the default was `true`" | [ref] |

What happens to a host outside the allowlist depends on the permission mode ([sbx] "Hosts outside your allowed domains"):
- `bypassPermissions` mode: **allowed without a prompt**.
- Manual mode and `acceptEdits` mode: you get a prompt.
- Auto mode: refused unless the command listed the host and the classifier approved it.
- `dontAsk` mode: refused.
- With `strictAllowlist` or `allowManagedDomainsOnly` on, the connection is refused in every mode.

### 2.2 Read rules: `denyRead` / `allowRead`

- `sandbox.filesystem.denyRead` and `sandbox.filesystem.allowRead` take arrays of paths.
  - "When read rules overlap, the rule with the narrower path applies".
  - So `denyRead: ["~/"]` plus `allowRead: ["."]` gives workspace-only reads.
  - An exact or wildcard `denyRead` entry inside a broader `allowRead` stays denied.
  - [ref], [sbx]
- **Path prefixes** ([ref] "Sandbox path prefixes"):
  - `/` is absolute and `~/` is home.
  - `./` or no prefix means the project root in project settings, but `~/.claude` in user settings.
  - These differ from the `Read(...)`/`Edit(...)` rule syntax, where `//path` is absolute and `/path` is project-relative.
  - A trailing slash is stripped. "Before v2.1.224 … Claude could still read or write paths under a `denyRead` or `denyWrite` entry written with one."
- **Wildcards** work in all four lists on macOS. On Linux and WSL2, `denyRead`/`allowRead` accept a trailing `/**`, or a wildcard after the first directory name: `/**/*.pem` "covers nothing", while `~/keys/*.pem` works. [ref]
- **Merging.**
  - Lists merge across scopes.
  - `Read(...)` deny rules are added to `denyRead`, and `Edit(...)` rules to `allowWrite`/`denyWrite`. So harness's `Read(./**/.env*)` rules do feed the sandbox, but see the Linux wildcard limit above. [ref] `sandbox.filesystem`
  - `allowManagedReadPathsOnly` (managed settings only) keeps only managed `allowRead` entries.
  - Under `permissions.blockReadsOutsideWorkingDirectories`, repository `allowRead` entries don't count.
- **`sandbox.credentials`** ([sbx] "Protect credentials", "Mask credentials"):
  - **Files.** `files[]` entries with `mode: "deny"` behave like `denyRead`.
  - **Env vars.** `envVars[]` entries with `deny` unset the variable before each sandboxed command.
  - **Merging.** `deny` entries merge, and "no scope can remove one that another scope added".
  - **Mask mode.** `mode: "mask"` shows a per-session sentinel, and the proxy swaps in the real value for `injectHosts`. Masking needs the experimental `network.tlsTerminate`. `mask`, `tlsTerminate`, `allowPlaintextInject`, `awsPairs` and `sigv4` are honoured only from user, managed or `--settings`, never from repository files.
- **`permissions.blockReadsOutsideWorkingDirectories`** ([ref]):
  - **What it blocks.** The file tools refuse reads outside the working dirs, and so do sandboxed commands (the roots are listed in §0.3).
  - **What it re-opens.**
    - Worktrees the session creates, and in a linked worktree the shared `.git`.
    - The parts of `~/.claude` that commands need.
    - The global git config files (`~/.gitconfig`, `~/.config/git/{config,ignore,attributes}`, and files named by `include`).
  - **What stays blocked.** `~/.git-credentials` and `$XDG_CONFIG_HOME/git/credentials`.
  - **When the sandbox part doesn't apply.** Under `filesystem.disabled` or `allowManagedReadPathsOnly`, or when the start directory's path contains a glob character.
  - **Scope.** Any file. "a repository can turn the block on for itself but can't lift yours."

### 2.3 `excludedCommands` and `dangerouslyDisableSandbox`

- **`sandbox.excludedCommands`** takes patterns in `Bash(...)` syntax. A matching command runs with "no filesystem restrictions and no network proxy".
  - It is textual, and every command in the call must match: `docker *` alone doesn't exclude `npm ci && docker build .`.
  - Excluded commands still go through permission rules.
  - [sbx], [ref]
- **`dangerouslyDisableSandbox`** is a tool-call parameter Claude can use to retry a failed command unsandboxed.
  - It is ignored when `allowUnsandboxedCommands` is `false`, and while commands are refused with `Sandbox is required`.
  - A `false` in user, managed or `--settings` holds even if the project sets `true`. "Before v2.1.285, a project's `true` overrode a `false` in your user settings."
  - [sbx] "Turn off the retry with strict sandbox mode"
- **Admin-required sandbox** ([sbx] "Repository settings under an admin-required sandbox", v2.1.285 and later):
  - **When it applies.** `allowUnsandboxedCommands: false` comes from managed or `--settings`, or `allowManagedDomainsOnly` is set in managed settings.
  - **What Claude Code ignores in the repo's `.claude/settings*.json`.** `excludedCommands`, `ignoreViolations`, `network.allowedDomains`, `allowUnixSockets`, `allowMachLookup`, the proxy ports, the write grants of `allowWrite`/`Edit` allow/`additionalDirectories`, and `WebFetch(domain:)` allow hosts. A `true` for `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAllUnixSockets` or `allowLocalBinding` is ignored too.
  - **Consequence for harness:** the `--settings` launch in docs/reference.md puts every run into this state, so the project's `allowedDomains` is dropped. [analysis]
- **Locks without admin-required** ([sbx]):
  - `strictAllowlist` set in managed, `--settings` or user settings makes Claude Code ignore the repo's `allowedDomains`, proxy ports and `WebFetch` allows.
  - `denyRead`/`credentials.files` set in managed or `--settings` makes it ignore repo `allowRead`/`allowWrite` entries under those paths.

### 2.4 What runs outside the sandbox

From [sbx] "What runs outside the sandbox" and "Scope", and https://code.claude.com/docs/en/sandbox-environments:

- **Read, Edit, Write, WebFetch, WebSearch.** "follow permission rules instead". A `denyRead` entry "doesn't stop the Read tool", and `allowedDomains` "doesn't limit WebFetch".
- **Command hooks, local MCP servers, plugin monitors, LSP servers, the status line command, `apiKeyHelper`.** These "run with your full access". Mods and their `$.process` programs are not sandboxed either.
- **`!` shell-mode commands.** Unsandboxed in most sessions. The exceptions are background sessions and Linux with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.
- **Excluded commands, and unsandboxed retries when allowed.**
- **Computer use.** It runs on the real desktop.
- **Subagents.** These *are* sandboxed, because they share the parent's sandbox.
- **Docker.** "`docker` is incompatible with the sandbox", and excluding it is the documented route. Allowing `/var/run/docker.sock` "effectively grants access to the host system". [sbx] "Security limitations"
- **Whole-process boundary.** The documented route is the sandbox runtime (`srt claude`), the dev container, a custom container or a VM. [docs] sandbox-environments.

Related controls:
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`** strips credential-looking env vars from Bash, hooks and stdio MCP servers.
  - It **leaves `GITHUB_TOKEN`/`GH_TOKEN`** and the proxy variables in place.
  - On Linux it also gives Bash an isolated PID namespace.
  - It makes `!` commands sandboxed on Linux, and turns auto-allow off.
  - [docs] https://code.claude.com/docs/en/env-vars ("What the subprocess environment scrub removes")
- **`permissions.blockWritesOutsideWorkingDirectories`** (v2.1.314 and later) covers Write, Edit and NotebookEdit only, and "doesn't limit shell commands, MCP tools, or the programs hooks run". [ref]

Documented security limits ([sbx] "Security limitations"):
- **Domain fronting.** The proxy decides on the client-supplied hostname without inspecting TLS, so "Allowing broad domains such as `github.com` can create paths for data exfiltration".
- **Unix sockets.** `allowUnixSockets` can escalate to the host.
- **`enableWeakerNestedSandbox`.** "considerably weakens security".
- **`allowAppleEvents`.** "removes code-execution isolation". Project settings can't enable it.
- **`allowMachLookup`.** Listed services are reachable from inside the sandbox.
- **`allowNestedUserNamespaces`.** Code can end up outside the sandbox.
- **Git over SSH on macOS.** `git push` over SSH fails on macOS even when the host is allowed. On Linux and WSL2 it works once port 22 is allowed and the key is readable. [sbx] "`git` over SSH fails"

### 2.5 Windows

- "The sandbox runs on macOS, Linux, and WSL2. On native Windows, Claude Code runs commands unsandboxed. To use the sandbox on a Windows machine, run Claude Code inside a WSL2 distribution." WSL1 errors with `Sandboxing requires WSL2`. [sbx]
- Sandbox-environments recommends "a container or VM, or run the Bash sandbox inside WSL2" for native Windows hosts. [docs]
- On WSL2, Windows binaries launch over a Unix socket, so interop needs `network.allowAllUnixSockets`, which "opens every Unix socket". [sbx]
- WSL mounts `C:\` at `/mnt/c` with interop on by default. [docs] https://learn.microsoft.com/en-us/windows/wsl/wsl-config. Windows-side credentials are therefore readable from WSL unless something denies them. `/mnt` is one of the roots `blockReadsOutsideWorkingDirectories` blocks.
- Prior art, outside Claude Code:
  - The standalone sandbox runtime now has a **Windows (alpha)** backend: a dedicated `srt-sandbox` account, a WFP egress fence and ACEs. Its README lists token-impersonation bypasses of the network fence. [source] https://github.com/anthropics/sandbox-runtime (README "Windows (alpha)", "Known limitations"). Claude Code's built-in sandbox doesn't use it on native Windows (per [sbx]).
  - Codex CLI has a native Windows sandbox (see §7).

---

## 3. Q2: Anthropic's reference dev container, and detecting a container

### 3.1 What it contains

Source: `anthropics/claude-code` `.devcontainer/`, last commit d945a61, 2026-06-30. [source] https://github.com/anthropics/claude-code/tree/main/.devcontainer

- **`Dockerfile`.**
  - `FROM node:20`. It installs git, `gh`, iptables, ipset, iproute2, dnsutils, aggregate, jq and sudo.
  - It sets `ENV DEVCONTAINER=true`.
  - It installs `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`, with the default `latest`.
  - It runs as `USER node`.
  - A sudoers entry allows only `node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh`. The script is root-owned.
- **`devcontainer.json`.**
  - `runArgs: ["--cap-add=NET_ADMIN","--cap-add=NET_RAW"]` and `remoteUser: "node"`.
  - Named volumes for bash history and `/home/node/.claude` (per `${devcontainerId}`), plus `CLAUDE_CONFIG_DIR=/home/node/.claude`.
  - The workspace is a **bind mount**: `source=${localWorkspaceFolder},target=/workspace,type=bind`.
  - `postStartCommand: "sudo /usr/local/bin/init-firewall.sh"`.
  - **No host credential mounts.**
- **`init-firewall.sh` (iptables plus ipset, default-deny).** Steps in order:
  1. Keep Docker's internal DNS NAT rules.
  2. Allow outbound UDP 53 to any server, outbound TCP 22 to any host, and loopback.
  3. Add GitHub's `web`, `api` and `git` CIDRs from `https://api.github.com/meta`.
  4. Resolve these names **once** to A records: `registry.npmjs.org`, `api.anthropic.com`, `sentry.io`, `statsig.com`, `marketplace.visualstudio.com`, `vscode.blob.core.windows.net`, `update.code.visualstudio.com`.
  5. Allow the host's /24.
  6. Set the default policy to DROP, and REJECT everything else.
  7. Self-test: `example.com` must fail and `api.github.com` must succeed.

### 3.2 Documented caveats

From [docs] https://code.claude.com/docs/en/devcontainer:
- "When executed with `--dangerously-skip-permissions`, dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials stored in `~/.claude`."
- "Avoid mounting host secrets such as `~/.ssh` or cloud credential files into the container; prefer repository-scoped or short-lived tokens."
- `--dangerously-skip-permissions` is rejected as root, so `remoteUser` must be non-root. A bypassed session "can still modify any file in the bind-mounted workspace, which appears directly on your host".
- Policy copied into `/etc/claude-code/managed-settings.json` from the Dockerfile can be removed by "anyone with write access" to the repo. Server-managed settings or MDM are the non-bypassable route.
- The reference is "a working example rather than a maintained base image". The feature `ghcr.io/anthropics/devcontainer-features/claude-code:1.0` "installs the latest Claude Code" and auto-updates. To pin, install `@anthropic-ai/claude-code@X.Y.Z` and set `DISABLE_AUTOUPDATER=1`.
- The firewall and the extra capabilities "are not required for Claude Code itself".
- Sandbox-environments adds: committing a dev container "is a convention rather than an enforcement boundary, because Claude Code does not require a container". [docs]

My reading of the firewall source [analysis]:
- **SSH.** TCP 22 to any host is an open egress path: `ssh`/`scp` to any server.
- **DNS.** UDP 53 to any resolver allows DNS-tunnel exfiltration, and lets the container bypass Docker's resolver.
- **GitHub.** All of GitHub's ranges are allowed, so pushes, gists and issues to *any* GitHub account work. This is the same "broad domain" risk the sandbox docs warn about.
- **Host network.** The host /24 is reachable, which may include other machines on a home or office LAN.
- **IPv6.** There are no `ip6tables` rules. If the container has IPv6, that egress is unfiltered. Whether Docker gives the container IPv6 depends on daemon config.
- **IP pinning.** IPs are resolved once at start. CDN-backed hosts rotate addresses, so the allowlist can break mid-session, or allow a neighbour on a shared IP.
- **Stale hosts.** `sentry.io` and `statsig.com` no longer match Claude Code's current network table (§6.1), which lists Datadog intake hosts instead.
- **Version pin.** `CLAUDE_CODE_VERSION=latest` is unpinned.

### 3.3 How Claude Code detects or recommends a container

- **Detection:** I found no documented container detection in Claude Code. The only documented runtime check is that `--dangerously-skip-permissions` refuses to start as root on Linux and macOS. [docs] sandbox-environments, devcontainer.
  - **UNCONFIRMED:** an `IS_SANDBOX` environment variable that lifts the root check is mentioned only by third parties. Search found no Anthropic doc for it.
- **Recommendation:** the docs recommend a container, VM or `srt` for `--dangerously-skip-permissions` and unattended runs. [docs] sandbox-environments "Choose an approach".

### 3.4 Can a process reliably tell it is inside a container or VM?

Not reliably by identity. Every signal below can be produced or hidden by whoever controls the launch. The threat model differs by actor:
- **The person** who launches the run can always fake every signal.
- **A non-root agent** inside a session can fake env vars only for its own children, and can't create root-owned files.

| Signal | What sets it | How it is spoofed or missed | Source |
|---|---|---|---|
| `/.dockerenv` | Docker creates it in the container root | Root on the host can `touch /.dockerenv`. Absent under Podman and other runtimes | [source] https://github.com/moby/moby/blob/master/daemon/initlayer/setup_unix.go |
| `/run/.containerenv` | Podman | Root can create it. "will not be created when a volume is mounted on /run" | [docs] https://docs.podman.io/en/latest/markdown/podman-run.1.html |
| `container=<name>` env of PID 1, `/run/host/container-manager` | Container managers following systemd's interface | The variable "is not inherited down the process tree". `/proc/1/environ` "is only accessible to root". Not every runtime sets it | [docs] https://systemd.io/CONTAINER_INTERFACE/ |
| `systemd-detect-virt --container` / `--vm` | Heuristics. Ids include `docker`, `podman`, `wsl`, `kvm`, `qemu`, `microsoft`, `apple` | Only on systemd distros. "WSL is categorized as a container for practical purposes". The page gives no detection internals | [docs] https://www.freedesktop.org/software/systemd/man/latest/systemd-detect-virt.html |
| `DEVCONTAINER=true` | Anthropic's reference Dockerfile | Any env var can be set by the launcher | [source] reference Dockerfile |
| `CODESPACES=true` | GitHub Codespaces | Same | [docs] https://docs.github.com/en/codespaces/developing-in-a-codespace/default-environment-variables-for-your-codespace |
| `CI=true`, `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted` | GitHub Actions. `GITHUB_*` and `RUNNER_*` can't be overwritten inside a workflow, but `CI` can | Outside Actions, anyone can set them | [docs] https://docs.github.com/en/actions/reference/workflows-and-actions/variables |
| `/proc/1/cgroup`, overlay root in `/proc/self/mountinfo`, DMI product name, CPUID hypervisor bit | Kernel and hypervisor | Format varies by cgroup v1/v2 and runtime. A VM can hide the hypervisor bit | UNCONFIRMED: no single primary source fetched |

**Conclusion [analysis].** Detection should prove *behaviour*, not identity:
- Run as non-root.
- Check that a root-owned marker written at image build is present and not writable by the current uid.
- Most importantly, check that a probe to a host outside the allowlist fails, as the reference script itself does with `example.com`.

This resists a drifted non-root agent. It doesn't resist the person who launches the run, and per the owner's model it doesn't need to: harness already treats `HARNESS_SANDBOX=1` as the launcher's claim.

---

## 4. Q3: a default credential `denyRead` list

Detailed per-tool sources are in the appendix (§10). The headline is §0.3: `blockReadsOutsideWorkingDirectories` already denies all of home, `/mnt` (WSL's `C:`) and `/Volumes`, for both the sandbox and the file tools. An explicit list is still needed in three cases:
- the owner doesn't want the home-wide block;
- the block doesn't apply (`filesystem.disabled`, `allowManagedReadPathsOnly`, a glob in the start path);
- credentials live outside home roots, such as `/etc` or a custom `CLAUDE_CONFIG_DIR`.

Harness should write the list as `sandbox.credentials.files` with `mode: "deny"`, not as `filesystem.denyRead`. Deny entries can't be removed by another scope, and the dedicated block is self-documenting. [sbx]

| Entry (sandbox path) | Covers | Breaks if denied |
|---|---|---|
| `~/.ssh` | Keys, `config`, `known_hosts` | git over SSH. It already fails on macOS inside the sandbox; on Linux it needs the key file readable. Deny only `~/.ssh/id_*` if SSH must work, since `known_hosts`/`config` are needed. The agent socket (`SSH_AUTH_SOCK`) is a Unix socket, governed by socket rules, not `denyRead` |
| `~/.aws` | `credentials`, `config`, `sso/cache`, `cli/cache` | `aws` CLI and SDKs |
| `~/.config/gcloud` | Credential DB, ADC JSON | `gcloud`/`gsutil`/`bq`, ADC client libraries |
| `~/.azure` | Token cache, profile | `az` |
| `~/.kube` | `config` | `kubectl`, `helm` (also any file named in `KUBECONFIG`) |
| `~/.docker/config.json` | `auths` (base64 creds) | Private registry pull and push. Denying the whole dir also loses contexts |
| `~/.npmrc`, `~/.yarnrc.yml`, `~/.bunfig.toml`, `~/.config/pnpm` (Linux) / `~/Library/Preferences/pnpm` (mac) | Registry tokens | Private-registry installs, `npm publish` |
| `~/.pypirc`, `~/.config/pip` / `~/Library/Application Support/pip`, `~/.config/pypoetry` / `~/Library/Application Support/pypoetry`, `~/.local/share/uv/credentials` | Index tokens, URLs with creds | `twine upload`, private indexes |
| `~/.config/gh`, `~/.config/hub` | `hosts.yml` (only when gh fell back to plaintext) | `gh`, and git HTTPS through `gh auth git-credential` |
| `~/.git-credentials`, `~/.config/git/credentials`, `~/.gcm/store`, `~/.password-store` | git `store` helper, GCM plaintext/gpg | git HTTPS through those helpers |
| `~/.netrc` | curl, uv, Heroku | `curl -n`, uv index auth |
| `~/Library/Keychains`, `~/.local/share/keyrings`, `~/.local/share/kwalletd` | Keychain files | See note below: the file deny doesn't stop IPC access |
| `~/Library/Application Support/Google/Chrome`, `~/Library/Application Support/Firefox`, `~/.config/google-chrome`, `~/.config/chromium`, `~/.mozilla` | Cookies, saved logins | Nothing a coding agent needs, unless tests reuse the real profile |
| `~/.cargo/credentials.toml`, `~/.gem/credentials`, `~/.m2/settings.xml`, `~/.gradle/gradle.properties`, `~/.terraformrc`, `~/.terraform.d/credentials.tfrc.json`, `~/.vault-token`, `~/.config/op` | Language and infra tokens | Publish and private-repo flows of each tool. `~/.m2/settings.xml` also holds mirrors |
| `~/.config/anthropic` | Anthropic profiles | A nested `ant`/`claude` |
| WSL2: `/mnt/c/Users` | All Windows-side credentials (`.ssh`, `.aws`, `AppData/Roaming/gcloud`, `AppData/Roaming/GitHub CLI`, …) | Windows-side tool use from WSL. On Linux and WSL2, `/mnt/c/Users/*/.ssh` style globs need care (§2.2); denying `/mnt/c/Users` whole is simplest |

What a file deny can't cover [docs, analysis]:
- **Keychains and keyrings behind IPC.** macOS Keychain items go through securityd, so a folder deny doesn't stop `security find-generic-password`. Whether the sandbox's default Seatbelt profile allows that Mach lookup is UNCONFIRMED. Tools that keep tokens there by default: `gh` ("stored in the system credential store by default", https://cli.github.com/manual/gh_auth_login), Docker Desktop, Poetry, GCM and Claude Code on macOS.
- **WSL interop.** GCM on WSL runs as a Windows `.exe` through interop and stores credentials in Windows Credential Manager. The sandbox blocks interop unless `allowAllUnixSockets` is set. https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/wsl.md ; [sbx]
- **Environment variables** (`GH_TOKEN`, `NPM_TOKEN`, `AWS_*`). Use `sandbox.credentials.envVars` deny, or `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` (which keeps GitHub tokens).
- **The Read tool.** It needs `Read(...)` deny rules or `blockReadsOutsideWorkingDirectories`. `denyRead` alone doesn't stop it.

---

## 5. Q4: server-side controls a repo-scoped agent token can't bypass

### 5.1 Availability

| Feature | Free (public repos) | Private repos | Source |
|---|---|---|---|
| Rulesets (branch and tag) | Yes, on GitHub Free and Free for orgs | Pro, Team, Enterprise Cloud | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets |
| Push rulesets (block file paths, extensions, sizes) | n/a: they target "a private or internal repository" | Plan tier for private personal repos UNCONFIRMED | same |
| Branch protection rules | Yes, public | Pro, Team, Enterprise | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches |
| Branch protection bypass lists | "only when the repository belongs to an organization" | same | same |
| "Restrict who can push" (branch protection) | Public repos of a Free **org**, all repos of Team and Enterprise Cloud orgs. Not personal repos | same | same |
| CODEOWNERS | Yes, public | Pro, Team, Enterprise | https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners |
| Required reviewers rule (per path, in rulesets) | "isn't available on user-owned repositories because they don't contain teams" | same | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets |

Rulesets layer with branch protection, and "the most restrictive version of the rule applies". In rulesets, admins are bound unless they are listed in the bypass list. Branch protection exempts admins unless "Do not allow bypassing the above settings" is on. [docs] about-rulesets, about-protected-branches.

Bypass actors ([docs] https://docs.github.com/en/rest/repos/rules):
- `actor_type` can be `Integration`, `OrganizationAdmin`, `RepositoryRole`, `Team`, `DeployKey` or `User`.
- `bypass_mode` can be `always`, `pull_request` or `exempt`.
- `OrganizationAdmin` "is not applicable for personal repositories".

### 5.2 Rules that bind the agent

From https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets:

- **Require a pull request before merging**, with:
  - required approvals of at least 1;
  - `require_code_owner_review`;
  - dismiss stale approvals;
  - `require_last_push_approval` ("approval from someone other than the last person to push");
  - require conversation resolution.
- **Require status checks to pass**, with the check pinned to an app:
  - "Any person or integration with write permissions to a repository can set the state of any status check … you can select an app … as the expected source … If the status is set by any other person or integration, merging won't be allowed." [docs] about-protected-branches
  - In the REST API this is `integration_id` on each required check. [docs] rest/repos/rules
- **Block force pushes** and **Restrict deletions**. Both are on by default in rulesets.
- **Restrict updates/creations** on the default branch, so only bypass actors push there.
- **Push ruleset → Restrict file paths.** It could block `.harness/**` and `.github/**` for everyone without bypass, but **private and internal repos only**.

### 5.3 CODEOWNERS plus required review

From https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners:
- **Location.** GitHub uses `.github/`, then the root, then `docs/`, taking the first `CODEOWNERS` it finds. PRs use the copy on the **base branch**.
- **Owners need write access.** Owners "must have write permissions", and a user or team without that access is silently not assigned. An invalid line is skipped.
- **Protect the file itself.** "To protect a repository fully … define an owner for the CODEOWNERS file itself", e.g. `/.github/ @owner_username`.
- **It enforces nothing alone.** CODEOWNERS only gates merges when "Require review from Code Owners" is on in a ruleset or branch protection.

**Single-maintainer deadlock [analysis].**
- GitHub doesn't let a PR's author approve it.
- If the agent pushes and opens PRs with the owner's own token, the owner is the author and can't satisfy required approvals.
- The only escape is putting the owner in the bypass list, which also lets the agent bypass, because the agent uses the owner's identity.
- So the agent needs a **separate identity**. Copilot's model matches this: the requester "cannot approve" the agent's PR. https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations

### 5.4 Minimal token scopes

The goal is an agent that pushes branches and opens PRs, but can't merge or change settings. Mapping from https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens:

| Permission | Grant | Why |
|---|---|---|
| Metadata | Read | Mandatory |
| Contents | **Read and write** | git push over HTTPS. **Also allows** `PUT /pulls/{n}/merge` (listed under Contents), so only rulesets stop a merge |
| Pull requests | Read and write | Create and update PRs. It also allows `POST /pulls/{n}/reviews`; the agent can't approve its own PR |
| Issues | Optional, read and write | Comments and labels |
| Workflows | **None** | Without it, the token can't change `.github/workflows`. For apps: "If your app specifically needs to access or edit Actions files in the `.github/workflows` directory, request the 'Workflows' repository permission." (https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app). The same refusal on a fine-grained PAT `git push` is UNCONFIRMED in docs; it needs a live check |
| Administration | **None** | Rulesets and branch protection endpoints need it |
| Commit statuses, Checks | **None** | Stops the agent posting a fake `harness-verify` status |
| Actions, Secrets, Variables, Environments, Webhooks | **None** | |

Identity options:
- **GitHub App installation token (recommended).**
  - It "will expire after 1 hour".
  - It can be narrowed per request with `repositories` and `permissions`.
  - It can't exceed what the app was granted.
  - [docs] https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
  - The app is a distinct author, so the owner can approve.
  - Minting the token needs the app's private key, which must stay outside the agent's reach (host keychain, or a CI secret used in a step before the agent starts).
- **Fine-grained PAT of a machine user.**
  - "Only select repositories". The expiry is 1–366 days or none. The default is 30 days.
  - GitHub removes tokens unused for a year.
  - [docs] https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
  - It is long-lived. Whether GitHub's terms allow a free machine account is UNCONFIRMED here.
- **The owner's fine-grained PAT.** The weakest option: it is the same identity as the reviewer (§5.3).
- **`GITHUB_TOKEN` in Actions.**
  - "events triggered by the `GITHUB_TOKEN` will not create a new workflow run". PRs it opens run CI only after a human approves.
  - So the required check won't run by itself. Claude's action docs say to use the app or a custom app token for this reason.
  - The repo setting "Allow GitHub Actions to create and approve pull requests" should stay **off**.
  - [docs] https://docs.github.com/en/actions/concepts/security/github_token ; https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository ; https://code.claude.com/docs/en/github-actions
- **Not the official Claude GitHub App.**
  - Its fixed set includes Workflows read and write, Actions read and write, Repository hooks read and write, Checks read and write, and Administration read.
  - "GitHub doesn't let you accept a subset."
  - Anthropic suggests a custom app with Contents, Issues and Pull requests.
  - [docs] https://code.claude.com/docs/en/github-actions "GitHub App permissions"
- **Cloud credentials in CI.** Use GitHub OIDC rather than stored secrets: https://docs.github.com/en/actions/concepts/security/openid-connect. Claude's action supports OIDC workload identity federation (`id-token: write`). [docs] github-actions

### 5.5 Making `harness-verify` hard to fake

- **Pin the source.** Pin the required check's `integration_id` to the app that runs it. For an Actions workflow that is GitHub Actions' app. Harness can read the id from an existing check run (`GET /repos/{o}/{r}/commits/{ref}/check-runs`, field `app.id`) rather than hard-coding it. [docs] https://docs.github.com/en/rest/checks/runs
- **The PR's own workflow file runs.** `pull_request` workflows run from the PR merge ref (`refs/pull/N/merge`). [docs] https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
  - The agent's token must therefore lack Workflows, so it can't rewrite the workflow.
  - `.github/` must be under CODEOWNERS review.
  - The workflow should run a **pinned** harness from the registry (`npx @khubaibqaiser/harness@<ver>`), not the PR's own `node_modules`.
  - It should read verify config from the base branch.
  - This matches done-contract verdict §3 C.
- **No skippable jobs.** Required jobs must have no job-level `if:` that can skip them (already in the done-contract verdict).

### 5.6 Can `gh` set this up idempotently?

- `gh ruleset` has only `list`, `view` and `check`. [docs] https://cli.github.com/manual/gh_ruleset
- Writes need `gh api`:
  - `GET /repos/{o}/{r}/rulesets`, then match on `name`.
  - `PUT /repos/{o}/{r}/rulesets/{id}`, or `POST` when there is none. Ruleset history endpoints exist for audit.
  - [docs] https://docs.github.com/en/rest/repos/rules
- Branch protection's `PUT /branches/{b}/protection` is a full replace, so it is idempotent by nature. It needs Administration, and supports `enforce_admins` and per-check `app_id`. [docs] https://docs.github.com/en/rest/branches/branch-protection
- The setup must run with the **owner's** credentials (Administration write), never the agent's.

---

## 6. Q5: outbound allowlists

### 6.1 What Claude Code itself needs

From [docs] https://code.claude.com/docs/en/network-config ("Network access requirements"):

- **Required for a Claude subscription:**
  - `api.anthropic.com` (API, WebFetch domain check, feature flags, telemetry event logging)
  - `claude.ai`
  - `platform.claude.com` (OAuth exchange and refresh)
- **Conditional:**
  - `claude.com`, `sso.claude.com`: browser sign-in and SSO
  - `mcp-proxy.anthropic.com`: claude.ai connectors (off with `ENABLE_CLAUDEAI_MCP_SERVERS=false`)
  - `downloads.claude.ai`: native installer, updater, plugin executables
  - `registry.npmjs.org`: npm install of Claude Code, plugins, `npx` MCP servers
  - `github.com`: plugin marketplaces
  - `raw.githubusercontent.com`: changelog, interactive only
  - `storage.googleapis.com`: plugin counts; installer before 2.1.116
  - `*.frame.claudeusercontent.com`: Artifact tool
  - `bridge.claudeusercontent.com`: Chrome extension
  - `code.claude.com`: docs lookups
  - `formulae.brew.sh`: Homebrew update check
- **Optional telemetry:** `http-intake.logs.us5.datadoghq.com` and `browser-intake-us5-datadoghq.com` (off with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`).
- **With an API key instead of OAuth**, `claude.ai` and `platform.claude.com` can be dropped. [docs] sandbox-environments "Sandbox runtime"
- **Note:** the in-session sandbox allowlist governs Bash children, not Claude Code's own API calls. This list matters for the container firewall and `srt`, not for `sandbox.network.allowedDomains`. [analysis]

### 6.2 Package registries

GitHub's Copilot "recommended allowlist" is the best primary list. [docs] https://docs.github.com/en/copilot/reference/copilot-allowlist-reference

| Ecosystem | Minimal hosts |
|---|---|
| npm, yarn, pnpm | `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com`, `nodejs.org` |
| Python | `pypi.org`, `files.pythonhosted.org` |
| Rust | `index.crates.io`, `static.crates.io`, `static.rust-lang.org` |
| Go | `proxy.golang.org`, `sum.golang.org` |
| Ruby | `rubygems.org`, `index.rubygems.org` |
| Java | `repo.maven.apache.org`, `repo1.maven.org`, `services.gradle.org`, `plugins.gradle.org` |
| Containers | `ghcr.io`, `registry-1.docker.io` (covered by `*.docker.io`), `auth.docker.io`, `production.cloudflare.docker.com` |
| GitHub (HTTPS git, `gh`) | `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com` |

Trade-off: any GitHub entry re-opens the exfiltration path the docs warn about ([sbx] warning on `github.com`). Without `tlsTerminate`, the allowlist can't restrict *which* repo or account the traffic reaches. Codex cloud's legacy option to limit HTTP methods to GET/HEAD/OPTIONS is a mitigation pattern Claude Code's proxy doesn't document (§7).

---

## 7. Q6: prior art (primary sources only)

**OpenAI Codex CLI** ([docs] https://learn.chatgpt.com/docs/agent-approvals-security , https://learn.chatgpt.com/docs/sandboxing , https://learn.chatgpt.com/docs/config-file/config-advanced):
- **Mechanism.** An OS process sandbox: Seatbelt on macOS, bubblewrap plus seccomp on Linux.
- **Modes.** `sandbox_mode` is `read-only`, `workspace-write` (the default) or `danger-full-access`.
- **Filesystem.** In `workspace-write`, **`.git` is read-only**, and so are `.agents`, `.codex` and `.aws`.
- **Network.** Off by default locally. `[sandbox_workspace_write] network_access` turns it on.
- **Env vars.** `shell_environment_policy` filters env vars. Its docs say `ignore_default_excludes` defaults to `true` (KEY, SECRET, TOKEN vars *not* stripped), which conflicts with blogs. Verify in source.
- **Windows.** A native sandbox, docs https://learn.chatgpt.com/docs/windows/windows-sandbox:
  - MXC on Windows 11 24H2 and later;
  - an `elevated` fallback with sandbox users and firewall rules;
  - an `unelevated` fallback with a restricted token and ACLs, and no deny-read.

**Codex cloud** (https://learn.chatgpt.com/docs/environments/cloud-environments):
- A VM per task, with egress through a CONNECT proxy and presets ("Package managers" plus extra domains).
- "Network secrets" are placeholders swapped in by the proxy, the same idea as Claude Code's `mask`.
- The legacy version blocked the network during the agent phase and removed secrets after setup.

**GitHub Copilot coding agent** (https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall , https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations):
- **Where it runs.** An ephemeral Actions runner. The firewall is on by default, with a recommended allowlist.
- **Firewall limits, as documented.** It covers only processes the agent starts through Bash. It does not cover MCP servers or setup steps. It "should not be considered a comprehensive security solution". It is unsupported on self-hosted and Windows runners.
- **Git model.** It pushes only to one `copilot/` branch, "cannot directly run `git push`", and can't approve, merge or mark ready.
- **Gates.** Its PR workflows need a human "Approve and run workflows". Requesters can't approve its PRs. Only users with write access can trigger it, and hidden characters are filtered.
- **Secrets.** Only "Agents" secrets reach it.

**Devin** (https://docs.devin.ai/enterprise/deployment/overview , https://docs.devin.ai/integrations/gh , https://docs.devin.ai/product-guides/secrets):
- A VM per session, reset from a snapshot. Enterprise deployment options exist.
- The GitHub App gets read and write on contents, PRs, **workflows**, actions and checks. The docs tell you to set up branch protection "before Devin can merge".
- Session secrets are scoped to the session.
- No per-session egress allowlist was found for cloud sessions.

**Cursor cloud agents** (https://cursor.com/docs/cloud-agent , https://cursor.com/docs/cloud-agent/security-network):
- Isolated VMs.
- "The agent has internet access by default". The modes are Allow all, Default plus allowlist, and Allowlist only; Cursor and SCM domains stay open even then.
- It auto-runs terminal commands. The docs warn prompt injection could make it "upload code to malicious websites".
- The GitHub app is read and write. No merge restriction is documented.

**Gemini CLI** (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/sandbox.md): an opt-in sandbox, either Seatbelt profiles (`permissive-open` default) or a Docker/Podman image.

**Recurring patterns:**
- An OS sandbox locally, and a disposable VM or runner in the cloud.
- Egress as a hostname allowlist with a registries preset. Every vendor admits it can be bypassed.
- Secrets kept out of the agent's environment by proxy substitution.
- The git surface as the real boundary. Copilot is the strictest: one branch, no merge, workflow runs gated by a human.

---

## 8. Threat framing (OWASP)

From the OWASP Top 10 for Agentic Applications 2026 (published 2025-12-09; launch post https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/):

| OWASP entry | How it maps to the layers |
|---|---|
| ASI01 Agent Goal Hijack (prompt injection) | The trigger for a "drifted agent" |
| ASI02 Tool Misuse | Mitigated by the token scope and rulesets |
| ASI03 Identity and Privilege Abuse ("leaked credentials let them operate far beyond their intended scope") | Mitigated by `denyRead`, env scrub and the short-lived app token |
| ASI05 Unexpected Code Execution | Mitigated by the container and sandbox |

The full entry list was not readable on the resource page (download only), so it is partly UNCONFIRMED. The OWASP LLM Top 10 entry LLM06:2025 Excessive Agency names its causes as "excessive functionality; excessive permissions; excessive autonomy". https://genai.owasp.org/llmrisk/llm062025-excessive-agency/

NIST SP 800-190 (Application Container Security Guide) applies to the container layer: https://csrc.nist.gov/pubs/sp/800/190/final. I did not extract specific controls from it. CISA guidance was not researched.

---

## 9. Gaps (not confirmed)

1. Whether Claude Code's default macOS Seatbelt profile allows the securityd Mach lookup, i.e. whether `security find-generic-password` (and `gh` with keyring storage) works inside the sandbox.
2. What `blockReadsOutsideWorkingDirectories` breaks for toolchains installed under home (`~/.nvm`, `~/.volta`, `~/.pyenv`, `~/.cargo/bin`, `~/.local/bin`, `~/.npm` cache). The docs list what is re-opened; toolchain dirs are not on it. This needs a live check.
3. Whether a fine-grained PAT without the Workflows permission is refused on `git push` of `.github/workflows` changes. It is documented for apps only.
4. Plan tier for push rulesets on *personal* private repos.
5. Whether rulesets on a personal repo accept a `RepositoryRole` admin bypass in `pull_request` mode (the API says `OrganizationAdmin` doesn't apply; nothing more).
6. An `IS_SANDBOX` env var for running as root in containers: third-party mention only.
7. IPv6 behaviour of the reference firewall under a Docker daemon with IPv6 on.
8. Whether GitHub's terms permit a free machine account per human for agent use.
9. The exact credential file names inside `~/.config/gcloud` and `~/.azure`, Terraform's `credentials.tfrc.json` path, and KWallet paths (secondary sources only; deny the whole directories).
10. The Codex `ignore_default_excludes` default (docs vs blogs).
11. The full OWASP Agentic Top 10 list, and specific NIST 800-190 or CISA controls.

---

## 10. Appendix: per-tool credential locations (primary sources)

Columns: path | env override | breaks | source.

- **SSH** | `-i`, `IdentityFile`, `-F`, `UserKnownHostsFile` | key auth, host aliases, host-key check | https://man.openbsd.org/ssh.1
- **AWS** `~/.aws/credentials`, `config`, `sso/cache`, `cli/cache` | `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE` | aws CLI and SDKs | https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html , https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html
- **gcloud** `~/.config/gcloud/`, `application_default_credentials.json` | `CLOUDSDK_CONFIG`, `GOOGLE_APPLICATION_CREDENTIALS` | gcloud, gsutil, bq, ADC | https://docs.cloud.google.com/sdk/docs/configurations , https://docs.cloud.google.com/docs/authentication/application-default-credentials
- **Azure** `~/.azure/` | `AZURE_CONFIG_DIR` | az | https://learn.microsoft.com/en-us/cli/azure/azure-cli-configuration
- **Kubernetes** `~/.kube/config` | `KUBECONFIG` (a list) | kubectl, helm | https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/
- **Docker** `~/.docker/config.json` | `DOCKER_CONFIG` | private registries | https://docs.docker.com/reference/cli/docker/login/
- **npm** `~/.npmrc`, project `.npmrc`, `$PREFIX/etc/npmrc` | `npm_config_userconfig`, `npm_config_globalconfig` | https://docs.npmjs.com/cli/v10/configuring-npm/npmrc
- **pnpm** `auth.ini` in the pnpm config dir | `XDG_CONFIG_HOME` | https://pnpm.io/npmrc
- **Yarn** `.yarnrc.yml` `npmAuthToken` | `YARN_NPM_AUTH_TOKEN` | https://yarnpkg.com/configuration/yarnrc
- **Bun** `~/.bunfig.toml` | `XDG_CONFIG_HOME` | https://bun.com/docs/runtime/bunfig
- **PyPI** `~/.pypirc` | https://packaging.python.org/en/latest/specifications/pypirc/
- **pip** config paths | `PIP_CONFIG_FILE` | https://pip.pypa.io/en/stable/topics/configuration/
- **Poetry** `auth.toml` | `POETRY_CONFIG_DIR` | https://python-poetry.org/docs/repositories/
- **uv** `~/.local/share/uv/credentials/credentials.toml`, `~/.netrc` | `NETRC` | https://docs.astral.sh/uv/concepts/authentication/http/
- **gh** `~/.config/gh` | `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `GH_TOKEN` | https://cli.github.com/manual/gh_help_environment , https://cli.github.com/manual/gh_auth_login
- **hub** `~/.config/hub` | `HUB_CONFIG` | https://hub.github.com/hub.1.html
- **git store** `~/.git-credentials`, `~/.config/git/credentials` | https://git-scm.com/docs/git-credential-store
- **GCM** `~/.gcm/store`, `~/.password-store`, keychain, secretservice | `GCM_CREDENTIAL_STORE`, `GCM_PLAINTEXT_STORE_PATH` | https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/credstores.md
- **netrc** | https://everything.curl.dev/usingcurl/netrc.html ; Heroku https://devcenter.heroku.com/articles/authentication
- **macOS keychain** | https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains
- **Chromium profile dirs** | https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md
- **Firefox profiles** | https://firefox-source-docs.mozilla.org/toolkit/profile/index.html
- **Claude Code** `~/.claude/.credentials.json` (Linux; Keychain on macOS) | `CLAUDE_CONFIG_DIR` | https://code.claude.com/docs/en/authentication
- **Terraform** `~/.terraformrc` | `TF_CLI_CONFIG_FILE`, `TF_TOKEN_<host>` | https://developer.hashicorp.com/terraform/cli/config/config-file
- **Cargo** `$CARGO_HOME/credentials.toml` | `CARGO_REGISTRY_TOKEN` | https://doc.rust-lang.org/cargo/reference/config.html
- **RubyGems** `~/.gem/credentials` | `GEM_HOST_API_KEY` | https://guides.rubygems.org/command-reference/
- **Maven** `~/.m2/settings.xml` | https://maven.apache.org/settings.html
- **Gradle** `$GRADLE_USER_HOME/gradle.properties` | https://docs.gradle.org/current/userguide/build_environment.html
- **1Password CLI** | `OP_CONFIG_DIR` | https://www.1password.dev/cli/config-directories/
- **Vault** `~/.vault-token` | https://developer.hashicorp.com/vault/docs/commands/token-helper
- **WSL automount and interop defaults** | https://learn.microsoft.com/en-us/windows/wsl/wsl-config ; GCM on WSL https://learn.microsoft.com/en-us/windows/wsl/tutorials/wsl-git

---

## 11. Design implications for harness

These are mapped to the owner's layers. Each lists the trade-offs.

### Layer A: server side (binding, out of the agent's reach)

**A1. `harness github protect` (owner-run; Administration needed).** Idempotent through `gh api`: find the ruleset named `harness` and PUT, or POST when there is none. Default-branch ruleset:
- PR required, with 1 approval, code-owner review, last-push approval and dismiss-stale;
- required check `harness-verify` with `integration_id` read from a real check run;
- block force push and restrict deletions;
- empty bypass list, or repo admin in `pull_request` mode (see Q4).

Doctor reads it back with `gh ruleset check <default>`.
- *For:* this is the only layer that binds everyone, the web UI and the owner's own terminal included. It is free on public repos.
- *Against:* private personal repos need Pro. It needs `gh` with admin scope at setup time. A required check blocks merges whenever CI is down.

**A2. CODEOWNERS block.** Write `.github/CODEOWNERS` lines for `/.harness/`, `/.github/`, `/.claude/` and `/CODEOWNERS`, using `project.codeowners` (already collected, today "input only").
- *For:* it is the documented way to protect workflows and harness config.
- *Against:* it is a no-op without A1's code-owner rule. Owners need write access, and a bad owner is skipped silently, so doctor must call the CODEOWNERS errors API.

**A3. Agent identity: `harness github agent-app`, guided.** A manifest flow creates a per-owner GitHub App with Contents read and write, Pull requests read and write, optional Issues read and write, Metadata read, and nothing else. The private key stays on the host or in a CI secret. `harness token` mints a 1-hour installation token narrowed to one repo, for the launcher to pass as `GH_TOKEN`.
- *For:* it is short-lived, it has no Workflows, Statuses or Administration permission, and it is a distinct author, which solves the self-approval deadlock.
- *Against:* it adds setup and a key to guard. It is the most complex part of the spec. A fine-grained PAT on a machine user is the simpler fallback, but long-lived.

**A4. Harden `harness-verify`.** The workflow pins the harness version from npm, reads config from the base ref, has no job-level `if:`, and needs no secrets. Doctor flags:
- a required check not pinned to an app;
- an agent token that has Workflows or Statuses (checked by inspecting `gh api /installation/repositories`, or through PAT introspection where available).
- *Against:* pinning the version means a bump PR for every harness release.

### Layer B: unattended and cloud isolation

**B1. Fix the existing launch command now (small, high value).** Add to the documented `--settings` JSON:
- `network.allowedDomains`, because the repo list is ignored under admin-required;
- `network.strictAllowlist: true`, because `bypassPermissions` otherwise allows any host;
- `sandbox.credentials` deny entries.

Optionally recommend `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. Update `sandbox-required` to also require `strictAllowlist` when the run is `bypassPermissions`, and to treat a non-empty `excludedCommands` from user or `--settings` as unsandboxed.
- *Against:* the launch command grows long, so `harness run` could print or exec it. The scrub also strips env from harness's own hooks; the TDD and stop gates may need a test env var.

**B2. `harness init --container`.** Write `.devcontainer/` derived from Anthropic's reference, with these changes:
- pin `CLAUDE_CODE_VERSION` and set `DISABLE_AUTOUPDATER=1`;
- non-root `node`;
- no host credential mounts;
- firewall changes: drop the TCP 22 rule (HTTPS plus token only), DNS only to Docker's `127.0.0.11`, add `ip6tables -P OUTPUT DROP`, allowlist from `.harness/config.yaml` instead of hard-coded, drop the host /24 unless asked;
- **also turn on Claude Code's sandbox inside it**, with `enableWeakerNestedSandbox: true`, so hostname-level filtering and protected paths (`.git/hooks`, `.git/config`, `.vscode`) apply on top of the IP firewall.

Optionally offer "clone into a container volume" instead of a bind mount, so nothing the agent writes runs on the host.
- *For:* this is Anthropic's recommended boundary for unattended runs, and it covers hooks, MCP and the file tools.
- *Against:*
  - Docker is a dependency.
  - IP-based allowlists drift with CDN rotation.
  - `NET_ADMIN` on the container.
  - `~/.claude` credentials stay exfiltratable, so prefer an API key with a spend cap, or OIDC federation in CI.
  - The weaker nested sandbox exposes `/proc`.
  - Keeping a fork of the reference current is ongoing work.

**B3. Container check for unattended runs.** `sandbox-required` gains a `container` verdict, based on behaviour:
- uid ≠ 0;
- a root-owned `/etc/harness/container` marker that the current uid can't write;
- an egress probe to a non-allowlisted host fails (cached per session).

`HARNESS_CONTAINER=1` from the launcher stays an option, like `HARNESS_SANDBOX=1`.
- *Against:* the probe costs a network timeout once per session, and the person launching the run can fake every signal (accepted in the owner's model).

**B4. Native Windows (owner decision already made).** Change `sandboxVerdict` on `win32` from `unavailable` (allow) to `deny` for unattended shell calls, unless the container verdict passes.
- On WSL2 the hooks see `linux`, so the existing bwrap path applies.
- Point users at WSL2 or `--container`.
- Note srt's Windows alpha as future prior art only.
- *Against:* it breaks today's Windows unattended users. It needs a migration note and a `sandbox: off` escape that is logged.

### Layer C: attended

**C1. Default to `permissions.blockReadsOutsideWorkingDirectories: true` in `.claude/settings.json`.** Under `sandbox: always` first, possibly every mode.
- *For:* one key covers sandboxed Bash *and* Read, Grep and Glob, all of home, `/mnt` (WSL's `C:`) and `/Volumes`, and repos can't lift it. It also keeps `.git-credentials` blocked while git config still works.
- *Against:*
  - It requires v2.1.257 or later.
  - It likely breaks toolchains under home (gap 2) and git over SSH.
  - `gh` with plaintext `hosts.yml` and private npm registries via `~/.npmrc` stop working.
  - The only fix for a broken toolchain is user-level `additionalDirectories`, because repo-level entries don't count.
  - It needs a live check across macOS and Linux before it becomes the default.

**C2. Ship an explicit `sandbox.credentials.files` deny list** (the §4 table) as a fallback, for where C1 is off or doesn't apply, plus `envVars` deny for `NPM_TOKEN`, `AWS_*`, `GH_TOKEN` and similar. Linux-safe paths only: no leading `/**`.
- *For:* deny entries can't be removed by other scopes.
- *Against:* the list is incomplete by nature, and it does nothing for keychain or keyring IPC or WSL interop.

**C3. A network allowlist per detected ecosystem**, written to `sandbox.network.allowedDomains` from the §6.2 table, with GitHub hosts only when HTTPS git is used.
- *For:* it ends the "asks the first time" friction recorded in `NETWORK_NOTE`.
- *Against:* every allowed broad host is an exfiltration path, and project-level entries are ignored under admin-required launches (B1 handles that).

**C4. `harness doctor` credential report.** Report three things:
- credential files from §4 that exist and are readable to sandboxed commands, given the effective `denyRead`, `credentials` and block settings;
- token-shaped env vars present in the session env;
- IPC paths: `gh auth status` showing keyring storage, `SSH_AUTH_SOCK` set, macOS keychain-held tokens, a WSL2 `/mnt/c` mount with interop on.

For each, show what denying it would break.
- *Against:* doctor can't prove the macOS keychain is out of reach (gap 1). It must not read secret values, only check that files exist and are readable.

---

## 12. Questions for the owner

1. **Agent identity for pushes and PRs.**
   - (a) **Recommended:** a per-owner GitHub App with a 1-hour token.
   - (b) A fine-grained PAT on a machine user.
   - (c) The owner's own fine-grained PAT, accepting that required reviews can't be satisfied without a bypass.
2. **Should `blockReadsOutsideWorkingDirectories` be on by default?**
   - (a) **Recommended:** on under `sandbox: always` only, after a live check of toolchains under home.
   - (b) On in every mode.
   - (c) Off, with the explicit deny list only.
3. **Who runs the server-side setup?**
   - (a) **Recommended:** a separate owner-run `harness github protect` command that never runs from the agent's session. The guard denies it in agent Bash.
   - (b) Part of `harness init` when `gh` has admin scope.
4. **Private personal repos without Pro.**
   - (a) **Recommended:** doctor states that server-side enforcement is unavailable and keeps the local layers.
   - (b) Refuse unattended mode there.
5. **Container mount.**
   - (a) **Recommended:** a bind mount with Claude Code's sandbox turned on inside, which protects `.git/hooks`, `.git/config` and `.vscode`.
   - (b) Clone into a container volume, so nothing runs on the host, at the cost of editor friction.
6. **Container firewall mechanism.**
   - (a) **Recommended:** keep the reference iptables/ipset approach, with the fixes in B2, *plus* the in-container Claude sandbox for hostname filtering.
   - (b) Replace iptables with `srt` as the whole-process boundary (beta research preview).
7. **GitHub in the allowlist.** Allowing `github.com` re-opens exfiltration.
   - (a) **Recommended:** allow it only in unattended runs that must push, together with a token scoped to one repo.
   - (b) Always allow it.
   - (c) Never allow it, and push from the host after the run.
8. **The `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` default for unattended launches.**
   - (a) **Recommended:** yes, and document that it keeps `GH_TOKEN` and strips env from harness hooks.
   - (b) No, and use `sandbox.credentials.envVars` only.
9. **Migrating native Windows unattended users (deny instead of today's allow).**
   - (a) **Recommended:** deny in the next minor release, with a doctor fix line and `sandbox: off` as a logged escape.
   - (b) Warn for one release first.
