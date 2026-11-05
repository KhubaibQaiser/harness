# Personal preset implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (owner-confirmed, R2) to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in named preset (`khubaib-frontend` first) that adds a short always-on core block to AGENTS.md, stack-matched on-demand skills, preselected catalog picks, git rules enforced in `harness git` and the guard, and Claude Code's attribution and telemetry settings. A builder (`/harness:preset`) produces the same format for anyone, installed at repo level or, with a yes per write, globally under `~/.claude/`.

**Size:** 18 tasks (1a, 1b, 2a, 2b, 3, 4, 5, 6a, 6b, 7, 8, 9, 10, 11, 12a, 12b, 13, 14), each one PR. Task ids keep the first draft's numbers; a split task got a letter suffix (pre-flight F15).

**Architecture:**
- `src/catalog/presets.ts` loads and checks a preset (YAML + its own items + templates), lists shipped (`catalog/presets/`) and repo-level (`.harness/presets/`) presets, matches `applies_when` against facts, and builds the select rows and context entries. The neutral catalog (`loadCatalog`, `compactCatalog`, the reviewer) never sees preset items, because `loadCatalog` reads only `catalog/items/`.
- **Hook-bundle rule (F4, F11):** no code in the hook bundle (`src/core/config.ts`, `src/checks/guard.ts` and what they import) imports from `src/catalog/presets.ts` or `src/catalog/load.ts`. The branch-name pieces both sides need (`PREFIX_RE`, `slug`, `suggestBranches`) live in the dependency-free leaf module `src/core/branch-prefix.ts`. `presets.ts` re-exports them.
- The chosen preset is recorded in `config.yaml` as `preset: { id, version, items, git }`. `items` is the core and skill ids the person ticked. `git` is a copy of the preset's git block, so the guard needs no preset file at run time.
- Writes go through the existing `planChanges` / `applyChanges` / manifest path:
  - the core block is a second marked text block (`mergeAgentsPreset`);
  - the skills are own files recorded with `item: "preset:<id>"`;
  - the settings are the existing `{"set":[...],"value":v}` blocks that `removeSets` already removes.
- A global install uses the same `applyChanges` with `root = home` and a state-paths parameter (`.claude/harness`). So the manifest, backups and lock are `~/.claude/harness/{manifest.json,backup/,apply.lock}`, and nothing global is written under a hardcoded `.harness/` (F12).
- The CLI never calls a model. The AI step (the builder interview) lives in `skills/preset/` and reaches the CLI only through files: the preset folder and `preset-answers.json`. No command turns answers into a folder: the skill writes the files, and `preset check` is the guard (F14 note on Task 14).

**Tech stack:** TypeScript, Node ≥ 22.11, esbuild bundle, Vitest, `yaml`. No new dependency.

**Spec:** `docs/specs/2026-11-05-personal-preset-design.md` (owner-approved, binding). Section numbers below (§n) and decision ids (Q, O, C, F, P) refer to it. Pre-flight finding ids are written `pre-flight Fn` to keep them apart from the spec's F1 to F12.

**PR-size dependency (O10).** PR-size has its own plan: `docs/plans/2026-11-05-pr-size.md` (branch `docs/prsize-plan`). This plan does not re-implement any of it. Names consumed from that plan:

| Name | From PR-size task | Used by preset task |
|---|---|---|
| `walkCommands<T>(command, w: Where, visit: (seg: Seg) => T \| null, hooks?, depth?)`, `Seg { toks, k, prev?, next?, words }`, `Where`, `runnerName` (`src/checks/guard.ts`) | 1 | 10 |
| `pr_size.{target_lines,max_lines,max_files,exclude}` and `crossKeyErrors` (`src/core/config.ts`) | 2 | 3 (rebase only), 9 |
| `measure(root, { base?, head? }, config: SizeConfig, opts?: { git?: Git }) : Size \| Unmeasured`, `Size { base, head, lines, files, top, excluded }`, `Unmeasured { error, base? }`, `isOver(size, config.pr_size)`, `Git`, `realGit` (`src/checks/pr-size/measure.ts`) | 3 | 9 |
| The last PR-size edits to `plan.ts`, `init.ts`, `status.ts` and the gate tests (`checks.prSize`, `pr-ship` in `LEGACY_OWN`) | 6, 7 | 6a, 6b, 7, 8 (rebase only) |

The first step of Tasks 9 and 10 still reads the merged code. If a merged name differs from this table, use the merged one and say so in the PR body.

## Dependencies and parallel lanes

| Task | Lane | Depends on (must be on `main`) | Shares files with PR-size? |
|---|---|---|---|
| 1a Loader and checks | A (now) | none | no |
| 1b `preset list\|check` CLI | A (now) | 1a | no |
| 2a Content: YAML, core, principles | A (now) | 1a | no |
| 2b Content: three frontend skills | A (now) | 1a, 2a | no |
| 4 Stack matching and select rows | A (now) | 1a | no |
| 5 Merge kinds and sandbox fix | A (now) | 1a | no |
| 3 Config key and answer | B | 1a, **PR-size 2** | `config.ts`, `config-io.ts` |
| 6a Preset writes in `planChanges` | C | 3, 4, 5, **PR-size 7** | `plan.ts` |
| 6b Init wiring and uninstall | C | 6a, **PR-size 7** | `init.ts` |
| 7 Update | C | 6b, **PR-size 7** | `update.ts`, `plan.ts` |
| 8 Init flow, preview, budget | C | 6b, **PR-size 7** | `init.ts`, `status.ts` |
| 9 `harness git` | D | 3, **PR-size 3** (and 2) | no |
| 10 Guard asks | D | 3, **PR-size 1**, the vet branch merged or rebased | `guard.ts` |
| 11 `preset install` (repo), guard entry | E | 1b, the vet branch merged or rebased | `guard.ts` (`PERSON_ONLY` only) |
| 12a State paths in apply and manifest | E | none | no |
| 12b `preset install --global` | E | 5, 11, 12a | no |
| 13 `uninstall --global` | E | 12b | no |
| 14 Builder skill and `validate preset-answers` | E | 1a, 11 | no |

- **Lane A** starts now. 1a merges first because every other A task imports its types. After that, 1b, 2a, 4 and 5 are file-disjoint from each other and from all of PR-size, so they run in parallel. 2b follows 2a.
- **Lane B:** Task 3 lands right after PR-size Task 2 merges, rebased on it. Both edit `RULES`, `overlay`/`loadConfig` and `SECTIONS`.
- **Lane C:** Tasks 6a, 6b, 7 and 8 land after PR-size Task 7 merges, the last PR-size task to touch `plan.ts`, `init.ts`, `status.ts` and the gate tests. Their tests assert that file lists *hold* the preset files, never that they *equal* a list, because PR-size makes `init` install `pr-ship` everywhere.
- **Lanes D and E** follow the dependencies in the table.
- **Merges stay serial** (owner rule): every branch rebases on `main` before it starts and before it merges. `docs/reference.md` is edited by both plans in the same sections, so each task does its docs step last.

## Planning checks (spec §13 and O12), run 2026-11-05

1. **Attribution key (O12): confirmed.** Source: https://code.claude.com/docs/en/settings-reference.md, "Git and attribution", fetched 2026-11-05.
   - The key is `attribution`, scope "Any file". Its type is "object with `commit` and `pr` strings and a `sessionUrl` Boolean, or `false` to hide all attribution". The page says: "To hide all attribution, set `attribution` to `false`." The `false` value "requires Claude Code v2.1.281 or later; earlier versions reject it and skip the whole user, project, or local settings file that holds it". The page gives the older-version form too: `commit` and `pr` set to empty strings and `sessionUrl` set to `false`.
   - **Deprecated older key:** `includeCoAuthoredBy`, "Deprecated since v2.0.62, when `attribution` replaced it." It is ignored once `attribution.commit` or `attribution.pr` is set.
   - **Plan decision:** write `"attribution": false` as one set block. harness already requires Claude Code 2.1.314 (`MIN_CLAUDE_CODE` in `src/core/min-claude.ts`), which is above 2.1.281, so no supported version skips the file. That matters, because the same file holds the harness hooks. If the person's settings already have an `attribution` value, it is left as is, with a note.
   - The page also says that the person's own CLAUDE.md or memory rule on attribution takes precedence over these lines, so the core block's "no AI trailer" line and the setting agree.
   - **`env` in project settings:** project-file `env` values apply "after you trust the workspace". `DO_NOT_TRACK` is not in the page's list of variables that project settings can't set. So C3 works from `.claude/settings.json` once the folder is trusted. The README says this (Task 8).
2. **taste-skill.**
   - Catalog entry: `catalog/items/taste-skill.yaml` pins `Leonxlnx/taste-skill` at `12af471f627f866411b4bd785b19646d3672784c`, with `license: MIT`, `applies_when: {"project_types":["web","landing"]}`, `conflicts_with: ["impeccable", "superdesign", "ui-ux-pro-max"]` and `stance: optional`.
   - **Licence: verified MIT.** An unauthenticated fetch of `https://raw.githubusercontent.com/Leonxlnx/taste-skill/12af471f627f866411b4bd785b19646d3672784c/LICENSE` (HTTP 200, 21 lines) gives the standard MIT text, "Copyright (c) 2026 Leonxlnx", with no added clause and no commercial-use restriction.
   - **Vet: not run** (it needs network and `gh`). It is an owner action (see Owner actions). Until it passes, nothing in this plan offers taste-skill: the preset preselects Impeccable.
