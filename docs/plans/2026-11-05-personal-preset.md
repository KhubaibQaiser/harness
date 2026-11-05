# Personal preset implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in named preset (`khubaib-frontend` first) that adds a short always-on core block to AGENTS.md, stack-matched on-demand skills, preselected catalog picks, git rules enforced in `harness git` and the guard, and Claude Code's attribution and telemetry settings. A builder (`/harness:preset`) produces the same format for anyone, installed at repo level or, with a yes per write, globally under `~/.claude/`.

**Architecture:**
- `src/catalog/presets.ts` loads and checks a preset (YAML + its own items + templates), lists shipped (`catalog/presets/`) and repo-level (`.harness/presets/`) presets, matches `applies_when` against facts, and builds the select rows and context entries. The neutral catalog (`loadCatalog`, `compactCatalog`, the reviewer) never sees preset items, because `loadCatalog` reads only `catalog/items/`.
- The chosen preset is recorded in `config.yaml` as `preset: { id, version, items, git }`. `items` is the core and skill ids the person ticked; `git` is a copy of the preset's git block, so the hook bundle (guard) needs no preset file at run time.
- Writes go through the existing `planChanges` / `applyChanges` / manifest path: the core block is a second marked text block (`mergeAgentsPreset`), the skills are own files recorded with `item: "preset:<id>"`, and the settings are the existing `{"set":[...],"value":v}` blocks that `removeSets` already removes.
- A global install uses the same `applyChanges` with `root = home` and a new `stateDir` option (`.claude/harness`), so the manifest is `~/.claude/harness/manifest.json` and backups stay under `~/.claude/harness/backup/`.
- The CLI never calls a model. The AI step (the builder interview) lives in `skills/preset/` and reaches the CLI only through files: the preset folder and `preset-answers.json`.

**Tech stack:** TypeScript, Node ≥ 22.11, esbuild bundle, Vitest, `yaml`. No new dependency.

**Spec:** `docs/specs/2026-11-05-personal-preset-design.md` (owner-approved, binding). Section numbers below (§n) and decision ids (Q, O, C, F, P) refer to it.

**Precondition: PR-size is on `main` (O10).** PR-size has its own plan (`docs/plans/2026-11-05-pr-size.md`, separate branch). This plan does not re-implement any of it. Tasks 9 and 10 consume, from PR-size spec §3.1, §4 and §7:
- `measure(root, { base, head }, config)` in `src/checks/pr-size.ts` (lines, files, or unmeasured with a reason);
- `config.pr_size.max_lines` and `config.pr_size.max_files`;
- the shared walker `walkCommands(command, where, visit)` extracted in `src/checks/guard.ts`.

The first step of Tasks 9 and 10 reads the merged PR-size code and uses its real names. If PR-size changed a name, use the merged one and note it in the PR body. Tasks 1 to 8 and 11 to 13 don't depend on PR-size and can merge before it, but the build order stays vet, PR-size, preset (spec header).

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
4. **Found while planning (owner question 1):** `superpowers` is preselected and is marked `telemetry-on-by-default` in the catalog. Its evidence says the opt-out is `SUPERPOWERS_DISABLE_TELEMETRY`, not `DO_NOT_TRACK`, and that the telemetry applies only to its optional visual companion. The spec's `telemetry_off: [impeccable]` doesn't cover it.

## Owner actions (not tasks; no code)

- **Task 2 wording review (Q3, P9).** The core block and the four skill bodies are drafted from §1 and §7 only. The owner reviews them before Task 2 merges.
- **taste-skill vet (O5, §6).** Before taste-skill may replace Impeccable in any preset, the owner runs `harness vet Leonxlnx/taste-skill#12af471f627f866411b4bd785b19646d3672784c` (or `/harness:vet` with the same target) in their own terminal and accepts any high findings. The licence check is done (Planning check 2). No code change follows: a person who prefers taste-skill unticks the Impeccable row in select and picks taste-skill, and `conflicts_with` stops the two from installing together.

## Plan decisions the spec leaves open (the owner can change them in review)

- **Config shape.** `preset: { id, version, items, git: { branch_prefixes, no_ai_trailer, pr_size_warning } }`. `version` is the harness version that wrote it. The git copy exists because the guard runs from the bundled hook, which can't read `catalog/presets/`. The key is absent without a preset (§4).
- **Docs label (P9).** A docs-filled line ends with `[docs: https://…]`. The check fails a line with `[docs` that has no `https://` link.
- **Identity check (§8).** It rejects `user.name`, `user.email` and email-shaped text matching `/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/`. The TLD rule keeps `react@19.0.0` and `@tanstack/react-query` from matching.
- **`select --preset` also takes `--answers`.** `applies_when.project_types` needs the project type, and `select` reads no answers today.
- **Repo-level built preset.** `harness preset install <dir>` (no `--global`) copies the checked folder to `.harness/presets/<id>/` (committed, not in the manifest; `uninstall --yes` removes `.harness/` whole). The person then chooses it in `/harness:init` or `/harness:update`.
- **Global per-write yes.** `preset install <dir> --global` prints every path with its diff. In a terminal it asks `prompt.confirm` once per path. With `--yes`, it writes only the paths in `--take <path,...>`, which the skill fills from the person's per-write answers.
- **Global skills.** User scope has no repo facts, so a global install offers every skill of the preset. The per-write yes picks which ones land.
- **Global limits** (each carries a `ponytail:` comment):
  - A second global install is refused while `~/.claude/harness/manifest.json` exists.
  - `CLAUDE_CONFIG_DIR`, when set to anything other than `~/.claude`, is refused with a message, because Claude Code wouldn't read what harness wrote.
- **Preview copy for Impeccable (§4).** The four lines live in a small table in `presets.ts`, keyed by catalog id, with a `ponytail:` comment: move them to a catalog field when a second item needs them.

## Global constraints

