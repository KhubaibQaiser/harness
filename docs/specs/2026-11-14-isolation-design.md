# Isolation hardening: design

- Status: draft for the owner's review, 2026-11-14. No code.
- Research: [`../research/2026-11-14-isolation.md`](../research/2026-11-14-isolation.md), cited below as "R§n". Its sources were fetched on 2026-11-14; URLs are repeated here where a design choice rests on them.
- Owner decisions: I0 to I11 in `.superpowers/sdd/isolation/decisions.md` (local, not committed). They bind; §1 lists them.
- Prior work, treated as shipped: the unattended launch fix, commit 9a98f50 on `fix/unattended-launch-strict` (I1), with its review fix round (Claude Code login denies, release note, the managed `allowManagedDomainsOnly` false deny, plan mode, a missing `permission_mode`) and I10's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. This spec builds on its `--settings` JSON and its `strictAllowlist` rule in `sandbox-required`, and does not redesign them. "The launch JSON" below means that command's `--settings` value.
- Sequencing: built after the done contract ([`2026-11-13-done-contract-design.md`](2026-11-13-done-contract-design.md)) lands (I0). Layer A depends on its `harness-verify` check.

## 1. Owner decisions

| # | Decision | Where |
|---|---|---|
| I0 | Spec now, build after the done contract. Native Windows unattended runs deny shell unless in WSL2 or a container. | §8, §12 |
| I1 | Launch fix: `strictAllowlist`, allowlist and credential denies in `--settings`; `sandbox-required` enforces `strictAllowlist` under `bypassPermissions`. | Prior work |
| I2 | Agent identity is a per-owner GitHub App: Contents, Pull requests and Metadata only; 1-hour, one-repo tokens. | §5 |
| I3 | `permissions.blockReadsOutsideWorkingDirectories` on by default in **every** mode. Needs a live check and documented fixes. | §7 |
| I4 | Server-side setup is a separate owner-run `harness github protect`; the guard denies it to the agent; doctor reads it back. | §4 |
| I5 | The container bind-mounts the workspace, with Claude Code's sandbox on inside. | §6 |
| I6 | The container boundary is Anthropic's sandbox runtime (`srt`), not iptables. The owner accepts that it is a beta. | §6 |
| I7 | `github.com` is allowed only for runs that push, with the App token. Refresh for runs lasting days. | §5.3, §6.4 |
| I8 | A private repo without Pro gets a plain doctor statement; the local layers stay. | §4.5 |
| I9 | Tokens come from a broker outside the agent. The App key lives in the OS keychain or a CI secret, never in the sandbox or container. Tokens reach the agent through a git credential helper and `gh`, re-minted automatically. | §5 |
| I10 | Unattended launches set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. | Prior work |
| I11 | The native Windows deny ships in the next minor release; doctor gives the fix; `sandbox: off` is the logged escape. | §8 |

I3 and I6 differ from the research's recommendations (R§12 Q2 and Q6). Their risks are stated where they are designed (§6.7, §7.6), not hidden in the limits.

## 2. Threat model

### 2.1 The actor

A Claude Code agent that has drifted or been prompt-injected (OWASP ASI01, R§8, https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/). It runs as the user's uid, with every tool the session allows, in attended or unattended runs. It can write any file the session can write and run any command the sandbox lets through. It cannot change the hooks' code or Claude Code's settings mid-session (protect, `denyWrite`, ConfigChange).

Out of scope: the person who launches the run (they can fake every signal, R§3.4), kernel or sandbox escapes, a compromised Claude Code, `srt` or GitHub, and the person approving a bad PR.

### 2.2 What the agent wants, and which layer answers

| Goal | A: server side | B: container | C: attended local |
|---|---|---|---|
| Land code on the default branch without a person | **Stops it**: PR, code-owner review, last-push approval, required `harness-verify` pinned to its app | No effect | Guard denies push to main and `gh pr merge` (a text check) |
| Fake the verify result | **Stops it**: the App has no Statuses or Checks permission; the check is pinned by `integration_id` | No effect | No effect |
| Rewrite CI or harness config to loosen gates | **Stops it from merging**: the App has no Workflows permission; CODEOWNERS covers `.github/`, `.harness/`, `.claude/` | `.devcontainer/` is read-only to the agent | Protect, `denyWrite`, ConfigChange |
| Steal the user's credentials | No effect | **Stops it**: host credentials are not in the container | Read block, credential denies, env denies, guard. Keychain IPC is a gap (R§9.1) |
| Act as the owner on GitHub | Gives the agent its own identity; no effect if the owner's credentials are reachable | Only the App token is mounted, and only for push runs | Credential-helper overrides and keychain reads are denied (a text check) |
| Exfiltrate code or secrets | No effect | Hostname allowlist; `github.com` only on push runs | Network allowlist; strict in unattended runs (I1) |
| Plant code that later runs on the host | Merges need review | **Partly**: protected paths only; other files in the bind mount reach the host (§6.6) | Protected paths in the sandbox |
| Do damage outside the repo | No effect | **Stops it**: only the workspace is mounted | Sandbox write rules (Bash only) |

### 2.3 What no layer stops