3. **C1 and C4: encoded on `main`, no mismatch.**
   - C1: `impeccable`, `taste-skill`, `ui-ux-pro-max` and `superdesign` each list the other three in `conflicts_with`.
   - C4: `taste-skill` has `project_types: [web, landing]`.
   - The other §3 claims also match the catalog: `react-best-practices` on `frameworks: [react, next]`, `vercel-react-native-skills` on `[react-native, expo]`, `web-design-guidelines` on `project_types: [web, landing]`, `impeccable` on `[web]`, and `ponytail` and `superpowers` on `always: true`. `caveman` is `discouraged` ("overlaps ponytail"), and the preset never preselects it (O4).
4. **Found while planning:** `superpowers` is preselected and is marked `telemetry-on-by-default` in the catalog. Its opt-out is `SUPERPOWERS_DISABLE_TELEMETRY`, not `DO_NOT_TRACK` (owner ruling R1).

## Owner rulings (2026-11-05)

- **R1, superpowers telemetry (option a).**
  - `telemetry_off` is `[impeccable, superpowers]`.
  - Each id maps to its own opt-out variable in `TELEMETRY_ENV` (`src/catalog/presets.ts`): `impeccable` → `DO_NOT_TRACK=1` (catalog evidence); `superpowers` → `SUPERPOWERS_DISABLE_TELEMETRY=<value>`.
  - The value is read in Task 2a from the pinned superpowers README (`obra/superpowers` at `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`, section "Visual companion telemetry"). It is never guessed. If the README gives no value, Task 2a stops and asks the owner.
  - A variable is written only when its item is selected in this repo. Both appear in the preview (Task 8).
- **R2, execution.** Subagent-driven (superpowers:subagent-driven-development).
- **R3, test fixtures (pre-flight F14, controller ruling).** Every task except 2a and 2b tests against fixture presets under `test/fixtures/presets/`, never the shipped `khubaib-frontend`. So the owner's wording review blocks only 2a's and 2b's merges.
- **R4, size (pre-flight F15, controller ruling).** A task estimated over 400 changed lines (an estimate) is split into its own PRs: 1 → 1a/1b, 2 → 2a/2b, 6 → 6a/6b, 12 → 12a/12b.
- **R5, stack matrix (pre-flight F6, resolved from the spec).** O5 says each preselect keeps its own catalog `applies_when`. `react-best-practices` has `frameworks: [react, next]`, and an Expo or bare RN app has `react` in its dependencies. So those rows include `react-best-practices` (Task 4 matrix). This follows from O5 and §3 and needs no new owner decision.

## Owner actions (not tasks; no code)

- **Wording review (Q3, P9), blocking 2a and 2b only.** The core block and the four skill bodies are drafted from §1 and §7 only. The owner reviews them before 2a and 2b merge.
- **taste-skill vet (O5, §6).** Before taste-skill may replace Impeccable in any preset, the owner runs `harness vet Leonxlnx/taste-skill#12af471f627f866411b4bd785b19646d3672784c` (or `/harness:vet` with the same target) in their own terminal and accepts any high findings. The licence check is done (Planning check 2). No code change follows: a person who prefers taste-skill unticks the Impeccable row in select and picks taste-skill, and `conflicts_with` stops the two from installing together.

## Plan decisions the spec leaves open (the owner can change them in review)

- **Config shape.** `preset: { id, version, items, git: { branch_prefixes, no_ai_trailer, pr_size_warning } }`. `version` is the harness version that wrote it. The git copy exists because the guard runs from the bundled hook. The key is absent without a preset (§4).
- **Docs label (P9).** A docs-filled line ends with `[docs: https://…]`. The check fails a line with `[docs` that has no `https://` link.
- **Identity check (§8).** It rejects `user.name`, `user.email` and email-shaped text matching `/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/`. The TLD rule keeps `react@19.0.0` and `@tanstack/react-query` from matching.
- **Shipped-id clash (pre-flight F3).** A built preset may not use a shipped id. That rule applies in `preset check <dir>` only when `<dir>` doesn't resolve inside the shipped `catalog/presets/` dir, and always in `preset install`.
- **`select --preset` also takes `--answers`.** `applies_when.project_types` needs the project type, and `select` reads no answers today.
- **Repo-level built preset.** `harness preset install <dir>` (no `--global`) copies the checked folder to `.harness/presets/<id>/` (committed, not in the manifest; `uninstall --yes` removes `.harness/` whole). The person then chooses it in `/harness:init` or `/harness:update`.
- **Global per-write yes.** `preset install <dir> --global` prints every path with its diff. In a terminal it asks `prompt.confirm` once per path. With `--yes`, it writes only the paths in `--take <path,...>`, which the skill fills from the person's per-write answers.
- **Global skills and settings.** User scope has no repo facts. So a global install offers every skill of the preset (the per-write yes picks which land) and writes attribution only, never `env` (C2, C3).
- **Global limits** (each carries a `ponytail:` comment):
  - A second global install is refused while `~/.claude/harness/manifest.json` exists.
  - `CLAUDE_CONFIG_DIR`, when set to anything other than `~/.claude`, is refused with a message, because Claude Code wouldn't read what harness wrote.
- **Temp files (pre-flight F12).** `applyChanges` writes each file through a sibling `<target>.harness-tmp` that it renames or removes in the same run (`apply.ts:27,143-166`). That is not a folder under a hardcoded root, so it stays as is. The backup folder, the manifest and the lock become parameters (Task 12a).
- **Preview copy for Impeccable (§4).** The two lines live in `PREVIEW_LINES` in `presets.ts`, keyed by catalog id, with a `ponytail:` comment: move them to a catalog field when a second item needs them.
- **`harness git pr` warns even when `checks.prSize` is off.** The preset's `pr_size_warning` decides, and the README says so.
- **Manifest `item: "preset:<id>"`.** `harness remove`, `why` and `status` see a non-catalog item id. `remove preset:<id>` stops with `Preset files are removed by turning the preset off in /harness:update.` `status` lists them under the preset's id (Task 6a).

## Global constraints

- Preset id `khubaib-frontend`, title `Khubaib frontend` (O1). Shipped presets live in `catalog/presets/`. Code lives in the new `src/catalog/presets.ts` and `src/core/branch-prefix.ts`. `src/install/preset.ts` (the gate-defaults preset) is not touched (spec header).
- **Hook bundle:** `src/core/config.ts`, `src/checks/guard.ts` and anything they import never import `src/catalog/presets.ts`, `src/catalog/load.ts` or `packageDir` (pre-flight F4, F11).
- Preselects: `superpowers`, `ponytail`, `react-best-practices`, `vercel-react-native-skills`, `web-design-guidelines`, `impeccable`. Each is filtered by its own catalog `applies_when` (O5). Never caveman (O4), and never Addy Osmani's skills (Q6).
- `telemetry_off: [impeccable, superpowers]` (R1).
- Branch prefixes: `feature/`, `fix/`, `hotfix/`, `chore/`, `refactor/`, `docs/`, `ci/` (O6). Each matches `^[a-z0-9-]+/$`.
- Skill bodies: at most 150 lines. Frontmatter has `name` and `description` (§3).
- Markers: `<!-- harness:preset:start -->` and `<!-- harness:preset:end -->`, placed after the harness block (§5).
- **Lean always-loaded context** (estimates, characters / 4 as in `measure.ts`, §5):
  - core block ~173 tokens; each skill's name and description ~58;
  - one stack ~347; Next.js and RN ~405; plain React ~289; no React ~231.
  - The preset rows go through `measureSelection` and `budgetVerdict` against `context.budget_tokens` (2000). The shipped totals must match these within one rule: ± 10 tokens on each total (Task 2b test).
- **Global writes each get their own yes** (O2). The preview lists every global path. `--dry-run` writes nothing. Git checks stay per repo (C2).
- **No invented data** (Q8, P9). Content is drafted from §1 answers only; doc fills cite a source and carry the docs label. Every number in copy or the README that is an estimate says so. No real name, email or signing key appears in any preset, test or fixture (Q7, §9). The one exception is the commit command below.
- **Tests:**
  - TDD: red first.
  - `pnpm test` passes with `claude` off PATH. Fake `Exec` for `claude` and `gh` the way `test/cli/git.test.ts` (`noGh`) does. Fake git for PR-size through its `Git` seam.
  - No paid or live Claude runs, no network in tests.
  - Global tests use a temp dir as `home`, never the real `~`.
  - Git fixtures pin `init.defaultBranch`.
  - Fixture presets only, outside Tasks 2a and 2b (R3).
- **Process:**
  - Each task is one small PR off `main`, on branch `feature/preset-<id>-<slug>`, merged serially per the lanes above.
  - Each PR stays at or under 400 changed lines and 20 files (estimates at planning; measured at PR time). A PR that grows past that is split before review, not after.
  - Commit as `git -c user.name=khubaibqaiser -c user.email=khubaib.dev@gmail.com commit …`, with no AI trailer and no footer.
  - Each PR checks `README.md` and `docs/reference.md`, and its PR body says, for each, "updated (…)" or "checked, no change".
- **Conflict note:** another branch is changing `src/vet/*` and the `vet` parsing in `src/checks/guard.ts`. No task touches `src/vet/*`. Tasks 10 and 11 edit `guard.ts`: rebase on `main` first and keep the vet lines as they land.
- Gates: `pnpm typecheck` and `pnpm test` pass at the end of every task.

## Review focus

