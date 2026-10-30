# Harness: design spec

- Status: draft, awaiting review
- Date: 2026-10-30
- Owner: khubaibqaiser
- Package: `@khubaibqaiser/harness` (npm, unclaimed as of 2026-10-30)
- Research basis: AI-Native Workflow Audit (claude.ai artifact CtVz1z8qP17BjFpHiKqsnV)

## 1. Goal

One tool that sets up a curated AI-native workflow inside a repository. It scans the repo, interviews the user about what the scan cannot tell, recommends items from its own closed catalog, lets the user choose, writes the chosen items into the repo, and asks before committing, pushing and opening a PR. The user makes every decision. The tool ships a local PR reviewer as one of its own items.

Everything is repo-level, so every developer who clones the repo gets the same workflow. Nothing is installed globally.

## 2. Decisions (agreed in brainstorming)

| Topic | Decision |
|---|---|
| Shape | TypeScript npm CLI plus a thin Claude Code plugin exposing `/harness init|update|review|doctor` |
| Engine | Rule-based pipeline. In `init` and `update`, Claude (headless, Agent SDK) is used only for interview and recommend, and returns schema-validated JSON. `review` uses the `staff-reviewer` agent |
| Catalog | Closed. Lives in this repo. Changes only through a new release |
| Third-party items | Referenced, never copied into this tool or committed into target repos |
| Target agent | Claude Code only in v1. Cursor, Codex, OpenCode on the roadmap |
| v1 project types | React/Next web app, landing/marketing (incl. 3D/motion), RN/Expo mobile, Node backend/infra |
| Install location | `.harness/` for config, manifest, report, hook scripts. Real files in `.claude/agents/` and `.claude/skills/`. Merged blocks in `.claude/settings.json`, `.mcp.json`, `AGENTS.md` |
| Outside non-plugin skills | `harness sync` installs them locally into `.claude/skills/`, gitignored, pinned to a commit |
| Git | Branch `chore/ai-workflow-<catalog-version>`, commit as the user's git identity, ask before push, ask before PR |
| PR reviewer trigger | On demand and after an agent runs `gh pr create` (hook, can be disabled) |
| PR reviewer browser | Headless Playwright for screenshots and axe, Chrome DevTools MCP for traces and runtime errors |
| Screenshots | After-only (no base-branch comparison), pushed to orphan branch `harness-assets` |
| Multi-file changes | `multi-file-gate` own hook: when an agent is about to edit a second source file in a turn, it asks the user once, showing files touched and the next file. Unattended behaviour (cloud, CI, headless, background) is set per repo in `config.yaml` (section 9b) |
| Unattended runs | Everything must work in cloud and CI runs. Behaviour that needs a human is configured in `config.yaml` under `unattended`, chosen by the user during init |
| App login | During init, ask where test login credentials live: a file path + key names (e.g. `.env.local`: `E2E_EMAIL`, `E2E_PASSWORD`) or environment variable names (for cloud and CI secrets). If given, a Playwright script uses them; values never enter the model's context. If missing or failing, show a clear error and offer the interactive login. If not given, interactive login on each run |
| SEO | Public-facing sites get SEO checks in the reviewer, flagged like accessibility, plus SEO catalog items |
| Token use | Minimal tokens, maximum impact: deterministic checks first, the model sees only their failures and the diff (section 5a) |
| Persona | A staff-level reviewer used for both the repo audit (init/update) and PR review (section 9a) |
| Review output | Pending (draft) GitHub review via `gh api`. Each comment tagged `[nit]`, `[medium]` or `[critical]`. Suggested verdict follows the worst finding. User submits |
| Repo home | `~/Documents/khubaib-personal/harness`, private GitHub repo `khubaibqaiser/harness` later (ask before creating) |

## 3. Non-goals for v1

- Cursor, Codex, OpenCode adapters
- Web UI, telemetry, multi-repo dashboards, auto-update
- Copying or vendoring any third-party skill or plugin
- Before/after screenshot comparison
- Storing credential values anywhere (only the file path and key names are stored)
- Global (user-level) installation of anything

## 4. Architecture

Pipeline: `scan → interview → recommend → select → apply → git`. Claude never writes files. Any install can be reproduced from `facts.json`, the user's answers and the user's selections.