- Preset id `khubaib-frontend`, title `Khubaib frontend` (O1). Shipped presets live in `catalog/presets/`. Code lives in the new `src/catalog/presets.ts`; `src/install/preset.ts` (the gate-defaults preset) is not touched (spec header).
- Preselects: `superpowers`, `ponytail`, `react-best-practices`, `vercel-react-native-skills`, `web-design-guidelines`, `impeccable`. Each is filtered by its own catalog `applies_when` (O5). Never caveman (O4), and never Addy Osmani's skills (Q6).
- Branch prefixes: `feature/`, `fix/`, `hotfix/`, `chore/`, `refactor/`, `docs/`, `ci/` (O6). Each matches `^[a-z0-9-]+/$`.
- Skill bodies: at most 150 lines. Frontmatter has `name` and `description` (§3).
- Markers: `<!-- harness:preset:start -->` and `<!-- harness:preset:end -->`, placed after the harness block (§5).
- **Lean always-loaded context** (estimates, characters / 4 as in `measure.ts`, §5):
  - core block ~173 tokens; each skill's name and description ~58;
  - one stack ~347; Next.js and RN ~405; plain React ~289; no React ~231.
  - The preset rows go through `measureSelection` and `budgetVerdict` against `context.budget_tokens` (2000). The installed totals must match these within rounding (Task 2 test).
- **Global writes each get their own yes** (O2). The preview lists every global path. `--dry-run` writes nothing. Git checks stay per repo (C2).
- **No invented data** (Q8, P9). Content is drafted from §1 answers only; doc fills cite a source and carry the docs label. Every number in copy or the README that is an estimate says so. No real name, email or signing key appears in any preset, test or fixture (Q7, §9).
- **Tests:**
  - TDD: red first.
  - `pnpm test` passes with `claude` off PATH. Fake `Exec` for `claude` and `gh` the way `test/cli/git.test.ts` (`noGh`) does.
  - No paid or live Claude runs, no network in tests.
  - Global tests use a temp dir as `home`, never the real `~`.
  - Git fixtures pin `init.defaultBranch`.
- **Process:**
  - Each task is one small PR off `main`, on branch `feature/preset-<n>-<slug>`, merged in order, one at a time. Flag it in the PR body if a task grows past the PR-size limit (400 changed lines or 20 files).
  - Commit as `git -c user.name=khubaibqaiser -c user.email=khubaib.dev@gmail.com commit …`, with no AI trailer and no footer.
  - Each PR checks `README.md` and `docs/reference.md`, and its PR body says, for each, "updated (…)" or "checked, no change".
- **Conflict note:** another branch is changing `src/vet/*` and the `vet` parsing in `src/checks/guard.ts`. No task touches `src/vet/*`. Tasks 10 and 11 edit `guard.ts`: rebase on `main` first and keep the vet lines as they land.
- Gates: `pnpm typecheck` and `pnpm test` pass at the end of every task.

## Review focus

1. **An update drops the preset's settings.** In `mergeSettings` (`src/install/merge.ts:139`), the non-`always` branch calls `removeSets(s, opts.recorded)` on every recorded set block, not only on the sandbox ones. So the first `harness update` with `sandbox: unattended` would delete `attribution` and `env.DO_NOT_TRACK`. Expected: only `set[0] === 'sandbox'` blocks are dropped there (Task 5 test).
2. **Deselecting `agents-md` while the preset is on removes the preset block too.** The deselected path in `planChanges` (`plan.ts:168-180`) cuts every recorded AGENTS.md block. Expected: only blocks holding `<!-- harness:start -->` go, the preset block stays, and CLAUDE.md keeps its `@AGENTS.md` import (Task 6 test).
3. **A global install where Claude Code won't look, or through a symlink.**
   - With `CLAUDE_CONFIG_DIR` set elsewhere, Claude Code ignores `~/.claude/`. Expected: harness refuses with a message instead of writing files that do nothing.
   - With a symlinked `~/.claude` (dotfile managers), `applyChanges` refuses symlinks. Expected: the message names the path and says nothing was written (Task 12 test).
4. **The identity check flags package versions.** `react@19.0.0`, `expo@~52.0.0` and `@tanstack/react-query` must pass. `jane@example.com` must fail (Task 1 test).
5. **The preset folder is gone at update time.** A built preset folder can be deleted, or a newer harness can drop a shipped one. Expected: update prints `Preset "<id>" was not found; its files are kept as they are.`, removes nothing and doesn't crash (Task 7 test).

---

### Task 1: Preset format, loader, checks and `harness preset list|check`

**Files:**
- Create: `src/catalog/presets.ts`, `src/cli/preset.ts`, `test/fixtures/presets/` (a small valid preset `tiny`, with one core and two skills, plus a broken copy built in the test)
- Modify: `src/cli/index.ts` (route `preset`, add to USAGE), `src/cli/catalog.ts` (`catalog check` also checks each shipped preset)
- Test: `test/catalog/presets.test.ts`, `test/cli/preset.test.ts`

**Interfaces:**
- Consumes: `validateItem`, `ID_RE`, `Catalog`, `CatalogItem` (`src/catalog/schema.ts`); `loadCatalog`; `packageDir`; `esc`, `CONTROL` (`src/core/config.ts`).
- Produces (in `src/catalog/presets.ts`):
  - `export interface PresetGit { branch_prefixes: string[]; no_ai_trailer: boolean; pr_size_warning: boolean }`
  - `export interface Preset { id: string; title: string; description: string; core: string; preselect: string[]; skills: string[]; settings: { attribution?: 'off'; telemetry_off: string[] }; git: PresetGit }`
  - `export interface LoadedPreset { preset: Preset; base: string /* the <id>/ folder */; items: CatalogItem[] /* core + skills */ }`
  - `export const PREFIX_RE = /^[a-z0-9-]+\/$/`
  - `export function loadPreset(yamlPath: string): { ok: true; loaded: LoadedPreset } | { ok: false; errors: string[] }`
  - `export function checkPreset(l: LoadedPreset, catalog: Catalog): string[]`
  - `export function identityProblems(dir: string): string[]` (every file under the preset folder)
  - `export const presetDirs = (root: string): string[] => [join(packageDir('catalog'), 'presets'), join(root, '.harness', 'presets')]`
  - `export function listPresets(root: string): { id: string; description: string; where: 'shipped' | 'repo' }[]`
  - `export function findPreset(id: string, root: string): string | null` (shipped first; the yaml path)