1. **An update drops the preset's settings.** In `mergeSettings` (`src/install/merge.ts:139`), the non-`always` branch calls `removeSets(s, opts.recorded)` on every recorded set block, not only on the sandbox ones. So the first `harness update` with `sandbox: unattended` would delete `attribution` and the telemetry `env` keys. Expected: only `set[0] === 'sandbox'` blocks are dropped there (Task 5 test).
2. **Deselecting `agents-md` while the preset is on breaks AGENTS.md.**
   - The deselected path in `planChanges` (`plan.ts:168-180`) cuts every recorded AGENTS.md block, the preset block included.
   - It also emits its own change, beside the preset's change, from the same "before" text (pre-flight F9).
   - Expected: one change for AGENTS.md, built once (harness block removed, then the preset block merged). The preset block stays, and CLAUDE.md keeps its `@AGENTS.md` import (Task 6a test).
3. **A global install where Claude Code won't look, or through a symlink.**
   - With `CLAUDE_CONFIG_DIR` set elsewhere, Claude Code ignores `~/.claude/`. Expected: harness refuses with a message instead of writing files that do nothing.
   - With a symlinked `~/.claude` (dotfile managers), `applyChanges` refuses symlinks. Expected: the message names the path and says nothing was written (Task 12b test).
4. **The identity check flags package versions.** `react@19.0.0`, `expo@~52.0.0` and `@tanstack/react-query` must pass. `jane@example.com` must fail, in a template and in `<id>.yaml`'s `description` (Task 1a test).
5. **The preset folder is gone at update time.** A built preset folder can be deleted, or a newer harness can drop a shipped one. Expected: update prints `Preset "<id>" was not found; its files are kept as they are.`, removes nothing and doesn't crash (Task 7 test).

---

### Task 1a: Preset loader, checks and branch-prefix leaf module

**Lane A. Depends on:** nothing.

**Files:**
- Create: `src/core/branch-prefix.ts`, `src/catalog/presets.ts`, `test/fixtures/presets/tiny.yaml` and `test/fixtures/presets/tiny/` (one core, two skills), and `test/fixtures/presets/stacks.yaml` and `test/fixtures/presets/stacks/` (R3). `stacks` has the same `preselect`, `skills` ids and `applies_when` shape as §3 and short placeholder bodies, so the code tasks never read the shipped content.
- Test: `test/core/branch-prefix.test.ts`, `test/catalog/presets.test.ts`

**Interfaces:**
- Consumes: `validateItem`, `ID_RE`, `Catalog`, `CatalogItem` (`src/catalog/schema.ts`); `packageDir`; `esc`, `CONTROL` (`src/core/config.ts`; one direction only: `config.ts` never imports `presets.ts`).
- Produces (in `src/core/branch-prefix.ts`, no imports at all):
  - `export const PREFIX_RE = /^[a-z0-9-]+\/$/`
  - `export const slug = (topic: string): string`: lower-cased, every run of characters outside `[a-z0-9]` becomes `-`, trimmed of `-`, cut to 50 characters; `topic` when empty.
  - `export const suggestBranches = (prefixes: string[], topic: string): string[]` (one `prefix + slug(topic)` per prefix)
  - `export interface PresetGit { branch_prefixes: string[]; no_ai_trailer: boolean; pr_size_warning: boolean }` (here, so `config.ts` can use it without importing `presets.ts`)
- Produces (in `src/catalog/presets.ts`, which re-exports the four above):
  - `export interface Preset { id: string; title: string; description: string; core: string; preselect: string[]; skills: string[]; settings: { attribution?: 'off'; telemetry_off: string[] }; git: PresetGit }`
  - `export interface LoadedPreset { preset: Preset; base: string /* the <id>/ folder */; yamlPath: string; items: CatalogItem[] /* core + skills */ }`
  - `export const TELEMETRY_ENV: Record<string, { name: string; value: string }> = {}`. Task 2a fills it.
  - `export function loadPreset(yamlPath: string): { ok: true; loaded: LoadedPreset } | { ok: false; errors: string[] }`
  - `export function checkPreset(l: LoadedPreset, catalog: Catalog, opts?: { builtOnly?: boolean }): string[]` (`builtOnly` turns on the shipped-id rule, pre-flight F3)
  - `export function identityProblemsIn(text: string, label: string): string[]` and `export function identityProblems(l: LoadedPreset): string[]`. The second checks `<id>.yaml` and every file under `<id>/` (pre-flight F13).
  - `export const shippedPresetsDir = (): string => join(packageDir('catalog'), 'presets')`
  - `export const presetDirs = (root: string): string[] => [shippedPresetsDir(), join(root, '.harness', 'presets')]`
  - `export function listPresets(root: string): { id: string; description: string; where: 'shipped' | 'repo' }[]`
  - `export function findPreset(id: string, root: string): string | null` (shipped first; the yaml path)
- Layout:
  - `<dir>/<id>.yaml`, `<dir>/<id>/items/<item>.yaml`, `<dir>/<id>/templates/core.md`, `<dir>/<id>/templates/skills/<name>/SKILL.md`.
  - Skill items are `kind: own-skill` with `source.files: [{ from: skills/<name>/SKILL.md, to: .claude/skills/<name>/SKILL.md }]`. `from` is relative to `<id>/templates/`.
  - The core item is `kind: rule`, `source: { type: own }`. Its text is always `templates/core.md`.

- [ ] **Step 1: Write the failing tests.**
  - `branch-prefix`:
    - `slug("Add login form")` is `add-login-form`; `slug("  ")` is `topic`; a 60-character topic gives 50 characters.
    - `suggestBranches(['feature/','fix/'], 'X y')` is `['feature/x-y','fix/x-y']`.
  - `loadPreset` on `tiny` returns ok with `items` ids `[core, skills…]`. `attribution: off` loads as the string `'off'` (yaml 2.x reads YAML 1.2, which this test pins).
  - Each §3 check gives one error, built by editing a copy of `tiny` in a temp dir:
    - unknown preselect id → `preselect "zzz" is not in the catalog`;
    - discouraged preselect (`caveman`) → `preselect "caveman" is discouraged in the catalog`;
    - missing skill item → `skills "x": no item at x/items/x.yaml`;
    - missing template → `x: template skills/x/SKILL.md not found`;
    - a preset item id equal to a catalog id (`ponytail`) → `item "ponytail" clashes with a catalog id`;
    - skill frontmatter without `description` → `skills/x/SKILL.md: frontmatter needs name and description`;
    - 151 body lines → `skills/x/SKILL.md: body has 151 lines; the limit is 150`;
    - `branch_prefixes: []` → must be a non-empty list; `[feature]` → `branch_prefixes[0]: must match ^[a-z0-9-]+/$`;
    - `telemetry_off: [ponytail]` with ponytail not in `preselect` → `telemetry_off "ponytail" is not in preselect`;
    - a `telemetry_off` id in `preselect` but with no `TELEMETRY_ENV` entry → `telemetry_off "x": harness knows no opt-out variable for it`;
    - an unknown top-level key → `unknown key "extra"`;
    - a body line `- Use X. [docs]` → `skills/x/SKILL.md:3: a docs-labelled line needs a link: [docs: https://…]`.
  - **Shipped-id clash (pre-flight F3):**
    - with `builtOnly`, a copy outside the shipped dir whose id is a shipped id → `preset id "<id>" is already a shipped preset`;
    - without `builtOnly`, the same preset is accepted.
  - **Identity (Review focus 4):**
    - a template with `jane@example.com` fails, and so does `description: "by jane@example.com"` in `<id>.yaml`;
    - `user.email` fails;
    - `react@19.0.0`, `expo@~52.0.0` and `@tanstack/react-query` pass;
    - `identityProblemsIn('jane@example.com', 'rules[0]')` gives one error naming `rules[0]`.
  - Every error text goes through `esc` (a `\u001b` in an id prints as `\u001b`).
  - `listPresets` lists both dirs with `where`. `findPreset` returns null for an unknown id.
  - `branch-prefix.ts` has no `import` line (a test reads the file), so the hook bundle can import it.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/core/branch-prefix.test.ts test/catalog/presets.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the interfaces. Unknown keys fail at every level, as in `validateItem`.
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Docs.** README and `docs/reference.md`: checked, no change (nothing user-visible yet). Say so in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): preset loader, checks and branch-prefix helpers`.

### Task 1b: `harness preset list|check` and `catalog check`

**Lane A. Depends on:** 1a.

**Files:**
- Create: `src/cli/preset.ts`
- Modify: `src/cli/index.ts` (route `preset`, USAGE), `src/cli/catalog.ts` (`catalog check` also checks each shipped preset)
- Test: `test/cli/preset.test.ts`, `test/cli/catalog.test.ts`

**Interfaces:**
- Consumes: `loadPreset`, `checkPreset`, `identityProblems`, `listPresets`, `shippedPresetsDir` (1a).
- Produces: `export function preset(args: string[], cli: CliEnv & { prompt?: Prompt; home?: string }): number | Promise<number>` with `list` and `check <dir>`. `install` comes in Tasks 11 and 12b.

- [ ] **Step 1: Write the failing tests:**
  - `preset list` prints `<id>  <description>` lines, or `No presets.`
  - `preset check <dir>` exits 0 with `ok` on `tiny`, and 1 with one error per line on a broken copy.
  - `preset check` on a copy of a shipped preset placed outside `catalog/presets/` reports the shipped-id clash. `preset check catalog/presets/<id>.yaml`'s own folder doesn't (pre-flight F3). Use a temp `catalog` dir through the `deps.dir` seam that `catalog()` already has.
  - `catalog check` reports shipped preset errors, prefixed `presets/<id>: `.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/cli/preset.test.ts test/cli/catalog.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** `docs/reference.md` "Commands in full": add `harness preset list` and `harness preset check <dir>`. README: checked; add the lines only if it lists every command. Put both results in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): harness preset list and check`.