```
src/
  scan/        rule-based detectors → facts.json
  interview/   Agent SDK session, read-only tools → answers in config.yaml
  recommend/   Agent SDK session, read-only tools → picks.json + report.md
  select/      terminal checklist
  apply/       template renderer, merge logic, manifest; apply/claude.ts holds all Claude-specific output
  git/         branch, commit, push, gh pr create (each outward step confirmed)
  review/      PR reviewer
catalog/
  items/*.yaml one file per item
  templates/   files for the tool's own items
plugin/        Claude Code plugin; slash commands call the CLI
```

The only seam for future agents is `apply/<agent>.ts` reading the same `picks.json`. No plugin framework until a second agent exists.

## 5. Commands

| Command | Does |
|---|---|
| `harness init` | Full pipeline on a repo without `.harness/` |
| `harness update` | Compare the running package's catalog version with the one in `config.yaml`, re-scan, re-recommend, show diff (new / changed / retired / now-conflicting), apply approved changes. A newer catalog arrives by upgrading the package (`npx @khubaibqaiser/harness@latest update`, or bumping the devDependency). `update --check` only reports whether npm has a newer version |
| `harness sync` | Install pinned outside non-plugin skills into gitignored `.claude/skills/` |
| `harness review <pr>` | Run the PR reviewer |
| `harness doctor` | Check installed files against the manifest, hooks wired, MCP servers declared, outside skills synced |
| `harness report` | Re-render `report.md` from stored facts, answers and picks |
| `harness assets prune` | Delete screenshot folders for closed PRs from `harness-assets` |
| `harness uninstall` | Remove only files and blocks listed in the manifest |

`scan` and `report` work without Claude Code. All other Claude-dependent steps stop with a clear message if Claude Code is missing or signed out.

## 5a. Design principle: minimal tokens, maximum impact

Every step follows this order: deterministic first, model last, and the model sees only what a script cannot judge.

- **Scripts do the measuring.** Stack detection, lint, typecheck, axe, SEO checks, console/network errors and performance numbers are produced by scripts. Only their failures, not their full output, go to the model.
- **Diff-scoped review.** The reviewer gets changed hunks plus a small window of surrounding code, `AGENTS.md`, and the failure list. It reads more files only through tool calls when it needs them.
- **Right model per step.** Route mapping and the verification pass use a small model (Haiku). The review and the recommend step use the configured main model. Models are set in `config.yaml`.
- **Compact catalog.** The recommend step receives each item's `id`, `applies_when`, `why` and `cost`, not template contents.
- **Images sparingly.** Screenshots are captured at all sizes for the PR body, but only the 1280 px light screenshot of each changed route is sent to the model for design review, downscaled.
- **No repeated work.** `facts.json` and interview answers are cached; `update` re-asks nothing that hasn't changed. Stable prompt prefixes (rubric, `AGENTS.md`) are ordered first to benefit from prompt caching.
- **Budgets.** Each Claude step runs with a turn cap and an optional `--max-budget-usd`. The run summary prints tokens and cost per step.
- **Output caps.** The reviewer reports at most 15 findings, ordered by severity. Extra nits are collapsed into one summary line.

## 6. Target repo layout

```
.harness/
  config.yaml      answers, selections, run recipe, catalog version, review settings
  manifest.json    every file and merged block written, with content hash
  report.md        findings, roadmap, deliberate exclusions
  hooks/           hook scripts, written in Node (no shell), so they run on macOS, Linux and Windows
  state/           per-session hook state, e.g. files touched this turn (gitignored)
  logs/            multi-file changes made in unattended runs (gitignored)
  reviews/         <pr>.json findings history (gitignored by default)
  debug/           raw model output on schema failure (gitignored)
AGENTS.md          harness block between <!-- harness:start --> and <!-- harness:end --> (repo root only in v1; nested per-package files are not touched)
CLAUDE.md          created with @AGENTS.md if absent; if it exists without that import, the apply diff proposes adding it
.claude/settings.json   harness keys merged: hooks, enabledPlugins, extraKnownMarketplaces, permissions
.claude/agents/         real agent files (staff-reviewer, researcher, ui-verifier)
.claude/skills/         own skills committed; synced outside skills gitignored
.mcp.json               harness servers merged, pinned versions
.gitignore              harness entries
```