- Layout: `<dir>/<id>.yaml`, `<dir>/<id>/items/<item>.yaml`, `<dir>/<id>/templates/core.md`, `<dir>/<id>/templates/skills/<name>/SKILL.md`. Skill items are `kind: own-skill` with `source.files: [{ from: skills/<name>/SKILL.md, to: .claude/skills/<name>/SKILL.md }]`. The core item is `kind: rule`, `source: { type: own }`; its text is always `templates/core.md`.

- [ ] **Step 1: Write the failing tests** in `test/catalog/presets.test.ts`:
  - `loadPreset` on `tiny` returns ok with `items` ids `[core, skills…]`.
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
    - an unknown top-level key → `unknown key "extra"`;
    - a body line `- Use X. [docs]` → `skills/x/SKILL.md:3: a docs-labelled line needs a link: [docs: https://…]`.
  - `identityProblems`: a template containing `jane@example.com` fails; one containing `user.email` fails; `react@19.0.0`, `expo@~52.0.0` and `@tanstack/react-query` pass (Review focus 4).
  - Every error text goes through `esc` (a `\u001b` in an id prints as `\u001b`).
  - `listPresets(root)` lists the shipped dir and `.harness/presets/` with `where`. `findPreset` returns null for an unknown id.
- [ ] **Step 2: Write the failing CLI tests** in `test/cli/preset.test.ts`:
  - `preset list` prints `<id>  <description>` lines, or `No presets.`
  - `preset check <dir>` exits 0 with `ok` on `tiny`, and 1 with one error per line on the broken copy.
  - `preset check` rejects a built preset whose id is a shipped id: `preset id "<id>" is already a shipped preset`.
  - `catalog check` reports shipped preset errors, prefixed `presets/<id>: `.
- [ ] **Step 3: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/catalog/presets.test.ts test/cli/preset.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 4: Implement** the interfaces above, and `preset(args, cli)` in `src/cli/preset.ts` with `list` and `check <dir>` (`install` comes in Tasks 11 and 12). Unknown keys fail at every level, as in `validateItem`.
- [ ] **Step 5: Run the tests and confirm they pass.** Then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Docs.** `docs/reference.md` "Commands in full": add `harness preset list` and `harness preset check <dir>`. README: checked; add only if it lists every command. Put both results in the PR body.
- [ ] **Step 7: Commit.** Message: `feat(preset): preset format, loader and checks`.

### Task 2: The `khubaib-frontend` preset content

**Files:**
- Create: `catalog/presets/khubaib-frontend.yaml`; `catalog/presets/khubaib-frontend/items/{core-rules,engineering-principles,frontend-react,frontend-nextjs,frontend-react-native}.yaml`; `catalog/presets/khubaib-frontend/templates/core.md`; `catalog/presets/khubaib-frontend/templates/skills/{engineering-principles,frontend-react,frontend-nextjs,frontend-react-native}/SKILL.md`
- Test: `test/catalog/khubaib-frontend.test.ts`

**Interfaces:**
- Consumes: `loadPreset`, `checkPreset`, `identityProblems` (Task 1); `estimateTokens`, `alwaysLoadedText` (`src/budget/measure.ts`).
- Produces: the shipped preset. Later tasks' tests use it as the reference fixture (§8).