### Task 2a: `khubaib-frontend`: YAML, items, core block, `engineering-principles`, telemetry variables

**Lane A. Depends on:** 1a. **Merge blocked by:** the owner's wording review (Owner actions). No other task waits on it (R3).

**Files:**
- Create: `catalog/presets/khubaib-frontend.yaml`; `catalog/presets/khubaib-frontend/items/{core-rules,engineering-principles,frontend-react,frontend-nextjs,frontend-react-native}.yaml`; `catalog/presets/khubaib-frontend/templates/core.md`; `catalog/presets/khubaib-frontend/templates/skills/engineering-principles/SKILL.md`; placeholder `SKILL.md` files for the three frontend skills (frontmatter with the final §7 descriptions, and one body line `Body: see Task 2b.`, so `preset check` passes)
- Modify: `src/catalog/presets.ts` (`TELEMETRY_ENV` entries, R1)
- Test: `test/catalog/khubaib-frontend.test.ts`

**Interfaces:**
- Consumes: `loadPreset`, `checkPreset`, `identityProblems`, `TELEMETRY_ENV` (1a).
- Produces: the shipped preset, and `TELEMETRY_ENV = { impeccable: { name: 'DO_NOT_TRACK', value: '1' }, superpowers: { name: 'SUPERPOWERS_DISABLE_TELEMETRY', value: <from the README> } }`.

- [ ] **Step 1: Read the superpowers opt-out value (R1).**
  - Fetch `https://raw.githubusercontent.com/obra/superpowers/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/README.md`. It is one unauthenticated file, the only network use in this plan, and it is done by the implementer, never in a test.
  - Copy the exact value that the "Visual companion telemetry" section gives for `SUPERPOWERS_DISABLE_TELEMETRY`. Quote that sentence and the URL in the PR body.
  - If the section names no value, stop and ask the owner. Never assume `1`.
- [ ] **Step 2: Write the failing tests:**
  - `preset check` passes on the shipped folder (no `builtOnly`), with zero identity problems.
  - YAML values:
    - id `khubaib-frontend`;
    - the six preselects in the order of Global constraints;
    - skills `[engineering-principles, frontend-react, frontend-nextjs, frontend-react-native]`;
    - `settings: { attribution: off, telemetry_off: [impeccable, superpowers] }` (R1);
    - git prefixes per O6, `no_ai_trailer: true`, `pr_size_warning: true`.
  - `caveman` is not anywhere in the folder.
  - `applies_when`: `engineering-principles` `{always: true}`; `frontend-react` `{frameworks: [react, next, react-native, expo]}`; `frontend-nextjs` `{frameworks: [next]}`; `frontend-react-native` `{frameworks: [react-native, expo]}`.
  - `core.md` equals the §5 block's inner text line for line (between the markers). Its first line contains `This overrides any skill that says to decide on its own.` (§6 "Asking wins").
  - The four frontmatter descriptions are the §7 table's text verbatim.
  - `TELEMETRY_ENV.superpowers` is `{ name: 'SUPERPOWERS_DISABLE_TELEMETRY', value: '<the README value from Step 1>' }`, and `TELEMETRY_ENV.impeccable` is `{ name: 'DO_NOT_TRACK', value: '1' }`.
- [ ] **Step 3: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/catalog/khubaib-frontend.test.ts`.
- [ ] **Step 4: Write the content.**
  - The `engineering-principles` body follows the §7 outline (P2 to P4, KISS and YAGNI worded to agree with ponytail's smallest-change rule), from §1 only.
  - A gap filled from the TypeScript docs ends with `[docs: <url>]` (P9).
  - Each item's `evidence` names the spec decision ids it comes from. `license` is `MIT` (the repo's), and `min_claude_code` is `MIN_CLAUDE_CODE`.
- [ ] **Step 5: Run the tests and confirm they pass.**
- [ ] **Step 6: Owner review (Q3).** Open the PR as a draft and ask the owner to review `core.md` and the principles body. Apply their edits, re-run Step 5, then mark the PR ready.
- [ ] **Step 7: Docs.** README and `docs/reference.md`: checked, no change (Task 8 adds the user section). Say both in the PR body.
- [ ] **Step 8: Commit.** Message: `feat(preset): khubaib-frontend preset, core block and principles skill`.

### Task 2b: `khubaib-frontend`: the three frontend skills

**Lane A. Depends on:** 1a, 2a. **Merge blocked by:** the owner's wording review.

**Files:**
- Modify: `catalog/presets/khubaib-frontend/templates/skills/{frontend-react,frontend-nextjs,frontend-react-native}/SKILL.md` (the real bodies)
- Test: `test/catalog/khubaib-frontend.test.ts`

**Interfaces:**
- Consumes: `estimateTokens`, `alwaysLoadedText` (`src/budget/measure.ts`); the 2a test file.
- Produces: the finished shipped content.

- [ ] **Step 1: Write the failing tests:**
  - No `SKILL.md` has the `Body: see Task 2b.` placeholder.
  - F3 is quoted verbatim in `frontend-react` (the whole §1 F3 string).
  - The P7 Tailwind sentence's intent is present (no `h-[98px]`-style arbitrary values where a scale class fits).
  - **Budget (estimate, §5, one rule):** the four totals (core + principles + react + one stack; + both stacks; core + principles + react; core + principles) are 347, 405, 289 and 231, each ± 10. The rule is `estimateTokens(core.md)` plus `alwaysLoadedText('skill', …)` per skill.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Write the bodies.**
  - They follow the §7 outlines, from §1 only.
  - Doc fills (react.dev, Next.js, Expo) end with `[docs: <url>]` (P9).
  - Items Vercel's `react-best-practices` already covers are not repeated (P9).
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Owner review (Q3)**, as in 2a Step 6.
- [ ] **Step 6: Docs.** README and `docs/reference.md`: checked, no change. Say both in the PR body.
- [ ] **Step 7: Commit.** Message: `feat(preset): khubaib-frontend React, Next.js and React Native skills`.

### Task 3: The `preset` config key and the `preset` answer

**Lane B. Depends on:** 1a, and PR-size Task 2 merged (rebase on it: both edit `RULES`, `overlay`/`loadConfig` and `SECTIONS`).

**Files:**
- Modify: `src/core/config.ts` (type, rule, overlay), `src/core/config-io.ts` (`SECTIONS`, `serializeConfig`), `src/ai/answers.ts`
- Not touched (pre-flight F5): `templates/config.example.yaml` (a test requires it to equal `serializeConfig(defaults())`) and `scripts/gen-config-docs.mjs` (its table comes from `defaults()`, which has no `preset`).
- Test: `test/core/config.test.ts`, `test/core/config-io.test.ts`, `test/ai/answers.test.ts`

**Interfaces:**
- Consumes: `PREFIX_RE` and `PresetGit` from `src/core/branch-prefix.ts` (1a; `config.ts` imports nothing from `presets.ts`, pre-flight F4); `ID_RE`; `findPreset` (used in `answers.ts` only, which isn't in the hook bundle).
- Produces:
  - `HarnessConfig.preset?: { id: string; version: string; items: string[]; git: PresetGit }`.
  - `Answers.preset: string | null`; `configToAnswers(c).preset === (c.preset?.id ?? null)`.

- [ ] **Step 1: Write the failing tests:**
  - `loadConfig` without `preset` gives `config.preset === undefined` and no warning.
  - With a valid `preset` mapping, it loads it as is.
  - Each error is reported:
    - `preset.id: must be lowercase letters, digits and hyphens`;
    - `preset.git.branch_prefixes[0]: must match ^[a-z0-9-]+/$`;
    - `preset.extra: unknown key` (as `objRule` already words it).
  - `serializeConfig(defaults())` is byte-identical to today's output, so the existing `config.example.yaml` test stays green. With `preset`, it adds a `# Named preset chosen at init (rules, skills, git checks).` section last.
  - `validateAnswers`:
    - accepts `preset` absent (treated as null), `null`, and the id of `tiny` copied into a temp repo's `.harness/presets/`;
    - rejects `"nope"` with `preset: "nope" is not a shipped or repo preset (harness preset list shows them)`.
  - A test reads the import lines of `src/core/config.ts` and finds no `presets` or `load` import.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/core/config.test.ts test/core/config-io.test.ts test/ai/answers.test.ts`.
- [ ] **Step 3: Implement.**
  - Add `RULES.preset` (an `objRule`).
  - `overlay`: a key missing from `base` that has a `RULES` entry is checked by that rule and set, instead of being reported unknown.
  - `serializeConfig`: skip a section whose value is `undefined`.
  - `validateAnswers`: add `preset` to the allowed keys and check it with `findPreset(id, facts.root)`.
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck` and `pnpm vitest run --project unit test/package/readme.test.ts`.
- [ ] **Step 5: Docs.**
  - `docs/reference.md` "Configuration keys": add a hand-written `preset` paragraph *outside* the generated `<!-- config:start -->` block.
  - README: checked, no change (it has no config table).
  - Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): record the chosen preset in config and answers`.

### Task 4: Stack matching, preset context and the preset rows in select

**Lane A. Depends on:** 1a.

**Files:**
- Modify: `src/catalog/presets.ts`, `src/install/select.ts` (`notPicked`, `toSelected`), `src/cli/select.ts`
- Test: `test/catalog/presets-match.test.ts`, `test/install/select.test.ts`, `test/cli/select.test.ts`

**Interfaces:**
- Consumes: `LoadedPreset` (1a); `Facts` (`src/install/detect.ts`); `ChecklistRow` (`select.ts`); `estimateTokens`, `alwaysLoadedText`, `ContextEntry` (`src/budget/measure.ts`).
- Produces:
  - `export function appliesTo(aw: AppliesWhen, facts: Pick<Facts, 'deps' | 'frameworks'>, projectType: string): boolean`. `always` is true; otherwise every key present must hold: `any_dep` and `frameworks` need one listed name in the facts, and `project_types` must include `projectType`.
  - `export function presetContext(l: LoadedPreset, ids: string[]): ContextEntry[]`. Core: `estimateTokens(core.md)`. Skill: `alwaysLoadedText('skill', body)`. Templates are read from `l.base/templates` (pre-flight F7; Task 8 only consumes it).
  - `export const presetReason = (id: string) => \`Preselected by the ${id} preset\``
  - `export function presetRows(l: LoadedPreset, c: Catalog, facts, projectType: string, picked: string[], dirs: { templates: string }): ChecklistRow[]`. `dirs.templates` is the package templates dir, for the catalog preselect rows' `itemContext`. Preset item rows read `l.base/templates` through `presetContext`.
    - The rows: the stack-matched preselects not in `picked`, then the core and the matched skills.
    - All are ticked, with `include: 'recommended'` and the reason.
    - Preset item rows have `context` `~<n> tokens (estimate)`.
  - `notPicked(chosen, p, c, extra: string[] = [])`: `extra` ids count as picked.
  - `toSelected(p, ids, c, reasons: Record<string, string> = {})`: a chosen id not in picks takes `reasons[id]` before `Chosen by you.`
  - CLI: `harness select --picks <file> [--preset <id> --answers <file>] [--choose <id,...>]`.

