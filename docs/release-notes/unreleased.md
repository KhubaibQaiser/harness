# Unreleased

<!-- Notes for the next release. When package.json gets the new version, rename this file to
docs/release-notes/<version>.md: the release workflow's check-tag step needs that file at tag time. -->

## What changed since 0.2.0-beta.2

Not yet listed here: changes merged before this file existed (the pr-body check, the review judge agent).

### Secrets scanning

- New catalog item `gitleaks-ci` (kind `ci`): a GitHub workflow that scans the full git history with gitleaks 8.30.1, checksum-verified, with `--redact`. `/harness:init` recommends it for `api` and `infra` repos.
- New catalog item `gitleaks-commit`: a new check, `checks.secretScan`, scans what an agent `git commit` or `git stash` could take (staged changes, and unstaged and untracked files that are not ignored) and blocks on a finding, naming the rule, file and line, never the value. The commit must be the only, plain command on its line. Merges, rebases and similar commands ask. Editing `.gitleaks.toml` or `.gitleaksignore` asks. It needs gitleaks on PATH and git 2.40 or newer; without them every agent commit is blocked until you install them or remove the item.
- Both items scan with harness's own rules, so a repo's `.gitleaks.toml`, `gitleaks:allow` comments, `.gitattributes` and NUL bytes can't hide a finding. A `.gitleaksignore`, which gitleaks always reads, blocks agent commits and fails the CI job.
- Any executable hook (not a `.sample`), or git config that names a program git may run (by key pattern: `*.program`, `*.command`, `*.cmd`, `*.editor`, `*.helper`, fsmonitor, filters other than git-lfs's, textconv, `diff.external`; credential and diff/merge tool namespaces left out; the editor only when the commit opens it, gpg programs only when it signs, textconv and `diff.external` only for the verbose diff in the editor; `interactive.diffFilter` too), makes an agent commit or stash ask, since git runs them after the scan; unattended, that is a deny. Writing a hook or `.git/config`, or changing `core.hooksPath`, `core.fsmonitor` or a filter, asks.
- The commit check is a seatbelt against honest mistakes and casual bypasses; `gitleaks-ci` and the done-contract CI verdict are the backstops.
- This repo's own CI gitleaks job is hardened the same way, and its catalog-pin allowlist is anchored to whole pin lines.

### Unattended launch

- An unattended `bypassPermissions` or plan-mode run whose sandbox is confirmed from settings files (including every `sandbox: always` repo run with `--dangerously-skip-permissions`) now has its shell commands denied unless your user or managed settings set `sandbox.network.strictAllowlist: true`. Without it, the sandbox lets such a run reach any host.
- The documented launch command now carries `strictAllowlist`, its own `allowedDomains` (empty) and `credentials` deny entries. A run that installs packages or pushes fails until you list the hosts it needs, and `gh`, cloud CLIs and `npm publish` can't sign in from the shell. The README says how to allow pushing.
- If your scripts copy the old command, replace it: `HARNESS_SANDBOX=1` now stands for the full one.

## Catalog

Catalog version 1, 92 items: 72 plugin, 6 external-skill, 5 own-hook, 3 mcp, 1 rule, 1 settings, 2 own-skill, 1 own-agent, 1 ci.

## Left out (38)

Listed in `catalog/excluded.yaml`. `init` never recommends these.

### Own items that are not selectable (20)

- Not built yet (this release ships existing own items only): `post-edit-format`, `session-context`, `researcher`, `ui-verify`, `seo-audit`, `webgl-landing`, `rn-a11y`, `perf-budget`, `adr`, `session-structure`, `ci-tdd`, `harness-integrity`, `lefthook-baseline`, `claude-code-action`, `harness-devdep`
- In the core install since platform enforcement; not a selectable item: `config-change-guard`, `sandbox-settings`
- Part of the PR reviewer (M2): `harness-review`, `ui-verifier`
- Replaced by the pr-size check (`pr-ship` item): `pr-create-trigger`

### Left out by the owner (6)

- `sourcegraph`: needs an enterprise Sourcegraph instance; single-repo work is covered by local search
- `context7`: queries go to Upstash's hosted backend; vendor llms.txt pages and docs MCPs cover the need
- `serena`: runs its unpinned upstream branch at every launch; LSP plugins cover it
- `supabase-agent-skills`: overlaps the supabase plugin (same plugin name)
- `getsentry-skills`: its always-on commit skill imposes Sentry's commit conventions
- `deepeval`: Python-only; project facts read JS dependencies only for now

### Research exclusions (12)

- `mcp-for-blender`: PyPI-only package run with uvx; the catalog can pin only npm or remote MCP sources
- `spec-kit`: installed with the specify CLI (uv tool install specify-cli); the repo has no Claude Code plugin manifest or skills directory for the catalog to pin
- `remember`: no license; LICENSE is a custom "Community License" with no-commercial-redistribution and no-competing-use clauses, not an SPDX license
- `wshobson-agents`: the repo is a marketplace of 94 plugins, not one plugin; there is no single source to pin
- `graphify`: installed from PyPI with `uv tool install graphifyy` then `graphify install`; the repo (Graphify-Labs/graphify) has no Claude Code plugin manifest and is not in the official marketplace, so the catalog has nothing to pin
- `maestro-mcp`: the MCP server is the `maestro mcp` command of the Maestro CLI binary (mobile-dev-inc/Maestro, Apache-2.0); it is neither an npm package nor a hosted server, the repo has no plugin manifest, and the older mobile-dev-inc/maestro-mcp repo is archived
- `prisma`: no license: prisma/claude-plugin has no LICENSE file, no license field in plugin.json and no README at the marketplace pin 815dbc4a045a (the repo holds only .claude-plugin and .mcp.json; GitHub license is null). Its .mcp.json also runs `npx -y prisma mcp` unpinned
- `mergify`: no open-source license: Mergifyio/mergify-cli LICENSE (marketplace pin 6307ed10e862) is a proprietary Mergify licence that allows running the software unmodified only with the Mergify service; plugin.json says LicenseRef-Mergify-Proprietary and the GitHub license is NOASSERTION. Brief step 4 excludes non-standard licenses; owner may add it back as vendor-terms
- `claude-security`: proprietary license: plugins/claude-security/LICENSE (marketplace pin a2e251d9b97b) says the plugin is "proprietary to Anthropic", all rights reserved, with a limited, non-transferable licence to run and modify it for internal use solely with Anthropic products; it is not an open-source or SPDX licence. plugin.json says "SEE LICENSE IN LICENSE". Owner may add it back as vendor-terms
- `semgrep`: no license: semgrep/mcp-marketplace (marketplace pin b58f407c6ac0, plugin dir plugin/) has no LICENSE or NOTICE file at the pin or at HEAD, no license field in plugin.json, and no license line in README.md; GitHub license is null. It also ships precompiled hook binaries and downloads and auto-updates a Guardian binary from semgrep.dev, so it is not just a pointer to a hosted server. Owner may add it back as vendor-terms
- `sonarqube`: no open-source license: SonarSource/sonarqube-agent-plugins LICENSE (marketplace pin 5a9356d957db) is the SONAR Source-Available License v1.0 (plugin.json license SSAL-1.0), which restricts use that competes with SonarQube and is not an SPDX open-source licence; GitHub says NOASSERTION. Brief step 4 excludes a non-standard license (as for mergify). If added back, the owner's Q5 stance applies: discouraged with stance_reason "belongs in CI quality gates, not the agent session."
- `evals-skills`: archived upstream: hamelsmu/evals-skills (MIT, 1675 stars) is archived on GitHub (last commit 22418da2bfb1, 2026-08-16); audit.html's pick for fitness-app's AI feature ("Error analysis and checking LLM judges against human labels"). langfuse (judge-calibration and error-analysis references) and deepeval cover the area

## Unpinned items

Every plugin and MCP server is pinned to a commit or an exact version. These run code that is not pinned, so what runs can change without a catalog change. Each is flagged in the item's evidence. Hosted MCP servers are not listed: their code does not run on your machine.

- `playwright`: runs `npx @playwright/mcp@latest`: the newest release from npm at run time
- `deploy-on-aws`: runs `uvx awslabs.aws-iac-mcp-server@latest` and `uvx awslabs.aws-pricing-mcp-server@latest` at launch
- `aws-serverless`: runs `uvx awslabs.aws-serverless-mcp-server@latest --allow-write` at launch
- `databases-on-aws`: `uvx ...@latest` for the aurora-dsql and cloudwatch servers; the vendor file marks both `disabled`, but Claude Code doesn't document that key, so they may still start
- `jfrog`: three `npx` commands name `@jfrog/agent-guard` with no version, at session start, on Skill and Read calls, and on prompt expansion
- `tdd-guard`: `npx tdd-guard@latest` in three hook events
- `probity`: `npx @nizos/probity` on every Bash, Write, Edit and NotebookEdit call: the local copy if installed, else the newest from npm
- `security-guidance`: installs claude-agent-sdk with pip and no version pin
- `expo`: its feedback step runs `npx --yes @expo/agent-cli@latest feedback`, only when feedback is submitted
- `shadcn`: its skill runs `npx shadcn@latest info --json` when it loads

These 44 items (38 plugins and 6 external skills: `react-best-practices`, `react-native-best-practices`, `shadcn`, `vercel-react-native-skills`, `web-design-guidelines`, `webapp-testing`) are pinned by commit but come from a `git-subdir` source with no `plugin_version`, so `doctor` has no version to compare and cannot report drift: `42crunch-api-security-testing`, `agent-sdk-dev`, `auth0`, `aws-core`, `aws-serverless`, `claude-code-setup`, `claude-md-management`, `code-review`, `code-simplifier`, `databases-on-aws`, `deploy-on-aws`, `design`, `engineering`, `expo`, `feature-dev`, `frontend-design`, `hookify`, `impeccable`, `kotlin-lsp`, `mcp-server-dev`, `neon`, `playwright`, `pr-review-toolkit`, `railway`, `ralph-loop`, `react-best-practices`, `react-native-best-practices`, `revenuecat`, `security-guidance`, `session-report`, `shadcn`, `skill-creator`, `stackhawk-hawkscan`, `stripe`, `swift-lsp`, `tdd-guard`, `terraform`, `trailofbits-insecure-defaults`, `trailofbits-supply-chain-risk-auditor`, `typescript-lsp`, `vercel-react-native-skills`, `web-design-guidelines`, `webapp-testing`, `workos`.

## Known limits

The full list is in `docs/reference.md#known-limits`. This release adds:

- 32 PR-size limits: text detection only, the unmeasured note, the pause and the agent's question, the raise and the hand-run deny.
- Guard and protect: zsh-only forms and aliases are read as bash; force-push forms, heredoc bodies and message values the text rules can't read; a script the agent wrote that takes a protected path as an argument.
- Context budget: harness measures files, not the live session (`/context` is the truth); the offline estimate probably runs low; plugins enabled outside the catalog picks aren't measured; the on-demand total is the most that could load; the budget asks cover only harness's own commands; using the API sends the measured text to Anthropic; the state card doesn't restore Claude Code's summary of earlier hook messages.
- Team decisions: a decision path built at run time, a script, or `tar -x`/`unzip` with no `-C`/`-d` can still change decision files; change detection fingerprints only the generated rules.

New since 0.2.0-beta.0, unchanged in this release:

- Plugin picks are local only and are missing in cloud sessions.
- `extraKnownMarketplaces` needs folder trust.
- MCP servers need each user's approval.
- `CLAUDECODE` is also set in IDE terminals.
- There is no version-drift check for `git-subdir` plugins without `plugin_version`.
- The agent asks before item changes.
- MCP servers aren't measured before install, and only the person installing is asked about the budget. Plugins and external skills now count the number the catalog records (see Context budget above).
- Under `sandbox: always`, item commands may need the `!` prefix. Unverified, pending the live check.
