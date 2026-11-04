# Personal preset: design spec

- Status: draft for the owner's review. The owner decisions are in section 1. Section 12 lists what the answers leave open; nothing there is decided.
- Date: 2026-11-05
- Owner: khubaibqaiser
- Inputs: the owner interview of 2026-11-05 (Q1 to Q9, then the frontend architecture interview). The code on main: `src/catalog/schema.ts`, `src/catalog/load.ts`, `src/install/facts.ts`, `src/install/select.ts`, `src/install/merge.ts` (`mergeAgents`), `src/budget/measure.ts`, `src/cli/git.ts`, `src/checks/guard.ts` (`PERSON_ONLY`), `skills/init/{SKILL,interview}.md`, and [`2026-11-03-pr-size-design.md`](2026-11-03-pr-size-design.md) ("PR-size", approved, not built).
- When: after vet. The order is vet, then the personal preset, then telemetry, then the context-budget build.
- Name clash: `src/install/preset.ts` already exists. It is the gate-defaults preset (`preset(facts)` builds the TDD, stop and multi-file config). This feature does not touch it, and its code goes in a new `src/catalog/presets.ts`.

## 1. Owner decisions

| # | Decision |
|---|---|
| Q1 | **Audience.** An opt-in named preset that anyone can choose. The neutral catalog stays the default. |
| Q2 | **Contents.** Working rules in AGENTS.md; third-party picks preselected; git and PR conventions enforced, not just written down; frontend architecture best practices for Next.js, React and React Native (the owner added this). "Your own skills" was not picked. |
| Q3 | **Source of the frontend rules.** Interview the owner on architecture, draft from their answers only, and the owner reviews the draft. |
| Q4 | **Frontend scope.** Only on matching stacks, detected by scan. Next.js rules go to Next.js repos, React Native rules to RN or Expo repos, and shared React rules to both. |
| Q5 | **Loading.** A short always-on core in AGENTS.md. The detailed frontend architecture is on-demand skills. |
| Q6 | **Preselected picks.** superpowers, caveman, ponytail and the Vercel React skills. Addy Osmani's skills are not preselected. |
| Q7 | **Git.** Enforced through `harness git`: no AI trailer, branch prefixes and a PR-size warning. The guard asks before a plain `git commit` that would add an AI trailer. The identity comes from the repo's git config and is never stored. |
| Q8, Q9 | **Always-on core rules (all chosen).** Ask before deciding, with options and a recommendation; no invented data, and label estimates; fix everything found; small PRs, with a README check in each PR; no paid actions without an OK; TDD; lean context; plain communication. |

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
- the preset file format and its loader and checks;
- one preset (its id is open, O1) with its core block, three frontend skills, preselected picks and git rules;
- the opt-in question in the init interview, and the preset rows in select;
- `harness git` checks (branch prefix, no trailer, PR-size warning) and one new guard ask;
- update, remove and uninstall, byte-identical;
- tests.

**Out:**
- the owner's own skills (Q2: not picked);
- Addy Osmani's skills as a preselect (Q6);
- i18n rules (F12);
- other people's published presets (O2);
- the team-decisions memory (O3);
- storing a git name or email, ever (Q7);
- changing the staff reviewer or the compact catalog it reads.

## 3. The preset format

A preset is one YAML file, `catalog/presets/<id>.yaml`, with its own items next to it in `catalog/presets/<id>/items/*.yaml`. The items use the catalog item schema unchanged (`validateItem` in `src/catalog/schema.ts`). They are kept out of `catalog/items/`, so the neutral catalog, its compact form (`load.ts`) and the reviewer never see them.

```yaml
id: <id>                       # O1
title: "<title>"
description: "<one line shown in the interview>"
core: core-rules               # an item id under <id>/items/, kind rule
preselect:                     # neutral catalog ids, ticked in select (Q6, O4, O5)
  - superpowers
  - caveman
  - ponytail
  - react-best-practices
  - vercel-react-native-skills
skills:                        # preset item ids; each item's applies_when picks the stacks (Q4)
  - frontend-react
  - frontend-nextjs
  - frontend-react-native
git:
  branch_prefixes: [...]       # O6
  no_ai_trailer: true
  pr_size_warning: true
```