- [ ] **Step 1: Write the failing tests** with the `stacks` fixture preset (R3) and fixture facts (§11 "Stacks"; R5 for rows 2 and 3):

  | Facts (frameworks; project type) | Skills | Preselects |
  |---|---|---|
  | `[next, react]`; web | principles, react, nextjs | superpowers, ponytail, react-best-practices, web-design-guidelines, impeccable |
  | `[expo, react, react-native]`; mobile | principles, react, react-native | superpowers, ponytail, react-best-practices, vercel-react-native-skills |
  | `[react, react-native]`; mobile | principles, react, react-native | superpowers, ponytail, react-best-practices, vercel-react-native-skills |
  | `[react]` (Vite); web | principles, react | superpowers, ponytail, react-best-practices, web-design-guidelines, impeccable |
  | `[expo, next, react, react-native]`; web | all four | superpowers, ponytail, react-best-practices, vercel-react-native-skills, web-design-guidelines, impeccable |
  | `[]`; api | principles | superpowers, ponytail |

  - Every preselect row carries `reason: Preselected by the stacks preset`.
  - A preselect the reviewer already picked appears once, as the reviewer's row.
  - `notPicked` with the preset ids as `extra` returns `[]`.
  - `caveman` never appears.
  - `presetContext` on `tiny` returns one entry per id, each equal to `estimateTokens` of its text.
  - CLI: `--preset` without `--answers` prints USAGE and exits 2. An unknown preset id exits 2 with `preset: "nope" is not a shipped or repo preset (harness preset list shows them)`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the interfaces. `select --choose` splits the ids: preset item ids skip `resolveSelection` (they aren't catalog items) and come back in the JSON as `preset_items: [...]`.
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** `docs/reference.md`: update the `harness select` line. README: checked. Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): stack matching and preset rows in select`.

### Task 5: Preset merge kinds and the sandbox removal fix

**Lane A. Depends on:** 1a.

**Files:**
- Modify: `src/install/merge.ts`
- Test: `test/install/merge.test.ts`

**Interfaces:**
- Consumes: `mergeAgents`, `removeBlocks`, `removeSets`, `removeFromSettings` (existing); `LoadedPreset`, `TELEMETRY_ENV` (1a; Task 5's tests set their own `TELEMETRY_ENV` entries for the fixture ids).
- Produces:
  - `export const PRESET_START = '<!-- harness:preset:start -->'` and `PRESET_END = '<!-- harness:preset:end -->'`
  - `export function mergeAgentsPreset(before: string | null, core: string): { after: string; blocks: string[] }`. It is `mergeAgents`'s logic with these markers and the given core text, and the same `MergeError` messages with "preset" in place of "harness".
  - `export type SetBlock = { set: string[]; value: unknown }`
  - `export function presetSets(l: LoadedPreset, opts: { selected: string[]; env: boolean }): SetBlock[]` (pre-flight F8). It returns leaf keys only:
    - `attribution: off` gives `{ set: ['attribution'], value: false }` (Planning check 1);
    - with `env: true`, there is one `{ set: ['env', name], value }` per `telemetry_off` id that is in `selected`, from `TELEMETRY_ENV`, each variable once.
    - The repo path passes the chosen catalog ids and `env: true`. The global path (12b) passes `env: false`.
  - `export function mergePresetSettings(before: string | null, want: SetBlock[], recorded: string[], label = '.claude/settings.json'): { after: string; blocks: string[]; dropped: string[]; notes: string[] }`.
    - It adds the created-parent block `{ set: ['env'], value: {} }` itself, only when `env` is absent and a wanted key needs it.
    - It adds each missing key as a set block.
    - A key that already holds another value is kept, with the note `` `<label>`: `<path>` is already <json>; left as is (the preset would set <json>). ``
    - It drops recorded non-sandbox set blocks that are no longer wanted, through `removeSets`.

- [ ] **Step 1: Write the failing tests** (fixture `TELEMETRY_ENV` entries `{ a: DO_NOT_TRACK=1, b: B_OFF=x }`, values invented for the test only and named as such):
  - **Agents block:**
    - On null, it creates the block. On `# Mine\n`, it appends with a blank-line separator.
    - After `mergeAgents`, the preset block follows the harness block.
    - `removeBlocks(after, presetBlocks)` returns the input byte for byte, for LF and CRLF.
    - On update, the block is replaced in place.
    - Two start markers → `AGENTS.md has a repeated preset marker; fix it by hand`.
    - End before start → `…missing or misordered preset marker…`.
  - **presetSets (pre-flight F8):**
    - `selected: ['a','b'], env: true` gives attribution plus both env keys.
    - `selected: ['b']` (an api repo, no `a`) gives no `DO_NOT_TRACK`.
    - `env: false` (global) gives attribution only.
  - **Settings:**
    - Into `{}`, attribution, the `env` parent and both keys are added.
    - Into `{"env":{"FOO":"1"}}`, only the two keys are added and `FOO` stays.
    - Into `{"env":{"B_OFF":"other"}}`, that key is left as is, with the note, and `DO_NOT_TRACK` is still added.
    - Into `{"attribution":{"commit":"x"}}`, it is left as is, with the note.
    - `removeFromSettings` with the recorded blocks restores the original object deep-equal and byte-equal for the `{}` and `FOO` cases.
  - **Review focus 1:** `mergeSettings(after, { sandbox: 'unattended', recorded: [...hookBlocks, ...presetBlocks] })` keeps `attribution` and both env keys, and its `dropped` holds no preset block. It still drops recorded `sandbox` set blocks when leaving `always` (the existing test stays green).
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/install/merge.test.ts`.
- [ ] **Step 3: Implement.**
  - The fix: in `mergeSettings`'s non-`always` branch, pass `removeSets` only the recorded blocks whose parsed `set[0] === 'sandbox'`. On `main` the only set blocks are sandbox ones (`merge.ts:130,135`), so nothing else changes.
  - `mergePresetSettings` reuses the file parse, indent and EOL rules of `mergeSettings` (factor the open and serialize lines into a local helper, rather than copying them).
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** README and `docs/reference.md`: checked, no change (nothing user-visible). Say so in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): preset AGENTS block and settings blocks`.

### Task 6a: Preset writes in `planChanges`

**Lane C. Depends on:** 3, 4, 5, and PR-size Task 7 merged.

**Files:**
- Modify: `src/install/plan.ts`, `src/cli/items.ts` (`remove` and `why` on a `preset:` id), `src/cli/status.ts` (list preset files under the preset id)
- Test: `test/install/plan.test.ts`, `test/cli/items.test.ts`

**Interfaces:**
- Consumes: `LoadedPreset`, `appliesTo` (1a, 4); `mergeAgentsPreset`, `presetSets`, `mergePresetSettings` (5); `config.preset` (3).
- Produces:
  - `planChanges` ctx gains `preset?: LoadedPreset`. When `config.preset` and `ctx.preset` are both set:
    - **AGENTS.md is built once (pre-flight F9):** start from the read text; if `agents-md` is on, `mergeAgents`, else cut only the recorded blocks that contain `<!-- harness:start -->`; then `mergeAgentsPreset`. That gives one `put('AGENTS.md', …)` with the surviving blocks. `mergeClaudeMd` runs whenever the preset or `agents-md` is on.
    - Each item in `config.preset.items` with files is `put` from `<base>/templates/<from>`, with `item: "preset:<id>"`.
    - The settings are chained after `mergeSettings`: `mergePresetSettings(settings.after, presetSets(l, { selected: selectedIds(config), env: true }), recorded)`, giving one `put('.claude/settings.json', …)`.
  - Recorded files with `item` starting `preset:` that are no longer wanted go through the same delete, restore or keep logic as a deselected own file (`plan.ts:127-135`).
  - `harness remove preset:<id>` exits 2 with `Preset files are removed by turning the preset off in /harness:update.` `harness why preset:<id>` prints `Installed by the <preset id> preset.`