- [ ] **Step 1: Write the failing tests:**
  - `preset check` passes on `catalog/presets/khubaib-frontend/` with zero identity problems.
  - YAML values are exactly the §3 example: id `khubaib-frontend`; the six preselects in the order of Global constraints; skills `[engineering-principles, frontend-react, frontend-nextjs, frontend-react-native]`; `settings: { attribution: off, telemetry_off: [impeccable] }`; git prefixes per O6, `no_ai_trailer: true`, `pr_size_warning: true`. `caveman` is not anywhere in the folder.
  - `applies_when`: `engineering-principles` `{always: true}`; `frontend-react` `{frameworks: [react, next, react-native, expo]}`; `frontend-nextjs` `{frameworks: [next]}`; `frontend-react-native` `{frameworks: [react-native, expo]}`.
  - `core.md` equals the §5 block's inner text line for line (between the markers). Its first line contains `This overrides any skill that says to decide on its own.` (§6 "Asking wins").
  - The four descriptions are the §7 table's text verbatim.
  - **Budget (estimate, §5):** `estimateTokens(core.md)` is 173 ± 5. Each `alwaysLoadedText('skill', …)` is 58 ± 8. The four totals (one stack, Next.js and RN, plain React, no React) are 347, 405, 289 and 231, each ± 10.
  - F3 is quoted verbatim in `frontend-react` (the whole §1 F3 string). The P7 Tailwind sentence's intent is present (no `h-[98px]`-style arbitrary values where a scale class fits).
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/catalog/khubaib-frontend.test.ts`.
- [ ] **Step 3: Write the content.**
  - Bodies follow the §7 outlines, from §1 only.
  - A gap filled from react.dev or the Next.js, Expo or TypeScript docs ends with `[docs: <url>]` (P9).
  - Items Vercel's `react-best-practices` already covers are not repeated (P9).
  - KISS and YAGNI are worded to agree with ponytail's smallest-change rule (§7).
  - `evidence` in each item names the spec decision ids it comes from. `license` is `MIT` (the repo's), and `min_claude_code` is `MIN_CLAUDE_CODE`.
- [ ] **Step 4: Run the tests and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Owner review (Q3).** Open the PR as a draft and ask the owner to review `core.md` and the four bodies. Apply their edits, re-run Step 4, then mark the PR ready.
- [ ] **Step 6: Docs.** README: checked, no change yet (Task 8 adds the user-facing section). `docs/reference.md`: checked, no change. Say both in the PR body.
- [ ] **Step 7: Commit.** Message: `feat(preset): add the khubaib-frontend preset content`.

### Task 3: The `preset` config key and the `preset` answer

**Files:**
- Modify: `src/core/config.ts` (type, rule, overlay), `src/core/config-io.ts` (`SECTIONS`, `serializeConfig`), `src/ai/answers.ts`, `templates/config.example.yaml` (a commented example only)
- Test: `test/core/config.test.ts`, `test/core/config-io.test.ts`, `test/ai/answers.test.ts`

**Interfaces:**
- Consumes: `PREFIX_RE`, `findPreset` (Task 1); `ID_RE`.
- Produces:
  - `HarnessConfig.preset?: { id: string; version: string; items: string[]; git: PresetGit }`
  - `Answers.preset: string | null`; `configToAnswers(c).preset === (c.preset?.id ?? null)`.

- [ ] **Step 1: Write the failing tests:**
  - `loadConfig` without `preset` gives `config.preset === undefined` and no warning.
  - With a valid `preset` mapping, it loads it as is.
  - Each error is reported:
    - `preset.id: must be lowercase letters, digits and hyphens`;
    - `preset.git.branch_prefixes[0]: must match ^[a-z0-9-]+/$`;
    - `preset.extra: unknown key`.
  - `serializeConfig` without `preset` is byte-identical to today's output (existing snapshot tests stay green). With `preset`, it adds a `# Named preset chosen at init (rules, skills, git checks).` section last.
  - `validateAnswers`:
    - accepts `preset` absent (treated as null), `null`, and `"khubaib-frontend"`;
    - rejects `"nope"` with `preset: "nope" is not a shipped or repo preset (harness preset list shows them)`.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/core/config.test.ts test/core/config-io.test.ts test/ai/answers.test.ts`.
- [ ] **Step 3: Implement.**
  - Add `RULES.preset` (an `objRule`).
  - `overlay`: a key missing from `base` that has a `RULES` entry is checked by that rule and set, instead of being reported unknown.
  - `serializeConfig`: skip a section whose value is `undefined`.
  - `validateAnswers`: add `preset` to the allowed keys and check it with `findPreset(id, facts.root)`.
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck` and `node scripts/gen-config-docs.mjs` (if the README config table changes, commit the regenerated table).
- [ ] **Step 5: Docs.** `docs/reference.md` "Configuration keys": add the `preset` row. README: checked, or updated through the generator. Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): record the chosen preset in config and answers`.

### Task 4: Stack matching and the preset rows in select

**Files:**
- Modify: `src/catalog/presets.ts`, `src/install/select.ts` (`notPicked`, `toSelected`), `src/cli/select.ts`
- Test: `test/catalog/presets-match.test.ts`, `test/install/select.test.ts`, `test/cli/select.test.ts`

**Interfaces:**
- Consumes: `LoadedPreset` (Task 1); `Facts` (`src/install/detect.ts`); `ChecklistRow`, `checklist` (`select.ts`).
- Produces:
  - `export function appliesTo(aw: AppliesWhen, facts: Pick<Facts, 'deps' | 'frameworks'>, projectType: string): boolean`. `always` is true; otherwise every key present must hold: `any_dep` and `frameworks` need one listed name in the facts, and `project_types` must include `projectType`.
  - `export const presetReason = (id: string) => \`Preselected by the ${id} preset\``.
  - `export function presetRows(l: LoadedPreset, c: Catalog, facts, projectType: string, picked: string[], dirs: { templates: string }): ChecklistRow[]`. It gives the stack-matched preselects not in `picked`, then the core and the matched skills. All rows are ticked, with `include: 'recommended'` and a reason. Preset item rows have `context` `~<n> tokens (estimate)`.
  - `notPicked(chosen, p, c, extra: string[] = [])`: `extra` ids count as picked.
  - `toSelected(p, ids, c, reasons: Record<string, string> = {})`: a chosen id not in picks takes `reasons[id]` before `Chosen by you.`
  - CLI: `harness select --picks <file> [--preset <id> --answers <file>] [--choose <id,...>]`.

- [ ] **Step 1: Write the failing tests** with fixture facts (§11 "Stacks"), each against `khubaib-frontend`:
  | Facts (frameworks; project type) | Skills | Preselects |
  |---|---|---|
  | `[next, react]`; web | principles, react, nextjs | superpowers, ponytail, react-best-practices, web-design-guidelines, impeccable |
  | `[expo, react, react-native]`; mobile | principles, react, react-native | superpowers, ponytail, vercel-react-native-skills |
  | `[react, react-native]`; mobile | principles, react, react-native | superpowers, ponytail, vercel-react-native-skills |
  | `[react]` (Vite); web | principles, react | superpowers, ponytail, react-best-practices, web-design-guidelines, impeccable |
  | `[expo, next, react, react-native]`; web | all four | superpowers, ponytail, react-best-practices, vercel-react-native-skills, web-design-guidelines, impeccable |
  | `[]`; api | principles | superpowers, ponytail |
  - Every row carries `reason: Preselected by the khubaib-frontend preset`.
  - A preselect the reviewer already picked appears once, as the reviewer's row.
  - `notPicked` with the preset ids as `extra` returns `[]`.
  - `caveman` never appears.
  - CLI: `--preset` without `--answers` prints USAGE and exits 2. An unknown preset id exits 2 with the Task 3 message.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the interfaces. `select --choose` splits the ids: preset item ids skip `resolveSelection` (they aren't catalog items) and come back in the JSON as `preset_items: [...]`.
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** `docs/reference.md`: update the `harness select` line. README: checked. Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): stack matching and preset rows in select`.

### Task 5: Preset merge kinds and the sandbox removal fix

**Files:**
- Modify: `src/install/merge.ts`
- Test: `test/install/merge.test.ts`

**Interfaces:**
- Consumes: `mergeAgents`, `removeBlocks`, `removeSets`, `removeFromSettings` (existing).
- Produces:
  - `export const PRESET_START = '<!-- harness:preset:start -->'` and `PRESET_END = '<!-- harness:preset:end -->'`
  - `export function mergeAgentsPreset(before: string | null, core: string): { after: string; blocks: string[] }`. It is `mergeAgents`'s logic with these markers and the given core text, and the same `MergeError` messages with "preset" in place of "harness".
  - `export type SetBlock = { set: string[]; value: unknown }`
  - `export function presetSets(l: LoadedPreset): SetBlock[]`. `attribution: off` gives `{ set: ['attribution'], value: false }` (Planning check 1). A non-empty `telemetry_off` gives `{ set: ['env'], value: {} }` (only when `env` is absent) and `{ set: ['env', 'DO_NOT_TRACK'], value: '1' }`.
  - `export function mergePresetSettings(before: string | null, want: SetBlock[], recorded: string[], label = '.claude/settings.json'): { after: string; blocks: string[]; dropped: string[]; notes: string[] }`. It adds each missing key as a set block. A key that already holds another value is kept, with the note `` `<label>`: `<path>` is already <json>; left as is (the preset would set <json>). `` It drops recorded non-sandbox set blocks no longer wanted, through `removeSets`.

- [ ] **Step 1: Write the failing tests:**
  - **Agents block:**
    - On null, it creates the block. On `# Mine\n`, it appends with a blank-line separator.
    - After `mergeAgents`, the preset block follows the harness block.
    - `removeBlocks(after, presetBlocks)` returns the input byte for byte, for LF and CRLF.
    - On update, the block is replaced in place.
    - Two start markers → `AGENTS.md has a repeated preset marker; fix it by hand`.
    - End before start → `…missing or misordered preset marker…`.
  - **Settings:**
    - Into `{}`, attribution and `env` are added.
    - Into `{"env":{"FOO":"1"}}`, only `env.DO_NOT_TRACK` is added and `FOO` stays.
    - Into `{"attribution":{"commit":"x"}}`, it is left as is, with the note.
    - `removeFromSettings` with the recorded blocks restores the original object deep-equal and byte-equal for the `{}` and `FOO` cases.
  - **Review focus 1:** `mergeSettings(after, { sandbox: 'unattended', recorded: [...hookBlocks, ...presetBlocks] })` keeps `attribution` and `env.DO_NOT_TRACK`, and its `dropped` holds no preset block. It still drops recorded `sandbox` set blocks when leaving `always` (the existing test stays green).
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/install/merge.test.ts`.
- [ ] **Step 3: Implement.**
  - The fix: in `mergeSettings`'s non-`always` branch, pass `removeSets` only the recorded blocks whose parsed `set[0] === 'sandbox'`.
  - `mergePresetSettings` reuses the file parse, indent and EOL rules of `mergeSettings` (factor the open and serialize lines into a local helper, rather than copying them).
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** README and `docs/reference.md`: checked, no change (nothing user-visible). Say so in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): preset AGENTS block and settings blocks`.