## 7. Catalog

### 7.1 Item format

```yaml
id: gsap-skills
kind: plugin   # own-skill | own-agent | own-hook | plugin | mcp | external-skill | rule | ci
title: GSAP official skills
source: { marketplace: greensock/gsap-skills, plugin: gsap-skills, ref: <tag-or-sha> }
license: MIT
applies_when:            # hints for the recommend step, not hard rules
  any_dep: [gsap]
  project_types: [landing]
conflicts_with: [motion-ai-kit]
requires: [playwright-mcp]
cost: { context: low, setup: none }
why: Correct ScrollTrigger and timeline usage.
evidence: [https://github.com/greensock/gsap-skills]
```

### 7.2 Catalog checks (CI)

Schema valid; every `requires` and `conflicts_with` target exists; own items have templates; outside items have `ref` and `license`; no duplicate ids.

### 7.3 Seed catalog for v1

Own items (shipped in this repo): `agent-guard` (hook), `stop-gate` (hook), `post-edit-format` (hook), `gitleaks-commit` (hook), `config-change-guard` (hook), `multi-file-gate` (hook), `session-context` (hook), `pr-create-trigger` (hook), `staff-reviewer` (agent), `review-rubric` (skill), `researcher` (agent), `ui-verifier` (agent), `ui-verify` (skill), `seo-audit` (skill + script), `webgl-landing` (skill), `rn-a11y` (skill), `perf-budget` (skill), `adr` (skill), `pr-ship` (skill), `agents-md` (rule template), `lefthook-baseline` (ci), `claude-code-action` (ci), `harness-devdep` (pins this package as a devDependency so the whole team runs the same version; offered as a choice because adding a dependency is something agent-guard blocks by default).

Referenced plugins, MCPs and skills, taken from the audit: frontend-design, modern-web-guidance, chrome-devtools-mcp, typescript-lsp, security-guidance, skill-creator, claude-md-management, superpowers, impeccable, web-design-guidelines, react-best-practices, shadcn, web-quality-skills, figma, playwright, gsap-skills, threejs-skills, emilkowalski-skills, spline-mcp, expo, react-native-best-practices, maestro-mcp, mobile-mcp, aws-serverless, aws-core, pulumi, terraform, render, vercel, cloudflare, supabase, prisma, neon, sentry, posthog, claude-security, semgrep, evals-skills, langfuse, deepeval, agent-sdk-dev, mcp-server-dev, marketingskills, mergify, claude-code-setup, session-report.

Each referenced item's `ref` and `license` are filled from its source at implementation time. Items whose source cannot be pinned are marked `ref: unpinned` and flagged in the report.

## 8. Flows

### 8.1 scan

Reads file names and an allowlist of config files only (never `.env*`). Produces `facts.json`: package manager, workspaces, frameworks from dependencies, router type, test runners, CI files, `Dockerfile`, IaC markers (`*.tf`, `cdk.json`, `Pulumi.yaml`), DB clients, auth SDKs, Expo markers (`app.json`, `eas.json`), deploy markers (`render.yaml`, `vercel.json`, `wrangler.toml`), existing `AGENTS.md`, `CLAUDE.md`, `.claude/`, lefthook or husky. Same repo state always gives the same facts.

### 8.2 interview

Claude gets `facts.json` and the README. It asks about gaps only, one question at a time with options: product type and domain, compliance needs (e.g. HIPAA, PCI), team size, open-source plans, deploy target if unclear, budget for agent runs, run recipe for the app (command, port, ready URL) if not detectable, whether the site is public-facing (enables SEO checks), and whether the app needs login. If it does: which file and keys, or which environment variable names, hold test credentials (stored as names only), plus the login URL and the post-login URL or selector that proves success. Also the `unattended` settings (section 9b): multi-file gate mode and what the reviewer does when no human is present. Claude proposes the login form selectors from the login page's markup, and the user confirms them. Answers are saved to `config.yaml`. `update` re-asks only when new facts contradict stored answers.

### 8.3 recommend