- [ ] **Step 1: Write the failing tests** (the `stacks` fixture, R3):
  - With the preset on a Next.js fixture, the plan *holds*:
    - AGENTS.md (both blocks);
    - `.claude/skills/{engineering-principles,frontend-react,frontend-nextjs}/SKILL.md` with `item: preset:<id>`;
    - settings with attribution and the telemetry keys of the selected ids.
  - Without a preset, the plan is unchanged from today (the existing plan tests stay green).
  - **Review focus 2:** `agents-md` deselected with the preset on gives exactly one AGENTS.md change. Its `after` has no harness block and has the preset block, and CLAUDE.md keeps `@AGENTS.md`.
  - `remove` and `why` on a `preset:` id print the lines above.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** `docs/reference.md` "What `init` changes in your repo": add the preset block, the skills and the settings keys. README: checked. Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): plan the preset's block, skills and settings`.

### Task 6b: Init wiring and the byte-identical uninstall

**Lane C. Depends on:** 6a, and PR-size Task 7 merged.

**Files:**
- Modify: `src/cli/init.ts` (`loadAiInputs`, `init`)
- Test: `test/cli/init.test.ts`, `test/cli/uninstall.test.ts`

**Interfaces:**
- Consumes: Task 6a's `planChanges`; `findPreset`, `loadPreset`, `appliesTo` (1a, 4).
- Produces: `loadAiInputs` returns `presetItems: string[]` and `preset?: LoadedPreset`. It sets `config.preset = { id, version: cli.version, items, git: preset.git }` when `answers.preset` is set. A `--choose` preset item that doesn't match the repo's stack → `"<id>" does not apply to this repo's stack.`