### Task 6: Preset writes in `planChanges`; init and uninstall

**Files:**
- Modify: `src/install/plan.ts`, `src/cli/init.ts` (`loadAiInputs`, `init`)
- Test: `test/install/plan.test.ts`, `test/cli/uninstall.test.ts`, `test/cli/init.test.ts`

**Interfaces:**
- Consumes: `findPreset`, `loadPreset`, `presetRows` (Tasks 1, 4); `mergeAgentsPreset`, `presetSets`, `mergePresetSettings` (Task 5); `config.preset` (Task 3).
- Produces:
  - `planChanges` ctx gains `preset?: LoadedPreset`. When `config.preset` and `ctx.preset` are both set:
    - the core block is chained after `mergeAgents` on the same text: one `put('AGENTS.md', …)` with both blocks, plus `mergeClaudeMd` even when `agents-md` is off;
    - each item in `config.preset.items` with files is `put` from `<base>/templates/<from>`, with `item: "preset:<id>"`;
    - the settings blocks are chained after `mergeSettings`: one `put('.claude/settings.json', …)`.
  - Recorded files with `item` starting `preset:` that are no longer wanted go through the same delete, restore or keep logic as a deselected own file (`plan.ts:127-135`).
  - `loadAiInputs` returns `presetItems: string[]` and sets `config.preset = { id, version: cli.version, items, git: preset.git }` when `answers.preset` is set. A `--choose` preset item that doesn't match the repo's stack → `"<id>" does not apply to this repo's stack.`

- [ ] **Step 1: Write the failing tests:**
  - **Plan:**
    - With the preset on a Next.js fixture, the plan holds AGENTS.md (both blocks), `.claude/skills/{engineering-principles,frontend-react,frontend-nextjs}/SKILL.md` with `item: preset:<id>`, and settings with attribution and DO_NOT_TRACK.
    - Without a preset, the plan is unchanged from today (the existing plan tests stay green).
  - **Review focus 2:** a config with `agents-md` deselected and the preset on removes only the harness block. AGENTS.md keeps the preset block, and CLAUDE.md keeps `@AGENTS.md`.
  - **Byte-identical (§11):**
    - `init --answers … --choose <ids incl. preset items>` with `preset: "khubaib-frontend"`, then `uninstall --yes`, leaves `hashes(root)` equal to before, with `git status --porcelain` empty. Use the `test/cli/uninstall.test.ts` helpers and the AI-path fixtures under `test/fixtures/ai/`.
    - The same on a repo whose `.claude/settings.json` already has `{"env":{"FOO":"1"}}`.
  - **Init:** `config.yaml` records `preset: { id: khubaib-frontend, version: 1.2.3, items: [...], git: {...} }`, and nothing in it is a name or an email.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** On the deselected-agents path, filter blocks by `block.includes('<!-- harness:start -->')`.
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** `docs/reference.md` "What `init` changes in your repo": add the preset block, the skills and the two settings keys. README: checked; the user section lands in Task 8. Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): install the preset through init, removed by uninstall`.

### Task 7: Update: re-render, stack changes, turning it off

**Files:**
- Modify: `src/cli/update.ts`, `src/install/plan.ts` (`setChanged` deletes a top-level key that `want` no longer has, for `preset` only)
- Test: `test/cli/update.test.ts`

**Interfaces:**
- Consumes: Task 6's `planChanges` preset path; `configToAnswers` (Task 3).
- Produces: update behaviour only.

- [ ] **Step 1: Write the failing tests:**
  - **Re-render:** a changed `core.md` in a copied preset gives a plan that replaces the block in place. The manifest drops the old block and records the new one.
  - **Stack gone:** after init on Next.js plus Expo, removing `expo` and `react-native` from `package.json` makes `update --dry-run` plan the delete of `frontend-react-native`'s SKILL.md and drop that id from `preset.items`.
  - **Stack new:** a newly matching skill prints `Note: frontend-nextjs now applies here; run /harness:update and tick it to add it.` and isn't written.
  - **Off:** partial answers `{"preset": null}` through the AI flags remove the core block, the skills, both settings blocks and the `preset` key, and leave the preselected plugins selected. Then `uninstall --yes` is byte-identical to before init (§11: init without, update with, update without).
  - **Review focus 5:** with `.harness/presets/<id>/` deleted after init, `update --dry-run` prints `Preset "<id>" was not found; its files are kept as they are.` and plans no preset change.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** `docs/reference.md`: add one line on update and turning the preset off. README: checked. Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): update re-renders, follows the stack and turns the preset off`.