**Checks** (in `harness catalog check` (`src/catalog/check.ts`) and CI, beside the item checks): every `preselect` id exists in `catalog/items/`; `core` and every `skills` id exist under `<id>/items/`; no preset item id clashes with a catalog id; `branch_prefixes` is a non-empty list of `^[a-z0-9-]+/$` strings; unknown keys fail.

**Stack matching** reuses `applies_when.frameworks` against `facts.frameworks` (from `deriveFacts` in `src/install/facts.ts`):

| Skill | `applies_when` |
|---|---|
| `frontend-react` | `frameworks: [next, react-native, expo]` (Q4: both); plain React is O7 |
| `frontend-nextjs` | `frameworks: [next]` |
| `frontend-react-native` | `frameworks: [react-native, expo]` |

`facts.frameworks` is the union over every package, so a monorepo with a Next.js app and an Expo app gets all three skills at repo level. That is the intended result of Q4.

## 4. How init offers it

- **Interview.** `skills/init/interview.md` gets one question, asked after scope and before the gaps: "Use a named preset?" The options are "No preset (neutral catalog, the default)" first, then one option per preset with its `description`. `harness catalog --presets` prints the list.
- **Answers.** `answers.json` gains `preset: null | "<id>"`. `harness validate answers` rejects an unknown id.
- **Recommend is unchanged.** The reviewer runs on the neutral catalog only, so the preset can't change its findings.
- **Select.** `harness select --picks <picks.json> --preset <id>` adds rows after the reviewer's: each preselect id as ticked, with the reason "Preselected by the <id> preset", unless the reviewer already picked it; then the core rule and each stack-matched skill as ticked rows. `notPicked` treats preset ids as picked. The skill text says which rows came from the preset.
- **Budget.** The preset rows go through `measureSelection` and `budgetVerdict` like any pick (section 5).
- **Config.** `config.yaml` records `preset: { id, version }`. Without a preset the key is absent, so existing configs need no migration.

## 5. The always-on core block

A second marked block in AGENTS.md, written by a new merge kind `agents-md-preset`. It follows `mergeAgents` exactly, with its own markers, and goes after the harness block:

```markdown
<!-- harness:preset:start -->

## Working rules

- Ask before deciding: give options with a recommendation, then wait for the answer.
- No invented data. Label every estimate as an estimate.
- Fix everything found, not only the first problem.
- Keep PRs small. Check the README in each PR and update it when it changed.
- No paid actions without an OK.
- TDD: write a failing test first.
- Lean context: load only what the task needs.
- Plain communication: short sentences, plain words.
- Git: no AI trailer in commits. Branch names start with an agreed prefix.

<!-- harness:preset:end -->
```

The lines are drafted from Q8, Q9 and Q7; the owner reviews the wording. The TDD line overlaps the harness block's TDD section when the TDD gate is on (O8).

**Cost (estimates, characters / 4 as in `measure.ts`):**

| Part | Tokens |
|---|---|
| Core block | ~148 |
| Each skill's name and description | ~58 |
| Preset total, Next.js or RN repo (core + 2 skills) | ~264 |
| Preset total, both stacks (core + 3 skills) | ~322 |
| Today's harness block, for scale | ~275 |

The preset adds about 13 to 16% of the 2000-token budget (estimate). superpowers, caveman and ponytail are plugins, which `itemContext` can't measure before install, so a preset with them always raises the budget ask for unmeasured items. That is the current rule, not a new one.

## 6. The frontend skills

Own skills at `.claude/skills/<name>/SKILL.md`, from `catalog/presets/<id>/templates/skills/<name>/SKILL.md`. Only the name and description load until a skill is used (Q5). Each body is drafted from section 1 only and reviewed by the owner (Q3).

| Skill | Description (always loaded) | Stacks |
|---|---|---|
| `frontend-react` | Shared React architecture rules for this repo (folders, state, components, forms, server data, testing, UI states, performance, style, accessibility, env). Use when writing or reviewing React code. | Next.js, React Native, Expo |
| `frontend-nextjs` | Next.js rules for this repo (Server Components first, "use client" at the smallest leaf, loading.tsx and error.tsx, next/image, SEO). Use when working on Next.js routes, layouts or data loading. | Next.js |
| `frontend-react-native` | React Native rules for this repo (Expo dev builds, Expo Router, expo-image, FlashList, Reanimated, config plugins). Use when working on React Native or Expo screens, lists or native config. | React Native, Expo |