- [ ] **Step 1: Write the failing tests** (the `stacks` fixture copied into the temp repo's `.harness/presets/`):
  - **Byte-identical (§11):**
    - `init --answers … --choose <ids incl. preset items>` with `preset: "stacks"`, then `uninstall --yes`, leaves `hashes(root)` equal to before, with `git status --porcelain` empty. Use the `test/cli/uninstall.test.ts` helpers and the AI-path fixtures under `test/fixtures/ai/`.
    - The same on a repo whose `.claude/settings.json` already has `{"env":{"FOO":"1"}}`.
  - **Init:** `config.yaml` records `preset: { id: stacks, version: 1.2.3, items: [...], git: {...} }`, and nothing in it is a name or an email.
  - **Stack mismatch:** choosing a skill the stack doesn't match gives the error above, exit 2.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** README and `docs/reference.md`: checked; the user section lands in Task 8. Say so in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): install the preset through init, removed by uninstall`.

### Task 7: Update: re-render, stack changes, turning it off

**Lane C. Depends on:** 6b, and PR-size Task 7 merged.

**Files:**
- Modify: `src/cli/update.ts`, `src/install/plan.ts` (`setChanged` deletes the top-level `preset` key when `want` no longer has it)
- Test: `test/cli/update.test.ts`

**Interfaces:**
- Consumes: Task 6a's `planChanges` preset path; `configToAnswers` (3).
- Produces: update behaviour only.

- [ ] **Step 1: Write the failing tests** (fixture presets, R3):
  - **Re-render:** a changed `core.md` in the repo's copy of `stacks` gives a plan that replaces the block in place. The manifest drops the old block and records the new one.
  - **Stack gone:** after init on Next.js plus Expo, removing `expo` and `react-native` from `package.json` makes `update --dry-run` plan the delete of the RN skill's SKILL.md and drop that id from `preset.items`.
  - **Stack new:** a newly matching skill prints `Note: <skill> now applies here; run /harness:update and tick it to add it.` and isn't written.
  - **No answers:** `update --dry-run` without `--answers` leaves `preset` in `config.yaml` as it is.
  - **Off:** partial answers `{"preset": null}` through the AI flags remove the core block, the skills, the settings blocks and the `preset` key, and leave the preselected plugins selected. Then `uninstall --yes` is byte-identical to before init (§11: init without, update with, update without).
  - **Review focus 5:** with `.harness/presets/<id>/` deleted after init, `update --dry-run` prints `Preset "<id>" was not found; its files are kept as they are.` and plans no preset change.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** `docs/reference.md`: add one line on update and turning the preset off. README: checked. Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): update re-renders, follows the stack and turns the preset off`.

### Task 8: Init flow: interview question, preview and budget lines

**Lane C. Depends on:** 6b, and PR-size Task 7 merged.

**Files:**
- Modify: `skills/init/interview.md`, `skills/init/SKILL.md`, `skills/update/SKILL.md`, `src/catalog/presets.ts` (`PREVIEW_LINES`, `previewLines`), `src/budget/measure.ts` (`extra` on both `measureSelection` and `measureSelectionSync`, pre-flight F10), `src/cli/init.ts` (`budgetGate`, plan output), `src/cli/status.ts` (pass the preset entries), `README.md`
- Test: `test/budget/measure.test.ts`, `test/cli/init.test.ts`, `test/cli/status.test.ts`, `test/skills/preset-text.test.ts` (create)

**Interfaces:**
- Consumes: `presetContext` (4); `TELEMETRY_ENV` (1a); `measureSelection`, `measureSelectionSync`.
- Produces:
  - `measureSelection(ids, c, dirs, { extra?: ContextEntry[] })` and `measureSelectionSync(…, { extra? })`: extra entries are added like items.
  - `export const PREVIEW_LINES: Record<string, string[]>`, with `impeccable`:
    - `Impeccable installs hooks: SessionStart, PostToolUse on Edit and Write, and Stop.`
    - `Impeccable downloads its engine into ~/.impeccable/bin/ on first use.`
  - `export function previewLines(l: LoadedPreset, selected: string[]): string[]`. It returns the `PREVIEW_LINES` of the selected ids, then one telemetry line per selected `telemetry_off` id (R1), then the attribution line:
    - `Telemetry: <name>=<value> goes in .claude/settings.json env for <id>; it applies to every command in the session.`
    - `Attribution: .claude/settings.json sets "attribution": false, so commits and PRs get no AI trailer.`

- [ ] **Step 1: Write the failing tests** (the `stacks` fixture with the fixture `TELEMETRY_ENV` entries, R3):
  - `budgetGate` with the preset on a Next.js fixture prints a total that includes the core and skill entries. The preselected plugins are listed under `Not measured before install:`, which is the current rule (§5).
  - **Status:** `status` after that init prints the same total as the init budget line (pre-flight F10).
  - **Preview:**
    - On a web fixture, the init `--dry-run` output holds `previewLines` exactly once each: two Impeccable lines, one telemetry line per selected `telemetry_off` id, and one attribution line.
    - On an api fixture (no Impeccable), it holds only the telemetry line of the always-matching id and the attribution line.
    - Without the preset, it holds none.
  - **Skill text** (`test/skills/preset-text.test.ts`):
    - `interview.md` asks "Use a named preset?" after scope and before the gaps, with "No preset (neutral catalog, the default)" first, and says to run `harness preset list`.
    - `SKILL.md` step 4 passes `--preset <id> --answers <answers.json>` to select, and says which rows came from the preset.
    - The update skill says that answering "No preset" turns it off.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the code and the skill lines. Keep `interview.md` and `SKILL.md` within their current length plus 4 lines each (lean context; they load only on use).
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.**
  - README: add a short "Named presets" section. It covers:
    - what `khubaib-frontend` adds, and the ~231 to ~405 token cost, labelled as an estimate;
    - that the telemetry variables (`DO_NOT_TRACK=1`, `SUPERPOWERS_DISABLE_TELEMETRY`) apply to the whole session (C3, R1) and only after the folder is trusted (Planning check 1);
    - that `harness git pr` warns on size even when `checks.prSize` is off;
    - how to turn the preset off.
  - `docs/reference.md` "The `/harness:init` flow": add the preset question.
  - PR body: both updated.
- [ ] **Step 6: Commit.** Message: `feat(preset): offer presets in init, with preview and budget lines`.

### Task 9: `harness git`: no trailer, `branch --suggest`, PR-size warning

**Lane D. Depends on:** 3, and PR-size Tasks 2 and 3 merged.

**Files:**
- Modify: `src/cli/git.ts`
- Test: `test/cli/git.test.ts`

**Interfaces:**
- Consumes:
  - `config.preset.git` (3);
  - `suggestBranches` (`src/core/branch-prefix.ts`, 1a);
  - from `src/checks/pr-size/measure.ts` (PR-size 3): `measure(root, { base, head }, config, { git })`, `isOver(size, config.pr_size)` and the `Git` type.
- Produces:
  - `gitStep(args, { root, out, exec, git?: Git })`: `git` defaults to `realGit(root)`. It is the test seam (pre-flight F2).
  - USAGE: `harness git branch [--suggest <topic>]|commit|push|pr [--title <t>]`.

- [ ] **Step 1: Read the merged PR-size code.** Confirm the names in the PR-size table, and note any difference in the PR body.
- [ ] **Step 2: Write the failing tests** (the `installed()` helper with a `preset:` block in `config.yaml`):
  - `commit` with `commit_trailer` set and the preset on exits 1 with `The <preset id> preset bans AI trailers; clear git.commit_trailer.` No commit is made. With the preset off, the existing trailer test stays green.
  - `branch --suggest "Add login form"` prints the seven names, one per line (`feature/add-login-form` … `ci/add-login-form`), creates no branch and exits 0.
  - `pr` with a fake `Git` whose numstat gives 512 lines in 14 files:
    - it prints `This PR has 512 changed lines in 14 files; the limit is 400 lines or 20 files.` before `gh pr create`, and still creates the PR;
    - under the limit (`isOver` false), it prints nothing extra;
    - when `measure` returns `Unmeasured`, it prints `PR size not measured: <error>.`
  - `pr` passes `{ base: def, head: branch }`, where `def` is the default branch `gitStep` already resolves (`git.ts:31`) and `branch` is the current branch. A test asserts the base name in the fake `Git`'s `merge-base`/`diff` arguments.
  - No test or fixture stores an identity; the repo identity is set with `git config` in the temp repo only.
- [ ] **Step 3: Run them and confirm they fail.**
- [ ] **Step 4: Implement.** `--suggest` is allowed only with `branch`. The guard's `git` entry already allows `branch` and `commit` (`guard.ts:87`).
- [ ] **Step 5: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 6: Docs.** `docs/reference.md` "Commands in full": `harness git branch --suggest`. README: checked. Say both in the PR body.
- [ ] **Step 7: Commit.** Message: `feat(preset): no-trailer, branch suggestions and PR-size warning in harness git`.

### Task 10: Guard asks: AI trailer and branch prefix

**Lane D. Depends on:** 3, and PR-size Task 1 merged (`walkCommands`). Rebase on `main` for the vet branch's `guard.ts` changes first.

**Files:**
- Modify: `src/checks/guard.ts`
- Test: `test/checks/guard.test.ts`, `test/hooks/dispatch.test.ts` (the unattended deny)

**Interfaces:**
- Consumes: `walkCommands`, `Seg`, `Where` (PR-size 1); `gitArgs` (`guard.ts:481`); `ctx.config.preset` (3); `suggestBranches` from `src/core/branch-prefix.ts` (not from `presets.ts`, pre-flight F11).
- Produces (in `guard.ts`, not exported unless the tests need them):
  - `const AI_TRAILER = /Co-Authored-By:[^\n]*(Claude|noreply@anthropic\.com)|Generated with \[?Claude Code/i`
  - `presetVisit(command, preset): Visit<Hit>`, a visitor over `Seg`. It calls `gitArgs(seg.toks)`:
    - On `commit`, when the closure's raw `command` (heredoc bodies included) matches `AI_TRAILER`, it gives the ask `the agent is committing with an AI trailer, which the <id> preset bans`.
    - On `checkout -b|-B <name>` or `switch -c|-C <name>`, when the name has no listed prefix, it gives the ask `branch "<name>" has no listed prefix; use one of: <suggestBranches(prefixes, name) joined by ", ">`.
  - Both run only when `ctx.config?.preset` is set, after the person-only check and before `ASK`. They are not `PERSON_ONLY` entries (§9).

- [ ] **Step 1: Read the merged `walkCommands`** and confirm the `Seg` fields.
- [ ] **Step 2: Write the failing tests** (§11 "Guard"):
  - Ask on:
    - `git commit -m "fix: x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>"`;
    - a heredoc `git commit -F - <<'EOF'` whose body has the trailer;
    - `git -C . commit -m "…Generated with Claude Code…"`.
  - Allow `git commit -m "fix: x"`.
  - Unattended, the dispatcher turns the trailer ask into a deny that starts `Unattended run:` (O11).
  - Ask on `git switch -c wip` with `feature/wip` in the reason; allow `git switch -c feature/x`, `git checkout -b fix/y` and `git switch main`.
  - With no `preset` in the config, nothing fires.
  - The guard's existing tests pass unchanged.
- [ ] **Step 3: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/checks/guard.test.ts`.
- [ ] **Step 4: Implement.** Add a `ponytail:` comment on the trailer visitor naming the limits:
  - a message from `-F <file>` or an editor isn't visible to the guard (§9);
  - the match runs on the whole command, so `echo "Co-Authored-By: Claude"; git commit -m x` asks too, which is accepted.
- [ ] **Step 5: Run the tests and confirm they pass.** Then `pnpm typecheck` and `pnpm test:perf` (PE latency budget; this is the second walker on each Bash call, beside PR-size's).
- [ ] **Step 6: Docs.** `docs/reference.md` "Guard details": the two asks, and both limits under "Known limits". README: checked. Say both in the PR body.
- [ ] **Step 7: Commit.** Message: `feat(preset): guard asks on AI trailers and unprefixed branches`.

### Task 11: `harness preset install` (repo) and the `preset` guard entry

**Lane E. Depends on:** 1b. Rebase on `main` for the vet branch's `guard.ts` changes first. No PR-size dependency (pre-flight F16).

**Files:**
- Modify: `src/cli/preset.ts`, `src/cli/index.ts` (route `preset install` with a prompt), `src/checks/guard.ts` (`PERSON_ONLY.preset` only)
- Test: `test/cli/preset.test.ts`, `test/checks/guard.test.ts`

**Interfaces:**
- Consumes: `loadPreset`, `checkPreset(…, { builtOnly: true })`, `identityProblems` (1a).
- Produces:
  - `harness preset install <dir> [--dry-run|--yes]`: it checks the folder, then copies `<id>.yaml` and `<id>/` to `.harness/presets/`. Without either flag, it asks `prompt.confirm` in a terminal and refuses with `NO_TTY` otherwise.
  - `PERSON_ONLY.preset = { kind: 'ask', allowed: (a) => a[0] === 'list' || a[0] === 'check' || (a[0] === 'install' && a.includes('--dry-run') && !a.includes('--yes')), why: () => 'the agent is installing a preset, which writes rules, skills and settings (global ones go to ~/.claude)' }` (§8).

- [ ] **Step 1: Write the failing tests:**
  - `install <tiny copy> --dry-run` lists the files and writes nothing. `--yes` copies them, and then `preset list` shows `where: repo`.
  - With no flag: a fake prompt answered yes copies; `tty: false` prints `NO_TTY` and exits 2.
  - A folder that fails `check` (an email in it) is refused with the check errors and nothing is copied.
  - An existing `.harness/presets/<id>/` → `.harness/presets/<id>/ already exists; remove it first.`
  - Guard: `harness preset install x --yes` asks; `harness preset list`, `harness preset check x` and `harness preset install x --dry-run` are allowed.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** `docs/reference.md`: `harness preset install`. README: checked. Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): install a built preset into the repo`.

### Task 12a: State paths as a parameter in apply, manifest, backups and finish

**Lane E. Depends on:** nothing.

**Files:**
- Modify: `src/install/apply.ts`, `src/install/manifest.ts` (`isBackupPath`, `backupText`, `readManifest`), `src/install/finish.ts` (`dropRestoredBackups`)
- Test: `test/install/apply.test.ts`, `test/install/manifest.test.ts`

**Interfaces:**
- Consumes: the existing code.
- Produces (in `manifest.ts`):
  - `export interface StatePaths { dir: string; manifest: string; backup: string; lock: string }`
  - `export const statePaths = (dir = '.harness'): StatePaths => ({ dir, manifest: \`${dir}/manifest.json\`, backup: \`${dir}/backup\`, lock: \`${dir}/apply.lock\` })`
  - `export const REPO_STATE = statePaths()`. `MANIFEST_REL` and `LOCK_REL` stay, as `REPO_STATE.manifest` and `REPO_STATE.lock`.
  - `isBackupPath(rel, sp = REPO_STATE)`, `backupText(root, rel, sp = REPO_STATE)`, `readManifest(root, read?, sp = REPO_STATE)`, `dropRestoredBackups(root, changes, sp = REPO_STATE)`, and `applyChanges(…, opts.state?: StatePaths)`. Every `.harness/backup` and lock literal in these files reads from `sp` (pre-flight F12).

- [ ] **Step 1: Write the failing tests:**
  - `applyChanges` with `state: statePaths('.claude/harness')` on a temp root writes the manifest at `.claude/harness/manifest.json`, the backup of an updated file under `.claude/harness/backup/<ts>/`, and the lock only while running.
  - `backupText(root, '.claude/harness/backup/x/f', statePaths('.claude/harness'))` reads it. The same path with `REPO_STATE` returns null.
  - `dropRestoredBackups` with the global paths deletes the global backup.
  - `grep -n "'.harness/backup" src/install/*.ts` finds only the `statePaths` default (a test reads the files).
  - Every existing apply, manifest and uninstall test passes unchanged (the default paths are byte-for-byte today's).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck` and `pnpm test`.
- [ ] **Step 5: Docs.** README and `docs/reference.md`: checked, no change. Say so in the PR body.
- [ ] **Step 6: Commit.** Message: `refactor(install): state paths as a parameter for manifest, backups and lock`.

### Task 12b: Global install: `preset install --global`

**Lane E. Depends on:** 5, 11, 12a.

**Files:**
- Modify: `src/cli/preset.ts`
- Test: `test/cli/preset-global.test.ts`

**Interfaces:**
- Consumes: `mergeAgentsPreset`, `presetSets(l, { selected: [], env: false })`, `mergePresetSettings` (5); `applyChanges(…, { state })`, `statePaths` (12a); `unifiedDiff`.
- Produces:
  - `export const GLOBAL_STATE = statePaths('.claude/harness')`
  - `harness preset install <dir> --global [--dry-run] [--yes --take <rel,...>]`, with `PresetEnv = CliEnv & { prompt: Prompt; home?: string }` (`home` defaults to `os.homedir()`).
  - The writes, relative to `home`:
    - `.claude/CLAUDE.md` (the core block with the preset markers);
    - `.claude/skills/<name>/SKILL.md` for every skill;
    - `.claude/settings.json` (attribution only; no `env`, C2 and C3);
    - `.claude/harness/presets/<id>.yaml` and `<id>/…`, all recorded in `~/.claude/harness/manifest.json`.

- [ ] **Step 1: Write the failing tests** with a temp `home` and the `tiny` fixture:
  - `--dry-run` prints `Global writes (each needs its own yes):`, then every path, then the diffs and the always-loaded total. It writes nothing; the temp home's file hashes are unchanged.
  - In a terminal (fake prompt), it asks once per path. A path answered no is not written and not recorded.
  - `--yes --take .claude/CLAUDE.md` writes only that file plus the manifest. `--yes` without `--take` → `--yes needs --take <path,...>: name each global write you approved.`, exit 2.
  - An existing `<home>/.claude/CLAUDE.md` (`# Mine\n`) is backed up under `<home>/.claude/harness/backup/`, never under `<home>/.harness/`.
  - A second install while the global manifest exists → `A global preset is already installed (<id>). Run harness uninstall --global first.`
  - **Review focus 3:**
    - `env.CLAUDE_CONFIG_DIR=/elsewhere` → `CLAUDE_CONFIG_DIR is set to /elsewhere, so Claude Code would not read ~/.claude. Unset it, or install the preset at repo level.`, exit 1.
    - A symlinked `<home>/.claude` → the `refusing symlink` ApplyError text plus `Nothing was written.`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Add `ponytail:` comments on the single-global-install and `CLAUDE_CONFIG_DIR` refusals.
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck` and `pnpm test` (Windows CI covers `path.join` use).
- [ ] **Step 5: Docs.** README "Named presets": add the global install, the per-write yes, and that git checks stay per repo (C2). `docs/reference.md`: add the command and the paths table (§8). PR body: both updated.
- [ ] **Step 6: Commit.** Message: `feat(preset): global preset install with a yes per write`.

### Task 13: `harness uninstall --global`

**Lane E. Depends on:** 12b.

**Files:**
- Modify: `src/cli/uninstall.ts` (extract the per-file loop as `removalChanges`; add `--global`), `src/cli/index.ts` (USAGE)
- Test: `test/cli/uninstall.test.ts`, `test/cli/preset-global.test.ts`

**Interfaces:**
- Consumes: `GLOBAL_STATE` (12b); `applyChanges(…, { state })`, `backupText(…, sp)`, `dropRestoredBackups(…, sp)` (12a); `removeFromSettings`; `removeEmptyDirs`.
- Produces:
  - `export function removalChanges(root: string, m: Manifest, force: boolean, sp: StatePaths = REPO_STATE): { changes: Change[]; kept: string[]; notes: string[] }`. It is the existing loop, now shared, reading backups through `sp`.
  - `harness uninstall --global [--dry-run] [--yes]`:
    - It reads `<home>/.claude/harness/manifest.json` and removes exactly what that records.
    - It restores the backups from `<home>/.claude/harness/backup/`, then deletes them and the manifest.
    - It removes the empty dirs harness created.
    - It needs no git repo.

- [ ] **Step 1: Write the failing tests:**
  - A temp home with `.claude/CLAUDE.md` = `# Mine\n` and `.claude/settings.json` = `{"theme":"dark"}\n`: a global install of every path, then `uninstall --global --yes`. Every file hash in the temp home equals before. There is no `.claude/harness/`, and no `.harness/` anywhere in the home (§11, pre-flight F12).
  - The same with an empty home: no `.claude/` is left.
  - `--global` with no global manifest → `No global preset is installed (no ~/.claude/harness/manifest.json).`, exit 1.
  - The guard's existing `uninstall` ask covers `--global` (a test, no code change).
  - The repo uninstall tests pass unchanged.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** README and `docs/reference.md` "Uninstall": add `--global`. PR body: both updated.
- [ ] **Step 6: Commit.** Message: `feat(preset): uninstall --global removes exactly what was written`.

### Task 14: The builder: `/harness:preset` and `validate preset-answers`

**Lane E. Depends on:** 1a, 11.

**Files:**
- Create: `skills/preset/SKILL.md` (under 40 lines, `disable-model-invocation: true`), `skills/preset/interview.md`, `src/ai/preset-answers.ts`
- Modify: `src/cli/validate.ts` (`preset-answers`), `src/cli/index.ts` (USAGE), `test/skills/preset-text.test.ts` (created in Task 8; if Task 14 lands first, create it here)
- Test: `test/ai/preset-answers.test.ts`, `test/skills/preset-text.test.ts`

**Interfaces:**
- Consumes: `ID_RE`, `PREFIX_RE`, `listPresets`, `identityProblemsIn` (1a, pre-flight F13), `CONTROL`, `loadCatalog`.
- Produces:
  - `export const STACKS = ['react', 'next', 'react-native'] as const`
  - `export const TOPICS = ['folders', 'server_data', 'client_state', 'components', 'forms', 'testing', 'ui_states', 'api_layer', 'performance', 'platform', 'style', 'extras'] as const` (spec F1 to F12)
  - `export interface PresetAnswers { id: string; title: string; description: string; target: 'repo' | 'global'; rules: string[]; preselect: string[]; git: PresetGit; stacks: Partial<Record<(typeof STACKS)[number], Partial<Record<(typeof TOPICS)[number], string>>>> }`
  - `export function validatePresetAnswers(raw: unknown, catalog: Catalog, root: string): { ok: true; answers: PresetAnswers } | { ok: false; errors: string[] }`
  - `harness validate preset-answers <file>`: exit 0 prints `ok`; exit 2 prints one error per line.
  - No command turns answers into a folder. The skill writes the files, and `preset check` is the guard (stated in the skill).

- [ ] **Step 1: Write the failing tests:**
  - **validatePresetAnswers:**
    - A full valid file passes.
    - Each of these gives its own error: an id that is a shipped id; a preselect `caveman` (discouraged) or `zzz` (unknown); a prefix `feature`; a `‮` in a rule; a string with `jane@example.com` (through `identityProblemsIn`, naming the field); an unknown topic `i18n`; an unknown top-level key.
    - A skipped topic is simply absent; nothing is filled in (§8).
  - **Skill text:**
    - `SKILL.md` says, in order:
      - one question per call with AskUserQuestion, 2 to 4 options, recommended first, plus "Other";
      - `mktemp -d`;
      - draft only from the answers, and quote free text verbatim;
      - show each file and apply edits;
      - run `harness preset check <dir>`, fix and retry once, then stop;
      - for `global`: run `preset install <dir> --global --dry-run`, ask a separate yes for each listed path, then run `--yes --take` with only the approved paths;
      - for `repo`: `preset install <dir>`, then `/harness:init` or `/harness:update`.
    - It says it never stores a git name or email.
    - It names no subagent (§8: the main session asks).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the validator and the two skill files. `interview.md` follows §8's six topics in order. Its working-rules question lists the eight Q8 rules as options.
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`, and `pnpm test` with `claude` off PATH.
- [ ] **Step 5: Docs.** README "Named presets": how to build your own with `/harness:preset`. `docs/reference.md` "Commands in full": `validate preset-answers`. PR body: both updated.
- [ ] **Step 6: Commit.** Message: `feat(preset): /harness:preset builder and preset-answers validation`.

---

## Self-review (2026-11-05, after the pre-flight)

- **Spec coverage:**

  | Spec section | Tasks |
  |---|---|
  | §3 format and checks | 1a, 1b |
  | §3 stack matching | 4 |
  | §4 interview, answers, select, preview, budget, config | 3, 4, 8 |
  | §5 core block and cost | 2a, 2b, 5, 6a, 8 |
  | §6 Impeccable telemetry, R1 superpowers telemetry | 2a, 5, 8 |
  | §6 taste-skill | Owner actions, Planning check 2 |
  | §6 asking wins | 2a |
  | §7 skills | 2a, 2b |
  | §8 builder | 14 |
  | §8 targets and global writes | 11, 12a, 12b, 13 |
  | §8 validation | 1a, 14 |
  | §9 harness git | 9 |
  | §9 guard | 10 |
  | §9 attribution | 5, Planning check 1 |
  | §9 identity | 1a, 9 |
  | §10 update, off, uninstall | 6a, 6b, 7, 13 |
  | §11 tests | spread as listed |
  | §12 order (PR-size first) | Dependencies and parallel lanes |

  §2's "Out" items are respected.
- **Pre-flight F1 to F16:** each is applied:

  | Finding | Where |
  |---|---|
  | F1, F2 | PR-size table, Task 9 |
  | F3 | 1a, 1b, decisions |
  | F4, F11 | `branch-prefix.ts`, 3, 10 |
  | F5 | 3 |
  | F6 | R5, Task 4 |
  | F7 | 4, 8 |
  | F8 | 5, 6a, 12b |
  | F9 | 6a, Review focus 2 |
  | F10 | 8 |
  | F12 | 12a, 12b, 13 |
  | F13 | 1a, 14 |
  | F14 | R3, fixtures |
  | F15 | R4, splits |
  | F16 | lanes table |

  The section-2 notes are applied too: `presetRows` dirs, the "env parent" moved into `mergePresetSettings`, `remove`/`status` on `preset:` ids, the update-without-answers test, the `test/skills/` location, and plain `install` without flags.
- **Types:** these names are used the same way in every task: `LoadedPreset`, `PresetGit`, `presetRows`, `presetContext`, `presetSets(l, { selected, env })`, `SetBlock`, `mergePresetSettings`, `StatePaths`, `GLOBAL_STATE`, `config.preset.items`, `identityProblemsIn`, `suggestBranches`.
- **Proportion:** there are no function bodies. Exact copy appears only where the spec fixes it, or where a test asserts it.

## Owner questions

None open. R1 answered the superpowers question. Pre-flight F6 follows from O5 (R5). F14 and F15 were decided by the controller (R3, R4).
