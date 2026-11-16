# Guard and protect overlap with Claude Code's native permission rules (CC10-0)

Date: 2026-11-16. Base: `origin/main` `49d4184`. Docs only.

**Question.** Which guard and protect decisions can Claude Code's own `deny`/`ask` rules express? The owner's decision: generate a native rule wherever one can express the check, and keep code only for what rules can't express. This audit sets the CC10-1 and CC10-2+ PRs.

**Scope.** Every `deny` and `ask` in `src/checks/guard*.ts`, `protect.ts`, `decisions-protect.ts`, `gh-writes.ts` and `mcp-writes.ts`, plus the parser modules they use (`src/core/command-head.ts`, `options.ts`, `shell-words.ts`). The forms come from `test/checks/guard.test.ts`, `protect*.test.ts`, `gh-writes.test.ts`, `mcp-writes.test.ts` and `decisions-protect.test.ts`.

**Sources.** Fetched on 2026-11-16: [permissions](https://code.claude.com/docs/en/permissions) (cited as *perm*), [permission-modes](https://code.claude.com/docs/en/permission-modes) (*modes*), [sandboxing](https://code.claude.com/docs/en/sandboxing) (*sbx*) and [settings](https://code.claude.com/docs/en/settings) (*set*). Anything the docs don't cover is marked **unverified, needs live check**.

## Native facts this audit uses

| # | Fact | Source |
|---|---|---|
| N1 | Rules are checked deny first, then ask, then allow, and the first match wins. "An allow rule can't carve an exception out of a deny rule", and "a matching ask rule prompts even when a more specific allow rule also matches". | *perm*, Manage permissions |
| N2 | A hook can't lift a rule. "a matching ask rule still prompts even when the hook returned `"allow"`". A blocking hook still beats allow rules. | *perm*, Precedence among rules, hooks, and mods |
| N3 | Deny and ask rules apply to every subcommand, including subshells, command substitutions and control-flow bodies. The separators are `&&`, `\|\|`, `;`, `\|`, `\|&`, `&` and newline. | *perm*, Compound commands |
| N4 | Before matching, Claude Code strips the wrappers `timeout`, `time`, `nice`, `nohup` and `stdbuf`, the builtins `command` and `builtin`, zsh's `noglob`, and bare `xargs`. `xargs -n1` is not stripped. Neither are `direnv exec`, `devbox run`, `mise exec`, `npx` or `docker exec`. Deny and ask rules match past any leading assignment. | *perm*, Wrappers |
| N5 | A rule "doesn't match the same program invoked in a different form": `/usr/bin/curl`, `sh -c '…'`, `git -C . push` and `git -c k=v push`. Rules are "not a security boundary"; for that, use the sandbox or a PreToolUse hook. | *perm*, What a Bash rule doesn't match |
| N6 | In a Bash rule, `*` matches any text, spaces included. A trailing ` *` also matches the bare command, and the space before it is part of the rule. Bash rules have no character classes and no negation. | *perm*, Wildcard patterns |
| N7 | Read and Edit deny rules cover the file tools, the Bash file commands Claude Code recognises (`cat`, `head`, `tail`, `sed`, `tee`) and redirect targets. They don't cover `grep -r pattern .` or a script that opens files itself. A Read deny also blocks Edit and Write on the same path. NotebookEdit is not covered. | *perm*, What Read and Edit rules cover |
| N8 | A Read deny applies "best-effort" to Grep and Glob. As an ask rule, `Read(docs/**)` doesn't prompt "when a search of a working directory above it returns matching files". | *perm*, Write/Glob/Grep rules don't match |
| N9 | A Read deny also applies to `@` mentions, IDE selection and open-file context, pasted image paths and `@`-directory listings. | *perm*, What Read and Edit rules cover; Attachments through a symlink |
| N10 | Paths use gitignore syntax. `//` is absolute, `~/` is home, `/` is the settings source and `./` is the cwd. A deny on a bare name or a single directory segment matches at any depth. A `!` pattern carves out of earlier `./` rules in the same file only, and can't reach `~/` or `//` rules. A deny matches either the requested path or the path it resolves to through symlinks. The docs don't say whether matching is case-insensitive on macOS (**unverified**). | *perm*, How path patterns match; Special characters; Symlinks |
| N11 | Deny and ask rules accept tool-name globs that must match the whole name (`mcp__*`). An `mcp__` rule with parentheses is skipped. The docs don't say whether these globs are case-sensitive (**unverified**). | *perm*, Tool name wildcards; MCP |
| N12 | Ask rules prompt in `auto`, are denied in `dontAsk`, and still prompt in `bypassPermissions`. Deny rules block in every mode. | *modes* (bypass, dontAsk and auto sections) |
| N13 | PowerShell rules have the same shape, are matched case-insensitively per AST subcommand, and canonicalise aliases. The docs don't say whether Read and Edit deny rules apply to PowerShell file cmdlets (**unverified**). | *perm*, PowerShell |
| N14 | Read and Edit deny rules are "merged into the final sandbox configuration". The page doesn't say that an Edit deny becomes a `denyWrite` entry. `docs/research/2026-11-14-isolation.md:115` quoted it as doing so. | *sbx*, Permission rules |
| N15 | Deny and ask rules in `.claude/settings.json` "apply right away", before workspace trust. | *set*, A committed key doesn't reach teammates |

## Findings beyond the row table

- **F1. An existing rule contradicts guard's own advice.** `Bash(git push *--force*)` (`templates/settings.fragment.json:25`) matches `git push --force-with-lease origin feat` by N6. Guard allows that form (`guard.ts:426`, test `destructive commands`), and its deny message tells Claude to use it. Per the docs, Claude Code denies it first. **Unverified, needs live check** (L6). See Q1.
- **F2. Existing rules are stricter than guard on `.env.example`.** `Read(./.env.*)` and `Read(./**/.env.*)` deny `.env.example`, while guard's `SAFE_EXAMPLE` (`guard.ts:26,415`) allows it. See Q2.
- **F3. Edit deny rules and the sandbox give conflicting evidence.** The fragment denies `Edit(./.harness/logs/**)`, `reviews/**` and `verdicts/**`. `DENY_WRITE_SKIPPED` (`protect.ts:33`) says sandboxed Bash must be able to write those paths, and its comment says "protect's text check and the Edit deny rule still guard it". If an Edit deny becomes `denyWrite` (N14), harness's own writes to those paths fail with EPERM. **Unverified, needs live check** (L1). This blocks every new `Edit(...)` deny below. Two cases are certain to break if the merge is real: an Edit deny on `.git/**` breaks git, and one on `node_modules/**` breaks installs.
- **F4. A native rule can only add, never subtract.** A hook "allow" can't lift a native rule (N2). A rule broader than the code turns allowed calls into prompts or denials. A narrower one only adds coverage. Every rule proposed below is checked against that.
- **F5. Read denies reach beyond Claude.** They block the person's `@` mentions and IDE context (N9). Through the sandbox merge, they also block sandboxed processes from reading those paths: test fixtures, dev TLS certificates, and ssh or git reading `~/.ssh`. That last effect is inferred from N14 and *sbx* "Permission rules". On Linux, a sandbox `**/*.pem` pattern covers nothing (`docs/research/2026-11-14-isolation.md:112`).
- **F6. Native rules cover tools harness doesn't hook.** Glob isn't in the PreToolUse matcher, but a native Read deny covers it (N8). Native denies also follow symlinks (N10), and `decidePaths` doesn't.
- **F7. Where native rules add protection.** Bash and the edit tools stay fail-closed under CC1 R1, so a missing `node` blocks them anyway. Read, Grep and MCP become fail-open under CC1, and native rules still hold there (N15, plan Q2). Native rules also still apply under `checks.guard: false`.
- **F8. Moved decisions leave harness's records.** A native denial never reaches harness's event log (`.harness/logs/events.jsonl`, used by `harness report`). Deleting code therefore also drops those denials from the log.

## Row table

Columns:
- **Expr** is how much a native rule can express: **F** full, **P** partial, **N** none.
- **Verdict** follows the plan: **R+K** (rule + keep code), **R+D** (rule + delete code), **C** (code only).
- **PR** is the PR group (see the PR list).

| ID | Check and reason (file:line) | Forms the code catches | Native rule text | Expr | Forms the rule misses (bypass example) | Verdict | PR |
|---|---|---|---|---|---|---|---|
| G1 | Secrets read, Read tool (`guard.ts:685-690,1179`; `sensitivePath` 399-423) | `.env*` except `.example/.sample/.template/.dist`; `.ssh/**` except `.pub`; `.aws/credentials\|config`; `id_rsa` and similar; `*.pem/p12/pfx/keystore`; `.netrc`; `.pgpass`; `*.tfstate*`; `*.tfvars`; any case; Windows `C:\`, 8.3 names (`ENV~1`), NTFS streams, trailing dots; `host:path` | Existing `Read(./.env)` and three siblings. Q3 A adds in-project `Read(**/id_rsa)`, `Read(**/id_ed25519)`, `Read(**/id_ecdsa)`, `Read(**/id_dsa)`, `Read(**/*.p12)`, `Read(**/*.pfx)`, `Read(**/*.keystore)`, `Read(**/*.tfstate)`, `Read(**/*.tfstate.*)`, `Read(**/*.tfvars)`, `Read(**/.netrc)` and `Read(**/.pgpass)`; `*.pem` and home paths only under Q3 B | P | `/proj/.ENV` on macOS (case, L2); `C:\proj\ENV~1`; `.env::$DATA`; `~/.ssh/id_rsa` and `x.pem` under Q3 A | R+K | 1 |
| G2 | Secrets search, Grep tool (`guard.ts:1180-1184`) | `path` or `glob` naming a secret, brace alternatives, wildcards dropped (`.e*v` is a known miss) | Same Read rules (N8, best-effort) | P | Grep with `path: "."` and `glob: ".env"`: a search above the file isn't matched (N8) | R+K | 1 |
| G3 | Secrets named in a Bash command (`guard.ts:995`) | Any token naming a secret path: `cat .env`, `node --env-file=.env x.js`, `scp host:secret.pem .` | Read rules cover `cat`/`head`/`tail`/`sed`/`tee` and `<` (N7) | P | `node --env-file=.env x.js`; `python -c 'open(".env")'`; `grep -r KEY .` (N7) | R+K | 1 |
| G4a | `harness tdd off` deny (`guard.ts:94,997`) | Real invocation past wrappers, runners, `CMD=harness`, a cli.mjs path, globs | `Bash(harness tdd off*)`, `Bash(npx @khubaibqaiser/harness tdd off*)` | P | `node dist/cli.mjs tdd off`; `sh -c 'harness tdd off'`; `sudo harness tdd off` (N4, N5) | R+K | 1b |
| G4b | `harness eval` deny, paid (`guard.ts:106`) | Any eval except `--help` | none (a deny also blocks `--help`, F4) | N | n/a | C | none |
| G4c | `harness task` approve, edit or close deny (`guard.ts:107`) | Every task subcommand but `draft` | `Bash(harness task approve *)` | P | `harness task close …`, any spelling in G4a | R+K | 1b |
| G4d | init, update, add, remove, sync, uninstall ask (`guard.ts:95-100`) | A non-preview run; a preview (`--dry-run`, `--check`, `--plan`) is allowed | none (an ask also prompts on previews, N2, F4) | N | n/a | C | none |
| G4e | `harness git` push or pr, preset install, context apply, report ask (`guard.ts:101-104`) | As G4d: per-subcommand allow-lists | none (same reason) | N | n/a | C | none |
| G4f | remember ask (`guard.ts:105,1172-1173`; `remember.ts`) | `remember add` with a quote check | none (content-based) | N | n/a | C | none |
| G5 | Hidden harness command deny (`guard.ts:238,303-329`) | `$X tdd off`, `eval` near harness, `function harness {…}`, `` `…` tdd `` | none | N | n/a | C | none |
| G6 | Built subcommand ask (`guard.ts:315-318`) | `xargs harness`, `harness t{d,}d off`, `"$@"` | none | N | n/a | C | none |
| G7 | Backstop ask (`guard.ts:374-384`) | Text naming harness plus `tdd off` or a change word | none (text scan, not command matching) | N | n/a | C | none |
| G8 | npm script chain too deep ask (`guard.ts:240`) | `pre`, `post` and nested scripts more than 3 deep | none | N | n/a | C | none |
| G9 | Deleting a test file in a TDD path deny (`guard.ts:1003-1005`) | `rm` of a test file under `tdd.paths` | none (paths come from config) | N | n/a | C | none |
| G10 | Recursive delete of root, home, `.` or `..` deny (`guard.ts:479`) | `rm -rf /`, `~`, `.`, `C:\`, `/c/`, `$USERPROFILE`; `rimraf` via runners | `Bash(rm -rf /)`, `Bash(rm -rf ~)`, `Bash(rm -rf .)`, `Bash(rm -rf ..)` (no `rm -rf /*`: by N6 it would also deny `rm -rf /tmp/x`, which the code only asks about, F4) | P | `rm -r -f /`; `rm -fr /`; `/bin/rm -rf /`; `npx rimraf /` (N5, N6) | R+K | 1b |
| G11 | Recursive delete outside build folders ask, and `xargs rm` ask (`guard.ts:477,480`) | `rm -rf src/old`; `… \| xargs rm -rf` | none (an allow-list of targets can't be written as an ask, N1) | N | n/a | C | none |
| G12 | Push to main or master deny, `+` refspec deny (`guard.ts:485-495`) | `git push origin main`, `HEAD:main`, `refs/heads/main`, `+x`; `git -C dir push`; quoted separators | Existing 12 Bash and 12 PowerShell rules (`settings.fragment.json:25-30`) | P | `git -C . push origin main` (N5); `git push origin "$B"` | R+K | existing |
| G13a | Force push deny (`guard.ts:426`) | `--force`, `-f`, not `--force-with-lease` | Existing `*--force*`, which also denies `--force-with-lease` (F1); proposed `Bash(git push --force)`, `Bash(git push --force *)`, `Bash(git push * --force)`, `Bash(git push * --force *)` | P | `git -c x=y push -f`; `git push -uf` (`docs/specs/2026-11-03-platform-enforcement-design.md:63`) | R+K | 1, Q1 |
| G13b | `curl \| sh` deny (`guard.ts:427`) | A download piped into a shell | none: rules match each subcommand on its own (N3), so "a pipe into sh" can't be written | N | n/a | C | none |
| G13c | `chmod 777` deny (`guard.ts:428`) | `chmod 777`, `chmod -R 0777` | `Bash(chmod 777 *)`, `Bash(chmod * 777 *)`, `Bash(chmod 0777 *)`, `Bash(chmod * 0777 *)` | P | `sudo chmod 777 x`; `/bin/chmod 777 x` | R+K | 1b |
| G13d | `dd of=/dev/…` deny (`guard.ts:429`) | `dd if=x of=/dev/disk2` | `Bash(dd * of=/dev/*)` | P | `sudo dd …`; `sh -c 'dd …'` | R+K | 1b |
| G14 | Shell write into a TDD path ask (`guard.ts:1010-1012`) | Redirects, `tee`, `sed -i` and more into `tdd.paths` | none (paths come from config) | N | n/a | C | none |
| G15 | Dependency add deny, dep-verify ask (`guard.ts:520-537`) | `pnpm add x`, `npm i x`, `uv add`, `pip install x`; not lockfile installs; `AGENT_GUARD_ALLOW_INSTALL` switches it to the registry check | none: an ask or deny on `npm install *` also hits `npm install` with no package (F4), and the env switch can't be expressed | N | n/a | C | none |
| G16 | Preset git asks: AI trailer, branch prefix (`guard.ts:1115-1124`) | Commit trailer text; branch name without a listed prefix | none (content-based) | N | n/a | C | none |
| G17 | gh and hub writes ask (`guard.ts:1049-1076`; `gh-writes.ts:57-82`) | Anything but a known read, including `gh api` with fields, `-X`, or a graphql mutation; gh extensions and aliases; hub passthrough | Asks for known writes: `Bash(gh pr merge *)`, `Bash(gh pr close *)`, `Bash(gh pr review *)`, `Bash(gh pr comment *)`, `Bash(gh issue close *)`, `Bash(gh issue comment *)`, `Bash(gh release create *)`, `Bash(gh workflow run *)`, `Bash(gh run rerun *)`, `Bash(gh secret set *)`, `Bash(gh variable set *)`, and `gh api` with `-X` or `--method` set to `POST`, `PATCH`, `PUT` or `DELETE`, flag before or after the path (not `-X GET`: the code allows it, F4) | P | `gh -R o/r pr merge 1`; `gh api repos/o/r/pulls -f title=x` (POST by fields); an extension; `op run -- gh pr merge` | R+K | 1b |
| G18 | GitLab merge-request push option ask (`gh-writes.ts:84-103`) | `-o merge_request.create`, `--push-option=`, `-c push.pushOption=` | `Bash(git push * -o merge_request.*)`, `Bash(git push * --push-option=merge_request.*)` | P | `git push -omerge_request.create`; `git -c push.pushOption=merge_request.create push` | R+K | 1b |
| G19 | refs/remotes and remote config writes ask (`gh-writes.ts:147-195`) | `update-ref refs/remotes/*`, `remote add` or `set-url`, `config remote.*.url`, fetch refspecs with a destination, plumbing, aliases | `Bash(git update-ref refs/remotes/*)`, `Bash(git remote add *)`, `Bash(git remote set-url *)`, `Bash(git config remote.* *)` (with a value only: the code allows a plain get, F4) | P | `git -c remote.origin.url=x fetch`; an alias; `git fetch origin x:refs/remotes/o/y` | R+K | 1b |
| G20a | `git reset --hard` ask (`guard.ts:433`) | `git reset --hard …` | `Bash(git reset --hard *)` | P | `git -C . reset --hard` (N5) | R+K | 1b |
| G20b | `git clean -f` ask (`guard.ts:434`) | `-f`, `-fd`, `-xdf` | `Bash(git clean -f*)`, `Bash(git clean -df*)`, `Bash(git clean -xf*)`, `Bash(git clean -xdf*)`, `Bash(git clean -dxf*)` | P | `git -C . clean -f`; `sh -c 'git clean -fd'` | R+K | 1b |
| G20c | Discard all with `checkout .` or `restore .` ask (`guard.ts:435`) | `git checkout .`, `git checkout -- .`, `git restore .` | `Bash(git checkout .)`, `Bash(git checkout -- .)`, `Bash(git restore .)` | P | `git -C . checkout .`; `sh -c 'git restore .'` | R+K | 1b |
| G20d | `git branch -D` ask (`guard.ts:436`) | `git branch -D x` | `Bash(git branch -D *)` | P | `git -C . branch -D x` | R+K | 1b |
| G20e | `sudo` ask (`guard.ts:437`) | `sudo` at a command start | `Bash(sudo *)` | P | `/usr/bin/sudo x`; `command -p sudo x` | R+K | 1b |
| G20f | Publish ask (`guard.ts:438`) | `npm`, `pnpm` or `yarn` `publish`/`unpublish` | `Bash(npm publish *)`, `Bash(pnpm publish *)`, `Bash(yarn publish *)`, `Bash(npm unpublish *)` | P | `npx npm publish`; `sh -c 'npm publish'` | R+K | 1b |
| G20g | `cdk deploy` or `destroy` ask (`guard.ts:439`) | `cdk deploy`, `cdk destroy` | `Bash(cdk deploy *)`, `Bash(cdk destroy *)` | P | `npx cdk deploy` (N4) | R+K | 1b |
| G20h | `terraform apply` or `destroy` ask (`guard.ts:440`) | Both | `Bash(terraform apply *)`, `Bash(terraform destroy *)` | P | `/opt/homebrew/bin/terraform apply` | R+K | 1b |
| G20i | Destructive AWS CLI ask (`guard.ts:441-442`) | Any `aws` call with `delete`, `terminate`, `remove` or `rb`; `s3 rm --recursive` | `Bash(aws * delete*)`, `Bash(aws * terminate*)`, `Bash(aws * remove*)`, `Bash(aws s3 rb *)`, `Bash(aws s3 rm *)` | P | `aws-vault exec p -- aws ec2 terminate-instances …`; `sudo aws s3 rb …` | R+K | 1b |
| G20j | `kubectl delete` ask (`guard.ts:443`) | `kubectl delete` | `Bash(kubectl delete *)` | P | `/usr/local/bin/kubectl delete pod y`; `sudo kubectl delete …` | R+K | 1b |
| G20k | Docker prune ask (`guard.ts:444`) | `docker system\|volume\|image prune` | `Bash(docker system prune*)`, `Bash(docker volume prune*)`, `Bash(docker image prune*)` | P | `/usr/bin/docker system prune` | R+K | 1b |
| G20l | `gh repo` or `release delete` ask (`guard.ts:445`) | Both | `Bash(gh repo delete *)`, `Bash(gh release delete *)` | P | `gh -R o/r release delete v1` | R+K | 1b |
| G20m | `vercel --prod` ask (`guard.ts:446`) | `vercel … --prod` | `Bash(vercel *--prod*)` | P | `npx vercel --prod` | R+K | 1b |
| G20n | SQL `DROP` ask (`guard.ts:447`) | `drop table\|database\|schema` anywhere in the text, any case | none (it is a text match inside arguments; `Bash(*drop table*)` is case-sensitive and over-matches, F4) | N | n/a | C | none |
| G21 | Parser limits (`guard.ts:854,865,892,904,907,910,915,916,917`; `shell-words.ts:15`) | Nesting deny, work-budget deny; scan-budget, glob-cap, glob-head, editor, splice, `${x:-…}`, fed-shell and builds-words asks | none (native asks only on parse failure for allow purposes, in Manual mode: *perm*, Read-only commands) | N | n/a | C | none |
| G22 | Git output written to a run file or into `.git` config deny (`guard.ts:875-876`) | `git log … > x.sh; sh x.sh`; output into `.git/hooks` | none | N | n/a | C | none |
| G23 | PowerShell naming `.harness`, `.claude` or `.env` ask (`guard.ts:1175-1177`) | Any PowerShell text containing them, any case | `PowerShell(*.harness*)`, `PowerShell(*.claude*)`, `PowerShell(*.env*)` (case-insensitive, N13) | P | Text outside any AST command, such as an assignment `$p = '.env'` (**unverified**, L5) | R+K | 1b, Q6 |
| P1 | Edit, Write, MultiEdit or NotebookEdit on a protected path deny (`protect.ts:19,780`) | `PROTECTED` globs; `.harness` and `.claude` themselves; case-insensitive; symlinks resolved to the repo; work-folder exemption under `.harness/tmp/<id>` | Existing 11 `Edit(./.harness/…)` rules; `results/**`, `apply.lock` and `tmp/**` aren't added: `results` must stay writable from sandboxed Bash (F3) and `tmp` holds the work folders | P | `.HARNESS/config.yaml` on macOS (L2); `.harness/results/x` | R+K | existing |
| P1s | The same for `.claude/settings*.json` (`protect.ts:19`) | Today: any edit. After CC6 (R12): only a weakening edit | Existing `Edit(./.claude/settings*.json)` rules; CC6 retires them | N after CC6 | content-based (R11) | C | CC6 |
| P2 | Edit tool into `node_modules` deny (`protect.ts:729`) | Any `node_modules` segment, any case | `Edit(node_modules/**)` would express it, but an Edit deny may become `denyWrite` and break installs (F3) | P | case (L2) | C | none (until L1) |
| P3 | Edit tool on git state deny (`protect.ts:730`) | `.git/config`, `HEAD`, `packed-refs`, `refs/**` | `Edit(./.git/config)` and similar would express it, but they may block git's own writes from sandboxed Bash (F3; comment at `protect.ts:701-703`) | P | case (L2) | C | none (until L1) |
| P4 | Bash write to a protected path deny (`protect.ts:756-757,769`) | Redirects, `tee`, `cp`/`mv`/`rm`, `sed -i`, `tar -C`, `find -delete`, `git restore` of the tree, globs, `cd` folders, wrappers, path heads | Existing Edit rules cover `>`, `tee` and `sed` targets (N7) | P | `cp x .harness/config.yaml`; `python -c …`; `cd .harness && echo > config.yaml` | R+K | existing |
| P5 | Bash or inline code writing `node_modules` deny (`protect.ts:745-746`) | Shell writes; `node -e` naming `node_modules` | none (F3) | N | n/a | C | none |
| P6 | Inline code naming a harness path deny (`protect.ts:749`) | `node -e`, `python -c`, `tsx -e` naming `.harness` or `.claude/settings` | none (N7: scripts aren't covered) | N | n/a | C | none |
| P7 | Bash write to git state deny (`protect.ts:762`) | Redirects or `cp` into `.git/refs` or `.git/config` | none (F3) | N | n/a | C | none |
| P8 | Link-placing command into `.harness/tmp` ask (`protect.ts:769`) | `ln`, `cp`, `tar` and more on a line writing a work folder | none | N | n/a | C | none |
| P9 | Editor on a protected file ask (`protect.ts:771`) | `vim`, `ex`, `sudoedit` and similar on a protected path | none: native rules don't know editors; an Edit rule covers only `sed`/`tee`/redirects (N7) | N | n/a | C | none |
| P10 | Unresolved `cd` ask (`protect.ts:772`) | `cd $X`, `cd -`, `cd ~` before a relative write | none (native asks on `cd` with a redirect only in Manual mode: *perm*, Read-only commands) | N | n/a | C | none |
| P11 | Built protected path ask (`protect.ts:776`) | `p=.harness/x; tee $p`, globs, `source`, functions | none | N | n/a | C | none |
| P12 | Ref move that changes protected files ask, deny when unattended (`protect.ts:357-414`) | `checkout`, `switch`, `reset --hard`, `merge`, `rebase`, `pull`, `stash`; a switch to a ref with no hooks | none (needs a git diff at call time) | N | n/a | C | none |
| P13 | Nesting deny (`protect.ts:735`) | Shells nested more than 4 deep | none | N | n/a | C | none |
| P14 | Path-head and glob-head asks (`protect.ts:806-807`) | `./bin/tee .harness/x`, `t?e .harness/x` | none (N5) | N | n/a | C | none |
| D1 | Team decision write deny (`decisions-protect.ts:225-230`) | Writes to existing decision files and `.claude/rules/harness-decision-*.md`; removal of the folders | `Edit(./.claude/rules/harness-decision-*.md)` covers only the rules part; `docs/decisions` depends on content; the CLI writes there from Bash (F3) | P | a decision file in `docs/decisions/` | C | none |
| D2 | Becomes-decision ask (`decisions-protect.ts:171,190-199`) | An edit that adds decision frontmatter | none (content-based) | N | n/a | C | none |
| D3 | Editor on a decision ask (`decisions-protect.ts:219-222`) | `vim docs/decisions/x.md` | none | N | n/a | C | none |
| M1 | MCP auto-merge deny (`mcp-writes.ts:33`) | Any tool whose words hold automerge with a write verb or no read verb first, on any server | Exact names: `mcp__ccd_pr__set_auto_merge`; a glob option is in Q4 | P | another server's auto-merge tool not on the list; case (L4) | R+K | 1, Q4 |
| M2 | Git-host MCP write ask (`mcp-writes.ts:36-39`) | A write verb on a GitHub, GitLab or similar server, or on a tool naming a PR or gist; on an opaque server, any write verb | none: an ask on `mcp__github__*` also hits reads, and a hook can't lift it (N2, F4) | N | n/a | C | none |

### Parser and helper modules (no decisions of their own)

| Module | Serves | Verdict |
|---|---|---|
| `src/core/shell-words.ts` (277 lines), `command-head.ts` (228), `options.ts` (68) | Every code-only and R+K Bash row above, plus P4 to P14 | Keep: every row that uses them keeps code |
| `src/checks/guard-base.ts` (726) | Frozen 9b1e516 decision for non-canonical text (`guard.ts:853-859`) | Keep while G-rows keep code |
| `guard-readings.ts`, `guard-scan.ts`, `guard-sinks.ts`, `guard-allow.ts`, `guard-reruns.ts` | Readings, the heredoc and message data exemption, glob readings | Keep |

## Counts

The table has 64 decision rows:
- full: 0;
- partial: 33;
- none: 31. P1s counts as none, because after CC6 it is judged by content.

By verdict:
- rule + keep code: 30. Three of these, G12, P1 and P4, are already covered by the rules in today's fragment.
- rule + delete code: 0;
- code only: 34. This includes P2, P3 and D1: a rule could express part of each, but it would hit the sandbox merge (F3).

That confirms the plan's expectation, and goes one step further: no row qualifies for "rule + delete code" today. The file-tool rows (G1, G2, P1 to P3) were the only candidates, and each misses a form the code catches. G1 and G2 miss case, Windows short names and streams, and the Grep `glob` parameter. P1 to P3 miss case, and P2 and P3 also hit the sandbox merge. Deletes can only follow live checks L1 and L2 and the owner's answers to Q5 and Q6.

## Rules that change what a person sees

- Every home-directory or `**/*.pem` Read deny (G1, Q3). It blocks `@` mentions, IDE context and pasted paths (N9). Through the sandbox it also blocks sandboxed processes from reading the files (F5).
- Changing the force-push rule (Q1). `--force-with-lease` then starts to pass natively.
- A `.env.example` carve-out (Q2). Claude may then read example env files.
- Native ask rules (group 1b) prompt in `bypassPermissions` (N12). Today harness denies in that mode, because it treats bypass as unattended. That shows only for forms the code misses, since the hook denies first.
- Any delete (Q5, Q6). The deny message becomes Claude Code's, and the denial no longer appears in harness's event log (F8).

## Live checks needed before CC10-1 merges

Run with the owner's yes, per batch.
- **L1.** Does `Edit(./x/**)` in `.claude/settings.json` make sandboxed Bash fail to write `x/`? Try `.harness/logs` with the current fragment (F3).
- **L2.** Is Read and Edit rule matching case-insensitive on macOS (`.ENV`, `.HARNESS/config.yaml`)?
- **L3.** Does `Read(!**/.env.example)` after `Read(./**/.env.*)` in the same file re-open `.env.example`?
- **L4.** Are tool-name globs (`mcp__*__*auto*merge*`) case-sensitive?
- **L5.** Does `PowerShell(*.env*)` match an assignment `$p = '.env'; Get-Content $p`? Do Read deny rules cover `Get-Content .env`?
- **L6.** Is `git push --force-with-lease origin feat` denied by the current `Bash(git push *--force*)`?
- **L7.** In `claude -p` with no permission prompt tool, does a native ask become a denial?

## PR list

| PR | Branch | Content | Est. non-test lines, files | After |
|---|---|---|---|---|
| CC10-1 | `feat/cc10-native-rules` | `{"ask": r}` merge blocks mirroring deny (`merge.ts`), `harnessAskRules` (`harness-files.ts`), weakening on removal (`settings-weaken.ts`), uninstall, docs and release note; plus the G1 in-project Read denies per Q3, M1 per Q4, and the F1 force-push fix per Q1 (an update drops the old rules via R13's `removeSets`) | about 140, 8 | CC10-0 approved; CC6 (fragment, merge); L1, L2, L6 |
| CC10-1b | `feat/cc10-bash-ask-rules` | Fragment-only Bash and PowerShell rules for G4a, G4c, G10, G13c, G13d, G17 to G20m and G23, about 70 rules; the table test `each generated rule matches its row's canonical form`; README limits line | about 90 (mostly fragment JSON), 4 | CC10-1; L5, L7 |
| CC10-2+ | `refactor/cc10-*` | None proposed. Possible only on Q5 = B (delete the G1/G2 Read and Grep branch and drop `Read\|Grep` from the matcher: about 25 lines, 3 files) or Q6 = B (delete the G23 PowerShell ask: about 10 lines, 2 files). Each runs the guard compare with the native rule as a pre-filter, and the result must be `0 looser than base`. | 0, or about 35, 5 | CC9c; guard token; L2, L5 |

## Owner questions

**Q1 (G13a, F1). Should the force-push deny let `--force-with-lease` through?** The current `Bash(git push *--force*)` also denies `--force-with-lease`, which guard allows and recommends.
- **A (recommended): replace it with token-bounded rules.** These are `git push --force`, `git push --force *`, `git push * --force` and `git push * --force *`, in Bash and PowerShell. Why: the native rule and guard then agree, and guard still denies `--force`. Moving loosens the native layer for `--force-with-lease` only.
- **B: keep the current rule.** Why: the native layer stays stricter. Guard's message then points Claude at a form Claude Code denies.

**Q2 (G1, F2). Should the native `.env` rules carve out `.env.example`, `.sample`, `.template` and `.dist`?**
- **A (recommended): add `!` carve-outs in the same file, after L3 confirms they work.** Why: it matches guard's `SAFE_EXAMPLE`, and Claude can read example env files that teams commit for this purpose. It loosens today's native rule.
- **B: keep native stricter than guard.** Why: no loosening. Example env files stay unreadable to Claude's file tools.

**Q3 (G1). Which secret paths get native Read denies?**
- **A (recommended): in-project only.** These are `**/id_rsa`, `**/id_ed25519`, `**/id_ecdsa`, `**/id_dsa`, `**/*.p12`, `**/*.pfx`, `**/*.keystore`, `**/*.tfstate*`, `**/*.tfvars`, `**/.netrc` and `**/.pgpass`, with no `**/*.pem` and no home rules. Code keeps home paths and `.pem`. Why: `~/.ssh/**` would block your own `@` mentions, `.pub` files (a `!` can't carve out of a `~/` rule, N10) and, through the sandbox, ssh and git over ssh. `*.pem` would block test fixtures and dev TLS certificates in sandboxed test runs (F5).
- **B: also `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/credentials`, `~/.aws/config` and `**/*.pem`.** Why: the most coverage when the hook fails open (CC1 Q2), but with the side effects above.
- **C: `.env` only, as today.** Why: no new side effects. CC1's fail-open then leaves the other secret paths code-only.

**Q4 (M1). How wide is the native auto-merge deny?**
- **A (recommended): exact tool names only** (`mcp__ccd_pr__set_auto_merge`, plus any you name). Why: no false denial. Code keeps the general word rule.
- **B: globs** `mcp__*__*auto_merge*`, `mcp__*__*automerge*` and `mcp__*__*AutoMerge*`. Why: they cover unknown servers even when the hook fails open. They also deny read tools such as `get_automerge_config` (code allows those; a hook can't lift a deny, N2), and case handling is unverified (L4).

**Q5 (G1, G2). Should the Read and Grep secrets code go, and `Read|Grep` leave the PreToolUse matcher (review row 4, perf)?**
- **A (recommended): keep the code.** Why: native rules miss case on macOS (unverified), Windows short names and streams, and the Grep `glob` parameter, and their denials don't reach harness's event log.
- **B: delete after L2.** Why: one fewer Node spawn on every Read and Grep. It loosens the forms above.

**Q6 (G23). Should the PowerShell text ask be deleted once the native `PowerShell(*.harness*)`-style rules are in?**
- **A (recommended): keep both.** Why: the native rule covers the code's forms only if L5 passes. Under `bypassPermissions`, the code denies while a native ask prompts.
- **B: delete after L5.** Why: less code. A person in bypass mode then sees a prompt instead of a denial, the message wording changes, and the denials leave the event log.