### Task 8: Init flow: interview question, preview and budget lines

**Files:**
- Modify: `skills/init/interview.md`, `skills/init/SKILL.md`, `skills/update/SKILL.md`, `src/catalog/presets.ts` (`presetContext`, `PREVIEW_LINES`), `src/budget/measure.ts` (`extra` entries), `src/cli/init.ts` (`budgetGate`, plan output), `README.md`
- Test: `test/budget/measure.test.ts`, `test/cli/init.test.ts`, `test/cli/skills-text.test.ts` (create if absent)

**Interfaces:**
- Consumes: `LoadedPreset`; `measureSelection`.
- Produces:
  - `export function presetContext(l: LoadedPreset, ids: string[]): ContextEntry[]` (core: `estimateTokens(core.md)`; skill: `alwaysLoadedText('skill', body)`)
  - `measureSelection(ids, c, dirs, { extra?: ContextEntry[] })`: extra entries are added like items.
  - `export const PREVIEW_LINES: Record<string, string[]>`, with `impeccable`:
    - `Impeccable installs hooks: SessionStart, PostToolUse on Edit and Write, and Stop.`
    - `Impeccable downloads its engine into ~/.impeccable/bin/ on first use.`
  - The preset itself adds these lines:
    - `Telemetry: DO_NOT_TRACK=1 goes in .claude/settings.json env; it applies to every command in the session.`
    - `Attribution: .claude/settings.json sets "attribution": false, so commits and PRs get no AI trailer.`

- [ ] **Step 1: Write the failing tests:**
  - `budgetGate` with the preset on a Next.js fixture prints a total that includes the core and skill entries. The preselected plugins are listed under `Not measured before install:`, which is the current rule (§5).
  - The init `--dry-run` output with the preset holds the four preview lines exactly once each. Without the preset, it holds none.
  - **Skill text:**
    - `interview.md` asks "Use a named preset?" after scope and before the gaps, with "No preset (neutral catalog, the default)" first, and says to run `harness preset list`.
    - `SKILL.md` step 4 passes `--preset <id> --answers <answers.json>` to select, and says which rows came from the preset.
    - The update skill says that answering "No preset" turns it off.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the code and the skill lines. Keep `interview.md` and `SKILL.md` within their current length plus 4 lines each (lean context; they load only on use).
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.**
  - README: add a short "Named presets" section. It covers what `khubaib-frontend` adds, the ~231 to ~405 token cost (labelled as an estimate), that `DO_NOT_TRACK=1` applies to the whole session (C3) and only after the folder is trusted (Planning check 1), and how to turn it off.
  - `docs/reference.md` "The `/harness:init` flow": add the preset question.
  - PR body: both updated.
- [ ] **Step 6: Commit.** Message: `feat(preset): offer presets in init, with preview and budget lines`.

### Task 9: `harness git`: no trailer, `branch --suggest`, PR-size warning

**Precondition:** PR-size is merged. Step 1 reads `src/checks/pr-size.ts` and confirms `measure`'s name, arguments and result shape.

**Files:**
- Modify: `src/cli/git.ts`, `src/catalog/presets.ts` (`slug`, `suggestBranches`)
- Test: `test/cli/git.test.ts`, `test/catalog/presets.test.ts`

**Interfaces:**
- Consumes: `config.preset.git` (Task 3); PR-size's `measure` and `config.pr_size`.
- Produces:
  - `export const slug = (topic: string): string`: lower-cased, every run of characters outside `[a-z0-9]` becomes `-`, trimmed of `-`, cut to 50 characters, and `topic` when empty.
  - `export const suggestBranches = (prefixes: string[], topic: string): string[] => prefixes.map((p) => p + slug(topic))`
  - USAGE: `harness git branch [--suggest <topic>]|commit|push|pr [--title <t>]`.

- [ ] **Step 1: Read the merged PR-size code** and note its names in the PR body.
- [ ] **Step 2: Write the failing tests** (the `installed()` helper with a `preset:` block in `config.yaml`):
  - `commit` with `commit_trailer` set and the preset on exits 1 with `The khubaib-frontend preset bans AI trailers; clear git.commit_trailer.` No commit is made.
  - With the preset off, the existing trailer test stays green.
  - `branch --suggest "Add login form"` prints the seven names, one per line (`feature/add-login-form` … `ci/add-login-form`), creates no branch and exits 0.
  - `pr` with a fake `measure` over the limit prints `This PR has 512 changed lines in 14 files; the limit is 400 lines or 20 files.` before `gh pr create`, and still creates the PR. Under the limit, it prints nothing extra. When unmeasured, it prints `PR size not measured: <reason>.`
  - No test or fixture stores an identity; the repo identity is set with `git config` in the temp repo only.
- [ ] **Step 3: Run them and confirm they fail.**
- [ ] **Step 4: Implement.** `--suggest` is allowed only with `branch`. The guard's `git` entry already allows `branch` and `commit` (`guard.ts:87`).
- [ ] **Step 5: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 6: Docs.** `docs/reference.md` "Commands in full": `harness git branch --suggest`. README: checked. Say both in the PR body.
- [ ] **Step 7: Commit.** Message: `feat(preset): no-trailer, branch suggestions and PR-size warning in harness git`.

### Task 10: Guard asks: AI trailer and branch prefix

**Precondition:** PR-size is merged, with `walkCommands` in `guard.ts`. Rebase on `main` for the vet branch's `guard.ts` changes first (conflict note).

**Files:**
- Modify: `src/checks/guard.ts`
- Test: `test/checks/guard.test.ts`, `test/hooks/dispatch.test.ts` (the unattended deny)