Claude runs with the `staff-reviewer` agent definition and `review-rubric` skill, so the repo audit and PR reviews apply the same standards. It gets facts, answers and the compact catalog. It must return `picks.json` matching the schema: per item `include: recommended | optional`, `reason`, `addresses: [finding ids]`. It also writes `report.md`: findings ranked by severity, a 30/60/90-day roadmap, items deliberately left out and why. Unknown ids fail validation; one automatic retry; second failure stops and saves raw output to `.harness/debug/`.

### 8.4 select

Terminal checklist. Recommended items pre-ticked, optional unticked. A key shows reason and cost. `requires` auto-selects dependencies with a notice; `conflicts_with` blocks selecting both. Final selection saved to `config.yaml`.

### 8.5 apply

Order: `.harness/` → `.claude/` files → `settings.json` merge → `.mcp.json` merge → `AGENTS.md` block → `.gitignore` → manifest. Full diff shown first; nothing written until confirmed. Writes go to a temp directory and are moved into place, so an interrupted run leaves the repo unchanged. Idempotent. If a manifest file's hash differs from what was written, `update` asks: keep mine / take new / show diff.

### 8.6 git

Requires a clean tree (or offers to stash). Creates `chore/ai-workflow-<catalog-version>`, commits with the user's git identity and a conventional message, no AI trailer unless the repo's config asks for one. Then asks, separately: push? open PR with `report.md` as body? Never pushes to the default branch.

## 9. PR reviewer

1. **Trigger.** `harness review <pr>` (runs the agent through the Agent SDK), `/harness review` (runs it as a subagent in the current session), or a `PostToolUse` hook on `Bash` matching `gh pr create` that tells Claude to run the review in the same session. Both paths load the same agent definition. Disable the hook via `review.auto_after_pr_create: false`. In unattended runs the `unattended.review` setting applies (section 9b).
2. **Gather.** `gh pr view`, `gh pr diff`, changed files, linked issue, `AGENTS.md`, referenced spec.
3. **Map to features.** Rules find route files (Next app router, TanStack file routes, Expo Router). Claude traces shared components to their routes. The user confirms or edits the route list.
4. **Run.** PR branch checked out in a separate git worktree. The run recipe in config has an install command, a start command, a ready URL and a port. The port is passed through `PORT` when the app supports it; otherwise, if the port is already taken, the review stops with a clear error instead of hitting your running dev server.
5. **Log in (if the app needs it).**
   - **Credentials configured:** a Playwright script reads the named keys from the named file (resolved in the main checkout, since `.env.local` is not copied into worktrees) or from the named environment variables, and fills the login form. Values never pass through the model, logs or the PR. Success is confirmed by reaching a post-login URL or selector stored in config.
   - **File missing, key missing or login rejected:** stop with a specific error (which file, which key, or "login page returned an error / did not reach the post-login URL"), then offer the interactive login.
   - **Not configured:** headed Playwright window opens and the developer logs in. In unattended runs there is no one to log in, so protected routes are skipped and listed in the review.
   - Storage state is saved to a gitignored temp file for this run only.
6. **Capture.** Each route at 375 and 1280 px, light and dark when supported, plus an axe scan. For public-facing sites, also the SEO script: title and meta description (present, length), canonical, Open Graph and Twitter tags, one `h1` and heading order, `lang`, image `alt`, JSON-LD validity, `robots` meta, `robots.txt` and `sitemap.xml` reachable, `hreflang` when i18n is detected. Expo: Expo web if supported, otherwise iOS Simulator or Maestro screenshots.
7. **Runtime evidence.** Chrome DevTools MCP performance trace on key routes; console errors; failed network requests.
8. **Review.** The `staff-reviewer` agent, fresh context, Read, Grep, Glob and browser tools only. It receives the diff, the failure lists from steps 6–7 and the downscaled screenshots (section 5a). Rubric (from the `review-rubric` skill): bugs and breaking changes, security (OWASP), performance, accessibility, SEO (public sites), design principles (DRY, coupling, single responsibility), anti-patterns, missing tests, `AGENTS.md` rules, design quality against tokens. Each finding needs file, line, evidence, severity, suggested fix. A verification pass drops findings without evidence.
   - `critical`: bug, breaking change, security issue, data loss
   - `medium`: performance, accessibility, SEO, maintainability
   - `nit`: style, naming