**Outlines:**
- `frontend-react`:
  - folders (F1);
  - client state, with F3 quoted verbatim;
  - TanStack Query on the client (F2);
  - components (F4);
  - forms (F5);
  - API layer (F8);
  - UI states: error boundaries with retry around widgets, an empty state for every list (F7);
  - testing: Testing Library, MSW, Storybook and visual tests (F6);
  - performance: memoize only when measured, narrow selectors, virtualize long lists, transitions, lazy loading in plain React (F9);
  - style (F11);
  - accessibility baseline and `env.ts` (F12).
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

## 7. Git enforcement

**In `harness git`** (`src/cli/git.ts`), when `config.preset` is set:
- **No AI trailer.** `commit` never adds `config.git.commit_trailer`, and refuses when a trailer is configured: `The <id> preset bans AI trailers; clear git.commit_trailer.` The message is otherwise unchanged.
- **Branch prefixes.** `branch` checks the branch name against `git.branch_prefixes`. Today `branch` only makes `chore/ai-workflow-<v>`, so the check bites only if `harness git` grows beyond harness's own commit (O9).
- **PR-size warning.** `pr` measures the branch with the PR-size count (PR-size §5: lockfiles and ignore files excluded) and prints, before `gh pr create`: `This PR has <n> changed lines in <f> files; the limit is <max_lines> lines or <max_files> files.` It warns and goes on (Q7 says warning). It depends on the PR-size measure (O10).

**In the guard** (`src/checks/guard.ts`): one new ask, separate from `PERSON_ONLY`, which covers `harness` subcommands only. When the preset is on and a Bash command runs `git commit` whose visible words contain an AI trailer (`Co-Authored-By:` naming Claude or `noreply@anthropic.com`, or "Generated with Claude Code"), the guard asks: `the agent is committing with an AI trailer, which the <id> preset bans`. It reuses the guard's existing word parsing. Limit: a message from `-F <file>` or an editor isn't visible to the guard, so it isn't checked. Unattended behaviour is O11.

**Identity.** `harness git commit` keeps reading `user.name` and `user.email` from the repo's git config and stops when either is unset. The preset stores no name, email or signing key, and no test or fixture contains a real one.

## 8. Update, remove and uninstall

- Every preset write is a manifest block or file, like any own item: the core block with its markers and leading separator, each skill file, and the `preset` key in `config.yaml`.
- **Update** (`harness update`) re-renders from the installed catalog version. A new catalog version can change the core text, the skills or the preselect list. Changed blocks are replaced through the manifest the same way as the harness block. A skill whose stack has gone is removed, and a newly matching one is offered.
- **Turning it off.** Answering "No preset" in `/harness:update` removes the core block, the skills and the config key. The preselected plugins stay as normal picks, because the person ticked them, and `harness remove` takes them out.
- **Uninstall** removes the preset blocks with everything else. The existing byte-identical test (beta spec §8) covers them.

## 9. Testing

- **Format:** a valid preset; each check in section 3 with a failing fixture (unknown preselect id, missing skill item, id clash, bad prefix, unknown key).
- **Stacks:** fixture facts for Next.js only, Expo only, bare React Native, a Next.js plus Expo monorepo, and no React. Each gets exactly the skills in section 3's table.
- **Select:** preset rows are ticked, carry their reason, aren't duplicated when the reviewer picked the same id, and pass `notPicked`.
- **Merge:** the preset block appends after the harness block, is replaced in place on update, and removes exactly. Repeated or misordered preset markers stop with the same error as `mergeAgents`.
- **Byte-identical, end to end:** init with the preset, then uninstall; init without, update with, update without. Both leave the repo byte-identical.
- **Git:** `commit` refuses a configured trailer; `branch` checks the prefix; `pr` prints the warning over the limit and not under it; nothing stores an identity.
- **Guard:** asks on `git commit -m "…Co-Authored-By: Claude…"` and on a heredoc message; allows a commit with no trailer; doesn't fire with no preset.
- **Budget:** the measured total matches the section 5 rows within rounding.