**Interfaces:**
- Consumes: `walkCommands` (PR-size); `gitArgs` (`guard.ts:481`); `ctx.config.preset` (Task 3); `suggestBranches` (Task 9).
- Produces (in `guard.ts`, not exported unless the tests need them):
  - `const AI_TRAILER = /Co-Authored-By:[^\n]*(Claude|noreply@anthropic\.com)|Generated with \[?Claude Code/i`
  - a visitor. When `gitArgs` starts with `commit` and the raw command (heredoc bodies included) matches `AI_TRAILER`, it gives the ask `the agent is committing with an AI trailer, which the <id> preset bans`. When it starts with `checkout -b|-B <name>` or `switch -c|-C <name>`, and the name has no listed prefix, it gives the ask `branch "<name>" has no listed prefix; use one of: <suggestBranches(prefixes, name) joined by ", ">`.
  - Both run only when `ctx.config?.preset` is set, after the person-only check and before `ASK`. They are not `PERSON_ONLY` entries (§9).

- [ ] **Step 1: Write the failing tests** (§11 "Guard"):
  - Ask on:
    - `git commit -m "fix: x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>"`;
    - a heredoc `git commit -F - <<'EOF'` whose body has the trailer;
    - `git -C . commit -m "…Generated with Claude Code…"`.
  - Allow `git commit -m "fix: x"`.
  - Unattended, the dispatcher turns the trailer ask into a deny that starts `Unattended run:` (O11).
  - Ask on `git switch -c wip` with `feature/wip` in the reason; allow `git switch -c feature/x`, `git checkout -b fix/y` and `git switch main`.
  - With no `preset` in the config, nothing fires.
  - The guard's existing tests pass unchanged.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run --project unit test/checks/guard.test.ts`.
- [ ] **Step 3: Implement.** Add a `ponytail:` comment on the trailer visitor naming the limit: a message from `-F <file>` or an editor isn't visible to the guard (§9).
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck` and `pnpm test:perf` (PE latency budget).
- [ ] **Step 5: Docs.** `docs/reference.md` "Guard details": the two asks, and the `-F <file>` limit under "Known limits". README: checked. Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): guard asks on AI trailers and unprefixed branches`.

### Task 11: `harness preset install` (repo) and the `preset` guard entry

**Files:**
- Modify: `src/cli/preset.ts`, `src/checks/guard.ts` (`PERSON_ONLY.preset`)
- Test: `test/cli/preset.test.ts`, `test/checks/guard.test.ts`

**Interfaces:**
- Consumes: `loadPreset`, `checkPreset`, `identityProblems`, `findPreset` (Task 1).
- Produces:
  - `harness preset install <dir> [--dry-run|--yes]`: checks the folder, then copies `<id>.yaml` and `<id>/` to `.harness/presets/`.
  - `PERSON_ONLY.preset = { kind: 'ask', allowed: (a) => a[0] === 'list' || a[0] === 'check' || (a[0] === 'install' && a.includes('--dry-run') && !a.includes('--yes')), why: () => 'the agent is installing a preset, which writes rules, skills and settings (global ones go to ~/.claude)' }` (§8).

- [ ] **Step 1: Write the failing tests:**
  - `install <tiny copy> --dry-run` lists the files and writes nothing. `--yes` copies them, and then `preset list` shows `where: repo`.
  - A folder that fails `check` (an email in it) is refused with the check errors and nothing is copied.
  - An existing `.harness/presets/<id>/` with other content → `.harness/presets/<id>/ already exists; remove it first.`
  - Guard: `harness preset install x --yes` asks; `harness preset list`, `harness preset check x` and `harness preset install x --dry-run` are allowed.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** `docs/reference.md`: `harness preset install`. README: checked. Say both in the PR body.
- [ ] **Step 6: Commit.** Message: `feat(preset): install a built preset into the repo`.

### Task 12: Global install: `stateDir` and `preset install --global`

**Files:**
- Modify: `src/install/apply.ts` (`opts.stateDir`), `src/install/manifest.ts` (`readManifest(root, read, stateDir)`), `src/cli/preset.ts`
- Test: `test/install/apply.test.ts`, `test/cli/preset-global.test.ts`

**Interfaces:**
- Consumes: `mergeAgentsPreset`, `presetSets`, `mergePresetSettings` (Task 5); `applyChanges`; `unifiedDiff`.
- Produces:
  - `applyChanges(…, opts.stateDir = '.harness')`: the manifest, backups and lock are `<stateDir>/manifest.json`, `<stateDir>/backup/…` and `<stateDir>/apply.lock`. The default is byte-for-byte today's behaviour.
  - `export const GLOBAL_STATE = '.claude/harness'`
  - `harness preset install <dir> --global [--dry-run] [--yes --take <rel,...>]`, with `PresetEnv = CliEnv & { prompt: Prompt; home?: string }` (`home` defaults to `os.homedir()`). The writes, relative to `home`:
    - `.claude/CLAUDE.md` (the core block with the preset markers);
    - `.claude/skills/<name>/SKILL.md` for every skill;
    - `.claude/settings.json` (attribution only; `DO_NOT_TRACK` stays repo-level, C2 and C3);
    - `.claude/harness/presets/<id>.yaml` and `<id>/…`, all recorded in `~/.claude/harness/manifest.json`.

- [ ] **Step 1: Write the failing tests** with a temp `home`:
  - `--dry-run` prints `Global writes (each needs its own yes):`, then every path, then the diffs and the always-loaded total. It writes nothing; the temp home's file hashes are unchanged.
  - In a terminal (fake prompt), it asks once per path. A path answered no is not written and not recorded.
  - `--yes --take .claude/CLAUDE.md` writes only that file plus the manifest. `--yes` without `--take` → `--yes needs --take <path,...>: name each global write you approved.`, exit 2.
  - A second install while the global manifest exists → `A global preset is already installed (<id>). Run harness uninstall --global first.`
  - **Review focus 3:**
    - `env.CLAUDE_CONFIG_DIR=/elsewhere` → `CLAUDE_CONFIG_DIR is set to /elsewhere, so Claude Code would not read ~/.claude. Unset it, or install the preset at repo level.`, exit 1.
    - A symlinked `<home>/.claude` → the `refusing symlink` ApplyError text plus `Nothing was written.`
  - The existing `applyChanges` and manifest tests pass unchanged (the default `stateDir`).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Add `ponytail:` comments on the single-global-install and `CLAUDE_CONFIG_DIR` refusals.
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck` and `pnpm test` (Windows CI covers `path.join` use).
- [ ] **Step 5: Docs.** README "Named presets": add the global install, the per-write yes, and that git checks stay per repo (C2). `docs/reference.md`: add the command and the paths table (§8). PR body: both updated.
- [ ] **Step 6: Commit.** Message: `feat(preset): global preset install with a yes per write`.

### Task 13: `harness uninstall --global`

**Files:**
- Modify: `src/cli/uninstall.ts` (extract the per-file loop as `removalChanges`; add `--global`), `src/cli/index.ts` (USAGE)
- Test: `test/cli/uninstall.test.ts`, `test/cli/preset-global.test.ts`

**Interfaces:**
- Consumes: `GLOBAL_STATE`, `applyChanges(…, { stateDir })` (Task 12); `removeFromSettings`; `removeEmptyDirs`.
- Produces:
  - `export function removalChanges(root: string, m: Manifest, force: boolean): { changes: Change[]; kept: string[]; notes: string[] }`. It is the existing loop, unchanged, now shared.
  - `harness uninstall --global [--dry-run] [--yes]`. It reads `<home>/.claude/harness/manifest.json`, removes exactly what it records, deletes the manifest, and removes the empty dirs harness created. It needs no git repo.

- [ ] **Step 1: Write the failing tests:**
  - A temp home with `.claude/CLAUDE.md` = `# Mine\n` and `.claude/settings.json` = `{"theme":"dark"}\n`: global install of every path, then `uninstall --global --yes`, leaves every file hash in the temp home equal to before, and no `.claude/harness/` (§11).
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