9. **Preview.** Screenshots, PR body section and all comments shown locally first.
10. **Publish (after explicit yes).** Push PNGs to orphan branch `harness-assets` at `pr-<n>/<sha>/`. Replace only the `<!-- harness:screenshots -->` block of the PR body. Create a pending review via `gh api` with summary counts and suggested verdict (any critical → Request changes, else Comment). The user submits in GitHub.
11. **Cleanup.** Stop server, remove worktree, delete storage state. Save findings to `.harness/reviews/<pr>.json`; `update` suggests a lint rule or test for findings that repeat.

## 9a. The staff-level persona

**Shape.** One agent plus one skill, used in two places:

- `staff-reviewer` (agent): fresh context and restricted tools, so it reviews work it didn't write and can't edit. It runs the PR review (section 9) and the repo audit behind `init` and `update` (the findings in `report.md`).
- `review-rubric` (skill): the standards it applies. These are staff-level questions (correctness, failure modes, security, performance, accessibility, SEO, operability, design principles, simplicity), the evidence rule (no finding without file, line and proof), severity rules, and the repo's own `AGENTS.md` and ADRs. As a skill, the main session can use the same rubric outside reviews.

**What it can do well:** apply a consistent checklist every time; catch bugs, security issues, anti-patterns and missing tests in the diff; back findings with runtime evidence (axe, SEO, traces, console errors); judge trade-offs it can see in the code and docs.

**What it cannot do, stated in every report:** know product or organisation context that isn't written down (the interview and `AGENTS.md` are its only sources); weigh business priorities; see production data unless an observability tool is connected. It can also be wrong, which is why every finding needs evidence, a verification pass removes unproven ones, and the user decides what is posted.

**Proving it is staff-level.** An eval set of past PRs with known issues (starting with fitness-app PRs) measures how many real issues it finds and how many findings are false alarms. Each change to the rubric or model is re-run against the set. The eval set and results live in this tool's repo under `evals/`, not in target repos. Without this, "staff-level" is a claim, not a measurement.

**Review settings** in `config.yaml`: `review.max_findings` (default 15), `review.model_screenshots` (default: 1280 px light only), `review.models` (main and small).

## 9b. Multi-file gate and unattended runs

**Rule.** When an agent is about to edit a second *source* file in one turn, the user is asked once. Approval covers the rest of that turn; the count resets on the user's next message.

**How it works (deterministic, a hook, not a prompt):**
- `UserPromptSubmit` clears this session's state in `.harness/state/`.
- `PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit` records the target file. If it would be the second counted file and the turn is not yet approved, the hook returns `permissionDecision: "ask"` with a reason listing the files touched so far and the next file.
- `PostToolUse` on the same tools marks the turn approved. That event only fires if the user allowed the edit, so a denial leaves the gate closed.
- An `AGENTS.md` guide tells the agent to list every file it plans to change before editing the second one, so the prompt shows the whole plan.

**What is not counted** (defaults, shown and editable in `config.yaml` during init): test files whose base name matches a source file already touched this turn; snapshot files; lockfiles; paths listed under `multi_file_gate.generated` (codegen output, migration output). Docs and config files count.

**Known limit, stated in the report:** edits made through shell commands (`sed`, codemods, `git mv`) don't go through Edit/Write, so the gate can't see them. agent-guard can be configured to ask before file-writing shell commands, but full coverage isn't possible from hooks.

**Unattended runs** (GitHub Action, routines, cloud sessions with nobody answering, headless `-p`, background subagents). A hook can't ask anyone there, so it never returns "ask". It follows `config.yaml`, which the user sets during init:

```yaml
unattended:
  multi_file_gate: block      # block | allow-log | off
  review: code-only           # skip | code-only
```
- `block`: refuse the second-file edit. The agent finishes with the list of files it wanted to change.
- `allow-log`: allow it, append the files to `.harness/logs/multi-file.jsonl`, and have the `pr-ship` skill list them in the PR description so the human gate moves to PR review.
- `off`: no gate when unattended.
- `review: code-only` runs the review without login (public routes only) and saves it as a local file or a PR artifact, never publishing without a human. `skip` does nothing.

