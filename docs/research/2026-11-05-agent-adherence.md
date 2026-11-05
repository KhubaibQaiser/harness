# Rule and skill adherence for coding agents: research for harness

Date of research: 2026-11-05. Every claim has a URL. **UNVERIFIED** marks claims I could not confirm from a primary source. **Estimate** marks numbers I worked out myself. **Vendor claim** marks results published by a party with a stake in them.

---

## 0. Summary

- Every vendor and every serious paper splits the problem in two. Rules that must always hold go into **deterministic harness controls**: hooks, deny rules and CI. Rules that need **judgment** can only be measured, with evals or transcript audits. Anthropic says this directly: CLAUDE.md is "context, not enforced configuration" ([memory docs](https://code.claude.com/docs/en/memory)), and if you keep adding emphasis to a line, it belongs in a hook ([best practices](https://code.claude.com/docs/en/best-practices)).
- Measured adherence is far from perfect, and it decays within a session:
  - In a 1,650-session Claude Code study, file structure (size, position, architecture, conflicts) had no detectable effect. Each additional generated function lowered the odds of compliance by about 5.6% ([arXiv 2605.10039](https://arxiv.org/abs/2605.10039)).
  - OctoCodingBench reports per-rule compliance above 80%, but "every rule held" in only 10% to 36% of tasks (**vendor claim**, MiniMax) ([MiniMax](https://www.minimax.io/news/production-grade-benchmark-for-coding-agents)).
- **Skills often don't fire.** Vercel saw the skill never invoked in 56% of cases, and skills alone added 0 percentage points ([Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)). Anthropic's own eval docs name "`tool_used: Skill` failing" as the most common first finding ([plugin-evals](https://code.claude.com/docs/en/plugin-evals.md)).
- Claude Code already has most of the primitives:
  - 33 hook events, including `InstructionsLoaded`, which can blocking-check, feed back or just log
  - transcript JSONL files that record `Skill` tool calls
  - OpenTelemetry metrics, events and beta traces
  - `claude plugin eval`, with deterministic graders and a no-plugin baseline
  - `/skill-doctor` and `/doctor prompt-audit`
- One open-source tool does almost exactly what harness wants: **keeptrue** (MIT, 0 stars, single release 2026-09-30). It turns AGENTS.md rules into deterministic checks and scores existing Claude Code and Codex JSONL logs with no model calls ([repo](https://github.com/meryemsakin/keeptrue)). It is very immature, but it is useful prior art.

---

## 1. How the industry measures or enforces adherence

### 1.1 Deterministic guardrails (no tokens, highest reliability)

| Mechanism | Vendor and source | What it does |
|---|---|---|
| Hooks: block, feed back, rewrite | Claude Code, 33 events ([hooks](https://code.claude.com/docs/en/hooks)) | `PreToolUse` can deny, ask or rewrite input. `PostToolUse` and `Stop` can return `decision: "block"` with a reason. See section 2.1. |
| Hooks | Cursor: `.cursor/hooks.json`, command and prompt hook types, a `stop` event ([Cursor hooks](https://cursor.com/docs/agent/hooks)) | Similar lifecycle model. A forum report says hooks don't run in the Cursor CLI (**UNVERIFIED**, [forum](https://forum.cursor.com/t/cursor-cli-hooks/148511)). |
| Hooks | OpenAI Codex: `hooks.json` or `[hooks]` in `config.toml`, `PreToolUse` with matchers ([Codex hooks](https://developers.openai.com/codex/hooks); I only reached it through a [mirror](https://apis.emri.workers.dev/https-developers.openai.com/codex/hooks)) | A third-party guide says Codex `PreToolUse` can only deny and has no `additionalContext` (**UNVERIFIED**, [guide](https://codex.danielvaughan.com/2026/04/15/codex-cli-hooks-complete-guide-events-policy-patterns/)). |
| Hooks | GitHub Copilot coding agent and CLI: `.github/hooks/*.json`, `preToolUse` can approve or deny ([GitHub docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks)) | Must be on the default branch for the coding agent to use it ([how-to](https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/use-copilot-agents/coding-agent/use-hooks)). |
| Policy engine | Cupcake (EQTY Lab): OPA/Rego compiled to WASM, plugged in through agent hooks ([repo](https://github.com/eqtylab/cupcake)) | Policies run outside the model's context. Covers Claude Code, Cursor, Factory and OpenCode. |
| Permission deny rules and managed settings | Claude Code ([memory docs](https://code.claude.com/docs/en/memory)) | "enforce rules with managed settings such as `permissions.deny`". |
| Linters and CI | ESLint, Semgrep and similar; RuleProbe maps AGENTS.md prose to ESLint config ([repo](https://github.com/moonrunnerkc/ruleprobe)) | Checks the output, whatever agent produced it. |
| Config linters | agnix lints CLAUDE.md, AGENTS.md, SKILL.md, hooks and MCP config ([repo](https://github.com/agent-sh/agnix)); `claude plugin validate` ([skills docs](https://code.claude.com/docs/en/skills)) | Catches config that can never work, such as unparseable frontmatter, before any session runs. |

Anthropic's caveat on hook types: a `prompt` or `agent` hook "asks another model to decide, so it isn't deterministic either". For real enforcement, use a `command` or `http` hook, optionally with `onFailure: "block"` ([best practices](https://code.claude.com/docs/en/best-practices)).

### 1.2 Evals

- **Grader types.** Anthropic's agent-eval guide lists three:
  - code-based: fast, cheap and reproducible, but brittle
  - model-based: flexible, but non-deterministic and in need of calibration
  - human: the gold standard, but slow

  It separates *transcript* grading from *outcome* grading. It advises grading what the agent produced over the path it took, because step checks are brittle. Its blunt instruction is "Read the transcripts!" ([Anthropic engineering](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
- **pass@k vs pass^k** ([same source](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)):
  - pass@k means at least one of k tries succeeds.
  - pass^k means all k tries succeed.
  - Example: a 75% per-trial rate gives pass^3 of about 42%.
  - For rule adherence, **pass^k is the relevant metric**, because a rule that holds "sometimes" is not followed.
- **Capability vs regression evals.** Regression suites should sit near 100%. Capability suites should start low ([same source](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
- **A/B with and without instructions.** This is the standard way to show that an instruction or skill does anything:
  - `claude plugin eval`, with its `with-without` ablation ([plugin-evals](https://code.claude.com/docs/en/plugin-evals.md))
  - skill-creator's with-skill vs without-skill benchmark and blind A/B between versions ([blog](https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills))
  - keeptrue's experimental `ablate` ([repo](https://github.com/meryemsakin/keeptrue))
  - the AGENTS.md paper, which removes the context file entirely ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988))
- **Benchmarks that report rule compliance separately from task success:**
  - OctoBench and OctoCodingBench: ISR means all checks pass, CSR is the share of checks that pass. Scored with an LLM judge against per-instance checklists. MIT licence. ([HF](https://huggingface.co/datasets/MiniMaxAI/OctoCodingBench/blob/main/README.md))
  - Harness-IF ([arXiv 2608.11727](https://arxiv.org/abs/2608.11727))
  - HANDBOOK.md ([arXiv 2607.25398](https://arxiv.org/abs/2607.25398))
  - AgentIF ([arXiv 2505.16944](https://arxiv.org/abs/2505.16944))
- **General eval frameworks that can drive agents:**
  - promptfoo, MIT ([repo](https://github.com/promptfoo/promptfoo))
  - Inspect AI from UK AISI, MIT ([repo](https://github.com/UKGovernmentBEIS/inspect_ai))

### 1.3 Observability and tracing

- **OpenTelemetry GenAI semantic conventions** define `invoke_agent` and `execute_tool` operations, among others. All of them are still at **Development** stability ([spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans)). A secondary source says they moved to a separate repo in v1.42.0 (**UNVERIFIED**, [Dash0](https://www.dash0.com/knowledge/opentelemetry-genai-semantic-conventions-explained)).
- **Vendor integrations for Claude Code.** All of them are hook-based plugins, not native OTel:
  - **Langfuse**: a plugin that uses the Stop hook ([docs](https://langfuse.com/integrations/developer-tools/claude-code); [plugin repo](https://github.com/langfuse/claude-observability-plugin), MIT)
  - **LangSmith**: the `langsmith-tracing` plugin, which groups turns by `thread_id` and also works in claude-code-action. It replaced an earlier approach built on a manual Stop hook ([docs](https://docs.langchain.com/langsmith/trace-claude-code)).
  - **Arize Phoenix**: the `coding-harness-tracing` plugin streams OpenInference spans and can target a self-hosted instance on `localhost:6006` ([docs](https://www.arize.com/docs/phoenix/integrations/coding-agents/claude-code.md))
  - **Braintrust**: a Claude plugin, MIT ([repo](https://github.com/braintrustdata/braintrust-claude-plugin))
- **The limit.** These tools show *what happened*: prompts, tools and tokens. None of them, as documented, knows *which rule applied*. Adherence still needs a layer that maps rules to checks on top of the traces. I found no vendor doc that markets rule adherence as a built-in metric. Their "evals" features are generic LLM-as-judge or score functions.

### 1.4 Transcript and session auditing

- Anthropic: "Read the transcripts!" ([engineering](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). In `claude plugin eval`, `regex` graders can target the full `trace`, and an `llm` judge sees the first 12 and last 12 messages ([plugin-evals](https://code.claude.com/docs/en/plugin-evals.md)).
- Local tools that read `~/.claude/projects/*.jsonl`:
  - keeptrue (adherence scoring)
  - claude-doctor (anti-patterns)
  - claude-code-log (HTML and Markdown rendering)
  - simonw/claude-code-transcripts (publishing)
  - ccusage (usage and cost)

  See the table in section 4.
- keeptrue reports **false passes** it found in itself: rejected commands counted as run, a system notice mistaken for the final answer, and rule patterns quoted inside heredocs. It treats missing evidence as *unknown*, not as a pass ([repo](https://github.com/meryemsakin/keeptrue)). Any transcript scanner needs the same discipline.

### 1.5 Drift detection over time

- **After a model or prompt change.**
  - Regression suites re-run when a model or plugin changes. Anthropic lists "catch regressions when you change the plugin or a new model is released" as a goal of plugin evals ([plugin-evals](https://code.claude.com/docs/en/plugin-evals.md)).
  - The CI recipe pins both the agent model and the judge model so that scores stay comparable. It also says to keep `partial: true` runs out of trend charts ([same](https://code.claude.com/docs/en/plugin-evals.md)).
  - keeptrue flags "observed drops vs. the first model", per rule ([repo](https://github.com/meryemsakin/keeptrue)).
- **Within-session decay.**
  - Compliance falls with each additional generated function, OR = 0.944 ([arXiv 2605.10039](https://arxiv.org/abs/2605.10039)).
  - MiniMax says instruction-following degrades as conversations get longer (**vendor claim**, [MiniMax](https://www.minimax.io/news/production-grade-benchmark-for-coding-agents)).
  - Multi-turn performance drops 39% on average in Laban et al. ([arXiv 2505.06120](https://arxiv.org/abs/2505.06120); [ICLR 2026](https://iclr.cc/virtual/2026/poster/10009146)).
- **Compaction.** Each invoked skill keeps only its first 5,000 tokens after compaction, under a 25,000-token shared budget. Older skills can be dropped entirely ([skills](https://code.claude.com/docs/en/skills)). `InstructionsLoaded` fires with `load_reason: "compact"` and `SessionStart` has a `compact` matcher ([hooks](https://code.claude.com/docs/en/hooks)), so compaction is an observable drift point.

---

## 2. What Claude Code offers

### 2.1 Hooks

Source: [hooks reference](https://code.claude.com/docs/en/hooks).

| Event | Can block? | Feedback path |
|---|---|---|
| `PreToolUse` | Yes. Exit 2, or `hookSpecificOutput.permissionDecision` set to `allow`, `deny`, `ask` or `defer`. | `permissionDecisionReason` is shown to Claude. `updatedInput` rewrites the call. `additionalContext` is added. A matcher on `Skill` fires when Claude calls the Skill tool. A typed `/skill` bypasses it, and `UserPromptExpansion` covers that path. |
| `PostToolUse` | No, the tool already ran. | `decision: "block"` with `reason`, `additionalContext`, or `updatedToolOutput`. Input includes `tool_input` and `tool_response`. |
| `Stop` / `SubagentStop` | Yes, they stop Claude from stopping. | `decision: "block"` and `reason`, or `additionalContext`. Inputs include `last_assistant_message` and `stop_hook_active`. There is a cap of 8 consecutive continuations. |
| `UserPromptSubmit` | Yes, the prompt is dropped. | Stdout or `additionalContext` is added next to the prompt. |
| `SessionStart` | No. | `additionalContext` at the start. Matchers are `startup`, `resume`, `clear`, `compact` and `fork`. |
| `InstructionsLoaded` | No. Its output is discarded. | Logging only. Fields are `file_path`, `memory_type`, `load_reason`, `globs`, `trigger_file_path` and `parent_file_path`. Docs recommend it for debugging which rules loaded ([memory](https://code.claude.com/docs/en/memory)). |

Other facts that matter for harness:
- Hook types are `command`, `http`, `mcp_tool`, `prompt` and `agent`.
  - `prompt` makes one LLM call, by default on the background model, and returns `{ok, reason}`. Default timeout is 30 s.
  - `agent` runs a subagent for up to 50 turns. Default timeout is 60 s.
  - `async: true` (command only) runs in the background and cannot block.
- Skills can declare `hooks` in frontmatter. They are registered when the skill is invoked and stay for the rest of the session ([skills](https://code.claude.com/docs/en/skills)).
- `transcript_path` is a common input field, but the file "is written asynchronously and can lag". Use `last_assistant_message` on Stop instead ([hooks](https://code.claude.com/docs/en/hooks)).

### 2.2 Transcript JSONL

- **Official docs.** I found no official schema page. Hook inputs reference transcript paths of the form `~/.claude/projects/.../<session>.jsonl`, with subagents at `.../subagents/agent-<id>.jsonl` ([hooks](https://code.claude.com/docs/en/hooks)). The schema should be treated as an undocumented, versioned internal format.
- **Third-party descriptions** cover the per-line fields (`type`, `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `version`, `gitBranch`) and `tool_use` blocks in assistant content (**UNVERIFIED** as official; [community doc](https://evilpiepirate.org/forge/kent/consciousness/raw/branch/master/doc/claude-code-transcript-format.md), [claude-dev.tools](https://claude-dev.tools/docs/jsonl-format)).
- **What I observed locally** (structure only, one recent session, no content read):
  - An `assistant` record contains a `tool_use` block with `name: "Skill"` and `input` keys `skill` and `args`.
  - Records also carry `version`, `cwd`, `gitBranch`, `sessionId`, `isSidechain` and `timestamp`.
  - Other record types include `attachment`, `file-history-snapshot` and `cost-state`.

  So skill invocation, Claude Code version, branch and every tool call can be recovered offline. Field names can change between versions, which is why keeptrue added strict and lenient parsing.

### 2.3 OpenTelemetry export

Source: [monitoring](https://code.claude.com/docs/en/monitoring-usage).

- **Metrics:**
  - `claude_code.session.count`
  - `lines_of_code.count`
  - `pull_request.count`
  - `commit.count`
  - `cost.usage` and `token.usage`, both with attribution attributes including `skill.name`, `plugin.name` and `agent.name`
  - `code_edit_tool.decision`
  - `active_time.total`
- **Events:**
  - `user_prompt`
  - `tool_decision`, with `source` set to `config`, `hook` or `user_*`
  - `tool_result`
  - `api_request`, `api_error` and `api_refusal`
  - `assistant_response`
  - `safety_event`
  - `plugin_loaded`, `subagent_completed` and others
- **Skill events.** There is **no dedicated skill event**. The skill name appears in `tool_parameters`, and as the `skill_name` span attribute, only with `OTEL_LOG_TOOL_DETAILS=1`. Third-party skill names are reported as `"third-party"` on counters unless that flag is set.
- **Traces** are beta (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`). The span tree is interaction, then llm_request, then tool. Hook spans appear only with detailed beta tracing, which needs org allowlisting for interactive sessions.
- **The constraint for harness:** Claude Code **ignores `OTEL_*` exporter variables in a repo's `.claude/settings.json`**. They must come from the shell, `~/.claude/settings.json` or managed settings. A repo-level installer therefore cannot switch on OTel by itself. OTel also needs a collector endpoint, or the `console` exporter.

### 2.4 `claude plugin eval`

Source: [plugin-evals](https://code.claude.com/docs/en/plugin-evals.md).

- **Layout.** Cases live in `evals/<case>/` with `prompt.md` and/or `case.yaml` plus a `graders/*.md` folder. `claude plugin eval init` drafts the cases interactively, which costs tokens.
- **Run model.** Each run is a fresh, isolated `claude -p` session with only the plugin loaded. **User and project CLAUDE.md, AGENTS.md, `.claude/`, hooks and other plugins do not load.** That includes a CLAUDE.md written by a `scaffold_script`. A rule that harness puts in AGENTS.md can therefore only be evaluated if it ships inside the plugin, or is injected with `append_system_prompt` under `execution:` in `case.yaml`.
- **Graders.**
  - Free: `regex` (targets the reply, the full `trace` or a file), `tool_used` (with `min`/`max` and `input_match`; `min: 0`, `max: 0` asserts "never"), `tool_order` and `file_exists`.
  - Paid: `llm` (best 2 of 3 judge votes) and `baseline` (a judge compares against a reference `.jsonl`).
  - There are no custom-code graders.
- **Scoring.**
  - 3 runs per case per arm by default.
  - A run's score is the fraction of graders that pass, optionally weighted. A case's score is the mean across its runs. It passes at `--threshold`, which defaults to 1.0.
  - `WITH`, `W/OUT` and `Δ` come from the no-plugin baseline.
  - `tool_used: Skill` graders are excluded from Δ and shown as a "plugin-fired indicator".
- **Cost.** About cases × runs agent runs with the plugin, the same again without it, plus 3 judge calls per `llm` grader per run. The docs say all of this is billed to the user's plan or API. `--max-cost-usd` sets a ceiling and exits 2 when it is hit. `--ablation none` halves the cost.
- **Output.** A JSON result (`aggregates.casesPassed`, `costUsd`, `claudeVersion`, `partial`) and a self-contained `report.html` that makes no external requests.
- **Stable signal.** The docs advise one outcome grader plus one process grader per case, `regex` instead of `llm` for long outputs, and pinning both models in CI.

### 2.5 Skill activation reliability and official guidance

Source for this section: [skills](https://code.claude.com/docs/en/skills), unless noted.

- **Descriptions.**
  - The combined `description` and `when_to_use` text is capped at **1,536 characters** in the listing (configurable with `skillListingMaxDescChars`). Put the key use case first.
  - The whole listing has a budget of **1% of the context window** (`skillListingBudgetFraction` or `SLASH_COMMAND_TOOL_CHAR_BUDGET`). When it overflows, descriptions of the least-used skills are dropped first, which removes the keywords Claude matches on.
- **"Skill not triggering" checklist:**
  - include natural user keywords
  - check that the skill appears in the "What skills are available?" listing
  - check that `paths` globs fall inside the cwd
  - malformed YAML loads the skill with empty metadata, so it is never auto-matched; find these with `claude plugin validate`
- **"Claude stops following a skill" guidance:**
  - Rules that must hold every time belong in a hook, possibly declared in the skill's frontmatter.
  - Write guidance as standing instructions, because the file isn't re-read.
  - Re-invoke the skill after compaction, and put the key instructions at the top.
- **Measuring.** Use fresh sessions with and without the skill (`skillOverrides: "off"`; for plugin skills, `claude plugin eval`). skill-creator's description tuning "improved triggering on 5 out of 6 public skills" (**vendor claim**, no rates given, [blog](https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills)).
- **Built-in reports.**
  - `/skill-doctor` reports each skill's context cost and usage, and flags skills that have never been invoked.
  - `/doctor` estimates the listing's cost.
  - `/doctor prompt-audit` finds conflicting or outdated instructions ([memory](https://code.claude.com/docs/en/memory)).
- **Practitioner evidence** (not peer-reviewed):
  - Vercel: baseline 53%, skill 53%, skill plus an explicit "use it" instruction 79%, compressed 8 KB AGENTS.md index 100%. The skill was never invoked in 56% of early cases (**vendor claim**; model and case count not stated; [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)).
  - Scott Spence: a "forced-eval" `UserPromptSubmit` hook reached 84% on a synthetic Haiku 4.5 setup. His later sandboxed test on the real binary gave different results ([post 1](https://scottspence.com/posts/how-to-make-claude-code-skills-activate-reliably), [post 2](https://scottspence.com/posts/measuring-claude-code-skill-activation-with-sandboxed-evals)). The exact later numbers are **UNVERIFIED**.

### 2.6 CLAUDE.md and AGENTS.md delivery facts that cause silent drift

Source: [memory docs](https://code.claude.com/docs/en/memory).

- **Delivery.** CLAUDE.md is "delivered as a user message after the system prompt", with "no guarantee of strict compliance".
- **Size.** Target **under 200 lines**. "Longer files consume more context and reduce adherence." Contradictions may be resolved "arbitrarily".
- **AGENTS.md shadowing.** **AGENTS.md is read only if there is no CLAUDE.md or CLAUDE.local.md in the cwd or above it**, unless the user sets `claude-md-and-agents-md`. That setting is read only from user or managed settings, not from project settings. AGENTS.md support also needs v2.1.277 or later.

  If harness installs rules into AGENTS.md in a repo that already has a CLAUDE.md, **Claude never sees them by default**. This is the cheapest drift to detect, and probably the most common.
- **Emphasis.** Current guidance says emphasis such as IMPORTANT or ALL CAPS "mostly makes Claude over-apply the rule". Either shorten the file or make the rule a hook ([best practices](https://code.claude.com/docs/en/best-practices)).

---

## 3. Published evidence on adherence and decay

| Source | Type | Finding relevant to harness |
|---|---|---|
| McMillan, *Instruction Adherence in Coding Agent Configuration Files* ([arXiv 2605.10039](https://arxiv.org/abs/2605.10039), May 2026) | Preprint, single author. 1,650 Claude Code sessions, 16,050 observations. | File size, position, architecture and conflicting files had **no detectable effect**; Bayes factors support the null for size and conflict. Compliance **declined within the session** (OR 0.944 per function), varied by task, and replicated on Opus 4.6. The decay finding was exploratory, not pre-registered. |
| Gloaguen et al., *Evaluating AGENTS.md* ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988), ICLR 2026) | Peer-reviewed. Claude Code, Codex and Qwen Code. | Context files "do not generally improve task success" and **raise cost by more than 20%**. Agents *do* follow them. Repo overviews don't help. They are useful for non-standard practices. |
| Zhang et al., *Guardrails Beat Guidance* ([arXiv 2604.11088](https://arxiv.org/abs/2604.11088)) | Preprint. 679 rule files with 25,532 rules; more than 5,000 Claude Code + Opus 4.6 runs on SWE-bench Verified. | Rules add 7 to 14 points, but **random rules help as much as curated ones**, which the authors call priming. Only *negative* constraints helped individually. No degradation up to 50 rules. Details are from the abstract and summaries ([HTML](https://arxiv.org/html/2604.11088)); I did not read the full paper. |
| Harness-IF ([arXiv 2608.11727](https://arxiv.org/abs/2608.11727), Aug 2026) | Preprint. 12 models, rules on 5 instruction surfaces. | Accuracy 72.1% to 85.9%. Rules that go **against the model's default** score 3.6 to 7.4 points lower. A rule the model would follow anyway tells you little; against-the-grain rules carry the signal. |
| OctoBench / OctoCodingBench ([HF](https://huggingface.co/datasets/MiniMaxAI/OctoCodingBench/blob/main/README.md), [MiniMax](https://www.minimax.io/news/production-grade-benchmark-for-coding-agents)) | **Vendor** benchmark (MiniMax ranks its own model second). LLM-judge checklists. | Per-check compliance (CSR) above 80%, but **all-checks compliance (ISR) only 10% to 36%**; Claude 4.5 Opus is top at 36.2%. Degrades with conversation length. |
| HANDBOOK.md ([arXiv 2607.25398](https://arxiv.org/abs/2607.25398)) | Preprint. 65 tasks, 20- to 124-page SOPs, 824 programmatic criteria. | Best model passes 36.2% of trials under strict grading; most models are below 25%. |
| IFScale, *How Many Instructions Can LLMs Follow at Once?* ([arXiv 2507.11538](https://arxiv.org/abs/2507.11538), NeurIPS 2025) | Peer-reviewed. Not agentic: keyword-inclusion instructions. | About 68% accuracy at 500 instructions for the best models. **Bias toward earlier instructions.** The degradation curve differs by model class. |
| AgentIF ([arXiv 2505.16944](https://arxiv.org/abs/2505.16944), NeurIPS 2025 D&B) | Peer-reviewed. 707 agentic instructions, about 1,723 words and 11.9 constraints each. | Models perform poorly on **conditional constraints** and tool-usage specs. |
| Laban et al., *LLMs Get Lost in Multi-Turn Conversation* ([arXiv 2505.06120](https://arxiv.org/abs/2505.06120), ICLR 2026) | Peer-reviewed. | Average 39% drop from single-turn to multi-turn (35% in v1), mostly from unreliability. |
| Chroma, *Context Rot* ([report](https://research.trychroma.com/context-rot), [code](https://github.com/chroma-core/context-rot), MIT) | Vendor technical report (Chroma sells retrieval). 18 models. | Performance degrades as input length grows, even on trivial tasks. |
| Du et al., *Context Length Alone Hurts…* ([arXiv 2510.05381](https://arxiv.org/abs/2510.05381)) | Preprint. | Accuracy fell 13.9% to 85% as length grew, even with perfect retrieval and masked distractors. |
| Liu et al., *Lost in the Middle* ([arXiv 2307.03172](https://arxiv.org/abs/2307.03172)) | Peer-reviewed (TACL). | U-shaped recall: information in the middle of long context is used worst. This underlies "put key rules first". |
| Wallace et al., *The Instruction Hierarchy* ([arXiv 2404.13208](https://arxiv.org/abs/2404.13208)) | OpenAI paper. | Models are trained to prioritise system over user over tool content. This matters because CLAUDE.md arrives as a *user* message, not a system one ([memory docs](https://code.claude.com/docs/en/memory)). |
| Zhou et al., *IFEval* ([arXiv 2311.07911](https://arxiv.org/abs/2311.07911)) | Peer-reviewed baseline. | Introduced **verifiable instructions** checked by code, the same design idea as deterministic rule checks. |
| keeptrue pilot ([experiment](https://github.com/meryemsakin/keeptrue)) | Tiny, synthetic, self-described "not a benchmark". | 12 runs per agent. Every "never" rule held in all 24 runs. Claude Code skipped "run tests" in 2 of 3 runs after a blocked-dependency stop, and broke a 120-word limit in 4 of 12. Rules interact. |

**What the evidence supports:**
1. Prohibitions and negative constraints are followed far more reliably than positive, vague, conditional or length rules. Evidence: Guardrails Beat Guidance; the keeptrue pilot; AgentIF on conditional constraints.
2. "Every rule held" rates are low even when per-rule rates look high. Report both numbers (ISR and CSR).
3. Decay is real within sessions and over long contexts. Evidence: McMillan, Laban et al., Chroma, Du et al.
4. The evidence that file *structure* matters is weak (McMillan found nothing). Anthropic's "<200 lines" is guidance, not a measured threshold.

**What it does not support:** I found no peer-reviewed study of Cursor rules adherence specifically, and no credible study that measures skill trigger rate across many skills. One "Cursor vs Copilot" benchmark blog ([rpdi-us](https://rpdi-us.pages.dev/blog/cursorrules-vs-copilot-instructions-md-benchmark-2026)) has no verifiable method, so I discarded it.

---

## 4. Open-source tools for rule and skill adherence

Licence, stars and last push come from the GitHub API on 2026-11-05. Stars are a weak maturity signal.

| Tool | URL | What it does | Model calls? | Licence | Maturity, last push |
|---|---|---|---|---|---|
| **keeptrue** | [github.com/meryemsakin/keeptrue](https://github.com/meryemsakin/keeptrue) | Turns AGENTS.md or CLAUDE.md rules into deterministic checks (`forbidden_command`, `required_command`, `forbidden_path`, `max_final_length`, `forbidden_in_diff`, `no_repeat_loops`). Scores existing Claude Code and Codex JSONL logs. Reports per-rule adherence, drops versus the first model, and tokens per success. Has an `audit` mode against hand labels, and an experimental `ablate`. | No (LLM judge planned) | MIT | v0.2.0, released 2026-09-30, 0 stars. Very early. **Closest match to harness's goal.** |
| **RuleProbe** | [github.com/moonrunnerkc/ruleprobe](https://github.com/moonrunnerkc/ruleprobe) | Now translates instruction prose into ESLint config and reports drift between AGENTS.md and the ESLint config. An earlier version verified agent output directly ([dev.to](https://dev.to/moonrunnerkc/same-instruction-file-same-score-completely-different-failures-46fp)). The npm package 4.5.0 lags the source. | No | MIT | 3 stars, pushed 2026-10-06 |
| **agnix** | [github.com/agent-sh/agnix](https://github.com/agent-sh/agnix) | Linter and LSP for CLAUDE.md, AGENTS.md, SKILL.md, hooks, MCP and Cursor rules, with autofix and a GitHub Action. Rule count differs by source (400+). Static only. | No | Apache-2.0 | 470 stars, pushed 2026-11-04. Active. |
| **Cupcake** | [github.com/eqtylab/cupcake](https://github.com/eqtylab/cupcake) | OPA/Rego policy engine run through agent hooks: allow, block with feedback, modify or ask. Claude Code, Cursor, Factory and OpenCode. Optional LLM judge. | Optional | Apache-2.0 | 299 stars, pushed 2026-03-02 |
| **drift** (jarosser06) | [github.com/jarosser06/drift](https://github.com/jarosser06/drift) | "TDD for AI workflows": standards in `.drift.yaml`, validates the structure of agents, skills and commands. Docs claim LLM-based checks too (**UNVERIFIED**). | Unclear | MIT | 1 star, pushed 2025-12-28. Stale. |
| **drift-ai** (uzucky) | [pypi.org/project/drift-ai](https://pypi.org/project/drift-ai/) | Flags stale config: dead paths, wrong environment claims, orphan memory files, oversized config. The GitHub repo returned 404. | No | MIT | v0.1.0, 2026-03-20 |
| **claude-doctor** | [github.com/millionco/claude-doctor](https://github.com/millionco/claude-doctor) | Analyses Claude Code transcripts for behavioural anti-patterns and proposes CLAUDE.md rules. | **UNVERIFIED** | None declared in the API (a secondary source says MIT; **UNVERIFIED**) | 619 stars, pushed 2026-04-15 |
| **agentsesh** | [github.com/ateeples/agentsesh](https://github.com/ateeples/agentsesh) | Session failure analysis for Claude Code and Codex JSONL. | **UNVERIFIED** | MIT | 0 stars, pushed 2026-03-30 |
| **ax** | [github.com/Necmttn/ax](https://github.com/Necmttn/ax) | Local-first observability and memory for Claude Code and Codex. | **UNVERIFIED** | AGPL-3.0, a copyleft risk if harness reuses its code | 122 stars, pushed 2026-10-28 |
| skill-creator (in anthropics/skills) | [github.com/anthropics/skills](https://github.com/anthropics/skills) | Skill evals, with/without benchmark, blind A/B and trigger-description tuning. | **Yes** | No repo-level SPDX (licences are per skill; **UNVERIFIED**) | Official. Pushed 2026-10-28. |
| `claude plugin eval` | [docs](https://code.claude.com/docs/en/plugin-evals.md) | Built in. Deterministic graders plus judge graders, no-plugin baseline, CI exit codes. | **Yes** (every run) | Proprietary CLI | Official. Can be switched off server-side. |
| diet103 showcase | [github.com/diet103/claude-code-infrastructure-showcase](https://github.com/diet103/claude-code-infrastructure-showcase) | Example skill auto-activation through hooks and `skill-rules.json`. A pattern, not a checker. | Adds context | MIT | 10k stars, pushed 2026-07-13 |
| promptfoo | [github.com/promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | General eval framework with rubric and LLM-judge asserts. | Yes | MIT | Very active |
| Inspect AI | [github.com/UKGovernmentBEIS/inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai) | Eval framework with agent and sandbox support. | Yes | MIT | Very active |
| Langfuse plugin | [github.com/langfuse/claude-observability-plugin](https://github.com/langfuse/claude-observability-plugin) | Stop-hook tracing to Langfuse (the server can be self-hosted). | No (tracing only) | MIT; the Langfuse core repo has a mixed licence | Pushed 2026-10-26 |
| Phoenix plugin | [docs](https://www.arize.com/docs/phoenix/integrations/coding-agents/claude-code.md) | Hooks emit OpenInference spans to a local Phoenix instance. | No | Phoenix repo: NOASSERTION in the API (it is Elastic License 2.0 per Arize; **UNVERIFIED**) | Active |
| claude-code-log / claude-code-transcripts / ccusage | [daaain](https://github.com/daaain/claude-code-log) (MIT), [simonw](https://github.com/simonw/claude-code-transcripts) (Apache-2.0), [ccusage](https://github.com/ccusage/ccusage) | Render, publish or cost transcripts. They show what happened; they check no rules. | No | Listed | Active |

---

## 5. Patterns that matter for harness (local-first, no server, low cost, lean context)

### 5.1 Cost map

The token figures are **estimates**, not measurements.

| Technique | Session tokens | Billed model calls | Notes |
|---|---|---|---|
| Static lint of installed files (frontmatter parses; description ≤1,536 characters; listing under budget; CLAUDE.md ≤200 lines; AGENTS.md shadowed by CLAUDE.md; conflicting rules) | 0 | 0 | Runs in the harness CLI. `claude plugin validate` is free and local. |
| `InstructionsLoaded` / `SessionStart` command hook that only **logs** to a local file | 0 (no output is returned to Claude) | 0 | Shows whether the harness rules actually loaded. |
| `PreToolUse` deny / `PostToolUse` check (command hook) for mechanical rules | 0 when nothing fires. On a block, roughly tens of tokens for the reason text (**estimate**). | 0 | The only real *enforcement*. |
| `Stop` command hook that runs a deterministic check, e.g. "tests ran?", and blocks | Small reason text plus **an extra turn** when it fires | It continues the session, so the session spends more | Use sparingly; capped at 8 continuations. |
| Async command hook that writes an event log | 0 | 0 | Cannot block. Good for the audit trail. |
| Post-hoc scan of transcript JSONL | 0 | 0 | The format is undocumented, so parse defensively and report unknowns. |
| OTel export to the console or a file | 0 | 0 | Cannot be switched on from repo settings. Needs the user or `~/.claude` scope. |
| `SessionStart` / `UserPromptSubmit` `additionalContext` reminders | **Costs context every time.** Per-prompt injection is paid on every turn. | 0 | Conflicts with harness's "no per-prompt injection" principle. |
| `prompt` / `agent` hooks (LLM judge inside the session) | Small in-session cost | **Yes**, one background-model call per firing, up to 50 turns for `agent` | Also not deterministic ([best practices](https://code.claude.com/docs/en/best-practices)). |
| `claude plugin eval` | n/a | **Yes**: about cases × runs × 2 arms, plus 3 judge calls per `llm` grader per run | Example (**estimate**): 10 cases × 3 runs × 2 arms = 60 agent runs. `--ablation none` and free graders only gives 30. |
| LLM-as-judge on transcripts | n/a | Yes | Defer; offer only as opt-in. |

### 5.2 Patterns to adopt

1. **Classify every installed rule.** Some rules are *enforceable*: they map to a tool, command, path or diff pattern. Some are *auditable*: checkable after the fact in the transcript or diff. Some are *judgment only*. Report judgment-only rules as "unscored", never as passing. This is the IFEval, keeptrue and RuleProbe design.
2. **Prefer negative constraints for enforcement.** They are the most reliably followed and the easiest to check (Guardrails Beat Guidance; the keeptrue pilot).
3. **Treat unknown as unknown.** Missing tool results or unparseable records count as unknown, not as passes, and the unknown count is shown (keeptrue).
4. **Report both per-rule rate and all-rules-held rate** (CSR and ISR), and pass^k when runs are repeated (OctoBench; Anthropic).
5. **Break down by Claude Code `version`, model, session position and post-compaction state.** These are the documented drift axes. Version, `cwd` and `gitBranch` are already in every transcript record. Compaction is visible through `InstructionsLoaded` `load_reason: "compact"` and the `SessionStart` `compact` matcher.
6. **Measure skill triggers as their own metric.** Count the `Skill` tool_use calls on sessions where a harness skill was relevant. Note that an explicit `/skill` typed by the user bypasses `PreToolUse` and appears through `UserPromptExpansion`. When the trigger rate is low, the fix is the description, not more context.
7. **Verify the rules actually loaded before measuring compliance.** The AGENTS.md-shadowed-by-CLAUDE.md case is a free, deterministic and high-yield check.
8. **Keep rules against-the-grain and few.** Rules a model would follow anyway inflate the scores (Harness-IF), and context files cost more than 20% extra inference (AGENTS.md paper).

---

## 6. Recommended layers for harness

Ordered by cost. Layers 0 to 3 are free, local and need no model calls. Layer 4 is opt-in and paid, and needs the owner's OK for each run, in line with the existing "no paid actions without OK" rule.

**Layer 0: `harness doctor` static checks (free, CLI only, zero context).**
- Skill frontmatter parses (or call `claude plugin validate`).
- `description` + `when_to_use` is 1,536 characters or less, with trigger words first.
- Estimated listing size against the 1%-of-context budget.
- CLAUDE.md and AGENTS.md line counts against the 200-line guidance.
- **AGENTS.md shadowed by an existing CLAUDE.md** (or the Claude Code version is below 2.1.277).
- Duplicate or contradictory rules across harness files and user files.

Optionally shell out to agnix (Apache-2.0) instead of rebuilding a linter.

**Layer 1: load verification (free, zero context).**
- One async command hook on `InstructionsLoaded` and `SessionStart`.
- It appends `{session, file_path, load_reason, version}` to a local log under the plugin data directory.
- `harness verify` then answers "did harness's rules and skills load in recent sessions, and did they survive compaction?"

**Layer 2: deterministic guardrails for "must or never" rules (free; tokens only when a hook fires).**
- Compile rules marked `enforce:` in the harness preset into `PreToolUse` deny hooks (forbidden commands and paths) and `PostToolUse` checks (forbidden diff patterns, format and lint).
- Use exit 2 or `permissionDecision: "deny"` with a one-line reason.
- Allow at most one `Stop` check, for example "tests were run before finishing", and respect `stop_hook_active`.
- This is the only layer that *makes* agents comply. The others measure.
- Ship these as skill-frontmatter hooks where a rule belongs to a skill.

**Layer 3: `harness audit`, a post-hoc adherence and drift report (free, local, zero context).**
- Parse `~/.claude/projects/<repo>/*.jsonl`, plus subagent files, defensively.
- Apply the auditable checks:
  - required or forbidden commands
  - edited paths
  - diff patterns
  - final-message limits
  - `Skill` tool calls for the skills that should fire
- Output per-rule adherence with n and unknowns, all-rules-held rate, skill trigger rate, and breakdowns by Claude Code version, model, turn index and pre/post compaction.
- Flag drops against a stored baseline window.
- Render as the local HTML report already queued under the telemetry feature.
- No server and no model calls.
- keeptrue (MIT) is direct prior art. Its check vocabulary and "unknown ≠ pass" rule are worth copying, or harness could integrate it as an optional backend, with the trade-off that it is very immature.

**Layer 4: opt-in regression evals with `claude plugin eval` (paid, explicit owner approval).**
- Ship an `evals/` suite with the harness plugin.
  - One case per key skill, with a `tool_used: Skill` grader for trigger and a free outcome grader (`regex`, `file_exists` or `tool_order`).
  - A few "never" cases using `tool_used` with `min: 0, max: 0`.
- Inject AGENTS.md rules through `append_system_prompt`, because eval sessions do not load project files.
- Default to `--ablation none`, free graders only, `--runs 3` and a hard `--max-cost-usd`.
- Run on new model releases and on harness rule changes. Pin the models.
- Turn on `with-without` only when deciding whether a rule earns its context.

**Not recommended as defaults:**
- Per-prompt `UserPromptSubmit` reminders or "forced-eval" hooks. They have a context cost on every turn and the evidence is mixed (Spence's 84% came from a synthetic setup).
- `prompt` and `agent` hooks as enforcement. They are paid and non-deterministic.
- Repo-level OTel. Repo settings cannot enable it, and it needs a collector.

These can be documented as optional add-ons. For example, a user can point their own `~/.claude` OTel at a local Phoenix instance or the console exporter.

---

*Limits of this research:*
- I did not run `claude`, any evals or any tools.
- The transcript schema comes from third-party docs plus a structure-only look at one local file.
- Codex and Copilot hook details are partly from secondary sources.
- Full papers were not read for 2604.11088, OctoBench, HANDBOOK.md or Harness-IF; abstracts and dataset cards only.
