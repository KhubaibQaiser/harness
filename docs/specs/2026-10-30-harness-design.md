# Harness: design spec

- Status: approved by owner on 2026-10-30
- Date: 2026-10-30
- Owner: khubaibqaiser
- Package: `@khubaibqaiser/harness` (npm, unclaimed as of 2026-10-30)
- Research basis: AI-Native Workflow Audit (claude.ai artifact CtVz1z8qP17BjFpHiKqsnV)

## 1. Goal

One tool that sets up a curated AI-native workflow inside a repository. It scans the repo, interviews the user about what the scan cannot tell, recommends items from its own closed catalog, lets the user choose, writes the chosen items into the repo, and asks before committing, pushing and opening a PR. The user makes every decision. The tool ships a local PR reviewer and a TDD harness as its own items.

Everything is repo-level, so every developer who clones the repo gets the same workflow. Nothing is installed globally except the `/harness` plugin used by whoever runs init or update.

## 2. Decisions

| Topic | Decision |
|---|---|
| Shape | **Plugin-first.** A Claude Code plugin (`/harness:init`, `/harness:update`, `/harness:review`, `/harness:doctor`, `/harness:status`; plugin skills are namespaced `/<plugin>:<skill>`) runs the judgment steps inside the developer's own Claude Code session. A TypeScript npm CLI (`npx @khubaibqaiser/harness …`) is the rule-based engine the skills call: scan, validate, apply, git, hook runtime, CI checks, stats |
| Why not the Agent SDK | Anthropic does not allow third-party products built on the Agent SDK to use claude.ai login unless approved; they must use API keys. Plugin-first needs no extra auth or cost. Headless runs (CI, routines) use `claude -p` with whatever auth that environment already has |
| Model output | Never trusted directly: the skill writes JSON, the CLI validates it against a schema, one retry, then stop |
| Catalog | Closed. Lives in this repo. Changes only through a new release |
| Third-party items | Referenced, never copied. Outside plugins are pinned to an exact commit through an inline `settings` marketplace in `.claude/settings.json`. Committing that only *enables* them; each developer installs them once with `harness sync` (Claude Code doesn't download project-enabled plugins by itself). They are stored in Claude Code's plugin cache in the user's home folder, which is how Claude Code works; enablement stays repo-scoped. **Cloud sessions don't load repo-enabled plugins**, so outside plugins don't apply there; own items (copied files) do |
| Product context | The interview's first question collects project scope: pointed files (README, PRD, spec) or a short description, summarised into `.harness/context/product.md` and approved by the user |
| Own items | Copied as real files into the repo (`.claude/`, `.harness/`), listed in a manifest with hashes. Changes to them need CODEOWNERS review and pass a CI integrity check |
| Target agent | Claude Code only in v1. Cursor, Codex, OpenCode on the roadmap |
| v1 project types | React/Next web app, landing/marketing (incl. 3D/motion), RN/Expo mobile, Node backend/infra. Monorepos with several apps are first-class |
| Outside non-plugin skills | `harness sync` installs them locally into `.claude/skills/`, gitignored, pinned to a commit |
| Git | Branch `chore/ai-workflow-<catalog-version>`, commit as the user's git identity, ask before push, ask before PR |
| PR reviewer | On demand and after an agent runs `gh pr create` (can be disabled). Always asks before running any PR's code. Config and hooks are loaded from the base branch |
| Reviewer browser | Headless Playwright for screenshots, axe and SEO checks; Chrome DevTools MCP for traces and runtime errors; browser restricted to localhost |
| Screenshots | After-only, pushed to orphan branch `harness-assets` |
| App login | Per app: credentials from a named file + keys or named environment variables, never stored or shown to the model; on failure a specific error then interactive login; if not configured, interactive login |
| Review output | Pending GitHub review via `gh api`, comments tagged `[nit]`, `[medium]`, `[critical]`, suggested verdict from the worst finding. User submits |
| SEO | Public-facing apps get SEO checks in the reviewer, flagged like accessibility |
| Multi-file changes | `multi-file-gate` asks once per turn before a second source file is edited (section 9b) |
| TDD | Enforced in layers (section 9c), logic paths only, human-only spike toggle |
| Unattended runs | Must work in cloud and CI. Human-dependent behaviour set in `config.yaml` under `unattended`, chosen at init |
| Token use | Deterministic first; the model sees only failures, the diff and compact inputs (section 5a) |
| Persona | `staff-reviewer` agent + `review-rubric` skill for repo audit and PR review, measured by evals (section 9a) |
| Build approach | Walking skeleton in milestones (section 13) |
| Repo home | `~/Documents/khubaib-personal/harness`; private GitHub repo `khubaibqaiser/harness` later (ask before creating) |

## 3. Non-goals for v1

- Cursor, Codex, OpenCode adapters
- Web UI, remote telemetry, multi-repo dashboards, auto-update
- Copying or vendoring any third-party skill or plugin
- Before/after screenshot comparison
- Storing credential values anywhere
- Global installation of anything except the `/harness` plugin
- Agent SDK / API-key mode

## 4. Architecture

```
plugin/                       Claude Code plugin (installed by whoever runs init/update)
  skills/harness-init/        interview + recommend in the user's session
  skills/harness-update/
  skills/harness-review/      orchestrates the PR review
  skills/harness-doctor/
src/ (CLI, deterministic)
  scan/       detectors → facts.json
  validate/   JSON schemas for answers, picks, findings; validation commands the skills call
  apply/      template renderer, merge logic, manifest; apply/claude.ts holds all Claude-specific output
  git/        branch, commit, push, gh pr create, gh review payloads
  hooks/      single dispatcher per hook event (section 9d)
  checks/     stop gate, TDD checks, SEO script, axe runner, diff coverage, proof of red, integrity check
  review/     worktree, run recipe, login script, capture, publish
  stats/      events log reader
catalog/
  items/*.yaml
  templates/  files for own items
evals/        reviewer and recommend eval sets and results
```

Init flow: `/harness:init` → CLI `scan` → skill interviews (Claude Code's native question prompts) → CLI `validate answers` → skill recommends → CLI `validate picks` → CLI `select` (checklist, also usable inside the session) → CLI `apply` (diff shown, confirm) → CLI `git` (each outward step confirmed).

`scan`, `report`, `doctor`, `stats`, `uninstall` and every check run from the CLI alone, without Claude.

The seam for future agents is `apply/<agent>.ts` plus a plugin for that agent. No plugin framework until a second agent exists.

## 5. Commands

| Command | Where | Does |
|---|---|---|
| `/harness:init` | plugin | Full pipeline on a repo without `.harness/` |
| `/harness:update` | plugin | Compare the running catalog version with `config.yaml`, re-scan, re-recommend, show diff (new / changed / retired / now-conflicting), apply approved changes. A newer catalog arrives by upgrading the plugin and package |
| `/harness:review <pr>` (plugin) and `/harness-review <pr>` (repo skill copied by init, so every developer has it) | plugin / repo | PR reviewer (section 9) |
| `harness scan` / `report` | CLI | Facts; re-render `report.md` |
| `harness sync` | CLI | One-time setup per developer after cloning: runs `claude plugin install <name>@harness-pins --scope project` for each declared outside plugin (after showing the list and asking) and installs pinned outside non-plugin skills into gitignored `.claude/skills/`. The session-start hook and `doctor` warn when something declared isn't installed |
| `harness doctor` | CLI | Manifest hashes, hooks wired, MCP servers declared, outside skills synced, Claude Code version ≥ each item's `min_claude_code` |
| `harness stats` | CLI | Summarise `.harness/logs/events.jsonl` (section 9e) |
| `harness status` / `/harness:status` | CLI / plugin | Installed items, gate states, TDD pause, sync gaps, catalog version, last review |
| `harness add <item>` / `remove <item>` | CLI | Change one catalog item without a full update: checks `requires` and `conflicts_with`, shows the diff, updates the manifest, offers a commit |
| `harness why <item>` | CLI | Why the item was picked (reason, findings it addresses, `applies_when` matches), or why it wasn't |
| `harness explain` | CLI | The last gate block: which gate, which rule, the files involved, and the allowed next step |
| `harness tdd off` / `on` / `status` | CLI; `off` is human-only | Pause TDD layers 2–4 for this session, resume them, or show the current state (section 9c) |
| `harness assets prune` | CLI | Delete screenshot folders for closed PRs |
| `harness uninstall` | CLI | Remove only manifest-listed files and blocks |
| `harness update --check` | CLI | Report whether npm has a newer version |

**Running the CLI.** `harness` is the command name of the npm package. Without installing it: `npx @khubaibqaiser/harness <command>`. With `harness-devdep` selected: `pnpm harness <command>` (or the repo's package manager), so the whole team runs the pinned version. Docs never show a bare global `harness`, because nothing is installed globally.

**After init.** `/harness:init` runs `sync` for the person who ran it, so everything works immediately. Teammates run `sync` once after cloning.

## 5a. Design principle: minimal tokens, maximum impact

- **Scripts measure.** Stack detection, lint, typecheck, axe, SEO, console/network errors, performance numbers, coverage. Only failures reach the model.
- **Diff-scoped review.** Changed hunks plus a small surrounding window, `AGENTS.md`, and the failure list. More files only through tool calls.
- **Right model per step.** Route mapping and the verification pass run in a subagent on a small model; review and recommend use the main model. Set in `config.yaml`.
- **Compact inputs.** Catalog items as `id`, `applies_when`, `why`, `cost`. Facts as JSON, not file dumps.
- **Images sparingly.** Only the 1280 px light screenshot of each changed route goes to the model, downscaled (`review.model_screenshots`).
- **No repeated work.** Cached facts and answers; stable prompt prefixes first for prompt caching.
- **Budgets and caps.** Turn caps per step; `review.max_findings` (default 15) with extra nits collapsed; headless runs use `--max-turns` and `--max-budget-usd`; each run prints tokens and cost per step.
- **Context isolation.** Review and recommend run as subagents so their working context does not stay in the developer's main session.

## 6. Target repo layout

```
.harness/
  config.yaml      answers, apps, selections, catalog version, review, tdd, unattended settings
  manifest.json    every file and merged block written, with content hash
  report.md        findings, roadmap, deliberate exclusions
  context/product.md  approved product scope summary (from pointed files or the user's own words)
  hooks/           dispatcher + check modules (Node, cross-platform)
  state/           per-session hook state (gitignored)
  logs/            events.jsonl, multi-file and tdd-off logs (gitignored)
  reviews/         <pr>.json findings history (gitignored by default)
  debug/           raw model output on validation failure (gitignored)
.harnessignore     paths never sent to the model (regulated data, fixtures)
AGENTS.md          harness block between markers (repo root only in v1)
CLAUDE.md          created with @AGENTS.md if absent; otherwise the diff proposes adding the import
.claude/settings.json   merged: hooks, permissions baseline, sandbox, enabledPlugins, inline pinned marketplace
.claude/agents/         staff-reviewer, researcher, ui-verifier
.claude/skills/         own skills incl. harness-review (committed); synced outside skills (gitignored)
.mcp.json               harness servers, pinned versions
.github/CODEOWNERS      harness paths owned by the user(s) chosen at init
.github/workflows/      selected CI items (ci-tdd, harness-integrity, claude-code-action)
.gitignore              harness entries
```

**`AGENTS.md` block rules:** only what the agent can't infer from the code (commands, conventions decided by people, denied actions, where specs and ADRs live), generated from interview answers and facts, kept under 60 lines. Architecture descriptions are not written there.

**Pinned outside plugins** (verified against the marketplace reference): `extraKnownMarketplaces` can pin a marketplace only to a branch or tag, so the tool writes an inline marketplace of type `settings` named `harness-pins`, whose `plugins` entries use `github` or `git-subdir` sources with a full commit `sha`. Plugins from marketplaces that use relative paths (e.g. the official marketplace) are referenced through `git-subdir` with the same `sha`.

## 7. Catalog

### 7.1 Item format

```yaml
id: gsap-skills
kind: plugin   # own-skill | own-agent | own-hook | plugin | mcp | external-skill | rule | ci | settings
title: GSAP official skills
source: { type: github, repo: greensock/gsap-skills, sha: <40-char sha> }
license: MIT
min_claude_code: 2.1.0
applies_when:            # hints for recommend, not hard rules
  any_dep: [gsap]
  project_types: [landing]
conflicts_with: [motion-ai-kit]
requires: [playwright-mcp]
cost: { context: low, setup: none }
stance: optional         # default | optional | discouraged
stance_reason: ""        # required for discouraged, e.g. "duplicates /goal"
side_effects: []         # e.g. [installs-hook, downloads-binary, telemetry-on-by-default]
why: Correct ScrollTrigger and timeline usage.
evidence: [https://github.com/greensock/gsap-skills]
```

### 7.2 Catalog checks (CI)

Schema valid; `requires` and `conflicts_with` targets exist; own items have templates; outside items have a `sha` (or `unpinned` with a reason) and `license`; no duplicate ids; `min_claude_code` present.

### 7.3 Seed catalog for v1

Own items:
- Hooks: `agent-guard` (incl. permissions baseline, `dep-verify`, shell-write ask), `stop-gate`, `post-edit-format`, `gitleaks-commit`, `config-change-guard`, `multi-file-gate`, `tdd-gate`, `session-context`, `pr-create-trigger`
- Agents: `staff-reviewer`, `researcher`, `ui-verifier`
- Skills: `review-rubric`, `harness-review`, `ui-verify`, `seo-audit`, `webgl-landing`, `rn-a11y`, `perf-budget`, `adr`, `pr-ship`, `session-structure` (creates and maintains `features.json`, `progress.md`, `init.sh`; `session-context` reads them at session start)
- Settings: `sandbox-settings` (required when any unattended mode is enabled), `permissions-baseline`
- Rules: `agents-md`
- CI: `ci-tdd`, `harness-integrity` (manifest hashes + CODEOWNERS required for harness paths), `lefthook-baseline`, `claude-code-action`
- Other: `harness-devdep` (pins the CLI as a devDependency; offered as a choice because agent-guard blocks new dependencies by default)

Referenced items: **everything discussed in the audit is in the allowlist.** The catalog is only the set of items the tool may recommend; a repo gets only what recommend proposes and the user ticks during init, update or `add`. `stance` tells recommend how to treat each one, and `discouraged` items are proposed only when the user asks for them by name or no alternative fits, always with the reason shown.

| Area | Items (stance in brackets where not `optional`) |
|---|---|
| Design direction | frontend-design [default], impeccable, ui-ux-pro-max, taste-skill, superdesign [discouraged: duplicates Figma], design (Anthropic knowledge-work plugin: accessibility review, critique, UX copy) |
| UI quality and performance | web-design-guidelines, react-best-practices, vercel-react-native-skills, modern-web-guidance, emilkowalski-skills, web-quality-skills, shadcn (skill + MCP), figma |
| 3D and motion | gsap-skills, threejs-skills, motion-ai-kit, spline-mcp, mcp-for-blender (`side_effects: runs-arbitrary-python`) |
| Process | superpowers [default], mattpocock-skills, addyosmani-agent-skills, ponytail, caveman [discouraged: overlaps ponytail], spec-kit [discouraged: overlaps superpowers], feature-dev [discouraged], pr-review-toolkit [discouraged], code-review [discouraged: built-in /code-review], code-simplifier, ralph-loop [discouraged: use /goal], remember [discouraged: built-in memory], wshobson-agents [discouraged: instruction overload] |
| Workflow upkeep | claude-code-setup, claude-md-management, skill-creator, hookify, session-report, dash0 |
| Code intelligence and docs | typescript-lsp [default], swift-lsp, kotlin-lsp, context7, graphify, serena [discouraged: duplicates LSP], sourcegraph [discouraged], mintlify, engineering (Anthropic knowledge-work plugin: architecture, system design, testing strategy, documentation, incident response, deploy checklist) |
| Verification | playwright, chrome-devtools-mcp, webapp-testing (anthropics/skills) |
| Mobile | expo, react-native-best-practices (Callstack), maestro-mcp, mobile-mcp, revenuecat |
| Backend, API, data | postman, 42crunch-api-security-testing, supabase, supabase-agent-skills, prisma, neon, databases-on-aws, auth0, workos, stripe |
| Cloud and IaC | aws-core, aws-serverless, deploy-on-aws, pulumi, terraform, vercel, cloudflare, render, railway |
| CI and repo flow | mergify |
| Security | security-guidance [default], claude-security, semgrep, trailofbits-insecure-defaults, trailofbits-supply-chain-risk-auditor, stackhawk-hawkscan, aikido [discouraged: duplicates semgrep], sonarqube [discouraged], jfrog [discouraged], sonatype-guide [discouraged], probity (alternative TDD engine to own `tdd-gate`), tdd-guard [discouraged: superseded by probity] |
| Observability and product | sentry, getsentry-skills, posthog, growthbook, datadog |
| AI features and evals | evals-skills, langfuse, deepeval, agent-sdk-dev, mcp-server-dev |
| Marketing and SEO | marketingskills |

Impeccable carries `side_effects: [installs-hook, downloads-binary, telemetry-on-by-default]`, shown in the select checklist. impeccable, ui-ux-pro-max, taste-skill and superdesign conflict with each other, so a repo has one lead design skill; frontend-design is lightweight and may sit alongside the lead, which takes precedence. The repo's design tokens or design-system doc stay the source of truth.

## 8. Flows

### 8.1 scan
Reads file names and an allowlist of config files only (never `.env*`, never `.harnessignore` paths). Produces `facts.json`: package manager, workspaces and **apps** (each workspace with a runnable entry: web, mobile, api), frameworks, router types, test runners, CI files, Docker, IaC markers, DB clients, auth SDKs, Expo markers, deploy markers, existing `AGENTS.md`/`CLAUDE.md`/`.claude/`, lefthook or husky. Deterministic.

### 8.2 interview
Runs in the user's Claude Code session through the `harness-init` skill, using native question prompts, one question at a time with options. **First question: project scope.** The user either points to the files that describe the product (README, PRD, spec, requirements; one or more paths) or writes a short scope in a few sentences. For pointed files, the skill reads only those files, writes a summary of at most 40 lines to `.harness/context/product.md` (purpose, users, core features, constraints, non-goals, source paths), and shows it for the user to edit and approve. Files outside the repo are summarised but not linked, because teammates can't open them; the summary says where they came from, and the tool offers to copy the original into `docs/` only if the user agrees. Paths in `.harnessignore` are never read. `product.md` is the product context for recommend, for the `staff-reviewer` in every PR review (checking changes against stated scope and non-goals), and for the `AGENTS.md` block, which links to it instead of repeating it.

Then it asks only about gaps in the facts and the product context: product type and domain, compliance (e.g. HIPAA, PCI) and data handling, team size, open-source plans, CODEOWNERS owner(s), deploy target, run budget, and **per app**: run recipe (install, start, ready URL, port), public-facing or not, login needed and where test credentials live (file + keys or environment variable names, stored as names only), login URL and post-login URL or selector. Also `unattended` settings, `tdd` paths and diff-coverage threshold. Answers are validated by the CLI and saved to `config.yaml`. `update` re-asks only when facts contradict stored answers.

### 8.3 recommend
Runs as the `staff-reviewer` subagent with the `review-rubric` skill, so repo audit and PR review apply the same standards. Input: facts, answers, compact catalog. Output: `picks.json` (per item `include: recommended | optional`, `reason`, `addresses: [finding ids]`) and `report.md` (findings by severity, 30/60/90-day roadmap, deliberate exclusions, the reviewer's stated limits, and the statement that only CI and branch protection enforce rules for everyone). CLI validates; unknown ids fail; one retry; then stop with raw output in `.harness/debug/`.

### 8.4 select
Checklist: recommended pre-ticked, optional unticked, key shows reason and cost; `requires` auto-selects with a notice; `conflicts_with` blocks both. Saved to `config.yaml`.

### 8.5 apply
Order: `.harness/` → `.claude/` files → `settings.json` merge → `.mcp.json` merge → `AGENTS.md` block → CODEOWNERS and workflows → `.gitignore` → manifest. Full diff first; nothing written until confirmed. Temp directory then move. Idempotent. If a manifest file's hash differs, ask keep / take new / show diff.

### 8.6 git
Clean tree required (or offer stash). Branch `chore/ai-workflow-<catalog-version>`, commit as the user, conventional message, no AI trailer unless the repo's config asks. Then ask separately: push? open PR with `report.md` as body? Never pushes to the default branch.

## 9. PR reviewer

1. **Trigger.** `/harness-review <pr>` (or `/harness:review` where the plugin is installed), or a `PostToolUse` hook on `Bash` matching `gh pr create` that asks Claude to run it in the same session (`review.auto_after_pr_create`). Headless: `claude -p "/harness-review <pr>"`, governed by `unattended.review`.
2. **Trust boundary.** Harness config, hooks and agent definitions are read from the **base branch**, never the PR. The tool **always asks before running any PR's code** (install or start), showing the author, whether they are a collaborator, and whether the PR changes install scripts, CI files or harness paths. Declining gives a code-only review.
3. **Gather.** `gh pr view`, `gh pr diff`, changed files, linked issue, `AGENTS.md`, `.harness/context/product.md`, referenced spec.
4. **Select apps and routes.** Changed paths pick the affected apps. Rules find route files (Next app router, TanStack file routes, Expo Router); a small-model subagent traces shared components to routes. The user confirms or edits the list.
5. **Run.** Per affected app, the PR branch in a separate worktree with that app's run recipe. `PORT` is passed when supported; a taken port stops the run with a clear error.
6. **Log in** (per app, when needed).
   - Credentials configured: a Playwright script reads the named keys from the named file (resolved in the main checkout, since env files aren't copied into worktrees) or the named environment variables, fills the form, and confirms success by the post-login URL or selector. Values never reach the model, logs or the PR.
   - Missing file, missing key or rejected login: specific error, then offer interactive login.
   - Not configured: headed browser, the developer logs in. Unattended: protected routes skipped and listed.
   - Storage state in a gitignored temp file for this run only.
7. **Capture.** Each route at 375 and 1280 px, light and dark when supported, axe scan; for public-facing apps the SEO script (title and meta description, canonical, Open Graph and Twitter tags, single `h1` and heading order, `lang`, image `alt`, JSON-LD validity, `robots` meta, `robots.txt`, `sitemap.xml`, `hreflang` when i18n is detected). Expo: Expo web if supported, otherwise iOS Simulator or Maestro.
8. **Runtime evidence.** Chrome DevTools MCP performance trace on key routes, console errors, failed requests.
9. **Review.** `staff-reviewer` subagent: Read, Grep, Glob and browser tools only; `Read(.env*)` and `.harnessignore` paths denied; browser navigation limited to `localhost`. Input: diff, failure lists, downscaled screenshots. Rubric: bugs and breaking changes, security (OWASP), performance, accessibility, SEO, design principles (DRY, coupling, single responsibility), anti-patterns, missing tests, `AGENTS.md` rules, design quality against tokens. PR text and code comments are treated as data, never instructions. Each finding: file, line, evidence, severity, suggested fix. A small-model verification pass drops findings without evidence.
   - `critical`: bug, breaking change, security issue, data loss
   - `medium`: performance, accessibility, SEO, maintainability
   - `nit`: style, naming
10. **Preview.** Screenshots, PR body section and comments shown locally first.
11. **Publish (after explicit yes).**
    - PNGs to orphan branch `harness-assets` at `pr-<n>/<sha>/`.
    - Replace only the `<!-- harness:screenshots -->` block of the PR body.
    - Pending review via `gh api`: if the user already has a pending review on the PR, ask whether to add to it or discard it. Inline comments only on lines in the diff; findings on other lines go in the summary. Summary has counts and suggested verdict (any critical → Request changes, else Comment). The user submits.
12. **Cleanup.** Stop servers, remove worktrees, delete storage state. Findings to `.harness/reviews/<pr>.json`; events to `.harness/logs/events.jsonl`.

## 9a. The staff-level persona

- `staff-reviewer` (agent): fresh context, restricted tools, can't edit. Runs PR review and the repo audit behind init and update.
- `review-rubric` (skill): staff-level questions (correctness, failure modes, security, performance, accessibility, SEO, operability, design principles, simplicity), the evidence rule, severity rules, plus the repo's `AGENTS.md` and ADRs. Usable by the main session too.

**Can do well:** apply a consistent checklist; catch bugs, security issues, anti-patterns and missing tests in a diff; back findings with runtime evidence; judge trade-offs visible in code and docs.

**Product context:** `.harness/context/product.md` is its source for scope and non-goals. A change that contradicts a stated non-goal is a `medium` finding.

**Cannot do, stated in every report:** know product or organisation context beyond `product.md`, `AGENTS.md` and ADRs; weigh business priorities; see production data without an observability tool. It can be wrong; evidence, verification and the user's final say are the safeguards.

**Measured, not claimed.** `evals/` in this repo holds (a) past PRs with known issues (starting with fitness-app) scored for issues found and false alarms, and (b) fixture repos with expected picks for the recommend step. Re-run on every rubric, prompt or model change.

**Settings:** `review.max_findings` (15), `review.model_screenshots` (1280 light), `review.models` (main, small).

## 9b. Multi-file gate and unattended runs

**Rule.** Before an agent edits a second source file in one turn, the user is asked once; approval covers the rest of the turn; the count resets on the next user message.

**Mechanism.**
- `UserPromptSubmit` clears this session's state.
- `PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit` records the file; on the second counted file without approval it returns `permissionDecision: "ask"` listing files touched and the next file.
- `PostToolUse` on the same tools marks the turn approved (it only fires if the edit was allowed).
- Files are counted per main session; edits from subagents are attributed by `agent_id` in the hook input and counted toward the turn that spawned them.
- `AGENTS.md` tells the agent to list all planned files before editing the second one.

**Not counted** (editable at init): a source file and its matching test count as one, in either order; snapshots; lockfiles; `multi_file_gate.generated` paths. Docs and config count.

**Known limit:** shell-command edits bypass Edit/Write; agent-guard asks before file-writing shell commands into TDD paths, but full coverage isn't possible from hooks.

**Unattended detection** (verified hook inputs): `CLAUDE_CODE_REMOTE=true` (cloud sessions), `permission_mode` of `dontAsk` or `bypassPermissions`, background subagents (`agent_id`), `CI=true`, and `HARNESS_UNATTENDED=1`, which every harness-installed workflow and routine sets because `-p` runs have no other marker. In unattended runs no hook returns `ask`; behaviour follows config set at init:

```yaml
unattended:
  multi_file_gate: block      # block | allow-log | off
  review: code-only           # skip | code-only
```
**Cloud sessions run with own items only.** Repo-enabled outside plugins are not loaded there (per the plugin docs), so nothing in the unattended path may depend on them; `report.md` lists which selected items won't apply in cloud runs.

`block` refuses and reports the wanted files; `allow-log` allows, logs, and `pr-ship` lists the files in the PR; `off` disables. `review: code-only` never runs PR code, never logs in, never publishes without a human. No defaults: init asks.

## 9c. TDD harness

Goal: no logic ships without a test that failed first; tests can't be weakened to pass; "done" against a spec needs proof. Only CI applies to everyone.

| # | Layer | Mechanism | Blocks |
|---|---|---|---|
| 1 | Guide | `AGENTS.md` TDD block + superpowers TDD skill | Nothing; sets intent |
| 2 | Red-first gate | `PreToolUse` on edits in `tdd.paths` | Editing implementation unless a related test failed since the last all-green run |
| 3 | Anti-tampering | `PreToolUse` content check on test and config files | `.skip`, `.only`, `xit`, `xdescribe`, `todo` on existing tests; removed assertions; no-op assertions; lowered coverage thresholds; deleted test files |
| 4 | Test lock | Red-step tests recorded; edits during green return `ask` with diff (blocked unattended) | Changing tests to fit code |
| 5 | Stop gate | typecheck, lint, related tests, diff coverage | Finishing with failures or coverage below `tdd.diff_coverage` |
| 6 | Spec gate | `PreToolUse` on `features.json` writes | `passes: true` unless each acceptance criterion names a test that exists and passed in the latest run |
| 7 | CI | `ci-tdd`: diff coverage, tamper scan, proof of red (new or changed tests fail on base, pass on head) | Merging untested or tampered changes |
| 8 | Mutation | Stryker on changed files for PRs labelled `mutation` | Tests that don't check anything |
| 9 | Reviewer | Rubric item: new logic without a test that would have failed before | Judgment cases |

**Red evidence.** Apply adds a JSON reporter output (Vitest or Jest) to `.harness/state/test-results.json` alongside existing reporters, shown in the diff. A `PostToolUse` hook on `Bash` records runs. "Related test" = matching base name or the runner's related-files lookup. No model calls.

**Scope.** `tdd.paths` / `tdd.exempt` per app, proposed from the scan and edited at init. Exempt paths skip layers 2–4 only.

**Spikes.** `harness tdd off` pauses layers 2–4 for one session; agent-guard denies it when run by an agent; logged and listed in the PR; layers 5–9 still apply.

**Shell bypass.** agent-guard asks before file-writing shell commands into `tdd.paths`; blocks them unattended.

**Hallucination checks.** Typecheck for invented APIs; `dep-verify` (exists on registry, first published ≥14 days ago, not a near-duplicate of a popular name) when the user allows a new dependency; Stop gate ignores claims and runs the checks; deny rules on `.harness/state/` and `.harness/hooks/`.

**Stop-gate speed.** Skips when only docs changed; incremental typecheck (`tsc -b` / workspace tool cache); tests and coverage scoped to changed files; configurable timeout after which it reports instead of blocking forever; retry cap so a broken environment can't trap the agent.

**Stated limit.** Hooks prove a test failed first and wasn't weakened, not that it tests the right thing. Coverage, mutation and the reviewer are proxies.

## 9d. Hook runtime

- One dispatcher script per event (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `ConfigChange`) runs all enabled checks in-process, so an edit costs one Node start, not one per check.
- Target: the harness adds under 100 ms (250 ms on Windows; raised from 200 ms on 2026-11-03 by owner decision, because shared Windows CI runners missed 200 ms by up to 13 ms while harness itself adds about 0.5 ms more than before round 12) per `PreToolUse` on top of a bare Node start, measured in CI as the median of paired differences against an empty `node` spawn, with a 1 s ceiling on the whole spawn.
  - Amended 2026-11-02: the original "under 150 ms per `PreToolUse`" timed the whole spawn, which follows machine load and Node start-up rather than harness code.
- A throwing check fails open with a visible warning, except agent-guard deny rules and `config-change-guard`, which fail closed.
- Each item declares `min_claude_code`; a weekly CI job in this repo runs all hook tests against the latest Claude Code release to catch schema drift.

## 9e. Measuring the harness

`.harness/logs/events.jsonl` records gate blocks and approvals, overrides (`tdd off`, multi-file approvals), Stop-gate failures by check, review findings with their later outcome (posted, edited, dropped), and token and cost per run. `harness stats` summarises them. `update` uses repeat findings and frequent overrides to suggest a new lint rule, test, or a loosened gate. Nothing leaves the machine.

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| Claude Code missing | CLI-only commands work; plugin steps explain how to install |
| Validation fails twice | Stop; raw output in `.harness/debug/` |
| Credential file or key missing, or login rejected | Specific error naming file, key or failed check; offer interactive login |
| App fails to install or start | Show output; offer code-only review |
| Review port in use | Stop with port and process; never use the developer's running server |
| User declines running PR code | Code-only review |
| Orphan-branch push rejected | Keep screenshots local; review without images, say why |
| Existing pending review | Ask: add to it or discard it |
| Comment line not in diff | Move finding to the summary |
| No test runner in a TDD path | Report that layers 2–6 can't run; recommend one; Stop gate and CI run what exists |
| Hook check throws | Fail open with warning, except guard deny rules and config-change-guard |
| Claude Code older than an item's `min_claude_code` | `doctor` and `apply` warn and skip that item |
| `gh` not authenticated | Keep results local; print the command to run later |
| Interrupted apply | Temp-dir write then move; repo unchanged |
| User edited a managed file | Ask keep / take new / diff |
| Manifest hash mismatch in CI | `harness-integrity` fails the check and names the file |

## 11. Safety

- Scan and Claude never read `.env*` or `.harnessignore` paths. Only the login script reads the named file and keys; values go straight to the browser form.
- PR review trust boundary: base-branch config and hooks; ask before running any PR code; reviewer denied `.env*`; browser limited to localhost; PR content treated as data.
- Interview and recommend have read-only tools; the reviewer can't edit.
- Every outward action (push, PR, PR body edit, pending review, orphan-branch push) needs an explicit yes.
- `permissions-baseline` denies reading secrets and writing harness state and hooks; `sandbox-settings` is required for unattended modes.
- Harness paths are covered by CODEOWNERS and the `harness-integrity` CI check, because copied hooks run code on every developer's machine.
- This package is published with npm provenance, minimal dependencies, and 2FA on the npm account, because its hooks run on every developer's machine.
- `report.md` states that only CI and branch protection enforce rules for everyone.

## 12. Testing

- Detector unit tests on fixture repos: Next/TanStack app, Astro landing, Expo app, Hono + CDK backend, a monorepo with web, mobile and api apps.
- Catalog CI checks (7.2) and a pin check that every `sha` still resolves.
- Hook tests with recorded hook JSON: multi-file gate (counting rules, approval through the turn, reset, subagent attribution, each unattended mode), agent-guard (deny rules, shell-write ask, `tdd off` denial, dep-verify), TDD gate (blocked without red, allowed after related red, blocked after green, each tamper pattern, test lock, spec gate), stop gate, config-change guard. Latency budget checked.
- `ci-tdd` on a fixture repo: proof of red fails a PR whose new tests already pass on base.
- Golden-file tests for apply, including the inline pinned marketplace and monorepo config.
- Skill steps tested by running the plugin headless (`claude -p`) against fixture repos with recorded expectations; evals in `evals/`.
- Acceptance per milestone (section 13).
- Dogfooding: this repo is the first repo the tool initializes.

## 13. Milestones (walking skeleton)

| Milestone | Delivers | Proven when |
|---|---|---|
| M1 Core harness | Hook dispatcher, agent-guard + permissions baseline, stop gate, multi-file gate, TDD gate, `staff-reviewer` + `review-rubric`, hand-installed into fitness-app | A week of real fitness-app work with gates firing correctly; `harness stats` shows blocks and overrides; no false block left unfixed |
| M2 PR reviewer | `/harness-review` end to end: trust prompt, worktree, login, capture, SEO, axe, traces, pending review, orphan-branch screenshots | Useful pending reviews on 3 real fitness-app PRs; reviewer eval set baseline recorded |
| M3 Installer | Catalog + checks, scan, `/harness:init` interview + recommend, select, apply, git, update, doctor, status, add/remove, why, explain, uninstall, sync, CI items | `init` on a fresh copy of fitness-app reproduces the M1/M2 setup plus a report the owner agrees with; this repo initialised by itself |
| M4 Coverage | Remaining project types and referenced catalog items: backend/infra → mobile → landing | Each fixture repo gets a report and install the owner agrees with |

The owner may reorder.

## 14. Verified and still to verify

**Verified on 2026-10-30 against current docs:**
- Agent SDK: third-party products must use API keys, not claude.ai login, unless approved → plugin-first design.
- Plugin sources (`github`, `url`, `git-subdir`) accept `ref` and full `sha`; marketplace sources in `extraKnownMarketplaces` accept only `ref`; inline `settings` marketplaces are supported → pinned plugins via `harness-pins`.
- Hook input includes `session_id`, `permission_mode`, and `agent_id` / `agent_type` inside subagents; `CLAUDE_CODE_REMOTE=true` in remote sessions; no marker for `-p` mode.
- Subagent frontmatter hooks require workspace trust; a `-p` run does not count as accepting trust.
- Project-scope plugins enabled in `.claude/settings.json` are not downloaded to collaborators' machines; each runs `claude plugin install … --scope project` once. `claude -p` loads already-installed plugins. Cloud sessions load neither user-installed nor repo-enabled plugins.

**Still to verify:**
- What `permissionDecision: "ask"` does in each mode where nobody can answer (expected: treated as deny; the dispatcher won't return it there anyway).
- Settings-file hook behaviour before workspace trust in a fresh clone.
- `gh api` payload for a pending review with inline comments, and the error when one already exists.
- How orphan-branch image links render in private-repo PR bodies.
- Vitest and Jest options to add a JSON reporter without replacing existing ones; `vitest related` in monorepos.
- Proof of red when new tests don't compile on base: count a compile or import error as "fails" only for newly added test files, and report it separately.
- Diff-coverage from istanbul output without a Python dependency.
- How teammates install the `/harness` plugin while this repo is private.
- Whether a cloud environment's setup script can install plugins (`claude plugin install`), which would let outside plugins apply in cloud runs.
- Whether plugins installed from an inline `settings` marketplace install cleanly with `claude plugin install <name>@harness-pins --scope project`.

## 15. Roadmap after v1

- Cursor adapter (`apply/cursor.ts` + Cursor rules and hooks), then Codex and OpenCode
- Optional before/after screenshots (`--compare`)
- Reviewer in CI via `claude-code-action`
- Container mode for running untrusted PRs
- Turning repeated recommend choices into deterministic rules
- Open-source release: license, contribution guide, catalog submission process