## 10. Size and cost

- **New code:** about 350 lines (estimate): `src/catalog/presets.ts` (load and check), the `agents-md-preset` merge kind, the select rows, the `harness git` checks and the guard ask.
- **Content:** the preset YAML, four items, the core template and three skill bodies. Each body should stay under about 150 lines (estimate) and is reviewed by the owner.
- **AI cost:** none at install, since the preset adds no AI step. The runtime cost is the always-loaded text in section 5.

## 11. Fit with the rest

- The guard's `PERSON_ONLY` entries are unchanged: choosing or dropping the preset happens through `init` and `update`, which already ask.
- vet doesn't apply, since preset items are first-party and versioned with the catalog.
- PR-size, when built, already asks at `gh pr create` over the limit. The preset's `harness git pr` warning is the same count, shown earlier.

## 12. Open questions

| # | Question | Options | Recommendation |
|---|---|---|---|
| O1 | The preset's id and title. | (a) the owner's handle, e.g. `khubaib`; (b) a style name, e.g. `opinionated`; (c) something else. | (a): it says whose opinions these are, which fits "named preset". |
| O2 | Can others publish their own presets? | (a) not in v1, presets ship in this repo only; (b) a preset from a GitHub repo, vetted first; (c) a local file path. | (a): one preset proves the format first; (b) can reuse vet later. |
| O3 | How does it relate to the team-decisions memory (`2026-11-03-team-decisions-design.md`)? | (a) separate: the preset is one person's defaults, decisions are a team's record; (b) the preset seeds the first decisions; (c) decisions can override preset rules. | (a): no coupling until both exist. |
| O4 | caveman is `discouraged` in the catalog ("overlaps ponytail"), yet Q6 preselects both. | (a) preselect both, and choosing the preset counts as naming caveman; (b) drop caveman from the preselect; (c) preselect ponytail and offer caveman unticked. | (a): it's the owner's explicit pick, and the row still shows the stance reason. |
| O5 | Which items are "the Vercel React skills", and do preselects follow `applies_when`? | (a) `react-best-practices` and `vercel-react-native-skills`, each only on its stack; (b) those two everywhere; (c) also `web-design-guidelines`. | (a): matches Q4's stack rule and the items' own `applies_when`. |
| O6 | Which branch prefixes? | (a) the conventional set `feat/ fix/ chore/ docs/ refactor/ test/`; (b) the owner lists them; (c) read from the repo's existing branches. | (b): the answers name no list, so the owner should give it. |
| O7 | Does `frontend-react` load on a plain React repo (e.g. Vite, no Next.js or RN)? | (a) yes, `frameworks: [react]`; (b) no, Next.js and RN only, as Q4 says. | (a): F9 already has a plain React rule, so the owner seems to expect such repos. |
| O8 | The core TDD line repeats the harness block's TDD section. | (a) keep it, since it holds when the TDD gate is off; (b) drop it when the TDD gate is on; (c) drop it always. | (a): about 8 tokens (estimate), and one fixed text is simpler to keep byte-identical. |
| O9 | Should `harness git` grow beyond committing harness files, so branch prefixes apply to everyday work? | (a) no, check prefixes in the guard on `git checkout -b` and `git switch -c` (ask); (b) add `harness git branch <name>` and `harness git commit` for any change; (c) prefixes only in the core text. | (a): it enforces Q7 on the commands the agent already runs, with no new CLI surface. |
| O10 | The PR-size measure isn't built yet. | (a) build PR-size's count first and reuse it; (b) the preset ships its own simple count; (c) leave the warning out until PR-size lands. | (a): one count, so the warning and the PR-size ask never disagree. |
| O11 | The trailer guard in unattended runs. | (a) deny, as PR-size does; (b) ask anyway; (c) allow and log. | (a): no one is there to answer, and PR-size D1 set that pattern. |
| O12 | Also set Claude Code's own attribution setting in `.claude/settings.json`, so trailers aren't added at all? | (a) yes, as part of the preset's settings; (b) no, only the guard and `harness git`. | (a): it stops the trailer at its source. It's a settings write, so the owner should confirm it. |