- Exfiltration over an allowed host. The proxy decides on the hostname the client sends, without inspecting TLS, so domain fronting works (R§2.4, https://code.claude.com/docs/en/sandboxing "Security limitations").
- Misuse of the App token inside its scope: pushing any non-default branch, opening and closing PRs, misleading PR text. The token reaches the agent by design, because the agent pushes with it.
- Hooks, MCP servers, LSP servers and WebFetch run outside Claude Code's sandbox (R§2.4). In the container they are inside `srt`; on the host they are not.
- A person who approves a bad PR, changes the ruleset in the web UI, or sets `sandbox: off`.

### 2.4 The binding layer

**Layer A binds.** It is the only layer that holds whatever happens on the machine, because GitHub enforces it and the agent's identity can't change it. Layers B and C shrink the blast radius on a machine the user controls, and the user can always turn them off. Where Layer A is unavailable (a private repo without Pro, I8), nothing binds, and doctor says so in those words.

## 3. Components at a glance

| Layer | Component | New or changed |
|---|---|---|
| A | `harness github protect` (ruleset through `gh api`) | New command |
| A | CODEOWNERS block from `project.codeowners` | Init, update and uninstall |
| A | Ruleset and CODEOWNERS read-back | Doctor, status |
| A | `harness github app` (manifest flow, key storage) | New command |
| A | `harness github broker` (mints and refreshes tokens) | New command |
| B | `harness init --container`: `.devcontainer/harness/` with `srt` | New install output |
| B | Container verdict in `sandbox-required`; `isolation.container` | Changed check |
| C | `blockReadsOutsideWorkingDirectories`, credential denies, ecosystem allowlist in `.claude/settings.json` | `mergeSettings` |
| C | Credential and toolchain report | Doctor |
| — | Native Windows deny | `sandbox-required` |
| — | Guard additions | Guard, protect |

## 4. Layer A: server-side protection

### 4.1 `harness github protect [--dry-run] [--yes]`

- Run by the owner, in their own terminal, with their own `gh` login. That login needs the admin role on the repo. The guard denies it to the agent in every mode (§9.5).
- Reads the repo and default branch with `gh repo view --json nameWithOwner,defaultBranchRef,visibility`, validated with the same safe-name patterns as `doctor-protection.ts`.
- `gh ruleset` can't write rulesets (R§0.10, https://cli.github.com/manual/gh_ruleset), so it uses `gh api` (https://docs.github.com/en/rest/repos/rules):
  1. `GET /repos/{o}/{r}/rulesets?includes_parents=false`, then pick the entry with `name == "harness"` and `source_type == "Repository"`.
  2. `GET /repos/{o}/{r}/rulesets/{id}`, then compare the fields harness sets (§4.2) with the desired ruleset. Fields GitHub adds (`id`, `node_id`, `_links`, `created_at`, `updated_at`, `current_user_can_bypass`, `source`) are ignored.
  3. Equal: it prints `harness ruleset on <o>/<r> is up to date` and exits 0, writing nothing.
  4. Different: it prints the field diff. Without `--yes` it asks for a yes, then `PUT /repos/{o}/{r}/rulesets/{id}`.
  5. None: it prints the ruleset, asks, then `POST /repos/{o}/{r}/rulesets`.
  6. It re-reads the ruleset and compares again. A mismatch exits 1.
- `--dry-run` stops after the diff.
- Rulesets with other names are never touched. A hand-edited `harness` ruleset is drift, and protect restores it after showing the diff.
- Ruleset JSON goes to `gh api --input -` on stdin, never on the command line.

### 4.2 Ruleset contents

```json
{
  "name": "harness",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [ { "context": "harness-verify", "integration_id": 0 } ] } }
  ]
}
```

- Each rule and why it binds is in R§5.2 (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).
- **Required check.** `integration_id: 0` above stands for the id read below. The `required_status_checks` rule is added only when the `harness-verify` CI item (done contract §4.7) is installed. `integration_id` is read from a real check run: `GET /repos/{o}/{r}/commits/{default}/check-runs?check_name=harness-verify`, field `app.id` (R§5.5, https://docs.github.com/en/rest/checks/runs). With the item installed but no check run yet, protect exits 1 (§10.2). Without the item, protect prints that merges won't require `harness-verify` and how to add it.
- **No bypass actors.** In rulesets, admins are bound unless listed (R§5.1). The owner merges by approving the App's PRs (§5), so nobody needs a bypass. The owner can still change the ruleset in the web UI, which is a known limit.
- Field names are pinned by a unit test against the REST docs' example payload in PR 7, because the research did not fetch the full schema.

### 4.3 CODEOWNERS from `project.codeowners`

- `project.codeowners` changes from "input only" to the owners harness writes. Each entry must match `^@[A-Za-z0-9-]+(/[A-Za-z0-9._-]+)?$`. The interview proposes the repo owner's login when the list is empty.
- Init, update and sync write a marked block, recorded in the manifest like other merged blocks. It goes into the first of `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` that exists, because GitHub reads only the first one (R§5.3, https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners). With none, it creates `.github/CODEOWNERS`.
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
- The block sits at the end of the file, because the last matching line wins in CODEOWNERS.
- Uninstall removes the block. An empty `project.codeowners` writes no block, and protect then notes that `require_code_owner_review` has no owners to require.
- The CODEOWNERS file itself is added to protect's table and `denyWrite`, so the agent can't edit it locally. Any change to it goes through code-owner review, because PRs use the base branch's copy.

### 4.4 Doctor read-back and drift

Doctor builds the same desired ruleset as protect, from the same function, then reads:

| Read | Result line |
|---|---|
| The ruleset equals the desired one | ok: `harness ruleset on <branch> is active and matches` |
| Fields differ | fix: `harness ruleset differs from harness's: <fields>` → `run harness github protect in your own terminal` |
| No ruleset named `harness` | fix: `no harness ruleset on <branch>` → same fix |
| `enforcement` is not `active` | fix: `harness ruleset is <evaluate/disabled>` → same fix |
| `gh` missing, not signed in, or no read access | note: `server-side protection unknown (<reason>)` |
| Private repo, rulesets unavailable on the plan | statement (§4.5) |
| `GET /repos/{o}/{r}/codeowners/errors` returns errors | fix: one line per error, with path and line |
| An owner in `project.codeowners` lacks write access | fix: `<owner> can't own code (no write access); GitHub skips them silently` |

- The CODEOWNERS errors endpoint is https://docs.github.com/en/rest/repos/repos#list-codeowners-errors. It was not fetched in the research, so PR 8 confirms it.
- The existing `branchProtection` check stays. Either a branch protection rule or the ruleset satisfies "protected".
- All `gh` output is treated as untrusted, as in `doctor-protection.ts`: size limits, control characters stripped, an args array and never a shell.
- `harness status` prints one line: `Server side: harness ruleset ok | drift | missing | unknown | unavailable (private repo without Pro)`.

### 4.5 Private repos without Pro (I8)

- Detection: `visibility` is `private` and the rulesets API returns 403 with an upgrade message. A 403 without that context is "unknown", never "unavailable".
- Protect exits 1 and changes nothing (§10.2).
- Doctor prints this statement, not a fix: `Server-side protection is unavailable: GitHub needs Pro, Team or Enterprise for rulesets on private repos. Nothing on GitHub stops a merge; harness's local layers stay on, and they can be bypassed.`
- The local layers are unchanged. The App still gives the agent its own identity, but without rulesets its Contents write can merge through the API (R§0.8). Only the guard's text checks stop that.

## 5. Layer A: agent identity

### 5.1 The App (I2)

`harness github app create [--org <org>] [--ci-secret]` runs the manifest flow (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest, not fetched in the research; PR 9 confirms the fields):

1. It starts an HTTP server on `127.0.0.1` on a random port, with a random `state` value.
2. It opens a local page that POSTs the manifest form to `https://github.com/settings/apps/new?state=<state>`, or `/organizations/<org>/settings/apps/new` with `--org`.
3. The manifest:
   ```json
   {
     "name": "<login>-harness-agent",
     "url": "https://github.com/KhubaibQaiser/harness",
     "hook_attributes": { "url": "https://github.com/KhubaibQaiser/harness", "active": false },
     "redirect_url": "http://127.0.0.1:<port>/callback",
     "public": false,
     "default_permissions": { "contents": "write", "pull_requests": "write", "metadata": "read" },
     "default_events": []
   }
   ```
   Names are cut to GitHub's 34-character limit. On a name clash it adds `-2`, `-3` and so on.
4. GitHub redirects to `/callback?code=…&state=…`. A wrong `state` exits 1. Harness calls `POST /app-manifests/{code}/conversions` and receives `id`, `slug` and `pem`.
5. It stores `pem` (§5.2), writes `github.app.id` and `github.app.slug` to `.harness/config.yaml`, and prints the install URL `https://github.com/apps/<slug>/installations/new`. The owner installs the App on selected repositories only.
6. It polls `GET /repos/{o}/{r}/installation` with the App JWT for up to 10 minutes, then checks the installation's permissions (§5.3).
7. With `--ci-secret` it also runs `gh secret set HARNESS_APP_KEY` with the key on stdin, after its own yes.

Permissions, from R§5.4 (https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens):
- **Granted:** Contents write, Pull requests write, Metadata read.
- **Not granted:** Issues, Workflows, Administration, Commit statuses, Checks, Actions, Secrets, Variables, Environments, Webhooks.
- The missing Workflows permission blocks pushes that touch `.github/workflows` (R§5.4, https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app). The missing Statuses and Checks permissions block a fake `harness-verify`.
- The App is a separate PR author, so the owner can approve its PRs. This ends the self-approval deadlock (R§5.3).
- Not the official Claude GitHub App, which holds Workflows, Actions and hooks (R§5.4, https://code.claude.com/docs/en/github-actions).

### 5.2 Where the key lives

| Where | Store | Read by |
|---|---|---|
| macOS | Login keychain, generic password, service `harness-github-app`, account `<app id>`, through `security add-generic-password` | `harness github broker` |
| Linux with Secret Service | `secret-tool store --label harness service harness-github-app account <app id>` | broker |
| Linux without Secret Service (headless, WSL2) | `~/.config/harness/app-<id>.pem`, mode 0600 in a 0700 folder. Covered by the read block and by a credentials deny entry (§7.3) | broker |
| Native Windows | Not supported: `app create` exits 1 with "Use WSL2" | — |
| Container | **Never inside.** The broker runs on the host | — |
| CI | Repository or environment secret `HARNESS_APP_KEY`, piped to the broker on stdin (§5.5) | broker |

- The key never goes into an environment variable, a command-line argument or the repo.
- Harness signs the App JWT with `node:crypto` (RS256, `iat` 60 seconds in the past, 9-minute expiry), with no new dependency.

### 5.3 The broker: `harness github broker [--repo <o/r>] [--key-stdin] [--env]`

The broker is a separate long-running process that the person starts outside the agent's session. It is the only code that reads the key.

- **Lifecycle.** It runs until it gets SIGINT or SIGTERM. On exit it revokes the token (`DELETE /installation/token`), deletes the token files, and exits 0.
- **Minting.** `POST /app/installations/{id}/access_tokens` with `{"repositories": ["<name>"], "permissions": {"contents": "write", "pull_requests": "write"}}`, which narrows each token to one repo (R§5.4, https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
- **Exact permissions, fail closed.** On every mint it compares the response's `permissions` with exactly `{contents: write, pull_requests: write, metadata: read}`. Anything extra, such as an Issues or Workflows permission added later in the web UI, exits 1 (§10.2) and deletes the token files. It also requires the response's `repositories` to be exactly the named repo.
- **Transport: files in a token folder,** never a socket.
  - Folder: `/tmp/harness-<user>/gh/<owner>-<repo>/`, mode 0700. The broker refuses to start, exit 1, if the folder exists with another owner or looser modes, or is a symlink.
  - Files, each written to a temporary name and then renamed:
    - `hosts.yml`, in `gh`'s format: `github.com: {oauth_token, user: <slug>[bot], git_protocol: https}`. Mode 0600.
    - `token`, the bare token. Mode 0600.
    - `expires`, the expiry as epoch seconds.
    - `meta.json`: `{repo, app_slug, permissions, expires_at, minted_at}`, with no token. Doctor reads it.
    - `git-credential`, a POSIX `sh` helper of about ten lines (§5.4). Mode 0700.
  - **Reaching it.** On the host nothing needs allowing: the agent's tree only reads the folder. In the container the host folder is mounted read-only at `/run/harness/gh`, and only `srt-push.json` lets the tree read it (§6.3).
  - Why files: Unix sockets need `allowUnixSockets`, which the docs warn can escalate (R§2.4). Loopback is refused by the local-address guard (R§2.1). A file needs only read access. `/tmp` and `/run` are not among the roots the read block closes (R§0.3), so no allow rule is needed. Whatever transport is used, the token reaches the agent, because git needs it.
- **Refresh for runs lasting days (I7).** A 60-second loop re-mints when less than 15 minutes are left, so a laptop that wakes from sleep catches up within a minute. A failed mint retries with backoff (5 s, 10 s, 20 s … up to 5 minutes) until the token expires, logging each failure to stderr. At expiry the broker deletes `hosts.yml` and `token`, and keeps retrying. The token is never extended past GitHub's expiry.
- **Logging.** Each mint logs time, expiry and repo to stderr and to `.harness/logs` as a `token-minted` event. The token is never logged.
- **`--env`** prints the environment block for the launcher (§5.4) and exits. It prints no secret.
- **`--key-stdin`** reads the PEM from stdin instead of the keychain (CI, §5.5).

### 5.4 How the agent uses the token

The launcher (the person's command, or `harness-run` in the container) sets:

```sh
GH_CONFIG_DIR=<token folder>                 # gh reads hosts.yml from here on every call
GIT_TERMINAL_PROMPT=0
GIT_CONFIG_COUNT=2
GIT_CONFIG_KEY_0=credential.helper            GIT_CONFIG_VALUE_0=
GIT_CONFIG_KEY_1=credential.https://github.com.helper  GIT_CONFIG_VALUE_1=<token folder>/git-credential
```

- The empty `credential.helper` resets the helper list, so the owner's own helpers (osxkeychain, GCM, `store`) are never asked (https://git-scm.com/docs/git-credential-store and gitcredentials). Live check L3 confirms this with `GIT_TRACE`.
- `git-credential` answers `get` only. It compares `expires` with `date +%s`. With 5 minutes or more left it prints `username=x-access-token` and the token. Otherwise it prints the §10.2 message to stderr and exits 1, so git fails rather than prompting.
- `gh` reads `hosts.yml` fresh on each call, so refreshed tokens apply to a running session. `GH_TOKEN` stays denied (launch JSON), and `GH_CONFIG_DIR` is not a credential variable.
- Commit authorship is unchanged (the local git identity). The App is the pusher and the PR author.

**Fail closed.** When the broker is down or unreachable, the token goes stale within an hour, both `gh` and git fail with a visible error, and nothing falls back to the owner's credentials. Local work continues. The run's done verdict is decided in CI, so it is unaffected.

### 5.5 CI

Documented workflow steps (docs only; harness ships no agent-run workflow):

```yaml
permissions: { contents: read }
steps:
  - uses: actions/checkout@<sha>
    with: { persist-credentials: false }   # else GITHUB_TOKEN sits in .git/config and the agent pushes with it
  - run: npm i -g @khubaibqaiser/harness@<pinned>
  - name: Start the broker (key on stdin only)
    env: { HARNESS_APP_KEY: "${{ secrets.HARNESS_APP_KEY }}" }
    run: |
      printf '%s' "$HARNESS_APP_KEY" | env -u HARNESS_APP_KEY harness github broker --repo "$GITHUB_REPOSITORY" --key-stdin &
      harness github broker --env --repo "$GITHUB_REPOSITORY" >> "$GITHUB_ENV"
  - run: <the launch-fix command, with github.com and api.github.com in allowedDomains>
```

- The key exists only in that step's shell, which exits, and in the broker's heap. It is not in the broker's environment, which `/proc/<pid>/environ` would expose to the same uid.
- The agent's Bash runs in its own PID namespace under I10's scrub on Linux (https://code.claude.com/docs/en/env-vars), so it can't see the broker process. Live check L7 confirms that Bash can read neither the broker's `environ` nor its memory.
- Doctor flags a workflow that runs `claude` after a checkout without `persist-credentials: false`.
- Hosted jobs end after 6 hours at most, so CI runs cross at most five refreshes.

### 5.6 Keeping the agent from minting tokens

1. **The key is out of reach.** It is not in the container, not in any environment, and in the keychain or a home file the read block covers. On a macOS host, whether sandboxed Bash can reach the keychain over IPC is unknown (R§9.1); L2 settles it (§15 Q3).
2. **Person-only commands.** The guard denies `harness github <anything>` to the agent (§9.5).
3. **Text checks**, a seatbelt. They deny in every mode, except credential-helper overrides, which ask in attended sessions:
   - keychain and keyring reads: `security find-generic-password`, `find-internet-password`, `dump-keychain`, `export`, and `secret-tool lookup|search`;
   - reads of `~/.config/harness/`;
   - requests to `/app/installations/*/access_tokens` and `/app-manifests/` through `gh api`, `curl`, `wget` or `fetch` in an inline script;
   - credential-helper overrides: `git -c credential.*`, `git config credential.*`, and `GIT_CONFIG_*`, `GIT_ASKPASS`, `SSH_ASKPASS` or `GH_CONFIG_DIR` set inline;
   - writes to `/tmp/harness-*/gh/`.
4. **Sandbox writes.** The token folder is outside the working directory, so sandboxed Bash can't write it anyway.

## 6. Layer B: the container

### 6.1 `/harness:init --container`

- Sets `isolation.container: required` (§9.1) and writes `.devcontainer/harness/`, a named devcontainer configuration, so an existing `.devcontainer/` is left alone. The files are recorded in the manifest. Update re-renders them, and uninstall, or `isolation.container: off` followed by update, removes them.
- Files:
  - `devcontainer.json`
  - `Dockerfile`
  - `srt.json` and `srt-push.json` (the `srt` settings)
  - `claude.json` and `claude-push.json` (the `--settings` for Claude Code inside)
  - `harness-run` (the launcher)
- `.devcontainer/**` joins protect's table and `denyWrite`, and the CODEOWNERS block. The agent can't change its own boundary, and a change takes effect only when a person rebuilds the image.

### 6.2 Derived from Anthropic's reference (R§3.1)

| Reference | Harness | Why |
|---|---|---|
| `FROM node:20` | `node:22-bookworm-slim@sha256:<digest>` | Harness needs Node 22.11; pinned by digest |
| `CLAUDE_CODE_VERSION=latest` | Pinned to the version harness's live checks ran on, never below `MIN_CLAUDE_CODE`, with `DISABLE_AUTOUPDATER=1` | R§3.2, https://code.claude.com/docs/en/devcontainer |
| iptables, ipset, `NET_ADMIN`, `NET_RAW`, sudoers entry, `init-firewall.sh` | **Removed** | I6: `srt` is the boundary |
| — | `bubblewrap`, `socat`, `ripgrep`; `@anthropic-ai/sandbox-runtime@<pin>`; `@khubaibqaiser/harness@<pin>` | `srt`'s Linux dependencies, per its README (https://github.com/anthropics/sandbox-runtime) |
| `USER node`, named volume for `/home/node/.claude` | Kept | `--dangerously-skip-permissions` refuses root |
| `CLAUDE_CONFIG_DIR=/home/node/.claude` | **Dropped**; the default path is the same | The I10 scrub strips `CLAUDE_CONFIG_DIR` from hooks (launch fix review); with the default path, hooks still find it |
| No host credential mounts | Kept | R§3.2 |
| Workspace bind mount | Kept (I5) | §6.6 |
| — | Token folder, read-only: host `/tmp/harness-${localEnv:USER}/gh/<o>-<r>` → `/run/harness/gh` | §6.4 |
| — | `initializeCommand` creates that host folder (mode 0700) | Docker refuses a missing bind source |
| — | Root-owned marker `/etc/harness/container`: `{"harness":"<ver>","image":"harness-devcontainer"}`, mode 0644 | §6.5 |
| — | `ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | Drops the telemetry hosts from the allowlist (R§6.1) |

`<digest>` and `<pin>` are filled in by each harness release, and pins move only then. A unit test fails the release when the Claude Code pin is below `MIN_CLAUDE_CODE`.

### 6.3 `srt` as the whole-process boundary, with Claude's sandbox inside (I5, I6)

```
docker container (no added capabilities, no host credentials)
└─ srt --settings /etc/harness/srt[-push].json          ← boundary for the whole process tree (I6)
   └─ claude -p … --settings /etc/harness/claude[-push].json
      ├─ hooks, MCP servers, LSP servers, WebFetch       ← inside srt, outside Claude's sandbox
      └─ Bash ─ Claude Code's sandbox (nested)            ← protected paths, denyWrite, credential denies (I5)
```

- `harness-run [--push] -- <claude args>`, root-owned at `/usr/local/bin/harness-run`, execs:
  ```sh
  env HARNESS_CONTAINER=1 HARNESS_SANDBOX=1 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 <§5.4 env, push runs only> \
    srt --settings /etc/harness/srt$P.json -- claude "$@" --settings "$(cat /etc/harness/claude$P.json)"
  ```
- The build copies the settings files from `.devcontainer/harness/` to `/etc/harness/`, root-owned. Running `srt` and Claude Code can't write them, and the repo copies are protected.
- `srt.json`:
  - `network.allowedDomains`: the Claude Code hosts for the login in use (`api.anthropic.com`, plus `claude.ai` and `platform.claude.com` for a subscription login, R§6.1, https://code.claude.com/docs/en/network-config), plus the ecosystem hosts (§7.4) and `isolation.network.allow`.
  - `filesystem.allowWrite`: `/workspace`, `/home/node/.claude`, `/tmp`.
  - `filesystem.denyWrite`: `/workspace/.devcontainer`, plus harness's `denyWritePaths()` under `/workspace`.
  - `filesystem.denyRead`: `/run/harness/gh`, so a run without `--push` can't read the token.
- `srt-push.json`: the same, plus `github.com` and `api.github.com`, and without the `/run/harness/gh` deny.
- `claude.json` and `claude-push.json`: the launch JSON with the same allowlist and the read block, plus `enableWeakerNestedSandbox: true` only if live check L4 shows nesting needs it. Exactly which nested keys are needed is §15 Q1.
- `srt`'s settings key names come from its README and are pinned by a test in PR 12. The research did not fetch its full schema.

### 6.4 The allowlist, and GitHub for push runs only (I7)

- One source, `.harness/config.yaml`: `isolation.network.ecosystems` and `isolation.network.allow` (§9.1). The same function renders the repo's `sandbox.network.allowedDomains` (§7.4), the `srt` files and the container's `--settings`.
- `github.com` and `api.github.com` appear only in the `-push` files. Clone and fetch happen on the host, through the bind mount, so a run without `--push` needs no GitHub host.
- A host listed in `isolation.network.allow` that matches `github.com`, `*.github.com`, `*.githubusercontent.com` or `*` is refused by config validation, with the §10.2 message. Without TLS inspection, GitHub is the broad exfiltration route the docs warn about (R§6.2).
- Changing the allowlist means update and then an image rebuild. Doctor inside the container compares `/etc/harness/srt.json` with the rendered file and flags a stale image.

### 6.5 Proving an unattended run is in the container

`sandbox-required` gains a `container` verdict. It is required when `isolation.container: required` and the run is unattended. All of these must hold (R§3.4, R§11 B3):

1. `HARNESS_CONTAINER=1` comes from the launcher. One set by a settings file's `env` is ignored, as for `HARNESS_SANDBOX` today.
2. `process.getuid() !== 0`.
3. `/etc/harness/container` exists, is a regular file owned by uid 0, is not writable by the current uid (`access(W_OK)` fails), and parses with the expected keys.
4. **Egress probe.** At SessionStart (`session-setup`), an HTTPS HEAD to `https://example.com` with a 3-second timeout must fail. The result is cached in session state. A probe that connects means the process tree is not fenced. Config validation keeps `example.com` out of the allowlist.

Hooks run inside `srt`, so the probe tests `srt`'s fence. Any failure, or a probe that never ran, denies unattended shell commands with the §10.2 message naming the failed signal. These signals resist a non-root agent, which can't create root-owned files or lift `srt`'s network fence. They don't resist the person who launches the run, who can fake all four. That matches the existing `HARNESS_SANDBOX=1` claim.

With `isolation.container: available` the verdict is computed and shown in `status`, but not required.

### 6.6 Bind-mount risks (I5)

Everything the agent writes in `/workspace` appears on the host and may run there later (R§0.6).

| Vector | Covered by |
|---|---|
| `.git/hooks`, `.git/config`, `.vscode`, `.idea`, shell startup files, `.gitconfig` in the workspace | Claude Code's sandbox protected paths (R§2.1), for Bash. `srt` likely has the same list (to confirm in L4) |
| `.harness/`, `.claude/settings*.json`, `.devcontainer/` | Protect, `denyWrite`, `srt` `denyWrite` |
| `package.json` scripts, `Makefile`, `.husky/`, `.envrc` (direnv runs it on `cd`), test config, `conftest.py`, `node_modules/.bin` | **Not covered.** They run on the host when the person runs them |
| `.github/workflows` | The App can't push them (§5.1). A local commit still exists on the host |

Mitigations:
- `harness status` on the host lists changes, since the session began, to a fixed host-run list (`.envrc`, `.husky/**`, `package.json`, `Makefile`, `.github/**`, `.git/hooks/**`, `.vscode/**`), extending today's "Harness files last changed during a session" line.
- The docs say: review the diff before running anything from a container run on the host.
- Cloning into a container volume would remove these vectors, but it was declined in I5.

### 6.7 I6 risks, stated plainly

The research recommended keeping iptables and adding the sandbox inside (R§12 Q6). The owner chose `srt`. What that costs:

1. **Beta.** `srt` is a research preview. A bug in it leaves the agent's tree with the container's open network. There is no second fence, because the container has no firewall.
2. **It fences only its own process tree.** VS Code's server, extensions, `postStartCommand` and `devcontainer exec` sessions not started through `harness-run` have unrestricted egress. The reference's iptables fenced every process in the container.
3. **Nesting in Docker is unverified.** `srt`'s bwrap needs user namespaces. Docker's default seccomp profile may refuse them, which can force `enableWeakerNestedSandbox` (it exposes `/proc`, R§11 B2) or a custom seccomp profile. Claude Code's own bwrap nests inside that. Whether its proxy chains through `srt`'s proxy is also unverified. L4 decides (§15 Q1).
4. **Hostname filtering only.** This is the same domain-fronting limit as Claude's sandbox (R§2.4). It is better than IP pinning, which drifts with CDNs (R§3.2).
5. **Claude Code's login is in the container.** `~/.claude` holds it. Claude's sandbox denies `.credentials.json` to Bash (launch fix list), but hooks and MCP servers can read it, and `api.anthropic.com` is always allowed (R§3.2, https://code.claude.com/docs/en/devcontainer).

## 7. Layer C: attended sessions

### 7.1 The read block, in every mode (I3)

- Init, update and sync write `permissions.blockReadsOutsideWorkingDirectories: true` into `.claude/settings.json` in every `sandbox` mode, `off` included, recorded as a set block. `isolation.block_reads: false` removes it; it is a team-wide switch.
- What it does (R§0.3, R§2.2, https://code.claude.com/docs/en/settings-reference):
  - Read, Grep, Glob and LSP refuse paths outside the working directories in every session.
  - With the sandbox on, sandboxed commands lose `/Users`, `/home`, `/root`, `/Volumes`, `/mnt`, `/media`, `/run/media` and `/srv`. The working directories, the session temp folder, the needed parts of `~/.claude` and the global git config are re-opened. `~/.git-credentials` stays blocked.
- Requires v2.1.257. `MIN_CLAUDE_CODE` is already 2.1.295.
- A `true` in any settings file applies, and no user setting can lift it. The person's only fixes are re-opening paths (§7.2), or the team turning off `isolation.block_reads`.

### 7.2 What breaks, and the fixes

| Breaks (sandbox on) | Why | Fix, in the person's `~/.claude/settings.json` |
|---|---|---|
| Node, Python and Ruby from `~/.nvm`, `~/.volta`, `~/.fnm`, `~/.pyenv`, `~/.rbenv`, `~/.asdf`, `~/.local/share/mise`; Rust from `~/.cargo` and `~/.rustup`; `~/.bun`, `~/.deno`, `~/.local/bin`; Linuxbrew `/home/linuxbrew` | The binary can't be read, so it can't run | Fix A, else Fix B, for that folder |
| Caches: `~/.npm`, `~/.cache/pip`, `~/Library/pnpm` and `~/.local/share/pnpm`, `~/go/pkg/mod`, `~/.m2/repository`, `~/.gradle/caches`, `~/.cache/ms-playwright` and `~/Library/Caches/ms-playwright` | Installs refetch or fail; Playwright can't find browsers | Same; or set the tool's cache folder inside the repo |
| git over SSH | `~/.ssh` is blocked. It already fails on macOS inside the sandbox (R§2.4) | HTTPS with the App's helper (§5.4). Re-opening `~/.ssh` would expose the keys |
| `gh` with a plaintext `hosts.yml` | `~/.config/gh` is blocked, and on the credential deny list | Use the App's `GH_CONFIG_DIR` (§5.4). Otherwise `isolation.credentials.allow: ["~/.config/gh"]`, then Fix A for `~/.config/gh`, which exposes the owner's token |
| `gh` with keyring storage | It still reads `~/.config/gh/hosts.yml` for the user name | The same `isolation.credentials.allow` entry, then Fix A for `~/.config/gh/hosts.yml`. It holds no token under keyring storage |
| Private registries through `~/.npmrc`, `~/.pypirc` or `~/.netrc` | Blocked, and on the credential deny list | Remove the path from harness's list with `isolation.credentials.allow` (§7.3), then Fix A. That exposes the token |
| The agent's Read tool on files in other folders | The file-tool block | `permissions.additionalDirectories` for that folder |

- **Fix A (read-only):** `"sandbox": {"filesystem": {"allowRead": ["~/.nvm"]}}`. The docs say repository `allowRead` entries stop counting under the block (R§2.2), which implies user-level ones still count. L1 confirms it.
- **Fix B (documented fallback):** `"permissions": {"additionalDirectories": ["~/.nvm"]}`. It makes the folder a working directory, so the agent can also write there. Use it only when Fix A doesn't work.
- Doctor finds what breaks without probing the sandbox: it resolves `node`, `python3`, `ruby`, `cargo`, `go`, `java`, `bun`, `deno` and the Stop steps' commands on PATH, and checks the known cache folders. For each one under a blocked root, it prints the exact Fix A line.
- With `sandbox: unattended` and an attended session, the sandbox is off, so only the file-tool part applies. That breakage is small.

### 7.3 `sandbox.credentials` fallback list

The read block does not apply under `filesystem.disabled` or `allowManagedReadPathsOnly`, when the start path contains a glob character, or to paths outside the blocked roots (R§4). So init, update and sync also write `sandbox.credentials` deny entries in every mode, merged one block per entry like `denyWrite`. Deny entries can't be removed by another scope (R§2.2, https://code.claude.com/docs/en/sandboxing).

- **`files`**, each `mode: "deny"`. This is the launch fix's list with its review additions, plus R§4. Paths are Linux-safe: no leading `/**` (R§2.2).
  ```
  ~/.ssh  ~/.aws  ~/.config/gcloud  ~/.azure  ~/.kube  ~/.docker/config.json
  ~/.npmrc  ~/.yarnrc.yml  ~/.bunfig.toml  ~/.config/pnpm  ~/Library/Preferences/pnpm
  ~/.pypirc  ~/.config/pip  ~/.config/pypoetry  ~/Library/Application Support/pypoetry  ~/.local/share/uv/credentials
  ~/.config/gh  ~/.config/hub  ~/.git-credentials  ~/.config/git/credentials  ~/.gcm/store  ~/.password-store  ~/.netrc
  ~/Library/Keychains  ~/.local/share/keyrings  ~/.local/share/kwalletd
  ~/.cargo/credentials.toml  ~/.gem/credentials  ~/.m2/settings.xml  ~/.gradle/gradle.properties
  ~/.terraformrc  ~/.terraform.d/credentials.tfrc.json  ~/.vault-token  ~/.config/op  ~/.config/anthropic
  ~/.claude/.credentials.json  ~/.config/harness
  /mnt/c/Users            (WSL2's C: drive; an entry for a missing path has no effect elsewhere)
  ```
  Browser profile folders are left off: they are large, and nothing in a coding run reads them. The read block covers them anyway.
- **`envVars`**, each `mode: "deny"`:
  ```
  NPM_TOKEN NODE_AUTH_TOKEN YARN_NPM_AUTH_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  GOOGLE_APPLICATION_CREDENTIALS AZURE_CLIENT_SECRET ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
  GITHUB_TOKEN GH_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN CARGO_REGISTRY_TOKEN GEM_HOST_API_KEY
  VAULT_TOKEN TF_TOKEN_app_terraform_io
  ```
- `isolation.credentials.allow` names entries harness leaves out (for example `["~/.npmrc"]`). An entry the person deletes by hand stays deleted, is recorded, and doctor shows it as a note. Unlike `denyWrite`, harness doesn't need these entries to protect itself.
- What the list can't cover (R§4): keychain and keyring IPC, WSL interop to Windows Credential Manager, the Read tool (the read block covers that), and on Linux a listed file that appears after the run starts (launch fix review M-7).

### 7.4 Network allowlist per ecosystem

- `isolation.network.ecosystems: auto` uses the ecosystems init's scan finds from lockfiles and manifests, or the person lists them. Hosts come from GitHub's Copilot allowlist reference (R§6.2, https://docs.github.com/en/copilot/reference/copilot-allowlist-reference):

  | Ecosystem | Hosts |
  |---|---|
  | `npm` | `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com`, `nodejs.org` |
  | `python` | `pypi.org`, `files.pythonhosted.org` |
  | `rust` | `index.crates.io`, `static.crates.io`, `static.rust-lang.org` |
  | `go` | `proxy.golang.org`, `sum.golang.org` |
  | `ruby` | `rubygems.org`, `index.rubygems.org` |
  | `java` | `repo.maven.apache.org`, `repo1.maven.org`, `services.gradle.org`, `plugins.gradle.org` |
  | `containers` | `ghcr.io`, `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` |

- Written to `sandbox.network.allowedDomains` in `.claude/settings.json`, one block per host, plus `isolation.network.allow`. GitHub hosts are never written (I7). Attended `gh` and HTTPS pushes still ask the first time, as today.
- Under an admin-required unattended launch, the repo list is ignored (R§0.4). The launch docs therefore point at `harness doctor --launch-hosts`, which prints the same list as JSON for the launch JSON's `allowedDomains`. This is a print-only flag: no command assembles the launch line, which keeps the launch fix's single source of truth in the docs.
- `NETWORK_NOTE` in `merge.ts` changes to name the hosts written.

### 7.5 Doctor credential report

A new doctor section, "Credentials the agent could reach". It never opens or reads a credential file and never prints a value.

- **Files.** For each §7.3 path it calls `lstat` only: present or absent. For present ones it reports the cover: `read block`, `credentials deny`, `both`, or `none`. The cover is computed from the effective settings layers, not probed.
- **Variables.** Names only, matching `/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i` or the §7.3 list, from doctor's own environment. The session's environment can't be seen, which doctor says.
- **IPC routes.**
  - `gh auth status` storage, `keyring` or `file`, parsed from its output; never `--show-token`.
  - `SSH_AUTH_SOCK` set.
  - macOS: a note that keychain items may be reachable over IPC, stating L2's result once known.
  - WSL2: `/mnt/c` mounted with interop on (`/proc/sys/fs/binfmt_misc/WSLInterop` exists).
- **Each line names what denying it breaks,** from the §7.2 and R§4 tables.
- It ends with `n credential paths present, n covered, n not covered`. A path that is not covered is a note, not a fix, because the person may need it.

### 7.6 I3 risks, stated plainly

The research recommended turning it on under `sandbox: always` only, after a live check (R§12 Q2). The owner chose every mode. What that costs:

1. On macOS, init's default is `sandbox: always`, so every nvm, volta, pyenv, rustup or Linuxbrew user loses their toolchain in the sandbox until they add Fix A or B. Many Stop steps then fail. This is the largest support cost in the spec.
2. It binds every teammate. A repo's `true` can't be lifted per person, only re-opened per path. A teammate who can't use Fix A ends up with Fix B, which also grants writes.
3. On native Windows the file-tool block applies, and which roots it uses there is not documented (L8).
4. It is new (v2.1.257), and its re-open list may change between Claude Code releases.

Hence the gate: PR 5 ships only after live batch L1 passes on macOS and Linux, and its findings are written into §7.2 and the docs in the same PR.

## 8. Native Windows (I0, I11)

- `sandboxVerdict` on `win32`: today `unavailable`, which logs and allows. It becomes `deny` for unattended shell calls (Bash, PowerShell, Monitor) unless `sandbox: off`.
- WSL2 and the container both run hooks under `linux`, so "unless in WSL2 or a container" needs no Windows-side detection. A native `win32` hook is never in either.
- **`sandbox: off` is the logged escape.** An unattended shell call on `win32` under `off` is allowed and logs a `sandbox-off-unattended` event once per session. `harness stats` counts it, and doctor shows a note.
- Attended native Windows sessions are unchanged.
- **Doctor on `win32`:** fix `unattended shell commands are denied on native Windows (no Claude Code sandbox)` → `run Claude Code in WSL2, or in the harness dev container (/harness:init --container); or set sandbox: off in .harness/config.yaml to keep the text checks only (logged)`.
- **Release plan:**
  - PR 1 ships in the next minor version, 0.3.0, in its first beta, under a "Breaking" heading in `docs/release-notes/unreleased.md`. It is not held back to wait for the rest of the spec.
  - The README's "native Windows keeps the text checks" sentences change in the same PR.
  - `srt`'s Windows alpha (R§2.5) is noted as future prior art only.

## 9. Config, commands, init, doctor, status, guard

### 9.1 Config keys (`.harness/config.yaml`)

| Key | Default | What it does |
|---|---|---|
| `isolation.block_reads` | `true` | Writes `permissions.blockReadsOutsideWorkingDirectories: true` in every mode (I3). `false` removes it on the next update. |
| `isolation.credentials.allow` | `[]` | §7.3 paths and variables harness leaves off its deny list. Each must be a §7.3 entry. |
| `isolation.network.ecosystems` | `"auto"` | `auto`, or a list from `npm`, `python`, `rust`, `go`, `ruby`, `java`, `containers`. |
| `isolation.network.allow` | `[]` | Extra hosts for the repo allowlist and the container. GitHub hosts, `*` and `example.com` are refused. |
| `isolation.container` | `"off"` | `off`, `available` (files written; the verdict is shown, not required), or `required` (unattended shell needs the container verdict). `/harness:init --container` sets `required`. |
| `github.app.id` | `0` | The agent App's id. `0` means none. Not a secret. |
| `github.app.slug` | `""` | The App's slug, for messages and `hosts.yml`. |
| `project.codeowners` | `[]` | Changed: the owners written to the CODEOWNERS block (§4.3). Was input only. |

The generated table in `docs/reference.md` picks these up from `src/core/config.ts`.

### 9.2 Commands

| Command | Who | What |
|---|---|---|
| `harness github protect [--dry-run] [--yes]` | Person only | §4.1 |
| `harness github app create [--org <org>] [--ci-secret]` | Person only | §5.1 |
| `harness github broker [--repo <o/r>] [--key-stdin] [--env]` | Person only | §5.3 |
| `harness doctor --launch-hosts` | Anyone (print only) | §7.4 |
| `/harness:init --container`, `harness init --container` | Through the skill, as init today | §6.1 |
| `harness-run [--push] -- <claude args>` | Person, inside the container | §6.3 |

`--repo` defaults to the current repo's `origin`.

### 9.3 Init and update

- Interview: confirm `project.codeowners`. With `--container`, confirm the container, and ask about push runs (whether to write the `-push` files).
- `mergeSettings` adds the read block, the credentials entries and the ecosystem hosts, each recorded as blocks, with notes as today.
- The CODEOWNERS block, and `.devcontainer/harness/` when the container is not `off`.
- Protect's table and `denyWrite` gain `.devcontainer/` and the CODEOWNERS file.

### 9.4 Doctor and status

- **Doctor gains these sections:**
  - server side (§4.4);
  - agent identity: App configured; `meta.json` present, with exact permissions; a broker counts as running when the token has more than 14 minutes left, since a running broker re-mints at 15;
  - read block and toolchain fixes (§7.2);
  - credentials (§7.5);
  - container: on the host, whether the files are present and the image is current; inside, the four signals;
  - native Windows (§8);
  - CI workflows missing `persist-credentials: false` (§5.5).
- **Status gains four lines:**
  ```
  Server side: harness ruleset ok
  Agent identity: <slug>[bot], token fresh until 14:05 UTC   (or: no App | broker not running | token expired)
  Reads outside the repo: blocked                          (or: allowed, isolation.block_reads is false)
  Container: required; this session: proved                (or: available | off; not proved: <signal>)
  ```

### 9.5 Guard and protect additions

- `PERSON_ONLY.github`: `kind: 'deny'` for every subcommand, with the §10.2 message. It uses the same token walk as `tdd off`, so `harness.cmd`, `npx` and wrapper spellings are covered.
- New guard denies from §5.6 item 3, in every mode. In attended sessions the credential-helper override asks instead of denying, because a person may need it.
- Protect: `.devcontainer/**` and the CODEOWNERS paths; writes to `/tmp/harness-*/gh/`.
- `sandbox-required`: the `win32` deny (§8) and the `container` verdict (§6.5).

## 10. Failure modes

### 10.1 Rules

- **Fail fast and closed.** Protect, `app create` and the broker exit 1 on any API error, wrong permissions, unexpected JSON, an unsafe token folder or a missing key, and print the cause. Protect's write is one PUT or POST, so it can't half-apply.
- **Never suppress errors.** A `gh` or API failure is shown with its first line, cleaned as in `doctor-protection.ts`. Doctor shows "unknown" with the reason, never "ok".
- **Verdicts deny on doubt.** A container probe that didn't run, an unreadable marker, or missing session state denies when the container is required. A stale token makes git and `gh` fail.
- **Nothing falls back** to the owner's credentials, to running unsandboxed, or to an unfenced network.

### 10.2 Messages

| When | Message |
|---|---|
| Unattended shell on native Windows | `Unattended shell commands are denied on native Windows: Claude Code has no sandbox there. Run Claude Code in WSL2 or in the harness dev container (/harness:init --container), or set sandbox: off in .harness/config.yaml to keep the text checks only (logged).` |
| Container required, not proved | `This repo requires unattended runs in the harness dev container (isolation.container: required), and this run is not proved to be in one: <signal>. Start it with harness-run inside the dev container, or ask the person to set isolation.container: available.` |
| Agent runs `harness github …` | `Only a person can run harness github <sub>: it changes GitHub settings or handles the App key. Ask them to run it in their own terminal.` |
| Keychain or key-file read | `Reading the OS keychain or the harness App key is denied: it holds your credentials. Pushes use the token the broker provides.` |
| Token mint request | `Minting GitHub App tokens is denied to the agent: only harness github broker, outside the session, mints them.` |
| Credential-helper override | `Changing git's or gh's credentials is denied: pushes must use the harness App token.` |
| `git-credential`, no fresh token | `harness: no fresh GitHub App token for <o/r> (<missing | expired at HH:MM UTC>). The person must run harness github broker outside the agent; pushes fail until then.` |
| Broker, wrong permissions | `The GitHub App <slug> has <list> on <o/r>; harness needs exactly Contents write, Pull requests write and Metadata read. Change the App's permissions on GitHub, then start the broker again.` |
| Broker, unsafe folder | `<folder> is not safe for tokens (<owned by uid N | mode 0755 | a symlink>). Remove it and start the broker again.` |
| Broker, no key | `No key for the GitHub App <id> in <keychain | Secret Service | file>. Run harness github app create, or pass the key with --key-stdin.` |
| Protect, private repo without Pro | `Rulesets need GitHub Pro, Team or Enterprise on private repos. Nothing was changed. Harness's local layers stay on; harness doctor lists them.` |
| Protect, no admin role | `Your gh login can't change rulesets on <o/r> (<HTTP status>: <first line>). It needs the admin role. Nothing was changed.` |
| Protect, no verify run yet | `No harness-verify check run on <branch> yet, so the required check can't be pinned to its app. Run the workflow once (open any PR), then run harness github protect again.` |
| Config, GitHub in the allowlist | `isolation.network.allow can't list <host>: GitHub is reachable only in runs that push (harness-run --push), with the App token.` |

## 11. Testing

### 11.1 Unit (no network, no `claude`)

- Ruleset builder: with and without `harness-verify`; normalised comparison that ignores GitHub's added fields; field names checked against the REST docs' example.
- Protect with a stub `gh`: POST, PUT, no-op, drift diff, `--dry-run`, 403 private, 403 without admin, no check run, a malformed answer. Nothing is written in the error cases.
- CODEOWNERS block: create, merge into an existing file in each of the three places, owner validation, uninstall.
- Doctor read-back: every row of the §4.4 table.
- JWT: sign and verify with a test key through `node:crypto`; `iat` skew.
- Broker, with a fake clock and a stub API: mint, refresh at T-15 minutes, catch-up after sleep, backoff, deletion at expiry, revoke on SIGTERM, an exact-permissions mismatch, unsafe folder modes, owner and symlink, atomic writes, `--env` printing no secret.
- `git-credential` run by `sh`: fresh, within 5 minutes of expiry, missing, a non-`get` action.
- Guard: `PERSON_ONLY.github` in every spelling the `tdd off` tests use; each §5.6 deny, and the attended ask for helper overrides.
- `sandbox-required`: `win32` deny, `win32` with `off` allowed and logged once, the container verdict for each signal failing, a probe missing from state, a `HARNESS_CONTAINER` from a settings env ignored.
- `mergeSettings`: the read block, credentials entries and ecosystem hosts added and recorded; `isolation.block_reads: false` removes; `credentials.allow` leaves entries out; a hand-deleted entry stays deleted; uninstall.
- Doctor credential report: a filesystem spy proves only `lstat` is called, never `open` or `read`; computed cover from layered settings.
- Container render: pinned versions; the Claude Code pin is at least `MIN_CLAUDE_CODE`; no capabilities, sudo or credential mounts; the push variant adds exactly the two GitHub hosts and drops the token-folder deny; the config refuses GitHub hosts.

### 11.2 End to end

Temp repos with a stub `gh` and a stub GitHub API on a local port, injected through a test-only base URL that the production build ignores:
- protect twice (the second is a no-op);
- `app create` through the callback with a fake code;
- the broker lifecycle feeding a real `git push` to a local bare remote through the helper;
- init and update with `--container`, then uninstall;
- the Windows deny path, run on `windows-latest`.

### 11.3 CI matrix

- **Existing:** `test` on `macos-latest` and `windows-latest` (Node 22), and the single-run jobs on `ubuntu-latest`. All new unit and e2e tests run on all three. Windows covers the `win32` deny, `harness.cmd` spellings, and paths in the credential report.
- **New job `container-smoke` on `ubuntu-latest`:** builds the `.devcontainer/harness` image from the e2e fixture and runs inside it, without `claude` or any paid call. It checks that:
  - `srt` starts;
  - `example.com` is refused and `registry.npmjs.org` is allowed;
  - the marker checks pass;
  - a write to `/workspace/.devcontainer` fails;
  - the non-push variant can't read `/run/harness/gh`.

  If L4 shows `srt` can't run on hosted runners, the job is marked as a known limit instead of being silently skipped.

### 11.4 Live batches (owner's subscription)

They run from the Terminal panel, with scripts in `harness-wt/live`, and need a yes per batch. Each records the Claude Code version.

| Batch | Where | Checks | Gates |
|---|---|---|---|
| L1 read block | macOS; Linux (Ubuntu with bwrap); WSL2 if available | With the block and the sandbox on: nvm or volta `node -v`, pyenv `python`, `cargo`, `~/.local/bin` tools, `npm ci` and `pnpm install` from cache, Playwright browsers, `gh auth status` (keyring and file), HTTPS push with the owner's helper, SSH push, the Read tool on a home file. Then Fix A, then Fix B, recording which lifts each | PR 5 |
| L2 credentials | macOS, Linux | Claude Code accepts the full §7.3 list without a warning; `cat` of each present path fails in Bash; the listed variables are absent; **macOS keychain probe**: sandboxed Bash runs `security find-generic-password -s harness-probe` on a dummy item (settles R§9.1); Linux `secret-tool` probe | PR 3, §15 Q3 |
| L3 broker on the host | macOS | `app create` on a scratch public repo; the broker mints; an attended agent pushes a branch and opens a PR as `<slug>[bot]`; the owner approves; `GIT_TRACE` shows only the harness helper; a 2.5-hour run with pushes every 20 minutes crosses two refreshes; kill the broker, and the next push fails with the §10.2 message | PR 10 |
| L4 container and `srt` | Docker Desktop on macOS; Docker on Linux | `srt` runs in an unprivileged container (with or without weaker nested mode); Claude Code's sandbox starts inside `srt`; `npm install` through both proxies; `.git/hooks` write fails; `srt`'s own protected paths; `example.com` refused; a `--push` run pushes with the App token; a run without push can't reach `github.com` or read the token | PR 12, PR 13, §15 Q1 |
| L5 end to end | Container, unattended `-p` | With the done contract on: the run pushes and opens a PR; the App can't merge (`gh api -X PUT …/merge` refused by the ruleset); it can't push a workflow change; it can't post a `harness-verify` status; the owner approves and merges | Release |
| L6 protect | Scratch public repo | Apply, re-apply as a no-op, hand-edit then doctor shows drift, protect restores; CODEOWNERS errors shown for an owner without access | PR 7, PR 8 |
| L7 CI broker | Public scratch repo, GitHub-hosted | `--key-stdin`; agent Bash can't read the broker's `/proc/<pid>/environ` or memory; without `persist-credentials: false`, doctor flags it; a 70-minute job crosses a refresh | PR 11 |
| L8 Windows | Native Windows, if the owner has a machine | An unattended PowerShell call is denied with the message; with `off` it is allowed and logged; the read block's roots on Windows | PR 1 (if no machine: CI only, and a known limit) |

## 12. Rollout

The done contract lands first (I0). Each PR is cut from `main`, stays within 400 non-test lines and 20 files, and updates the README and release notes in the same PR. Sizes are estimates.

| # | PR | Depends on | Size (est.) |
|---|---|---|---|
| 0 | Launch fix (I1, I10): prior work, merged before this list starts | — | done |
| 1 | Native Windows deny, `off` escape logged, doctor fix, "Breaking" release note (ships in 0.3.0) | 0 | ~120 |
| 2 | Guard: `PERSON_ONLY.github` and the §5.6 denies; protect: `.devcontainer/`, CODEOWNERS, token folder | 0 | ~200 |
| 3 | Credentials fallback list in `mergeSettings`, `isolation.credentials.allow` (after L2) | 0 | ~220 |
| 4 | Ecosystem allowlist: `isolation.network.*`, the render function, `doctor --launch-hosts`, `NETWORK_NOTE` | 3 | ~250 |
| 5 | Read block default, `isolation.block_reads`, doctor toolchain fix lines (after L1) | 3 | ~260 |
| 6 | Doctor credential report | 3, 5 | ~250 |
| 7 | CODEOWNERS block, and `harness github protect` with the ruleset builder (after L6) | 2, done contract | ~380 |
| 8 | Doctor and status read-back, drift, private without Pro | 7 | ~250 |
| 9 | `harness github app create`, JWT, key storage | 2 | ~350 |
| 10 | Broker, token folder, `git-credential`, host launch docs, doctor and status identity lines (after L3) | 9 | ~380 |
| 11 | CI broker (`--key-stdin`) docs, `persist-credentials` doctor check (after L7) | 10 | ~150 |
| 12 | Container templates, `--container`, `harness-run`, `isolation.container` (after L4) | 4, 10 | ~390 |
| 13 | Container verdict in `sandbox-required`, SessionStart probe, status line, `container-smoke` job | 12 | ~300 |
| 14 | Known limits and reference wrap-up; L5; release | all | ~150 |

Note: §11.4 names PRs by these numbers. PR 7 is the most likely to grow past 400 lines. If it does, it splits into "CODEOWNERS block" and "protect", in that order.

## 13. Known limits

- **Server side.**
  - Binds only on GitHub, only where rulesets are available, and only until a repo admin changes them in the web UI.
  - A private repo without Pro has no binding layer (I8).
  - Push rulesets (file paths) are not used, because they apply to private and internal repos only (R§5.1).
- **Personal repos.** Per-path required reviewers are unavailable on user-owned repos (R§5.1), so code-owner review stands in. CODEOWNERS silently skips owners without write access; doctor reports it.
- **The App token reaches the agent.** For up to an hour, the agent can use it anywhere for anything Contents and Pull requests allow on that one repo, including deleting or overwriting non-default branches. Only the default branch is in the ruleset.
- **Keychain IPC (macOS) and Secret Service over D-Bus (Linux).** Until L2, it is unknown whether sandboxed Bash can read them. The guard's denies are text checks. The container removes this route, because the key is not there.
- **Outside the sandbox.** Hooks, MCP servers, LSP servers and WebFetch run outside Claude Code's sandbox on the host. In the container they are inside `srt`.
- **`srt`.** It is a beta, fences only its own process tree, may need its weaker nested mode in Docker, and filters by hostname only (§6.7).
- **Bind mount.** Files outside the protected paths reach the host and can run there later (§6.6).
- **The read block** costs toolchains under home until Fix A or B is added, binds every teammate, and its Windows roots are undocumented (§7.6).
- **Credential list.** It is incomplete by nature. On Linux a file created after the start is not covered.
- **Detection.** The person who launches a run can fake every container signal and `HARNESS_SANDBOX=1`, by design.
- **Native Windows.** Unattended shell is denied; attended sessions keep text checks only; `app create` is not supported.
- **CI.** Hosted jobs end after 6 hours. The broker's key safety there rests on a PID namespace and ptrace rules confirmed only by L7.
- **Container login.** Claude Code's login lives inside the container, and `api.anthropic.com` is always reachable.

## 14. Spec points the owner can overrule

1. Token transport is a file folder (`/tmp/harness-<user>/gh/<o>-<r>/`), not a socket or helper process (§5.3).
2. The broker is a separate long-running process the person starts, not a hook. One design covers the host, the container and CI.
3. Refresh at 15 minutes before expiry, checked every 60 seconds. The git helper refuses a token within 5 minutes of expiry.
4. Git's credential helpers are reset through `GIT_CONFIG_COUNT` env, not by writing any git config file.
5. `gh` gets the token through `GH_CONFIG_DIR/hosts.yml`, not `GH_TOKEN`, so a refresh reaches a running session.
6. The broker refuses to mint if the App has any permission beyond the three (exact match).
7. Ruleset: 1 approval, code-owner review, last-push approval, dismiss stale reviews, conversation resolution, strict status check, no bypass actors, default branch only.
8. The required check is added only when the `harness-verify` item is installed. With the item but no check run, protect exits 1 rather than skipping the rule.
9. CODEOWNERS paths: `/.github/`, `/.harness/`, `/.claude/`, `/.devcontainer/`, `/AGENTS.md`, `/CLAUDE.md`, and the CODEOWNERS files. The block goes at the end of the file.
10. App key storage on native Windows is not supported; WSL2 instead.
11. The container lives in `.devcontainer/harness/`, a named configuration, so an existing `.devcontainer/` is untouched.
12. The `-push` and non-push `srt` and `--settings` files are baked into the image. Changing the allowlist needs a rebuild.
13. `isolation.container` is three-way (`off`, `available`, `required`); `--container` sets `required`.
14. The egress probe host is fixed to `example.com`.
15. Credential entries a person deletes stay deleted (unlike `denyWrite`); `isolation.credentials.allow` is the supported way.
16. Browser profile folders are left off the credential list; the read block covers them.
17. `isolation.block_reads` exists as a team-wide off switch, although I3 sets it on.
18. No command assembles the launch line. `harness github broker --env` and `harness doctor --launch-hosts` print parts, and the docs stay the single source.

## 15. Open questions

1. **What if `srt` won't nest cleanly in Docker (L4)?** Two cases:
   - `srt` runs only with `enableWeakerNestedSandbox`. **Recommended:** ship it that way, state it in doctor and status ("`srt` in weaker nested mode: `/proc` exposed"), and don't add `SYS_ADMIN` or an unconfined seccomp profile.
   - Claude Code's sandbox can't start inside `srt`, or its proxy can't chain through `srt`'s. This conflicts with I5. **Recommended:** ask the owner then. The default proposal would be to rely on `srt`'s own protected paths, if L4 confirms they cover `.git/hooks` and `.git/config`, and drop the inner sandbox for the container only.
2. **What if Fix A doesn't lift the read block for sandboxed commands (L1)?** **Recommended:** document Fix B as the fix, with doctor printing the exact `additionalDirectories` line and saying that it also grants writes. Keep I3 as decided.
3. **What if sandboxed Bash can read the macOS keychain (L2)?** Then a drifted agent in an attended host session could read the App key. **Recommended:**
   - keep keychain storage, since there is no better local store;
   - keep the guard's text denies;
   - state the gap in doctor;
   - recommend the container for pushing runs, where the key is absent;
   - add the keychain's Mach service to the sandbox deny if Claude Code exposes such a setting by then (it doesn't today: `allowMachLookup` only adds services).