The spec deliberately sets no default for these. Init asks, and the user's answer is written to config.

Detecting "unattended" reliably is listed in section 14 to verify.

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| Claude Code missing or signed out | `scan` and `report` run; other steps stop with instructions |
| Schema validation fails twice | Stop; raw output in `.harness/debug/` |
| Credential file or key missing, or login rejected | Specific error naming the file, key or failed check; offer interactive login |
| App fails to install or start during review | Show the install or start output; offer code-only review |
| Review port already in use | Stop with the port and the process using it; never review against the developer's running server |
| Orphan-branch push rejected (no write access, fork PR) | Keep screenshots local, post the review without images, say why |
| Hook script throws | Fail open with a visible warning (except agent-guard deny rules), so a broken hook never bricks a session |
| `gh` not authenticated | Keep results local; print the command to run later |
| Interrupted apply | Temp-dir write then move; repo unchanged |
| User edited a managed file | Ask keep / take new / diff; never overwrite silently |

## 11. Safety

- Scan and Claude never read `.env*`. The only exception is the review's login script, which reads only the file and keys the user named during init. Values go straight to the browser form and never reach the model, logs, `config.yaml` or the PR.
- Interview and recommend sessions run with read-only tools.
- Reviewer agent has no Edit or Write tools.
- Every outward action (push, PR, PR body edit, pending review, orphan-branch push) needs an explicit yes.
- The tool states in `report.md` that only CI and branch protection enforce rules for everyone; repo hooks apply to developers who use Claude Code and trust the folder.

## 12. Testing

- Detector unit tests against fixture repos: Next/TanStack app, Astro landing, Expo app, Hono + CDK backend, a monorepo combining them.
- Catalog CI checks (section 7.2).
- Hook tests feeding recorded hook JSON to each script: the multi-file gate (ignored files, approval carried through the turn, reset on a new prompt, each unattended mode), agent-guard, stop gate, pr-create trigger.
- Golden-file tests for apply: fixed facts + picks → exact file tree.
- Agent SDK steps tested against recorded responses; one live smoke test run on demand.
- Acceptance: `init` on a copy of fitness-app produces a report the owner agrees with; `review` on one real fitness-app PR produces a useful pending review with screenshots.
- Dogfooding: this repo is the first repo the tool initializes.

## 13. Build order within v1

1. Catalog format + checks, scan, apply, git (rule-based core, no Claude)
2. Interview + recommend (Agent SDK)
3. Select UI, update, doctor, uninstall, sync
4. PR reviewer
5. Claude Code plugin wrapper
6. Project-type coverage in order: web app → backend/infra → mobile → landing

The owner may reorder.

## 14. To verify during implementation

These are assumptions to confirm against current docs before relying on them:

- Whether `extraKnownMarketplaces` entries in project settings can pin a git ref or tag.
- Agent SDK (TypeScript) support for structured JSON output and per-session tool allowlists.
- How images from an orphan branch render in private-repo PR bodies (expected: visible only to viewers with repo access).
- Claude Code hook input fields for `PostToolUse` on `Bash` (to match `gh pr create` reliably).
- The exact `gh api` payload for creating a pending review with inline comments.
- How a hook can tell an unattended run from an interactive one (`CI` env var, `-p` mode, cloud session markers, subagent fields in hook input), and what a `permissionDecision: "ask"` does in each case. If detection isn't reliable, unattended settings fall back to an explicit `HARNESS_UNATTENDED=1` set by the CI workflow and routines that harness installs.
- Whether hook input lets subagent edits be told apart from main-session edits, for counting files per turn.
- Whether the Agent SDK can use the developer's existing Claude Code login or needs `ANTHROPIC_API_KEY`. This affects onboarding and cost, and the README must say which.
- How teammates install the `/harness` plugin while this repo is private (they need read access to `khubaibqaiser/harness`).

## 15. Roadmap after v1

- `apply/cursor.ts`, then Codex and OpenCode adapters
- Optional before/after screenshots (`--compare`)
- CI mode for the reviewer (GitHub Action)
- Turning repeated recommend choices into deterministic rules
- Open-source release (license, contribution guide, catalog submission process)