**Files:**
- Create: `skills/preset/SKILL.md` (under 40 lines, `disable-model-invocation: true`), `skills/preset/interview.md`, `src/ai/preset-answers.ts`
- Modify: `src/cli/validate.ts` (`preset-answers`), `src/cli/index.ts` (USAGE)
- Test: `test/ai/preset-answers.test.ts`, `test/cli/skills-text.test.ts`

**Interfaces:**
- Consumes: `ID_RE`, `PREFIX_RE`, `listPresets`, `identityProblems`, `CONTROL`, `loadCatalog`.
- Produces:
  - `export const STACKS = ['react', 'next', 'react-native'] as const`
  - `export const TOPICS = ['folders', 'server_data', 'client_state', 'components', 'forms', 'testing', 'ui_states', 'api_layer', 'performance', 'platform', 'style', 'extras'] as const` (F1 to F12)
  - `export interface PresetAnswers { id: string; title: string; description: string; target: 'repo' | 'global'; rules: string[]; preselect: string[]; git: PresetGit; stacks: Partial<Record<(typeof STACKS)[number], Partial<Record<(typeof TOPICS)[number], string>>>> }`
  - `export function validatePresetAnswers(raw: unknown, catalog: Catalog, root: string): { ok: true; answers: PresetAnswers } | { ok: false; errors: string[] }`
  - `harness validate preset-answers <file>`: exit 0 prints `ok`; exit 2 prints one error per line.

- [ ] **Step 1: Write the failing tests:**
  - **validatePresetAnswers:**
    - A full valid file passes.
    - Each of these gives its own error: an id that is a shipped id; a preselect `caveman` (discouraged) or `zzz` (unknown); a prefix `feature`; a `‮` in a rule; a string with `jane@example.com`; an unknown topic `i18n`; an unknown top-level key.
    - A skipped topic is simply absent; nothing is filled in (§8).
  - **Skill text:**
    - `SKILL.md` says, in order: one question per call with AskUserQuestion, 2 to 4 options, recommended first, plus "Other"; `mktemp -d`; draft only from the answers and quote free text verbatim; show each file and apply edits; run `harness preset check <dir>`, fix and retry once, then stop; for `global`, run `preset install <dir> --global --dry-run`, ask a separate yes for each listed path, then run `--yes --take` with only the approved paths; for `repo`, `preset install <dir>` then `/harness:init` or `/harness:update`.
    - It says it never stores a git name or email.
    - It names no subagent (§8: the main session asks).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** the validator and the two skill files. `interview.md` follows §8's six topics in order. Its first line on working rules lists the eight Q8 rules as options.
- [ ] **Step 4: Run the tests and confirm they pass.** Then `pnpm typecheck`, and `pnpm test` with `claude` off PATH.
- [ ] **Step 5: Docs.** README "Named presets": how to build your own with `/harness:preset`. `docs/reference.md` "Commands in full": `validate preset-answers`. PR body: both updated.
- [ ] **Step 6: Commit.** Message: `feat(preset): /harness:preset builder and preset-answers validation`.

---

## Self-review (2026-11-05)

- **Spec coverage:**

  | Spec section | Tasks |
  |---|---|
  | §3 format and checks | 1 |
  | §3 stack matching | 4 |
  | §4 interview, answers, select, preview, budget, config | 3, 4, 8 |
  | §5 core block and cost | 2, 5, 6, 8 |
  | §6 Impeccable telemetry | 5, 8 |
  | §6 taste-skill | Owner actions, Planning check 2 |
  | §6 asking wins | 2 |
  | §7 skills | 2 |
  | §8 builder | 14 |
  | §8 targets and global writes | 11, 12, 13 |
  | §8 validation | 1, 14 |
  | §9 harness git | 9 |
  | §9 guard | 10 |
  | §9 attribution | 5, Planning check 1 |
  | §9 identity | 1, 9 |
  | §10 update, off, uninstall | 6, 7, 13 |
  | §11 tests | spread as listed |
  | §12 order (PR-size first) | Precondition |

  §2's "Out" items are respected: no own skills, no caveman, no i18n, no registry, no team memory, no stored identity, no reviewer change.
- **Types:** these names are used the same way in every task that touches them: `LoadedPreset`, `PresetGit`, `presetRows`, `presetSets`, `SetBlock`, `mergePresetSettings`, `config.preset.items` and `GLOBAL_STATE`.
- **Proportion:** there are no function bodies. Exact copy appears only where the spec fixes it, or where a test asserts it.

## Owner questions

1. **superpowers telemetry** (Planning check 4). The options:
   - (a) Recommended: in Task 2, add `superpowers` to `telemetry_off`, and have `presetSets` also write `SUPERPOWERS_DISABLE_TELEMETRY`. Its value is read from the pinned superpowers README in that task, and is never guessed.
   - (b) Keep the spec as is, and have the README say that superpowers' optional visual companion has its own opt-out.
   - (c) Leave superpowers out of the preselects.
