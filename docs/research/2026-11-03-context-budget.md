# Context budget: research note (2026-11-03)

Input for [`../specs/2026-11-03-context-budget-design.md`](../specs/2026-11-03-context-budget-design.md). Sources fetched 2026-11-03. Claude Code docs are cited by page name: `context-window`, `features-overview`, `memory`, `skills`, `sub-agents`, `mcp`, `hooks`, `commands`, `plugins/loading` (all under https://code.claude.com/docs/en/). The token-counting page is https://platform.claude.com/docs/en/build-with-claude/token-counting ("TC"). Facts from the earlier memory research (`docs/research/2026-11-03-memory.md`, on the local branch `docs/memory-spec`, which isn't pushed) are marked [mem]. I didn't read the changelog for this note; version floors below come from the docs pages.

## 1. What loads at session start

| Source | When it loads | Source |
|---|---|---|
| CLAUDE.md and CLAUDE.local.md in the working directory and the directories above it | At launch, in full (up to 4 MiB; a larger file is skipped) | memory |
| `@path` imports | With the file that imports them. Paths are relative to the importing file, up to four hops deep. Imports "don't reduce its context cost" | memory |
| Block-level HTML comments in CLAUDE.md | Stripped before injection. Comments inside code blocks are kept | memory |
| AGENTS.md | Read directly only when there is no CLAUDE.md or CLAUDE.local.md in the working directory or above it (needs v2.1.277). Otherwise only through an `@AGENTS.md` import, and it is never read twice. A **Project instructions** setting changes this; it is read from user, `--settings` or managed settings only | memory |
| `.claude/rules/**/*.md` without `paths` | At launch, with the same priority as `.claude/CLAUDE.md`. "All `.md` files are discovered recursively" | memory |
| Skill listing | Every model-invocable skill's name and description, on every request. `description` plus `when_to_use` is cut at 1,536 characters. The whole listing has a budget that "scales at 1% of the model's context window"; over it, descriptions of the least-used skills are dropped. `disable-model-invocation: true` keeps a description out of context. `skillOverrides` (`on`, `name-only`, `user-invocable-only`, `off`) does the same from settings, but "Plugin skills are not affected by `skillOverrides`" | skills, features-overview |
| Subagent descriptions | They "take up context". There is a startup warning above 15,000 tokens of combined custom descriptions, but every agent still loads | sub-agents |
| MCP | With tool search (the default): "Only tool names and server instructions load at session start". Full schemas are deferred. Server instructions are cut at 4,096 characters | mcp, features-overview |
| Auto memory | The first 200 lines or 25 KB of `MEMORY.md` | memory |
| Output style, system prompt, git status | Every request | context-window, features-overview |
| Hooks | Nothing, "unless the hook returns additional context" | features-overview |

## 2. What loads on demand

- **Path-scoped rules** (`paths:` frontmatter) load when Read, Write or Edit touches a match, or a Bash `cat` or `head` of one file. Each pattern is relative to the folder that holds the rule's `.claude` (memory).
- **Nested CLAUDE.md** loads when Claude reads, writes or edits a file in that subdirectory (memory).
- Files that load on demand are cut at 40,000 characters in a 200K window (v2.1.309+) (memory).
- **Skill bodies** load when invoked and stay in the conversation (skills).
- **Subagents** get a fresh context with their own prompt, CLAUDE.md and any preloaded `skills:` (sub-agents).
- **MCP tool schemas** load when Claude searches for the tool (mcp).

## 3. Compaction

From the context-window page:
- Project-root CLAUDE.md, unscoped rules and auto memory are re-injected from disk.
- Skill descriptions are rebuilt and re-injected (v2.1.304+).
- Path-scoped rules and nested CLAUDE.md reload on demand.
- Invoked skill bodies come back capped at 5,000 tokens each and 25,000 in total.
- "Context that hooks added earlier" is summarised.
- SessionStart hooks that match `compact` run, and their output is added to the compacted context.

## 4. Hooks: SessionStart and PreCompact

- **SessionStart matchers:** `startup`, `resume`, `clear`, `compact`, `fork`.
- **SessionStart input fields:** `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `source` (the same five values). It also has `model` (optional; "check for the field before reading it"), `agent_type` (only with `--agent`) and `session_title`. On resume or fork it also gets `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired` and `estimated_cache_write_usd`. Source: hooks.
- **SessionStart output:** `hookSpecificOutput.additionalContext`, added "at the start of the conversation". It can't block. Exit 2 only shows stderr. Source: hooks.
- **Limit:** "A hook's `additionalContext`, `systemMessage`, and `initialUserMessage` strings, and its plain stdout, are capped at 10,000 characters." Over the cap, Claude Code saves the text to a file and passes the path with a 2,000-character preview, and "doesn't ask Claude to read the file". Source: hooks.
- **PreCompact:** matchers `manual` and `auto`. Exit 2 blocks compaction. Its input fields and whether it can add context weren't in the parts I read: **unverified**. PostCompact is for side effects only. Source: hooks.
- **InstructionsLoaded:** fires for each CLAUDE.md or rule load. `load_reason` is one of `session_start`, `nested_traversal`, `path_glob_match`, `include` or `compact`, and the event can't block. Source: hooks.

## 5. What Claude Code already reports (don't duplicate)

- **`/context [all]`:** a live grid by category, "with optimization suggestions". It lists the memory files that loaded. Its Skills row is "the size of the listing after the budget is applied" (v2.1.196+). `all` shows the tokens of each MCP tool. Sources: commands, skills, features-overview.
- **`/doctor`:** compares "unused skills, MCP servers, and plugins" with their context cost, proposes trims for checked-in CLAUDE.md, and offers to move always-loaded guidance into skills or nested files. It estimates the skill listing's cost. Source: skills.
- **`/doctor prompt-audit`** (v2.1.283+): finds stale or contradictory instructions. Source: memory.
- **`/skill-doctor`** (v2.1.252+): the cost and use of each skill. Source: commands, skills.

What none of these do: run outside a live session (no CLI, no CI), know which source a tool such as harness or an M3 pick added, hold a budget, or ask before something is added. That gap is harness's job. Live totals, the system prompt, MCP and model-driven trim proposals stay with Claude Code.

## 6. Token counting API (TC)

- `POST https://api.anthropic.com/v1/messages/count_tokens`, with headers `x-api-key`, `anthropic-version: 2023-06-01` and `content-type: application/json`. The body takes the Messages fields: `model`, `messages`, and optionally `system` and `tools`. The response is `{ "input_tokens": n }`.
- "Token counting is **free to use** but subject to requests per minute rate limits": 5,000, 10,000 or 20,000 RPM by tier. These limits are separate from message creation.
- "The token count is an **estimate**", and it "might include tokens added automatically by Anthropic for system optimizations". So a count of one source carries some message overhead. The example "Hello, Claude" with a short system prompt counts as 14 tokens.
- It counts under the tokenizer of the `model` passed. From Claude Opus 4.7 on, models use a newer tokenizer that gives "approximately 30 percent more tokens" for the same text. So a characters ÷ 4 rule, which comes from older tokenizers, probably underestimates on current models. The size of that error is **unverified**.
- The API needs an Anthropic API key. Many Claude Code users sign in with claude.ai instead (not checked here), so the offline estimate will often be the only count.

## 7. Context engineering

- Anthropic (2025-09-29): context "must be treated as a finite resource with diminishing marginal returns". Aim for "the smallest possible set of high-signal tokens". Load data just in time, compact, and keep notes outside the window. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- features-overview: "Too much can fill up your context window, but it can also add noise that makes Claude less effective". Keep CLAUDE.md under 200 lines.
- [mem]: context files raised cost by more than 20% without raising success in one study (arXiv 2602.11988); a counter-study found them neutral to positive (arXiv 2601.20404). Both favour short files.

## 8. Unverified

- U1. The exact text Claude Code puts in the skill listing per entry (name, plugin prefix, separators). Harness counts `name: description`.
- U2. Whether HTML comments are stripped in rules files and skill files, not only CLAUDE.md.
- U3. Whether the CLAUDE.md line `@AGENTS.md` costs anything once expanded.
- U4. The unit of the skill listing budget ("1% of the model's context window" next to "character budget").
- U5. Whether `.claude/commands/*.md` descriptions join the skill listing.
- U6. PreCompact input fields and whether it can return context.
- U7. Whether `skillOverrides: name-only` on a project skill still lets a subagent preload it through `skills:`.
- U8. How far characters ÷ 4 is from the API count on current models.
