# Personal preset: design spec

- Status: draft for the owner's review. The owner decisions are in section 1: Q1 to Q9 and F1 to F12 came from the interview, O1 to O12 answered the first draft's open questions, and C2 and C3 answered the second draft's. Section 13 lists the checks left for planning.
- Date: 2026-11-05
- Owner: khubaibqaiser
- Inputs: the owner interview of 2026-11-05 (Q1 to Q9, then the frontend architecture interview) and the owner's answers to the draft (O1 to O12). The code on main: `src/catalog/schema.ts`, `src/catalog/load.ts`, `src/catalog/check.ts`, `src/install/facts.ts`, `src/install/select.ts`, `src/install/merge.ts` (`mergeAgents`), `src/budget/measure.ts`, `src/cli/git.ts`, `src/checks/guard.ts` (`PERSON_ONLY`), `skills/init/{SKILL,interview}.md`, and [`2026-11-03-pr-size-design.md`](2026-11-03-pr-size-design.md) ("PR-size").
- When: the order is vet, then PR-size (O10), then the personal preset, then telemetry, then the context-budget build.
- Name clash: `src/install/preset.ts` already exists. It is the gate-defaults preset (`preset(facts)` builds the TDD, stop and multi-file config). This feature leaves it alone and puts its code in a new `src/catalog/presets.ts`.

## 1. Owner decisions

| # | Decision |
|---|---|
| Q1 | **Audience.** An opt-in named preset that anyone can choose. The neutral catalog stays the default. |
| Q2 | **Contents.** Working rules in AGENTS.md; third-party picks preselected; git and PR conventions enforced, not just written down; frontend architecture best practices for Next.js, React and React Native (the owner added this). "Your own skills" was not picked. |
| Q3 | **Source of the frontend rules.** Interview the owner on architecture, draft from their answers only, and the owner reviews the draft. |
| Q4 | **Frontend scope.** Only on matching stacks, detected by scan. Next.js rules go to Next.js repos, React Native rules to RN or Expo repos, and shared React rules to both. |
| Q5 | **Loading.** A short always-on core in AGENTS.md. The detailed frontend architecture is on-demand skills. |
| Q6 | **Preselected picks.** superpowers, ponytail and the Vercel React skills (O4 dropped caveman; O5 named the picks). Addy Osmani's skills are not preselected. |
| Q7 | **Git.** Enforced through `harness git`: no AI trailer, branch prefixes and a PR-size warning. The guard asks before a plain `git commit` that would add an AI trailer. The identity comes from the repo's git config and is never stored. |
| Q8, Q9 | **Always-on core rules (all chosen).** Ask before deciding, with options and a recommendation; no invented data, and label estimates; fix everything found; small PRs, with a README check in each PR; no paid actions without an OK; TDD; lean context; plain communication. |
| O1 | **Id.** The preset id is `khubaib-frontend`. |
| O2 | **Preset builder in v1 (scope change).** Other people go through an interview that captures their own preferences. Those preferences become personalised skills and rules. The person chooses a repo-level or a global install. Global installs are a deliberate exception to harness's repo-level rule: they write to `~/.claude/`, are tracked in a separate global manifest and are removed by `harness uninstall --global`. Every global write is listed in the preview and gets its own yes. The owner's preset is the first output of the same format (section 8). |
| O3 | **Team memory.** The preset stays separate from team memory. |
| O4 | **ponytail only; caveman is dropped.** The owner's reason: caveman's blunt tone clashes with the plain-communication rule, and ponytail fits staff-level engineering. |
| O5 | **Picks.** `react-best-practices`, `vercel-react-native-skills`, `web-design-guidelines` and `impeccable`, each on its own stack. Impeccable's telemetry is off by default (`DO_NOT_TRACK=1`). Its hooks and binary download are listed in the preview. `taste-skill` (Leonxlnx/taste-skill) is wanted next to Impeccable if the two don't conflict and keeping both makes sense; otherwise Impeccable alone. Even with taste-skill, Claude always asks the user before making any decision, and that overrides taste-skill's "just apply taste decisions" text. taste-skill is added only after a `harness vet` run and a licence check (section 6). |
| O6 | **Branch prefixes.** `feature/`, `fix/`, `hotfix/`, `chore/`, `refactor/`, `docs/`, `ci/` (from the owner's existing git conventions). |
| O7 | **Plain React.** The shared React skill also loads on plain React repos. |
| O8 | **TDD line.** The core keeps its TDD line. |
| O9 | **Prefix enforcement.** The guard asks on `git checkout -b` and `git switch -c` when the name has no listed prefix. `harness git branch` suggests prefixed names. |
| O10 | **PR-size first.** The PR-size feature (already specced) is built before the preset, and the preset reuses it. |
| O11 | **Unattended.** In unattended runs, a commit that adds an AI trailer is denied. |
| O12 | **Attribution setting.** The preset sets Claude Code's attribution setting in `.claude/settings.json`, merged like the other harness blocks and shown in the preview. The key name is checked against the Claude Code docs during planning. |
| C2 | **Global scope.** A global install includes the core rules, the personalised skills and the attribution setting at user scope (`~/.claude/settings.json`). The git checks stay per repo. |
| C3 | **Telemetry.** `DO_NOT_TRACK=1` goes in the repo's `.claude/settings.json` `env`. It applies to the whole session, and the README says so. |

**Frontend answers** (the owner's words or choices; quotes are verbatim):

| # | Topic | Answer |
|---|---|---|
| F1 | Folders | Hybrid. Shared and generic code by type (`_components/`, `hooks/`, `lib/`); product features by feature. |
| F2 | Server data | Next.js Server Components for the first load, TanStack Query on the client for interactive and live data. React Native uses TanStack Query. |
| F3 | Client state | "Filters, tabs and pagination goes to URL search params, local state where its only needed for single component and should reset on unmount, context for ready only shared/global level state, zustand with carefully curated slices for optimized performance" |
| F4 | Components | In-house design-system components on headless primitives, styled with Tailwind and variants (cva). No raw styling inside features. |
| F5 | Forms | React Hook Form with Zod schemas, the single validation source, shared with the server. Fields use design-system wrappers. |
| F6 | Testing | Testing Library units (behaviour, roles); MSW for APIs; E2E only for key flows (Playwright, Maestro or Detox); Storybook stories and visual tests for design-system components. |
| F7 | UI states | Suspense, `loading.tsx` and `error.tsx`; error boundaries with retry around widgets; an explicit empty state for every list. |
| F8 | API layer | A typed client, generated from OpenAPI or with Zod-parsed responses, plus per-feature query and mutation hooks with key factories. Components only use the hooks. |
| F9 | Performance | Server Components by default, `"use client"` at the smallest leaf; memoize only when measured; narrow store selectors; virtualize long lists; "in Next.js repo use of next Image component, in plain react.js use other techniques like lazy loading etc. use transitions (newer react apis) wherever needed for optimal client ux" |
| F10 | React Native | Expo with dev builds, Expo Router, expo-image, FlashList and Reanimated. Config plugins, never eject. |
| F11 | Style | kebab-case files, PascalCase components, camelCase hooks starting with `use`; named exports only, except where the framework needs a default; strict TypeScript (no `any`, a justified `!`, Zod-inferred types); barrel files only at a feature's or design system's public edge. |
| F12 | Extra | Web apps "SEO-optimized from the start, with a focus on performance and ideal UX best practices"; an accessibility baseline (semantic HTML, labels, keyboard and focus, WCAG AA, RN accessibility props); env vars validated once with Zod in `env.ts`, never read from `process.env` directly. i18n was not picked. |

## 2. Scope

**In:**
- the preset file format, its loader and its checks;
- the `khubaib-frontend` preset: core block, three frontend skills, preselected picks, git rules, the attribution setting;
- the preset builder: interview, generated preset, repo-level or global install (O2);
- the global manifest and `harness uninstall --global`;
- the opt-in question in the init interview, and the preset rows in select;
- `harness git` checks, a prefix suggestion, and two guard asks (trailer, branch prefix);
- update, remove and uninstall, byte-identical;
- tests.

**Out:**
- the owner's own skills (Q2: not picked);
- caveman (O4) and Addy Osmani's skills (Q6) as preselects;
- i18n rules (F12);
- publishing or sharing presets through a registry; a built preset is a folder the person keeps;
- the team memory (O3);
- storing a git name or email, ever (Q7);
- changing the staff reviewer or the compact catalog it reads.

## 3. The preset format

A preset is one YAML file plus its own items and templates:

```
<presets dir>/<id>.yaml
<presets dir>/<id>/items/*.yaml          # catalog item schema, unchanged
<presets dir>/<id>/templates/core.md     # the core block
<presets dir>/<id>/templates/skills/<name>/SKILL.md
```

Shipped presets live in `catalog/presets/`. Built presets live where section 8 puts them. The items are validated by `validateItem` in `src/catalog/schema.ts` and kept out of `catalog/items/`, so the neutral catalog, its compact form (`load.ts`) and the reviewer never see them.

```yaml
id: khubaib-frontend
title: "Khubaib frontend"
description: "<one line shown in the interview>"
core: core-rules               # a preset item, kind rule
preselect:                     # neutral catalog ids; each still filtered by its own applies_when (O5)
  - superpowers
  - ponytail
  - react-best-practices
  - vercel-react-native-skills
  - web-design-guidelines
  - impeccable                 # taste-skill joins only after section 6's preconditions
skills:                        # preset items; each item's applies_when picks the stacks (Q4, O7)
  - frontend-react
  - frontend-nextjs
  - frontend-react-native
settings:
  attribution: off             # O12; the settings key is confirmed in planning
  telemetry_off: [impeccable]  # O5; writes DO_NOT_TRACK=1 (section 6)
git:
  branch_prefixes: [feature/, fix/, hotfix/, chore/, refactor/, docs/, ci/]
  no_ai_trailer: true
  pr_size_warning: true
```

**Checks** run in `harness catalog check` (`src/catalog/check.ts`) and in CI for shipped presets, and in `harness preset check <dir>` for built ones:
- every `preselect` id exists in `catalog/items/` and isn't `discouraged`;
- `core` and every `skills` id exist under `<id>/items/`, and each template exists;
- no preset item id clashes with a catalog id;
- each skill template has frontmatter with `name` and `description`, and a body of at most 150 lines;
- `branch_prefixes` is a non-empty list of `^[a-z0-9-]+/$` strings;
- `telemetry_off` ids are in `preselect`;
- unknown keys fail.

**Stack matching** reuses `applies_when.frameworks` against `facts.frameworks` (from `deriveFacts` in `src/install/facts.ts`):

| Skill | `applies_when` |
|---|---|
| `frontend-react` | `frameworks: [react, next, react-native, expo]` (Q4, O7) |
| `frontend-nextjs` | `frameworks: [next]` |
| `frontend-react-native` | `frameworks: [react-native, expo]` |

`facts.frameworks` is the union over every package, so a monorepo with a Next.js app and an Expo app gets all three skills at repo level. That is the intended result of Q4. The preselects keep their catalog `applies_when` (O5): `react-best-practices` on react or next, `vercel-react-native-skills` on react-native or expo, `web-design-guidelines` on web or landing, and `impeccable` on web.

## 4. How init offers it

- **Interview.** `skills/init/interview.md` gets one question, after scope and before the gaps: "Use a named preset?" The options are "No preset (neutral catalog, the default)" first, then each shipped or repo-level built preset with its `description`. `harness preset list` prints them.
- **Answers.** `answers.json` gains `preset: null | "<id>"`. `harness validate answers` rejects an unknown id.
- **Recommend is unchanged.** The reviewer runs on the neutral catalog only, so the preset can't change its findings.
- **Select.** `harness select --picks <picks.json> --preset <id>` adds rows after the reviewer's: each stack-matched preselect as ticked, with the reason "Preselected by the khubaib-frontend preset", unless the reviewer already picked it; then the core rule and each stack-matched skill as ticked rows. `notPicked` treats preset ids as picked. The skill text says which rows came from the preset.
- **Preview.** The apply preview lists Impeccable's hooks (SessionStart, PostToolUse on Edit and Write, Stop), its engine download into `~/.impeccable/bin/`, the telemetry line, and the attribution block (O5, O12).
- **Budget.** The preset rows go through `measureSelection` and `budgetVerdict` like any pick (section 5).
- **Config.** `config.yaml` records `preset: { id, version }`. Without a preset the key is absent, so existing configs need no migration.

## 5. The always-on core block

A second marked block in AGENTS.md, written by a new merge kind `agents-md-preset`. It follows `mergeAgents` exactly, with its own markers, and goes after the harness block:

```markdown
<!-- harness:preset:start -->

## Working rules

- Ask before deciding: give options with a recommendation, then wait for the answer. This overrides any skill that says to decide on its own.
- No invented data. Label every estimate as an estimate.
- Fix everything found, not only the first problem.
- Keep PRs small. Check the README in each PR and update it when it changed.
- No paid actions without an OK.
- TDD: write a failing test first.
- Lean context: load only what the task needs.
- Plain communication: short sentences, plain words.
- Git: no AI trailer in commits. Branch names start with feature/, fix/, hotfix/, chore/, refactor/, docs/ or ci/.

<!-- harness:preset:end -->
```

The lines are drafted from Q7 to Q9, O5, O6 and O8; the owner reviews the wording. The override sentence on the first line carries O5's rule that asking wins over taste-skill's "just apply taste decisions" text. The TDD line stays even when the harness block's TDD section is present (O8).

**Cost (estimates, characters / 4 as in `measure.ts`):**

| Part | Tokens |
|---|---|
| Core block | ~173 |
| Each skill's name and description | ~58 |
| Preset total, one stack (core + `frontend-react` + one stack skill) | ~289 |
| Preset total, Next.js and RN (core + 3 skills) | ~347 |
| Preset total, plain React (core + `frontend-react`) | ~231 |
| Today's harness block, for scale | ~275 |

The preset's own text is about 12% to 17% of the 2000-token budget (estimate). The preselected plugins can't be measured before install by `itemContext`, so a preset with them always raises the budget ask for unmeasured items. That is the current rule, not a new one.

## 6. Third-party picks

- **Impeccable.** Its catalog side effects stay as they are: `installs-hook`, `downloads-binary` and `telemetry-on-by-default`. The preset turns telemetry off by merging `"env": { "DO_NOT_TRACK": "1" }` into `.claude/settings.json` as a recorded block, shown in the preview. Claude Code passes this env to every command in the session, so other tools that honour `DO_NOT_TRACK` stop sending telemetry too. The README says so (C3).
- **taste-skill.** It's in `catalog/items/taste-skill.yaml` today (pinned at `12af471`, `license: MIT`, `applies_when: project_types: [landing]`). It joins the preselect only when all three of these hold:
  1. `harness vet Leonxlnx/taste-skill` passes at the pinned sha, and the owner accepts any high findings;
  2. the licence check confirms MIT with no commercial-use restriction at that sha (one listing mentions one), and the item records the evidence;
  3. the planning-time conflict check (section 13, C1) finds that Impeccable and taste-skill don't conflict and keeping both makes sense.

  If any of these fails, the preset ships with Impeccable alone.
- **Asking wins.** The core block's first line overrides taste-skill's "just apply taste decisions" text. A test checks that the line is in the core template.

## 7. The frontend skills

Own skills at `.claude/skills/<name>/SKILL.md`, from `catalog/presets/khubaib-frontend/templates/skills/<name>/SKILL.md`. Only the name and description load until a skill is used (Q5). Each body is drafted from section 1 only and reviewed by the owner (Q3).

| Skill | Description (always loaded) | Stacks |
|---|---|---|
| `frontend-react` | Shared React architecture rules for this repo (folders, state, components, forms, server data, testing, UI states, performance, style, accessibility, env). Use when writing or reviewing React code. | React, Next.js, React Native, Expo |
| `frontend-nextjs` | Next.js rules for this repo (Server Components first, "use client" at the smallest leaf, loading.tsx and error.tsx, next/image, SEO). Use when working on Next.js routes, layouts or data loading. | Next.js |
| `frontend-react-native` | React Native rules for this repo (Expo dev builds, Expo Router, expo-image, FlashList, Reanimated, config plugins). Use when working on React Native or Expo screens, lists or native config. | React Native, Expo |

**Outlines:**
- `frontend-react`:
  - folders (F1);
  - client state, with F3 quoted verbatim;
  - TanStack Query on the client (F2);
  - components (F4) and forms (F5);
  - API layer (F8);
  - UI states: error boundaries with retry around widgets, an empty state for every list (F7);
  - testing: Testing Library, MSW, Storybook and visual tests (F6);
  - performance: memoize only when measured, narrow selectors, virtualize long lists, transitions, lazy loading in plain React (F9);
  - style (F11);
  - the accessibility baseline and `env.ts` (F12).
- `frontend-nextjs`:
  - Server Components for the first load, then TanStack Query (F2);
  - Server Components by default, `"use client"` at the smallest leaf (F9);
  - Suspense, `loading.tsx` and `error.tsx` (F7);
  - the next Image component (F9);
  - SEO from the start (F12);
  - E2E with Playwright for key flows (F6).
- `frontend-react-native`:
  - Expo with dev builds, Expo Router, expo-image, FlashList, Reanimated; config plugins, never eject (F10);
  - TanStack Query (F2);
  - E2E with Maestro or Detox for key flows (F6);
  - RN accessibility props (F12).

## 8. The preset builder (O2)

**Entry.** The `/harness:preset` skill runs in the main session (subagents can't ask questions), and the `harness preset` CLI checks and installs the result. The CLI never calls a model.

**Interview.** One question per call with AskUserQuestion, 2 to 4 options, the recommended one first with a short why, and an "Other" free-text answer. Free-text answers are kept verbatim and quoted in the generated files. The topics follow the owner's own interview:
1. id, title and a one-line description;
2. install target: repo-level (the default) or global;
3. always-on working rules: the eight Q8 rules as options, plus the person's own;
4. third-party picks from the neutral catalog (`harness catalog` ids only), preselected or not;
5. git: branch prefixes, the trailer rule, the PR-size warning;
6. stacks, then per stack the F1 to F12 topics (folders, server data, client state, components, forms, testing, UI states, API layer, performance, platform specifics, style, extras). A topic the person skips is left out, not filled in.

**Drafting.** The skill writes the preset in a temp dir (`mktemp -d`): the YAML, the items, `core.md` and one skill per stack. It drafts only from the answers. It shows each file, applies the person's edits, then runs `harness preset check <dir>`. On errors it fixes and retries once, then stops and shows them.

**Where the files go:**

| Target | Preset folder | Core block | Skills | Settings | Manifest |
|---|---|---|---|---|---|
| Repo | `.harness/presets/<id>/` (committed) | AGENTS.md, preset markers | `.claude/skills/<name>/` | `.claude/settings.json` | the repo manifest |
| Global | `~/.claude/harness/presets/<id>/` | `~/.claude/CLAUDE.md`, preset markers | `~/.claude/skills/<name>/` | `~/.claude/settings.json` | `~/.claude/harness/manifest.json` |

- A repo-level preset installs through `/harness:init` or `/harness:update` with that preset chosen (section 4).
- A global preset installs with `harness preset install <dir> --global`, which first prints a preview with every global path and its diff. The skill asks a separate yes for each global write. `--dry-run` writes nothing.
- The global manifest uses the repo manifest's file and block records, so `harness uninstall --global` removes exactly what was written and leaves `~/.claude/` byte-identical. The existing guard ask on `uninstall` already covers `--global`. `preset install` is added to `PERSON_ONLY` as an ask.
- A global install carries the core rules, the skills and the attribution setting at user scope (C2). Git enforcement (the guard asks and the `harness git` checks) stays per repo, because it needs harness's hooks, which are installed per repo.

**Validated:**
- everything in section 3's checks;
- answer files through a new `harness validate preset-answers`, in the same way as the other AI files;
- no git identity anywhere in the output: the check rejects `user.name`, `user.email` and email-shaped strings;
- text through `esc()` wherever it's printed;
- the always-loaded total, shown against the budget before install.

**The owner's preset** is the first output of this format. `catalog/presets/khubaib-frontend/` is committed in exactly the shape the builder writes, and the builder's tests use it as the reference fixture.

## 9. Git enforcement

**In `harness git`** (`src/cli/git.ts`), when `config.preset` is set:
- **No AI trailer.** `commit` never adds `config.git.commit_trailer`, and refuses when a trailer is configured: `The khubaib-frontend preset bans AI trailers; clear git.commit_trailer.`
- **Prefix suggestion (O9).** `branch` keeps making `chore/ai-workflow-<v>`, which already has a listed prefix. `harness git branch --suggest "<topic>"` prints one name per listed prefix (for example `feature/<slug>` and `fix/<slug>`) and creates nothing.
- **PR-size warning (O10).** `pr` measures the branch with PR-size's count, which is built first, and its `pr_size` config. Before `gh pr create` it prints `This PR has <n> changed lines in <f> files; the limit is <max_lines> lines or <max_files> files.` It warns and goes on (Q7). PR-size's own guard ask at `gh pr create` still applies.

**In the guard** (`src/checks/guard.ts`), two new asks, separate from `PERSON_ONLY`, which covers `harness` subcommands only. Both run only when the preset is on and reuse the guard's word parsing:
- **Trailer.** On a `git commit` whose visible words contain an AI trailer (`Co-Authored-By:` naming Claude or `noreply@anthropic.com`, or "Generated with Claude Code"), the guard asks with `the agent is committing with an AI trailer, which the khubaib-frontend preset bans`. Unattended runs are denied (O11). Limit: a message from `-F <file>` or an editor isn't visible to the guard.
- **Branch prefix (O9).** On `git checkout -b <name>`, `git checkout -B <name>`, `git switch -c <name>` or `git switch -C <name>` where the name has no listed prefix, the guard asks and lists the prefixed names, as `--suggest` prints them.

**Attribution (O12).** The preset merges Claude Code's attribution setting into `.claude/settings.json`, so commits and PRs get no trailer in the first place. It's a recorded block, shown in the preview and removed exactly. The key name and shape are confirmed against the Claude Code settings docs during planning, before any code is written.

**Identity.** `harness git commit` keeps reading `user.name` and `user.email` from the repo's git config and stops when either is unset. No preset, built or shipped, stores a name, email or signing key, and no test or fixture contains a real one.

## 10. Update, remove and uninstall

- Every preset write is a manifest block or file, like any own item: the core block with its markers and leading separator, each skill file, the attribution and `env` blocks, and the `preset` key in `config.yaml`.
- **Update** (`harness update`) re-renders from the installed catalog version, or from the built preset folder. Changed blocks are replaced through the manifest in the same way as the harness block. A skill whose stack has gone is removed, and a newly matching one is offered.
- **Turning it off.** Answering "No preset" in `/harness:update` removes the core block, the skills, the settings blocks and the config key. The preselected plugins stay as normal picks, because the person ticked them, and `harness remove` takes them out.
- **Uninstall** removes the preset blocks with everything else; the existing byte-identical test (beta spec §8) covers them. `harness uninstall --global` does the same for `~/.claude/` from the global manifest.

## 11. Testing

- **Format:** a valid preset; each check in section 3 with a failing fixture (unknown or discouraged preselect id, missing skill item or template, id clash, bad prefix, a body over 150 lines, unknown key).
- **Stacks:** fixture facts for Next.js only, Expo only, bare React Native, plain React (Vite), a Next.js plus Expo monorepo, and no React. Each gets exactly the skills and preselects in section 3.
- **Select:** preset rows are ticked, carry their reason, aren't duplicated when the reviewer picked the same id, and pass `notPicked`. caveman never appears.
- **Merge:** the preset block appends after the harness block, is replaced in place on update, and removes exactly. Repeated or misordered preset markers stop with the same error as `mergeAgents`. The attribution and `DO_NOT_TRACK` blocks merge into existing settings and remove exactly.
- **Byte-identical, end to end:** init with the preset, then uninstall; init without, update with, update without. Both leave the repo byte-identical. A global install then `uninstall --global` leaves a fake `HOME` byte-identical.
- **Builder:** `preset check` passes on `catalog/presets/khubaib-frontend/`; a built preset with an email in it is rejected; the global preview lists every path; `--dry-run` writes nothing; each global write needs its own yes in the skill text.
- **Git:** `commit` refuses a configured trailer; `branch --suggest` prints one name per prefix; `pr` prints the warning over the limit and not under it; nothing stores an identity.
- **Guard:** asks on `git commit -m "…Co-Authored-By: Claude…"` and on a heredoc message; denies the same commit when unattended; asks on `git switch -c wip` and allows `git switch -c feature/x`; nothing fires with no preset.
- **Core:** the core template has the override sentence (section 6).
- **Budget:** the measured totals match section 5 within rounding.

## 12. Size and cost

All numbers are estimates.

| Part | New code (lines) |
|---|---|
| Preset loader and checks (`src/catalog/presets.ts`) | ~150 |
| `agents-md-preset` merge kind and settings blocks | ~80 |
| Select rows and the interview question | ~40 |
| `harness git` checks and `--suggest` | ~50 |
| Guard asks (trailer, branch prefix) | ~80 |
| Builder CLI: `preset list`, `check`, `install --global`, `validate preset-answers` | ~200 |
| Global manifest and `uninstall --global` | ~150 |
| **Total** | **~750** |

- **Content:** the preset YAML, four items, the core template and three skill bodies of at most 150 lines each, all reviewed by the owner. The builder skill and its interview guide come to about 120 lines.
- **Tests:** about as many lines as the code again.
- **AI cost:** installing a preset adds no AI step. A builder run is one interview plus drafting in the person's own session, with no subagent. The runtime cost is the always-loaded text in section 5.
- **Build order:** PR-size lands first (O10), so the PR-size warning needs no count of its own.

## 13. Planning-time checks

These two are checks to run during planning, not open owner questions. Their results go to the owner.

| # | Check | How | Then |
|---|---|---|---|
| C1 | **Planning-time check:** conflict analysis of Impeccable and taste-skill. Both give design direction, and taste-skill tells the agent to apply taste decisions on its own. | After `harness vet` on taste-skill, compare their skills, hooks and commands for overlap, and run both together on one fixture repo. | The owner decides whether taste-skill joins (O5). |
| C4 | **Planning-time check:** taste-skill's catalog entry targets `landing` repos only, while Impeccable targets `web`. | Once C1 is done, compare which repos each item should apply to. | The owner picks `landing` only, or `web` and `landing`, for taste-skill in the preselect. |
