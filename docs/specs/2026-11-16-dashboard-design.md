# Harness dashboard: design

- Status: revision 3, for the owner's review, 2026-11-16. No code. Draft PR #252.
  - Revision 1: 35730e1. Revision 2: 8d0f80b.
  - Revision 2 applies the owner's answers of 2026-11-16 (§25).
  - Revision 3 applies the owner's later answers of 2026-11-16 (§26).
- Research and owner intent: `.superpowers/sdd/dashboard/research.md` (local, not committed), cited as "R".
- Claude Code facts come from the official docs, read on 2026-11-16, and are cited by URL:
  - monitoring and OpenTelemetry: https://code.claude.com/docs/en/monitoring-usage ("Mon");
  - hooks: https://code.claude.com/docs/en/hooks ("Hooks");
  - environment variables in settings files: https://code.claude.com/docs/en/env-vars ("Env");
  - model configuration and context windows: https://code.claude.com/docs/en/model-config ("Model"), cited for §2.3;
  - status line: https://code.claude.com/docs/en/statusline ("SL"), cited only to explain why it is not used.
- Code facts are from `main` at 16c59c2, plus open PR #250 (no-follow writes), which this spec depends on (§14.3).
- Owner decisions D1 to D13 bind; §1 lists them.

## 0. The non-goal this reverses

The original design lists "Web UI, remote telemetry, multi-repo dashboards" as non-goals for v1 (`docs/specs/2026-10-30-harness-design.md:47`). **The owner reverses that** for this feature:
- a web UI, served locally by `harness dashboard`;
- a multi-repo switcher, limited to repos on this machine that have harness installed.

It stays local, and **there is still no remote telemetry**:
- nothing leaves the machine;
- the page loads nothing from the network;
- the OpenTelemetry data goes only to a receiver on `127.0.0.1`.

## 1. Owner decisions (2026-11-16)

| # | Decision | Where |
|---|---|---|
| D1 | A local web page served by `harness dashboard`. It is a Node `http` server on `127.0.0.1` only, with a random token per launch, Host and Origin checks, a strict CSP, no external network, and no remote scripts or fonts. It ships inside the npm package, with minimal or no new runtime dependencies. | §10, §14 |
| D2 | This repo by default, plus a switcher listing the other repos on this machine that have harness installed. Each repo's own `.harness` folder is read. There is no machine-wide database. | §10.4 |
| D3 | OpenTelemetry from the start, cross-checked so nothing is missed. Gap detection shows "telemetry missed N" and back-fills from another source, labelling every number with its source and whether it is exact or estimated. The status-line source is dropped by D11, and the back-fill order is set in §8. | §7, §8 |
| D4 | Opt-in at any time, as a previewed change with a confirm, reversible the same way, and removed by uninstall. Levels as narrowed by D9. | §9 |
| D5 | Names on, content off. `OTEL_LOG_TOOL_DETAILS=1` gives skill, hook and MCP names. Never `OTEL_LOG_USER_PROMPTS`, tool content or raw bodies. | §7.2.4 |
| D6 | Controls (phase 3). Every action runs a harness CLI command, shows the exact change first, and needs the person's click to apply. Backups are made as the CLI makes them. Nothing is deleted or overwritten without that yes, and unattended agents can't drive it. | §11 |
| D7 | A clean harness design: dark and light, dense tables, sparklines and gauges, keyboard navigation, accessible (WCAG AA contrast, focus states), no external fonts. | §10.5 |
| D8 | Four phases, each shippable for the owner to test while the next is built: 1 See, 2 Live, 3 Control, 4 History and proof. | §6, §7, §11, §12, §21 |
| D9 | OTel is switched on only at the global level (`~/.claude/settings.json`, with the owner's previewed yes) or in the shell. One receiver per user routes each session to its repo and keeps nothing for repos without harness. The team level covers harness's hook log only. Was open question 1; team is the only repo level (Q-T3). | §2.1, §7.2, §9 |
| D10 | Phase 4 trend charts use uPlot, pinned to exactly `1.6.32` and bundled into the dashboard's static assets, with no CDN. It is MIT-licensed, and its minified build is 51,081 bytes plus 1,857 bytes of CSS. Both facts were verified from the npm tarball (§10.6). Sparklines and gauges stay hand-written SVG. Was open question 11. | §10.6, §12.2 |
| D11 | Don't touch the status line. The dashboard never adds, wraps or chains a `statusLine`. Live context use and cost come from OTel `api_request` events and token metrics, with transcripts as the labelled fallback. Was open question 9. | §7.3, §8 |
| D12 | Add `harness config set <key> <value>`, with the same validation, preview, backup, protect rules and person-only gating as other config changes, as its own PR before phase 3's controls. Was open question 10. | §11.3, §21 |
| D13 | Standing rule: nothing may go in that directly conflicts with Claude Code's own harness or agentic tools. Any such case is flagged and confirmed with the owner first. | §15 |

## 2. What the docs settled

### 2.1 OpenTelemetry can't be turned on from a repo's settings files (hence D9)

- **Env:** `CLAUDE_CODE_ENABLE_TELEMETRY` is "Ignored in project and local settings … Set it in your shell, user settings, or managed settings."
- **Mon:** Claude Code "ignores the OpenTelemetry exporter variables in a repository's `.claude/settings.json` and `.claude/settings.local.json`, so a repository can't use them to turn telemetry on, choose where it goes, or capture content."

What follows:
- Global env applies to every session on the machine, so the receiver is one per user, on one port. It routes by announced session (§7.2.3).
- Sessions get announced, and the receiver kept running, by harness's record hook. That hook is the team level in each repo. **So OTel data reaches a repo only when that repo also has the hook log on.**

### 2.2 Other facts the design rests on

- **Protocols:** `OTEL_EXPORTER_OTLP_PROTOCOL` takes `grpc`, `http/json` or `http/protobuf`. The default is `http/protobuf` for an `http(s)://` endpoint, from v2.1.323 (Mon).
  - Harness sets `http/json`.
  - The receiver also accepts `http/protobuf`, in case a higher layer forces it.
  - It doesn't accept gRPC.
- **Export intervals:** metrics every 60000 ms and logs every 5000 ms by default. Metric temporality is `delta` by default (Mon).
- **Events harness uses** (Mon):
  - `api_request` (event name `claude_code.api_request`): `model`, `cost_usd`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `request_id`, `query_source`. Mon: `input_tokens` excludes tokens read from or written to the prompt cache, and `cost_usd` is an estimate;
  - `skill_activated`: `skill.name`, `invocation_trigger`, `skill.source`;
  - `hook_execution_start`, `hook_execution_complete` and `hook_registered`;
  - `compaction`: `trigger`, `pre_tokens`, `post_tokens`;
  - `subagent_completed`, `tool_decision`, `tool_result` and `user_prompt`;
  - `plugin_loaded` and `mcp_server_connection`.
- **Metrics harness uses:** `claude_code.token.usage` and `claude_code.cost.usage`, with `model`, `query_source` (`main`, `subagent`, `auxiliary`), `agent.name` and `skill.name`.
  - `claude_code.token.usage` (unit `tokens`) has a `type` attribute: `input`, `output`, `cacheRead` or `cacheCreation`. Mon: `input` excludes cache reads and writes, and `cacheCreation` counts the five-minute and one-hour cache writes together.
  - `claude_code.cost.usage` (unit `USD`) has no `type` attribute.
  - Mon's per-session guidance: group by `session.id`, which `/clear` replaces, and which `OTEL_METRICS_INCLUDE_SESSION_ID=false` removes from metrics. Mon gives no per-day method; harness buckets by timestamp (§7.4).
- **Correlation keys:**
  - `session.id` is on everything;
  - `prompt.id` is on events, never on metrics;
  - `event.sequence` counts per process (Mon).
- **Context window size:** no built-in source outside the status line (§2.3). The live gauge shows tokens in context, not a percentage (§7.3).
- **`OTEL_LOG_TOOL_DETAILS=1` also adds content:** Bash commands, tool input and `tool_parameters` (Mon). D5 wants names only, so the receiver drops those attributes before anything reaches disk (§7.2.4).
- **Always-on identity attributes:** `user.email` and `user.id`, plus `user.account_uuid` by default (Mon). The receiver drops them too.
- **Skill-name redaction:** the docs contradict themselves on custom skill names (three statements, quoted in Q2). Harness sets `OTEL_LOG_TOOL_DETAILS=1`, so names should be verbatim. That is unverified.
- **Hooks** (Hooks):
  - `UserPromptSubmit` carries `prompt_id`. Harness records only that id, never the prompt.
  - `UserPromptExpansion` gives `expansion_type`, `command_name`, `command_args`, `command_source` and `prompt`.
  - `SubagentStart` and `SubagentStop` give `agent_id` and `agent_type`.
  - `PreCompact` gives `custom_instructions`; `PostCompact` gives `compact_summary`.
  - The model-switch hooks give `from_model` and `to_model`.
  - `SessionStart` gives `source` and `model`; `SessionEnd` gives `reason`.
  - **Async hooks:** `async: true` runs a command hook "in the background without blocking", with no enforced timeout. In `-p` mode, async hooks still running at teardown are killed. Async output is delivered on the next turn. Completion notices show only in verbose mode.
- **Status line:** not used (D11). SL notes that a custom status line also hides most of Claude Code's footer hints. That is one reason the owner ruled it out.
- **Transcripts** change format between versions (R). Harness reads them defensively (`src/report/transcript.ts`, tested range `TESTED` 2.1.286 to 2.1.317).
  - Usage fields, checked read-only against a local transcript written by Claude Code 2.1.309 on 2026-11-16: an assistant line has top-level `requestId`, and `message.id`, `message.model` and `message.usage` with `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`. `src/report/transcript.ts` already reads those four.
  - Transcripts carry no cost.

### 2.3 Context window size: not available without the status line

The owner asked for a built-in source of the window size other than the status line, which D11 forbids. **There is none, so a window percentage isn't possible from Claude Code's built-in data, and the gauge shows tokens only.** What the docs say, read on 2026-11-16:
- **Mon:** no metric, event or attribute reports a window size, a context limit or a percentage. `claude_code.compaction` gives `pre_tokens` and `post_tokens`, described as approximate.
- **Hooks:** no hook input has a window size or percentage. `PreModelSwitch` has `context_tokens` (the tokens the next request re-sends), and `SessionStart` has `context_tokens` on `resume` and `fork`. Both are token counts, not a window.
- **Env and Model:** `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `autoCompactWindow` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` are settings the person or an admin sets. They override or cap the window; they don't report the window Claude Code uses. Model says the status line's `used_percentage` is the measure against the model's full window, which is the status line again.
- **A per-model table** written from Model's prose (which models run at 1M, which at 200K) would be harness's own copy. It goes stale when Claude Code or a gateway changes the window, and misreads `[1m]`, `CLAUDE_CODE_DISABLE_1M_CONTEXT` and gateway IDs. The owner's rule is that accuracy matters, so harness doesn't ship one.

## 3. Goal and non-goals

**Goal.** One local page answers: "what is harness doing in this repo, what did it cost, and did anything get missed". It covers:
- gates blocked, with what and why;
- skills installed vs used;
- the per-file context budget;
- tokens by session, model and destination, with a per-model breakdown of input, output, cache read, cache creation and cost (§7.4);
- the Stop sandbox state;
- a live session view and trends;
- done-contract proof;
- control of harness behind the person's click.

**Success means:**
- every number names its source and says whether it is exact or estimated;
- a capture gap is shown and filled, never silent;
- no agent can drive a control.

**Non-goals:**
- Remote telemetry, a hosted UI, or any upload.
- A machine-wide database. The receiver's announcement folder holds only session-to-repo entries, pruned after 7 days.
- Anything in Claude Code's own UI. There is no status line (D11) and no hook output shown to the person or the model.
- Driving Claude Code sessions (starting, prompting or stopping them).
- Editing CLAUDE.md, skills or MCP config beyond what an existing CLI command does.
- OTel fan-out to the person's own collector. The owner placed it after phase 4 (Q16); until then global opt-in refuses when another endpoint is set (§9).
- gRPC OTLP and OTel traces.
- Desktop-app or VS Code panes.

## 4. Data sources and trust

| Source | Written by | Can the agent plant it? | Gives |
|---|---|---|---|
| `.harness/logs/events.jsonl` | harness hooks and CLI | **Yes**, from sandboxed Bash through harness commands. `.harness/logs` is in `DENY_WRITE_SKIPPED` (`src/checks/protect.ts:31`), so protect guards the raw text only. | gate decisions, reasons, files |
| `.harness/logs/timing.jsonl` | dispatcher | Yes: same folder | hook latency |
| `.harness/state/*` (stop record, session state) | hooks | No: denyWrite and Edit deny | Stop sandbox, gates |
| `.harness/telemetry/**` (new) | record hook, receiver | No: denyWrite, Edit deny and protect (§13) | invocations, OTel |
| Session transcripts (`~/.claude/projects/…`) | Claude Code | The content yes (its own words and tool calls); the files no | per-request tokens, tool uses, compactions |
| `.claude/skills`, settings, config | person or harness | Settings and config are Edit-denied; skills are repo files | installed inventory, budget |

Rules:
- **Every value is untrusted for display.** It is escaped and capped.
- **No value from any source is ever used as a write path or as a command argument** (§14).

## 5. Components at a glance

```
Claude Code session
  |-- hooks (existing dispatch.mjs, sync) -------> events.jsonl, timing.jsonl
  |-- hooks (new record.mjs, async) -------------> telemetry/invocations.jsonl
  |        `-- SessionStart, UserPromptSubmit, record events: ensure receiver; SessionStart: announce session
  `-- OTLP/HTTP (global env only, D9) ---> receiver (one per user, 127.0.0.1:<port>)
                                             `-> routed per announced session ---> <repo>/.harness/telemetry/otel/<day>.jsonl
harness dashboard (person-run, 127.0.0.1:<random>)
  reads all of the above + transcripts + config ---> HTML pages, JSON, SSE
  actions ---> spawns the harness CLI: --dry-run (diff shown), then --yes on click
```

| Component | Ships in | New source |
|---|---|---|
| Dashboard server, pages and client JS | `dist/cli.mjs` (client JS and CSS inlined as strings at build) | `src/dashboard/**` |
| Record hook | `dist/hooks/record.mjs`, copied to `.harness/hooks/record.mjs` | `src/telemetry/record.ts` |
| OTel receiver | `dist/receiver.mjs`, copied to `~/.claude/harness/bin/receiver.mjs` at global opt-in | `src/telemetry/receiver/**` |
| Opt-in command | `dist/cli.mjs` | `src/cli/telemetry.ts` |
| `harness config set` | `dist/cli.mjs` | `src/cli/config-set.ts` |
| Gap detection and back-fill | `dist/cli.mjs` | `src/telemetry/gaps.ts` |

**Runtime dependencies: none.** That matches today, where `package.json` has no `dependencies` and esbuild bundles `yaml` and `picomatch`.
- uPlot (D10) is added the same way: as an exact-pinned devDependency, bundled into the dashboard's assets at build (§10.6).
- Sparklines, gauges and the phase 1 and 2 charts are hand-written SVG, extending `src/report/svg.ts`.

## 6. Phase 1: See (no new capture)

Everything here comes from what `harness report` already computes. Phase 1 is the report, served with navigation.

**Reuse:**
- `collect()` moves from `src/cli/report.ts` to `src/report/collect.ts`, unchanged, so the report and the dashboard share it.
- The page renders from the same accumulators: `gatesAcc`, `skillsAcc`, `usageAcc`, `windowsAcc`, `alwaysLoadedSafe`, `contextSet`, `recommend`, `readStopRecord` and `stopSandboxLine`.
- `h()` escapes every string.

| View | Content | From |
|---|---|---|
| Overview | gate on/off lines; Stop sandbox line; context total vs `context.budget_tokens` (gauge); 14-day token sparkline; probable false blocks; hook p95; untested Claude Code versions; config errors | `status` logic, report summary |
| Gates | **blocked what and why:** the last 500 `deny`, `ask` and `block` events (time, check, decision, reason, files, session), filterable by check and decision. Also tallies, overrides, probable false blocks by signal, latency rows, Stop steps (runs, blocks, flakes, p50, p95) and hallucination counts | `readEvents`, `gatesAcc` |
| Skills | installed vs listed vs invoked when relevant; invoked otherwise; typed or carried; dropped from listing; before and after compaction; by turn bucket | `installedSkills`, `skillsAcc` |
| Context | per-file always-loaded rows (tokens, owner) against the budget; on-demand rows; recommendations. Offline estimate only: an exact count uploads text, so it is a phase 3 action | `contextSet` offline, `recommend` |
| Tokens | totals; main vs subagent; by model, by day, by session (peak context, compactions); tool result characters | `usageAcc` |
| Stop sandbox | whether `srt` was found, the last preflight record, allowed domains, writable paths | `readStopRecord`, `stopSandboxLine` |

The window is `--days N`, default 14, as in the report. Phase 1 writes nothing.

## 7. Phase 2: Live capture

Both capture sources are opt-in (§9) and append-only. There are exactly two: the record hook and the OTel receiver.

### 7.1 Invocation log (record hook)

`harness telemetry on --level team` adds new hook groups to `.claude/settings.json` (§9). Each runs `node ${CLAUDE_PROJECT_DIR}/.harness/hooks/record.mjs` with `"async": true`. The existing hooks stay as they are.

| Event | Matcher | Recorded |
|---|---|---|
| `PreToolUse` | `Skill` | `name` (the skill), `use` (`tool_use_id`) |
| `UserPromptSubmit` | all | `prompt` (`prompt_id`) only. **Never the prompt text.** It also ensures the receiver. |
| `UserPromptExpansion` | all | `name` (`command_name`), `source` (`command_source`), `kind` (`expansion_type`). **Never `command_args` or `prompt`.** |
| `SubagentStart`, `SubagentStop` | all | `agent` (`agent_type`), `aid` (`agent_id`). **Never `last_assistant_message`.** |
| `PreCompact`, `PostCompact` | all | `trigger`. **Never `custom_instructions` or `compact_summary`.** The pre event waits on Q7. |
| `PreModelSwitch`, `PostModelSwitch` | all | `from`, `to` (model ids). The pre event waits on Q7. |
| `SessionStart` | all | `source`, `model`, `otel` (below). It also ensures the receiver and announces the session (§7.2). |
| `SessionEnd` | all | `reason`. It also runs the rollup and the retention sweep (§12.1, §13). |

Rules:
- **A small separate bundle.** `record.mjs` imports no check. It parses stdin, keeps only the listed fields, appends one line, and exits 0.
- **It never writes stdout.** Async output reaches the next turn, and PreCompact stdout would become compaction instructions (Hooks).
- **Names are validated** so content can't ride in a name field:
  - names: at most 128 characters matching `^[A-Za-z0-9:._@/-]+$`, else `other`;
  - model ids: must match `MODEL_RE` (`src/report/export.ts`), else `other`.
- **`otel` on SessionStart** tells gap detection whether to expect OTel for the session (only `harness` sessions):
  - `harness` when the hook's environment has `CLAUDE_CODE_ENABLE_TELEMETRY=1` and an endpoint equal to the URL in `~/.claude/harness/receiver.json`;
  - `other` when telemetry is on with another endpoint;
  - `off` otherwise.
- **No turn latency.** Async means Claude Code doesn't wait (Hooks). `-p` runs can lose in-flight lines at teardown, and gap detection shows that (§8).

### 7.2 OTel receiver

#### 7.2.1 Process

- **Where.** Throughout this spec, `~/.claude/harness/` means `claudeConfigDir()/harness/` (`src/core/settings-layers.ts`), so `CLAUDE_CONFIG_DIR` is honoured. The owner approved keeping `bin/`, `receiver/` and `receiver.json` there (Q-T8), with the limit in §22.
- **One per user.** `record.mjs` starts it detached (owner-approved, Q-T4). Global opt-in copies the bundle to `~/.claude/harness/bin/receiver.mjs`. It runs with `process.execPath`, `stdio: 'ignore'` and a minimal environment.
- **Bind:** `127.0.0.1:<port>`, with `<port>` taken from `~/.claude/harness/receiver.json`. Global opt-in tries the default `4320`; if that port is busy at opt-in, it picks a free loopback port and the preview names it. A port that later becomes busy fails closed (`EADDRINUSE`, below) and shows as a gap. The owner's Q-T4 approval covers this (Q13).
- **Single instance:**
  - a lock folder `~/.claude/harness/receiver/lock` holds the owner pid, nonce, port, version and start time;
  - it uses the `withSessionLock` pattern: `mkdir`, an owner file, and a stale break when the pid is dead;
  - `EADDRINUSE` on bind is a second guard: the receiver exits 0 and logs.
- **Idle exit** after 30 minutes with no accepted request. The next record hook (SessionStart, UserPromptSubmit or any recorded event) or the next `harness dashboard` start restarts it.
- **Crash restart:** the next record hook or `harness dashboard` start sees a dead pid and starts it again. The data missed while it was down is a gap, back-filled with a notice (§8).
- **Never killed by harness.** A hook never kills a receiver. A newer harness version takes over only after the old receiver exits.

#### 7.2.2 Endpoints and request checks

| Path | Method | Notes |
|---|---|---|
| `/v1/logs`, `/v1/metrics` | POST | `application/json` or `application/x-protobuf` (§7.2.6) |
| `/v1/traces` | any | 404 (tracing is beta, and off) |
| `/health` | GET | `{ ok, version, pid }`, for doctor |
| `/shutdown` | POST | Used by `harness telemetry off --level global` |

**Every request must have:**
- `Host` exactly `127.0.0.1:<port>`;
- **no** `Origin` header (whether the exporter ever sends one is checked in L1);
- the header `x-harness-key: <key>`. Harness puts the key in `OTEL_EXPORTER_OTLP_HEADERS` at global opt-in. It is 32 random bytes in base64url, also stored in `receiver.json` with mode 0600;
- a body of at most 4 MB, read within 10 s.

**Anything else:**
- gets 403 or 413;
- is counted in `receiver.log`;
- has its body discarded.

**Why the custom header:** it forces a CORS preflight, which the receiver refuses. So a web page can't post to it.

#### 7.2.3 Routing and announcements

- **Announce.** On SessionStart, `record.mjs` writes `~/.claude/harness/receiver/announce/<session>.json` as `{ root, ts }`. The session id must pass `isSafeSessionId`. The write uses the #250 helpers (§14.3) and mode 0600.
- **Route.** The receiver routes each record by `session.id`, after checking the announced root:
  - its `realpath` has a regular-file `.harness/manifest.json`;
  - the hook log is on there;
  - `ensureRealDir(root, '.harness/telemetry/otel')` succeeds, so no folder is a symlink.
- **Cross-check.** Once the session's transcript exists, its first `cwd` (read as `locate.ts`'s `firstCwd` does) must be inside the root. A mismatch drops the announcement and logs `announce-mismatch`.
- **Unannounced sessions** (other repos, or a missed SessionStart):
  - held in memory for up to 10 minutes, 5 MB in total;
  - written if an announcement arrives, else dropped;
  - **so data from repos without harness never reaches disk** (D9).
- **Bounds.** Announcements are pruned after 7 days, and the folder is capped at 10,000 files.

#### 7.2.4 Allowlist: names on, content off (D5)

Records are reduced before any write. **Any attribute not listed is dropped**, including:
- `user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`, `terminal.type`, `vcs.*`;
- `tool_parameters`, `tool_input`, Bash command strings, `error` text, `prompt`, `hook_definitions`, and every body event.

| Record | Kept |
|---|---|
| all | `session.id`, `prompt.id`, `event.sequence`, `event.timestamp`, `app.version` if present |
| `api_request` | `model`, `cost_usd`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `request_id`, `query_source`, `speed` |
| `skill_activated` | `skill.name`, `invocation_trigger`, `skill.source`, `skill.kind`, `plugin.name`, `marketplace.name` |
| `hook_execution_start` / `_complete` | `hook_event`, `hook_name`, `num_*` counts, `total_duration_ms`, `*_chars` counts, `hook_source` |
| `hook_registered` | `hook_event`, `hook_type`, `hook_source`, `hook_matcher`, `plugin.name` |
| `compaction` | `trigger`, `success`, `duration_ms`, `pre_tokens`, `post_tokens` |
| `subagent_completed` | `agent_type`, `agent.source`, `is_built_in`, `is_async`, `total_tokens`, `total_tool_uses`, `duration_ms`, `model`, `final_model`, `model_swapped` |
| `tool_decision` / `tool_result` | `tool_name`, `decision`, `source`, `decision_source`, `success`, `duration_ms`, `tool_use_id`, plus names only from the parameters: `mcp_server_name`, `mcp_tool_name`, `skill_name`, `subagent_type` |
| `user_prompt` | `prompt_length`, and command names under the §7.1 name rule |
| `plugin_loaded`, `mcp_server_connection` | name, source and status fields (exact names pinned in L1) |
| `token.usage`, `cost.usage` metrics | value, `type`, `model`, `query_source`, `agent.name`, `skill.name`, `plugin.name`, `mcp_server.name`, `mcp_tool.name` |

Further rules:
- **Name values** pass the §7.1 name rule, else `other`.
- **Token attribute names** on `api_request` are Mon's (§2.2). L1 confirms them in recorded payloads before P2.3 merges (Q3).
- **Content variables:** harness never sets `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` or the beta tracing variables. Doctor warns when any of them is set in a layer harness reads.

#### 7.2.5 Ensure

`ensureReceiver()` runs in `record.mjs` only when the machine opted in globally and the session's `otel` is `harness`, and in `harness dashboard` at start when the machine opted in globally. It:
1. reads the lock owner;
2. runs `kill(pid, 0)`;
3. if the receiver isn't running, spawns it detached and returns **without waiting**.

- **Budget:** under 15 ms on top of the record work (§16).
- **A spawn failure** becomes one invocation-log line, `receiver-start-failed`, with the error `code` only.

#### 7.2.6 Protobuf

- **Hand-written decoder** for the subset of OTLP `ExportLogsServiceRequest` and `ExportMetricsServiceRequest` that the allowlist reads: resource and scope attributes, log records with attributes, and sum data points.
- **Bounds:**
  - unknown fields are skipped by wire type;
  - lengths are bounds-checked;
  - nesting depth is at most 32.
- **Tests** run against recorded payloads (§20.4).
- **Why it exists:** harness itself sets `http/json`, so protobuf is for when a managed or shell value overrides it (Q5).

#### 7.2.7 Responses

- The receiver answers 200 with `{}` (JSON) or an empty protobuf body as soon as the body parses.
- Writes are queued and flushed every 1 s.
- A write failure is logged and counted, never returned as a 5xx. The exporter's retry behaviour is unknown (Q4), and a retry storm would cost more than the gap check recovers.

### 7.3 Live session numbers (no status line, D11)

| Number | Source | Label |
|---|---|---|
| Tokens in context now | `input + cache read + cache creation` of the latest `api_request` with `query_source: main`, from OTel. Fallback: the latest main-thread transcript response, by the same formula as `usageAcc`'s peak | estimate (the next request's input isn't known yet) |
| Context gauge | tokens in context against `context.budget_tokens` for the always-loaded part, and against the last `compaction`'s `pre_tokens` as the observed compaction point. **No window percentage**: Claude Code's built-in data has no window size outside the status line (§2.3) | estimate |
| Session cost | sum of `claude_code.cost.usage` deltas, or the sum of `api_request.cost_usd` | estimate (list price) |
| Tokens by model, destination, skill or agent | `claude_code.token.usage` deltas by `model`, `query_source`, `skill.name` and `agent.name` | exact |
| Model now | the latest `api_request.model`; else `PostModelSwitch.to` or SessionStart `model` from hooks; else the transcript | exact |
| Timeline | prompts (hooks), skills, subagents, compactions, model switches (hooks and OTel), gate decisions (`events.jsonl`), requests (OTel, else the transcript) | per-row source |
| Per-skill cost | `cost.usage` by `skill.name` | estimate |
| Per-hook cost | `hook_execution_complete`: `total_duration_ms` by `hook_event`, and `additional_context_chars` as tokens | time exact; tokens "estimate, characters / 4" |
| Rate limits | **not available.** The status line was the only source, and D11 removes it (§22) | — |

### 7.4 Per-model token usage

The owner asked for per-model visibility from Claude Code's own data, because accuracy matters (Q-new 1). The Tokens view and the live session view show one table per scope:

| Scope | Rows | Columns |
|---|---|---|
| Per day | one row per local calendar day and model | input, output, cache read, cache creation, total tokens, cost |
| Per session | one row per `session.id` and model | the same |
| Window total | one row per model | the same |

**Sources, in order** (names from Mon, §2.2):

| Column | Primary: `claude_code.api_request` events | Cross-check: metrics | Back-fill: transcript (`message.usage`) |
|---|---|---|---|
| model | `model` | `model` | `message.model` |
| input | `input_tokens` | `claude_code.token.usage`, `type: input` | `input_tokens` |
| output | `output_tokens` | `claude_code.token.usage`, `type: output` | `output_tokens` |
| cache read | `cache_read_tokens` | `claude_code.token.usage`, `type: cacheRead` | `cache_read_input_tokens` |
| cache creation | `cache_creation_tokens` | `claude_code.token.usage`, `type: cacheCreation` | `cache_creation_input_tokens` |
| cost | `cost_usd` | `claude_code.cost.usage` | none: shown as "unknown", never 0 |
| request key | `request_id` | — | top-level `requestId`, deduped with `message.id` as `usageAcc` does |

**Rules:**
- **The displayed figure is the sum of `api_request` events,** one per `request_id`. Events are per request, so each can be matched to a transcript response and back-filled one by one (§8.2 Requests check). A request with no event is filled from the transcript and labelled `transcript`.
- **The metrics are a cross-check, not a second total.** For each session and model, Data health shows the `claude_code.token.usage` and `claude_code.cost.usage` delta sums beside the event sums, and flags any difference. The table never silently picks one.
- **Labels (§8.4):** tokens are `exact` from events and from transcripts. Cost is `est.` because Mon calls `cost_usd` an estimate. A row mixing sources shows the split.
- **Totals:** total tokens is the sum of the four columns. Mon's `input` excludes cache reads and writes, so nothing is counted twice.
- **Day:** a request belongs to the local calendar day of its `event.timestamp` (transcript: its `timestamp`). Mon gives no per-day method.
- **Session:** grouped by `session.id` (transcript: top-level `sessionId`). Mon notes that `/clear` replaces it, so one conversation can span two rows. If `OTEL_METRICS_INCLUDE_SESSION_ID=false` is set, the metric cross-check loses its session key and shows per model only; doctor says so.
- **Model ids** pass `MODEL_RE`, else `other`.
- **Phase 1** renders the same tables from transcripts only (P1.4): tokens exact, cost "unknown until OTel is on". P2.6 adds the OTel sources and the back-fill.

## 8. Gap detection and back-fill

### 8.1 Keys

- **Session:** `session_id` equals `session.id`.
- **Prompt:** `prompt_id` (UserPromptSubmit) equals `prompt.id`.
- **Request:** OTel `request_id` equals the transcript's `requestId`. Transcript responses are deduped by message id plus request id, as `usageAcc` does.
- **Skill:** by name within a prompt.

### 8.2 Checks (per session, in the window)

| Check | Harness hooks say | OTel must have | Missed when |
|---|---|---|---|
| Session | SessionStart with `otel: harness` | any record | no OTel record for the session |
| Prompts | UserPromptSubmit `prompt_id`s | an event with that `prompt.id` | the id is absent |
| Skills | Skill `PreToolUse` and `UserPromptExpansion` names | `skill_activated` with that name, in that prompt | absent |
| Subagents | `SubagentStop` count | `subagent_completed` count | fewer |
| Compactions | `PostCompact` count | `compaction` count | fewer |
| Hooks | harness `timing.jsonl` lines per event | `hook_execution_complete` per `hook_event` | fewer |
| Requests | — (hooks see no requests) | `api_request` for each transcript response's request id | absent |

**The reverse check** catches the hook log failing: an OTel or transcript skill use, prompt, subagent or compaction with no record-hook line is flagged as "hook log missed N", for example an async hook killed in `-p`.

### 8.3 Back-fill order: OTel, then hooks for counts, then transcripts for tokens

| Metric | OTel | Hooks | Transcript |
|---|---|---|---|
| Tokens per request and per session | exact | no | exact (API usage as logged) |
| Cost | estimate | no | not computed (no price table in harness) |
| Tokens in context | estimate | no | estimate |
| Model | exact | exact (SessionStart, PostModelSwitch) | exact |
| Skill invoked | exact (named, per §2.2) | exact (the Skill tool, typed commands) | exact for Skill tool uses; typed ones from `invoked_skills` |
| Subagents | exact | exact (start and stop) | exact (sidechain files) |
| Compactions | exact | exact (`PostCompact`) | exact (`compact_boundary`) |
| Prompts | exact | exact (ids) | exact |

### 8.4 Labels

- **A badge on every number:** its source (`OTel`, `hooks`, `transcript` or `harness log`) and `exact` or `est.`.
- **A tooltip** with the method, using the report's `ESTIMATE` text for character-based estimates.
- **Mixed totals** show the split, for example `12,400 (OTel 11,900 · transcript 500)`.

### 8.5 What the person sees

- **A banner on any page with a gap**, for example: "Telemetry missed 3 prompts and 12 requests in the last 14 days. 12 requests filled from transcripts; 3 prompts counted from hooks, tokens unknown."
- **A Data health view** listing:
  - each source: on or off, last record, records in the window, dropped counts from `receiver.log`, parse failures;
  - each gap, by session.
- **A source that is off isn't a gap.** It shows as "off", with the opt-in.
- **A transcript removed by Claude Code's retention sweep** reads "transcript deleted (retention)", never zero.

## 9. Opt-in levels (D4, D9)

The commands are `harness telemetry on|off --level team|global [--dry-run|--yes]` and `harness telemetry status`. The dashboard's opt-in buttons run exactly these. There are exactly two levels (owner, Q-T3).

| Level | Writes | Turns on |
|---|---|---|
| team | hooks in `.claude/settings.json` (committed); `.harness/hooks/record.mjs`; the telemetry write record (§9.1) | the hook log for everyone who opens the repo |
| global | the `env` block in `~/.claude/settings.json` (below); `~/.claude/harness/bin/receiver.mjs`; `~/.claude/harness/receiver.json`; the telemetry write record (§9.1) | OTel to the harness receiver for every session on the machine, routed only to repos whose hook log is on |

**Harness never writes `.claude/settings.local.json`.** Claude Code writes that file itself, and harness can't lock against it. Any other `--level` value is a usage error (exit 2) that writes nothing.

The global `env` entries:

| Variable | Value |
|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
| `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:<port>` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `x-harness-key=<key>` |
| `OTEL_LOG_TOOL_DETAILS` | `1` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` |

The owner confirmed this list as written, including `OTEL_LOG_TOOL_DETAILS=1` and the 15 s interval (Q-T1, which also answers Q13's interval).

**Rules:**
- **Preview first.**
  - `--dry-run`, or the dashboard's preview, prints the exact diff of each file and what it turns on.
  - For team, it says the change binds every teammate.
  - For global, it lists every variable (§15 T1).
  - A team opt-in also says: "OTel can only be turned on in your user settings (Claude Code ignores it in repo files). Turn on global too?" That is a second, separate confirm.
- **Takes effect in new sessions.** OTel reads its variables once at startup (Env). From P2.9, harness's ConfigChange gate allows harness's own telemetry change in open sessions without a blocked-change notice (§9.1), and Claude Code then applies it as it applies any allowed settings change. Nothing relies on that: an open session had no SessionStart with `otel: harness`, so it isn't announced, its OTel isn't routed, and gap detection doesn't expect OTel for it (§7.1, §8.2). The preview says "takes effect in new sessions".
- **Never clobber.** Global opt-in refuses, naming the layer, when any layer the hook can see already sets `CLAUDE_CODE_ENABLE_TELEMETRY` or an `OTEL_EXPORTER_OTLP_*` endpoint. Doctor then says "OTel goes to `<host>`; harness uses its hooks and transcripts". Fan-out to both is deferred until after phase 4 (Q16), so this refusal stays until then.
- **Recorded like every harness change:**
  - the team level uses the manifest blocks (`mergeSettings` style) and backups in `.harness/backup/<ts>`, so `harness uninstall` or `off` removes them;
  - the global level uses `GLOBAL_STATE` (`~/.claude/harness/manifest.json`, `src/cli/preset.ts:61`), so `harness uninstall --global` or `off --level global` removes it.
- **`off` is the same preview and confirm, in reverse.**
  - It stops the receiver with `/shutdown`.
  - It never deletes the collected `.harness/telemetry/` data. That is a separate, explicit confirm that lists the files.
- **Guard.** `telemetry` joins `PERSON_ONLY` (`src/checks/guard.ts:93`) as `ask`, allowed for `status` and `--dry-run`, like `context apply`. Unattended turns the ask into a deny, as today.

### 9.1 ConfigChange: harness's own telemetry block is allowed (Q-T7)

Today the gate (`src/checks/config-change.ts`) blocks a mid-session change to harness's hooks, deny rules, sandbox or `env`. It allows one thing already: a project-file change the harness CLI recorded in `.harness/state/files-snapshot.json`. Telemetry adds a second, narrower allowance. **Every other change stays blocked.**

**The record.** `harness telemetry on|off` writes it, after the settings write and in the same apply lock:

| Level | Record path | Protected by |
|---|---|---|
| team | `.harness/state/telemetry-write.json` | the existing `.harness/state` protection: Edit deny, sandbox `denyWrite`, protect table |
| global | `~/.claude/harness/state/telemetry-write.json` | an `Edit(~/.claude/harness/state/**)` deny and a `denyWrite` entry for that folder, added to the harness block of each repo's `.claude/settings.json` (§15 T5 pattern; nothing extra goes in user settings) |

Each record is `{v, id, file, action, block, after, ts}`, written with `writeAtomic` and mode 0600:
- `file`: `project_settings` or `user_settings`;
- `action`: `on` or `off`;
- `block`: SHA-256 of the canonical JSON (sorted keys, no whitespace) of exactly the entries harness added or removed: the record hook groups for team, the §9 `env` keys and values for global;
- `after`: SHA-256 of the whole settings file text right after harness's write;
- `id`: 16 random bytes in base64url.

**The gate allows a change only when all of these hold:**
1. the reported source matches the record's `file`, and the file is the one the gate watches (the existing `elsewhere` rule is unchanged);
2. the file's current text hashes to `after`;
3. the guarded diff between the session baseline and the current view is exactly the recorded block: for `on`, removing entries whose canonical hash equals `block` gives back the baseline; for `off`, adding them back does;
4. the record's `id` hasn't been used in this session. A new `guardedTelemetry` session-state field holds used ids, as `guardedCli` does for the CLI record, so a record is used once;
5. the entries themselves are harness's shape, so a forged record can't pass anything else: for team, each hook group's command is exactly `node ${CLAUDE_PROJECT_DIR}/.harness/hooks/record.mjs` with `"async": true` on a §7.1 event; for global, the keys are exactly the §9 `env` list, with the §9 values and an endpoint of `http://127.0.0.1:<port>` where `<port>` is the one in `receiver.json`.

When it allows, the current view becomes the session's baseline for that file, as the CLI allowance does. When any check fails, today's block and notice apply unchanged.

**Tests (unit, `test/checks/config-change.test.ts`):**
- team `on` and `off` mid-session: allowed, no `config-change-blocked` event, no notice;
- global `on` and `off`: the same, for `user_settings`;
- one byte changed in the block after harness wrote it: blocked;
- the telemetry block plus any other change (a deny rule removed, another `env` key, `disableAllHooks`): blocked;
- a record whose `after` doesn't match the file: blocked;
- a consistent record and file whose block isn't harness's shape (another command, another endpoint or port, an extra `env` key, `OTEL_LOG_USER_PROMPTS`): blocked;
- the same record replayed a second time in the session: blocked;
- a record for `project_settings` used for a `user_settings` change, and the reverse: blocked;
- a missing, unreadable or malformed record: blocked;
- a record path that is a symlink: not read (`ensureRealDir` and `lstat`), so blocked;
- `local_settings` changes: unchanged behaviour (harness never writes that file).

**Where it ships:** P2.9 (§21), after P2.4, so both levels exist. Until P2.9 merges, a mid-session opt-in logs today's blocked-change notice; the preview says so.

## 10. Server and page

### 10.1 `harness dashboard [--days N] [--repo <path>] [--no-open] [--print-url]`

- **It refuses to start:**
  - inside Claude Code (`insideClaude`) or unattended (`src/core/unattended.ts`), with: `Run harness dashboard from your own terminal, not inside Claude Code or an unattended run.`;
  - for the agent at all: `PERSON_ONLY.dashboard` is a `deny`.
- **It binds `127.0.0.1` on a random port** (`listen(0)`), never IPv6 or another interface.
- **Launch token.**
  - It is 32 random bytes in base64url. The launch URL `http://127.0.0.1:<port>/launch?t=<token>` is opened with `openCommand` (`src/cli/report.ts`).
  - The URL is printed only when stdout is a TTY, or with `--print-url` (for tests).
  - It is good for one use. The exchange sets a session cookie `hd=<random>` (`HttpOnly`, `SameSite=Strict`, `Path=/`) and answers 303 to `/`.
  - A second exchange is refused, and shown on the page and in the terminal. Using another browser means another launch.
- **Lifetime.** The server ends on Ctrl-C or SIGHUP and keeps no state on disk.

### 10.2 Request checks (every request)

- **Host:** must equal `127.0.0.1:<port>`, else 421. This blocks DNS rebinding.
- **Origin:** when present, must equal `http://127.0.0.1:<port>`, else 403.
- **Cookie:** required everywhere except `/launch`, else 401.
- **Writes:** a `POST` also needs `x-harness-csrf` with the per-session value. JSON bodies only, at most 64 KB.
- **Headers on every response:**
  - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'`;
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`;
  - `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
- **Assets** come from strings in the bundle, never from disk paths.

### 10.3 Rendering

- **Pages are rendered on the server,** reusing the report's renderers and `h()`. Every link works without JS.
- **Client JS** is one file with no framework. It adds keyboard navigation, the theme toggle, table filter and sort, SSE live patches (phase 2) and action previews (phase 3).
  - It sets text through `textContent` only.
  - Trusted Types are required and no policy is defined, so `innerHTML` can't be used.
- **`/api/<view>`** returns the same data as JSON.
- **`/api/live`** is an SSE stream (phase 2). The server polls the stat of the repo's telemetry files and the active transcripts every 1 s, at most 64 files, and never uses `fs.watch`.

### 10.4 Repo switcher (D2)

**Discovery,** read-only and bounded:
1. list `~/.claude/projects/*/` (at most 20,000 entries, as `locate.ts` bounds it);
2. take the newest session file's first `cwd` (`firstCwd`);
3. find its git root;
4. keep the root if `.harness/manifest.json` there is a regular file;
5. add `--repo`.

The list is cached for the server's lifetime, with a refresh button.

- **The client sends an index into that list,** never a path.
- **Switching** re-roots the reads.
- **Actions** in another repo run with that repo as `cwd`, and the confirm says so.

### 10.5 Design (D7)

- **Tokens.**
  - The base is the report's CSS variables (`src/report/html-parts.ts`), plus `--ok`, `--bad`, `--focus` and `--badge-*` per source.
  - Dark and light follow `prefers-color-scheme`, with a manual `:root[data-theme]` override stored in `localStorage` (inside try/catch).
  - The system font stack only, monospace for numbers and ids.
- **Layout.**
  - A top bar with the repo switcher, the window, a data-health dot and the theme toggle.
  - A left nav: Overview, Gates, Skills, Context, Tokens, Sessions, Data health, Actions, History.
  - Dense tables: 13 px text, sticky headers, right-aligned tabular numbers, rows at most 28 px high.
  - Tiles with sparklines, and gauges.
- **Charts.**
  - Inline SVG with `role="img"`, an `aria-label` and a `<title>` per mark, plus a text table next to each chart (the report's `chart()` pattern).
  - Colours from tokens only.
  - No motion under `prefers-reduced-motion`.
- **Keyboard:**

  | Keys | Action |
  |---|---|
  | `g` then `o` `g` `s` `c` `t` `l` `h` `a` `y` | go to a view |
  | `/` | filter |
  | `j` / `k` | move between rows |
  | `Enter` | open a row |
  | `[` / `]` | change the window |
  | `r` | switch repo |
  | `?` | help |
  | `Esc` | close |

  There is also a skip link, `:focus-visible` rings of at least 2 px, native controls only, and dialogs with a focus trap and focus return.
- **Accessibility.**
  - WCAG 2.1 AA contrast: text at least 4.5:1; UI parts and chart marks at least 3:1. A test checks every token pair (§20.1).
  - Headings in order, `th scope` on headers.
  - Status is never shown by colour alone.

### 10.6 uPlot for trend charts (D10)

**Facts**, checked on 2026-11-16 from `npm view uplot` and the `uplot-1.6.32.tgz` tarball:

| Fact | Value |
|---|---|
| Version | `1.6.32`, published 2025-03-14 |
| Repository | `github.com/leeoniya/uPlot` |
| Licence | `MIT` in the npm metadata; the tarball's `LICENSE` reads "The MIT License (MIT) Copyright (c) 2022 Leon Sorokin" |
| Dependencies | none |
| Integrity | `sha512-KIMVnG68zvu5XXUbC4LQEPnhwOxBuLyW1AHtpm6IKTXImkbLgkMy+jabjLgSLMasNuGGzQm/ep3tOkyTxpiQIw==` |
| Size | `dist/uPlot.iife.min.js` is 51,081 bytes (22,009 gzipped at level 9); `dist/uPlot.min.css` is 1,857 bytes (772 gzipped); the whole package unpacked is 545,468 bytes, of which only the two files above ship |
| CSP fit | a search of `dist/uPlot.esm.js` found no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval(`, `new Function` or `cssText`, so it should run under `script-src 'self'` with Trusted Types required. P4.1 confirms this in a browser |

**How it ships:**
- `package.json` gets `"uplot": "1.6.32"` in `devDependencies`, exact with no range. The lockfile pins the integrity above.
- `build.mjs` inlines the two dist files as strings into `dist/cli.mjs`, as it does the client JS. They are served at `/assets/uplot.min.js` and `/assets/uplot.min.css` from `127.0.0.1` only.
- There is no CDN, no runtime fetch, and no `dependencies` entry.
- The MIT notice ships with the asset, as a header comment in the served file, and in a `THIRD_PARTY_NOTICES` file added to the package `files`.
- **Theming:** colours are read from the CSS tokens with `getComputedStyle`, so dark and light follow the page.
- **Accessibility:** uPlot draws on a canvas, so each chart keeps the §10.5 text table beside it, plus an `aria-label` on its wrapper.
- **Upgrades** are a deliberate PR. A test checks the bundled bytes against the pinned version's files (§20.1).

## 11. Phase 3: Control (D6)

### 11.1 How an action runs

1. **List.** The Actions view lists what can be done now, each with its exact command.
2. **Preview** runs the CLI with `--dry-run`:
   - `process.execPath` with the packaged `dist/cli.mjs`;
   - `cwd` set to the repo, `shell: false`, and `CLAUDECODE` removed from the environment.

   The output and diff are shown verbatim, escaped.
3. **Apply.** A second click (with the CSRF header) runs the same command with `--yes`. A command without `--dry-run` shows fixed text describing the change, and a confirm.
4. **Arguments come from fixed templates.**
   - Ids must pass `ID_RE`.
   - File arguments must be paths the server listed (for example `.harness/tmp/<w>/task.json`, with its `realpath` inside the repo).
   - No free text from the page or from repo files reaches argv.
5. **The CLI makes the backups, locks and manifest entries,** as today. The dashboard never writes a repo file itself.
6. **Audit.** Each applied action appends a `dashboard` / `action-applied` event to `events.jsonl` with the command id and exit code.
7. **Stale preview.** If a file changed between preview and apply (hash compare), apply refuses and asks for a new preview.

### 11.2 Actions

| Action | Command | Preview |
|---|---|---|
| Pause or resume TDD | `harness tdd off` / `on` | fixed text |
| Approve, edit or close a task contract | `harness task …` | the criteria, as `task` prints them |
| Apply context recommendations | `harness context apply <n> --dry-run` / `--yes` | diff |
| Count context exactly (uploads text to the count API) | `harness context --json` | fixed text naming the upload |
| Change a config value, including the `checks.*` gate toggles | `harness config set <key> <value> --dry-run` / `--yes` (§11.3) | diff |
| Remove an item | `harness remove <id> --dry-run` / `--yes` | diff |
| Remember a decision | `harness remember …` | as the CLI prints |
| Telemetry on or off | `harness telemetry … --dry-run` / `--yes` | diff |
| Uninstall | `harness uninstall --dry-run` / `--yes` | diff |
| Report and export | `harness report [--export]` | none (it writes only `.harness/reports/`) |
| Add an item, update, sync, init | these refuse outside Claude Code (`refuseOutsideClaude`) | shown as a copyable `/harness:<cmd> …` line |

**Commands that refuse inside Claude Code** (`tdd off` and the person-only ones) run normally from the dashboard. The dashboard refuses to start inside Claude Code, and it spawns the CLI without `CLAUDECODE`, so the person's click is the person-only step.

### 11.3 `harness config set <key> <value> [--dry-run|--yes]` (D12)

- **Key.**
  - A dotted path present in the config rule table (`src/core/config.ts`), for example `checks.tdd` or `stop.max_attempts`.
  - Unknown keys and list or object roots (`items`, `apps`, `preset`) are refused.
- **Value.**
  - Parsed as one YAML scalar, or as a flow list for list keys.
  - The whole changed config must pass `validateConfig` (strict), with the same messages, so a bad value writes nothing.
  - The error never echoes the value, as the config rules do today.
- **Write.**
  - Only that key changes in the YAML document, and the rest of the file's text is kept.
  - It goes through the existing apply path, with a backup in `.harness/backup/<ts>`, `apply.lock`, and the manifest hash for `.harness/config.yaml`.
  - `--dry-run` prints the diff, and without `--yes` the CLI asks for a yes.
- **Protect:**
  - `.harness/config.yaml` stays protected;
  - the command is the only new way in, and it runs outside the agent;
  - mid-session, change detection reports the change as it reports a hand edit (`harness-files-changed`).
- **Person-only gating, as the other config changes:**
  - **guard `deny`:** any change that loosens enforcement — a `checks.*` key to `false`, `sandbox` to `off`, `stop.allow_local` to `true`, `stop.allow_write` or `stop.allowed_domains` added to, `unattended.*` relaxed. This mirrors `tdd off`;
  - **guard `ask`** for every other change;
  - **allowed** with `--dry-run`;
  - refused in unattended runs.
- **Exit codes:** 0 applied or no change, 1 refused or invalid, 2 usage.
- **Its own PR** (P3.1), before the action runner.

### 11.4 Why an agent can't drive it

- **It can't start the dashboard:** `PERSON_ONLY.dashboard` denies it, and the dashboard refuses inside Claude Code and in unattended runs.
- **The launch token is one-use.** By the time an agent could read the opener's argv or the browser history, it is spent. A second exchange is refused and shown.
- **The session lives in an `HttpOnly`, `SameSite=Strict` cookie** (§22).
- **A `POST` needs the CSRF value.**
- **Cross-site requests and DNS rebinding are refused** (§10.2).
- **Whether sandboxed Bash can reach a `127.0.0.1` port** is Q8.

## 12. Phase 4: History and proof

### 12.1 Daily rollups

- **File:** `.harness/telemetry/daily/<YYYY-MM-DD>.json`, counts only, one for each completed day not yet rolled.
- **Built by:**
  - the async SessionEnd record hook, from harness's own logs (events, timing, invocations, OTel);
  - the dashboard and `harness report`, which add transcript counts for days whose transcripts still exist.
- **Schema:** the report export's counters (`buildExport`), plus the invocation, OTel and gap counters.
- **Retention:** `telemetry.rollup_days`, default 400. Rollups outlive transcripts, which Claude Code's retention sweep removes.

### 12.2 Views

- **Trends:** tokens, cost, gates, false blocks, the skills hit rate, the context total and hook p95, by day and by week, drawn with uPlot (D10, §10.6).
- **Done-contract verdicts over time:**
  - from `.harness/verdicts/<commit>.json` (done PR 4 and later, not on `main` yet): outcomes, the false-done rate (done spec §6), tamper denies and blocked reasons;
  - until then, it shows the `false-done-claim` events that exist today (`src/checks/stop/done-claim.ts:74`).
- **Team export:** `harness report --export` at schema 2, adding the invocation, OTel and gap counters under the same allowlist (`exportProblems`). Counts only.

## 13. On-disk formats and retention

**Where new repo files go:** all of them live under `.harness/telemetry/`. That folder is added to:
- `HARNESS_LOCAL` (gitignored);
- `PROTECTED` and `PROTECTED_CONCRETE`;
- the `Edit(./.harness/telemetry/**)` deny;
- the sandbox `denyWrite`.

It is **not** in `DENY_WRITE_SKIPPED`: only the record hook and the receiver write there, and both run outside the sandbox.

**How lines are written:** every line starts with `"v":1`, and all writes use the #250 helpers (§14.3).

| File | Line | Bound |
|---|---|---|
| `telemetry/invocations.jsonl` | `{v, ts, session, prompt?, event, name?, source?, kind?, agent?, aid?, trigger?, from?, to?, reason?, model?, otel?, use?}` | rotated at 5 MB to `.1` (two files) |
| `telemetry/otel/<YYYY-MM-DD>.jsonl` | `{v, rx, kind: "log" or "metric", name, session, prompt?, seq?, ts, value?, attrs: {allowlisted}}` (metrics as deltas) | `telemetry.retention_days` (30) and `telemetry.max_mb` (50) per repo; the oldest day goes first |
| `telemetry/daily/<YYYY-MM-DD>.json` | counts only | `telemetry.rollup_days` (400) |
| `telemetry/cache/<session>.json` | transcript-derived per-session counts, keyed by the transcript's size and mtime | 5,000 files, 90 days |
| `~/.claude/harness/receiver.json` | `{v, port, key, created}`, mode 0600 | one file |
| `~/.claude/harness/receiver/lock/owner` | `{pid, nonce, port, version, started}` | one file |
| `~/.claude/harness/receiver/announce/<session>.json` | `{v, root, ts}`, mode 0600 | 7 days, 10,000 files |
| `~/.claude/harness/receiver/receiver.log` | one line per error class, with counts, never payloads | 1 MB, two files |
| `.harness/state/telemetry-write.json`, `~/.claude/harness/state/telemetry-write.json` | `{v, id, file, action, block, after, ts}` (§9.1), mode 0600 | one file each, replaced on each write |

**Valid `event` values** in `invocations.jsonl`: `skill`, `prompt`, `command`, `subagent-start`, `subagent-stop`, `compact-pre`, `compact-post`, `model-pre`, `model-post`, `session-start`, `session-end`, `receiver-start-failed`.

**The retention sweep** runs in the receiver (hourly) and in the SessionEnd record hook. It deletes only:
- harness-created files under `.harness/telemetry/` and `~/.claude/harness/receiver/`;
- that match the exact name patterns above;
- that `lstat` shows to be regular files.

It never follows a symlink. These are harness's own logs, not the person's files. **Telemetry `off` deletes collected data only after its own confirm (§9).**

**Existing files:** `events.jsonl` rotation and protection are a separate PR, done now, outside this spec (owner, Q14). This spec doesn't change `events.jsonl`.

## 14. Security

### 14.1 Threat model

**The actor** is the drifted or prompt-injected agent of the isolation spec (§2.1 there). It runs as the person's uid, writes repo files and runs Bash, sandboxed or not. Its words and tool calls are in the transcripts.

| It tries to | Answer |
|---|---|
| Inject script through a file name, skill name, reason text, transcript text, or another repo's `.harness` | `h()` on the server (HTML plus control, zero-width and bidi characters); `textContent` only in the client; Trusted Types required; `script-src 'self'` with no inline script. Hostile fixtures are fed to every view (§20.2). |
| Plant numbers the dashboard trusts | `.harness/telemetry/` is outside the sandbox write set and Edit-denied. `events.jsonl` and `timing.jsonl` stay plantable (§4), so their rows are labelled `harness log` and cross-checked against OTel hook counts. Every parser caps line length (`MAX_LINE`) and key count (`MAX_KEYS`). |
| Make the dashboard or receiver write elsewhere: a symlinked folder or file, or a forged announcement | `ensureRealDir` plus `APPEND_NOFOLLOW` (§14.3); the announced root must have a manifest and match the transcript `cwd`; no write path ever comes from file content, config values or the page. |
| Drive a control | §11.4 |
| Turn content capture on | the receiver's allowlist drops content whatever Claude Code sends; doctor flags content variables in any layer. |
| Post fake OTel from a web page or another local process | the header key, no `Origin`, the `Host` check and the refused CORS preflight (§7.2.2). A same-uid process that reads `~/.claude/settings.json` can still post fake OTel (§22). |
| DNS rebinding or CSRF | an exact `Host` check; a `SameSite=Strict` cookie plus a CSRF header; `frame-ancestors 'none'`. |
| Exhaust disk or memory | §13 bounds, body caps, the unannounced-session cap, at most 64 polled files, at most 8 SSE clients. |

Out of scope, as in the isolation spec: the person, kernel escapes, and a compromised Claude Code or Node.

### 14.2 Other local users

Other uids on the same machine can connect to `127.0.0.1`. The dashboard needs the one-use token and then the cookie. The receiver needs the key, stored with mode 0600.

### 14.3 No-follow writes (depends on PR #250)

PR #250 (`fix/safe-writes`, open) adds to `src/core/atomic.ts`:
- `ensureRealDir(root, rel)`: makes the folder if missing, and throws if it, or any folder above it inside `root`, is a symlink or not a folder;
- `APPEND_NOFOLLOW`: an `O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW` flag, so a linked file fails with ELOOP.

This spec uses them for every new write:
- appends use `ensureRealDir` plus `APPEND_NOFOLLOW`;
- whole-file writes (rollups, cache, announcements, `receiver.json`) use `ensureRealDir` plus `writeAtomic`, whose rename replaces a planted link instead of writing through it;
- `~/.claude/harness/...` paths use the home folder as `root`.

**#250 must merge before P2.1.** PR #250 itself states the remaining limit, a microsecond race between the check and the open.

## 15. Touchpoints with Claude Code's own configuration (D13)

Every place this feature touches Claude Code's config or behaviour, whether it could conflict with Claude Code's own harness or agentic tools, and whether the owner must confirm it. Revision 3 records the owner's answers for T1, T3, T4, T7 and T8. **T2 is the only touchpoint still open; it waits on live check L4 (Q7 in §24).**

| # | Touchpoint | Could it conflict? | Owner confirms |
|---|---|---|---|
| T1 | **Global settings `env`** (§9): `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*_EXPORTER`, the endpoint, the protocol, the headers, `OTEL_LOG_TOOL_DETAILS=1` and `OTEL_METRIC_EXPORT_INTERVAL=15000`, in `~/.claude/settings.json` | **Yes.** It applies to every Claude Code session on the machine, in every repo. `OTEL_LOG_TOOL_DETAILS=1` makes Claude Code put Bash commands and tool input in its OTel events; the receiver drops them, but if the person later points OTel elsewhere without removing the variable, that content goes there. The 15 s interval changes export cadence for all sessions. A managed or org OTel setup takes precedence, so global opt-in refuses then. | **Resolved:** the owner confirmed the list as written, with `OTEL_LOG_TOOL_DETAILS=1` and the 15 s interval (Q-T1) |
| T2 | **Async hooks in repo settings** (§7.1): `PreToolUse` with the `Skill` matcher, `UserPromptSubmit`, `UserPromptExpansion`, `SubagentStart`/`Stop`, `PreCompact`/`PostCompact`, `PreModelSwitch`/`PostModelSwitch`, `SessionStart` (all sources) and `SessionEnd` | **Low for most.** They are async and print nothing, so they can't decide or inject. They count in Claude Code's own `hook_execution_*` telemetry and show in `/hooks`. `disableAllHooks` or `allowManagedHooksOnly` turns them off, and then OTel isn't routed. **Possible on the pre events:** PreCompact stdout becomes compaction instructions, and a PreModelSwitch hook cancelled at its timeout blocks the switch (Hooks). Harness prints nothing and uses `async`, but whether async fully avoids both is unverified. | **Yes, for the pre events:** keep them or record the post events only (Q7) |
| T3 | **`.claude/settings.local.json`** | **None now.** Claude Code writes that file itself, so a harness write could race with it. The owner dropped the level that needed it: harness never writes this file (§9). | **Resolved** by dropping the level (Q-T3) |
| T4 | **SessionStart and other record hooks start the receiver**: a detached background process that outlives the session and listens on a loopback port | **Possible.** It is a long-lived process started from a Claude Code hook. Whether Claude Code reaps a hook's detached children, in `-p` teardown or otherwise, is unverified. The port could collide with another local tool (default 4320, a free one picked at opt-in, and a busy port fails closed). | **Resolved:** approved. A dead receiver is restarted by the next record hook or `harness dashboard`, and gaps are back-filled with a notice (§7.2.1, §8). L7 still checks reaping (Q-T4) |
| T5 | **Permission and sandbox entries:** the `Edit(./.harness/telemetry/**)` deny, the `.harness/telemetry` entry in the sandbox `denyWrite`, the `~/.claude/harness/state` Edit deny and `denyWrite` entries (§9.1), all in the repo's `.claude/settings.json`; the protect table; and guard `PERSON_ONLY` entries (`dashboard` deny, `telemetry` ask, `config` ask or deny) | **No.** They follow the existing harness pattern and narrow only harness's own files and commands. The guard asks show in Claude Code's permission prompt, as today's do. | No |
| T6 | **Reading Claude Code's files:** transcripts (`~/.claude/projects`), the settings layers (for refusal checks and doctor) and the projects list for the switcher, all read-only | **No.** Read-only, bounded, symlink-refusing, as `locate.ts` does today. | No |
| T7 | **Settings changed mid-session** by `harness telemetry` or dashboard actions | **Harness against harness, visible in Claude Code,** until P2.9. Without it, harness's own ConfigChange gate blocks the mid-session hook or env change and the person may see the notice. OTel picks up env only at startup anyway. The preview says "takes effect in new sessions". | **Resolved:** the gate allows harness's own telemetry block, matched by content hash of exactly what harness wrote; every other change stays blocked (§9.1, P2.9) (Q-T7) |
| T8 | **Files under `~/.claude/harness/`** (`bin/`, `receiver/`, `receiver.json`, `state/telemetry-write.json`) | **Possible.** They are inside Claude Code's config folder, in harness's existing subfolder (global presets already use it). Whether Claude Code's retention sweep or plugin sync ever touches unknown subfolders is unverified. `CLAUDE_CONFIG_DIR` is honoured through `claudeConfigDir()`. | **Resolved:** kept there, as a known limit (§22); doctor detects missing files (§19) (Q-T8) |
| T9 | **Claude Code's UI** | **No.** There is no status line (D11), no `systemMessage` or `additionalContext` from record hooks, and the dashboard runs outside Claude Code. Async hook completion notices appear only in verbose mode (Hooks). | No |
| T10 | **Claude Code's sandbox and network:** the dashboard and receiver run outside it; harness doesn't add loopback or domains to any allowlist | **No change.** Whether sandboxed Bash can reach them is a security question (Q8), not a config change. | No |

## 16. Performance budgets

Budgets reuse `test/perf/overhead.ts` (paired spawns against a bare `node`). They are targets, checked in `test:perf`.

| What | Budget |
|---|---|
| Turn latency added by the record hooks | 0: they are async, so Claude Code doesn't wait (Hooks) |
| `record.mjs` process above bare node | under `OVERHEAD_MS` (100 ms on Linux, 150 on macOS, 450 on Windows); the median is printed |
| Ensure step | under 15 ms |
| Existing sync hooks | unchanged: no new code in `dispatch.mjs` |
| `record.mjs` bundle | under 60 KB |
| Receiver memory | RSS under 80 MB steady after 50,000 records; unannounced buffer at most 5 MB |
| Receiver CPU | at most 1 % of one core when idle; a 4 MB body parsed in under 200 ms |
| Dashboard first page | under 3 s on 14 days and 200 sessions |
| Dashboard memory | under 300 MB on the same fixture |
| SSE poll | at most 64 stats per second |

## 17. Failure modes

The rule: **capture fails open and quiet, and is shown; controls fail closed.**

| Failure | Effect | Shown as |
|---|---|---|
| The record hook crashes or can't write | the line is lost; Claude Code is unaffected | "hook log missed N" (§8.2 reverse check) |
| An async hook is killed at `-p` teardown | the line is lost | a gap |
| The receiver is down, crashed, idle-exited, or its port is busy | OTel data for that window is lost; the next record hook restarts it | a gap with back-fill; doctor shows `receiver: not running (<reason>)` |
| A receiver write fails, or the disk is full | the record is dropped and counted | Data health shows "dropped N" |
| Malformed OTLP, or an unknown field | skipped and counted; the rest gets 200 | Data health |
| The transcript format changes | counts show unknown, never zero; the untested-version banner appears | banner |
| A transcript is deleted by retention | the rollups remain | "transcript deleted (retention)" |
| A teammate has no global opt-in | no OTel for them | "OTel off on this machine", with the opt-in |
| The hook log is off in a repo with global OTel on | sessions aren't announced, so nothing is written | Data health: "turn on the hook log to receive OTel here" |
| The dashboard crashes | nothing is lost; restart it | — |
| An action fails: preview and apply differ, the CLI exits non-zero, or the lock is held | not applied, or the CLI rolls back | the CLI's message, verbatim |

## 18. Config keys

New keys in `.harness/config.yaml` (protected). They are added to the rule table in `src/core/config.ts`, which makes them settable by `harness config set`:

| Key | Default | What |
|---|---|---|
| `telemetry.retention_days` | `30` | days of `telemetry/otel/` kept (1 to 365) |
| `telemetry.max_mb` | `50` | `telemetry/otel/` size cap per repo (5 to 1000) |
| `telemetry.rollup_days` | `400` | days of `telemetry/daily/` kept (30 to 3650) |

**Not in config:**
- the opt-in state, which is the settings entries themselves;
- the receiver port, which lives in `receiver.json` (default 4320, §7.2.1).

## 19. CLI, guard, doctor, status, uninstall

| Command | Who | What |
|---|---|---|
| `harness dashboard [--days N] [--repo <path>] [--no-open] [--print-url]` | person only (guard `deny`; refuses inside Claude Code and in unattended runs) | §10 |
| `harness telemetry on\|off --level team\|global [--dry-run\|--yes]` | person (guard `ask`; preview allowed) | §9 |
| `harness telemetry status` | anyone | levels on, sources and last record, receiver state, gap counts |
| `harness config set <key> <value> [--dry-run\|--yes]` | person (guard `ask`, or `deny` when it loosens enforcement) | §11.3 |
| `node record.mjs` | hooks only | §7.1 |
| `node receiver.mjs` | spawned by `record.mjs` | §7.2 |

- **Doctor** gains:
  - receiver health, version, port and lock;
  - on a machine that opted in globally (per `GLOBAL_STATE`), a missing `receiver.json`, `bin/receiver.mjs` or `receiver/` folder under `~/.claude/harness/`, named by path, with "re-run `harness telemetry on --level global` to restore it". Claude Code's sweeps may remove unknown subfolders (§22), so this is reported, never silently recreated by doctor;
  - `OTEL_METRICS_INCLUDE_SESSION_ID=false` in a layer harness reads (§7.4);
  - a foreign OTel endpoint;
  - content variables that are set;
  - `.harness/telemetry` protection;
  - `record.mjs` present and matching its hash;
  - the warning "hook log off, so OTel isn't routed here";
  - for the team level, a note that each teammate must opt in globally.
- **Status** gains one line: `Live data: hook log on (team), OTel on (global, receiver running), gaps last 7 days: 3`.
- **Uninstall:**
  - `harness uninstall` removes the repo entries and `record.mjs`;
  - `harness uninstall --global` removes the global env entries, the bin file, `receiver.json` and `state/telemetry-write.json`;
  - collected data is listed and kept unless the person confirms.
- **README:** updated in each PR.

## 20. Testing

### 20.1 Unit (no network, no `claude`)

- **Server:**
  - the Host, Origin and cookie matrix;
  - the one-use exchange;
  - CSRF and body caps;
  - every security header on every route;
  - the refusals;
  - `PERSON_ONLY.dashboard` in the guard's spellings;
  - the switcher accepting an index only.
- **Escaping:** every view rendered with hostile values (`<script>`, `"><svg onload>`, bidi and zero-width characters, 16 MB lines, 10,000 distinct names). Checks: no raw `<` from data, and every cap holds.
- **Contrast:** every token pair meets AA, in both themes.
- **Record hook:**
  - the field allowlist per event. These never reach the file, asserted on the bytes: prompt text, `command_args`, `prompt`, `custom_instructions`, `compact_summary` and `last_assistant_message`;
  - the name rule;
  - no stdout ever;
  - the `otel` values;
  - rotation;
  - ensure, with a live pid, a dead pid, and a spawn failure.
- **Receiver:**
  - the allowlist drops identity and content attributes;
  - routing, the `cwd` cross-check, and the unannounced TTL and cap;
  - a symlink at each path component is refused (through `ensureRealDir`);
  - the key, `Origin`, `Host` and 413;
  - the lock, a stale break, `EADDRINUSE`, idle exit and `/shutdown`;
  - the sweep deletes only pattern-matched regular files.
- **Gaps:** every §8.2 check, the reverse check, and the §8.3 matrix with one source missing at a time; labels and splits; "deleted (retention)" vs "unknown".
- **Live numbers:** tokens in context from OTel and from the transcript fallback; cost sums; no percentage is ever rendered (§2.3).
- **Per-model breakdown (§7.4):**
  - per day, per session and window totals from `api_request` fixtures, one row per model, with the four token columns and cost;
  - a request seen twice (same `request_id`) counts once;
  - a request missing from OTel is filled from the transcript, labelled `transcript`, with cost "unknown", never 0;
  - metric delta sums that differ from the event sums are flagged in Data health, and the table keeps the event sums;
  - day buckets follow the local calendar day, including a request just before and just after midnight;
  - a model id failing `MODEL_RE` shows as `other`.
- **Opt-in:**
  - an exact preview per level;
  - any `--level` value other than `team` or `global` exits 2 and writes nothing;
  - no level ever creates or changes `.claude/settings.local.json`, asserted on the file's bytes and mtime;
  - the telemetry write record (§9.1) is written per level, with `after` equal to the file's hash;
  - a foreign OTel setup refuses;
  - `off` restores byte for byte;
  - manifest and backup entries;
  - `uninstall` and `uninstall --global`;
  - **no `statusLine` key is ever written at any level** (D11).
- **`config set`:**
  - a key path that isn't in the table is refused;
  - list and object roots are refused;
  - each `validateConfig` failure writes nothing, and the error never echoes the value;
  - the other text in the file is preserved;
  - a backup and the manifest hash are written;
  - the guard denies every loosening class and asks for the rest;
  - an unattended run is refused.
- **ConfigChange allowance:** the §9.1 cases.
- **Doctor:** each missing `~/.claude/harness/` file (§19) is named; nothing is recreated.
- **uPlot asset:** the inlined bytes equal `dist/uPlot.iife.min.js` and `dist/uPlot.min.css` from `uplot@1.6.32`; the version in `package.json` is exact; the MIT header is present; no served byte loads a remote URL.
- **Actions:**
  - arguments come from templates only;
  - a hash mismatch refuses;
  - the environment has no `CLAUDECODE`;
  - copy-only commands are never spawned.

### 20.2 End to end (temp repos, a fake `HOME`, no network)

- **Dashboard:** started with `harness dashboard --no-open --print-url`. Cases:
  - the token exchange;
  - every view with hostile fixtures;
  - CSP and the other headers;
  - no URL in any served byte except `127.0.0.1`;
  - a rebinding `Host`, a cross-site `POST`, and a missing CSRF header are each refused;
  - SSE shows an appended line within 2 s;
  - the switcher lists exactly the two harness repos out of three;
  - `context apply` and `config set`, each through preview, apply and backup.
- **Receiver:** a real receiver fed recorded payloads, with the files then checked on disk. After a kill, the next record hook restarts it, and so does a `harness dashboard` start; the gap between shows in Data health.

### 20.3 Transcript parser fixtures

- **Layout:** `test/fixtures/transcripts/<claude-version>/`, holding recorded transcripts scrubbed of text (the existing `make.ts` approach) and an `expected.json` of counts.
- **Coverage:** one folder per version in `TESTED`, plus each newly seen version.
- **Checks:**
  - unknown record types are counted, never fatal;
  - duplicate streamed entries are deduped;
  - sidechain and resumed sessions are handled.

### 20.4 OTel recorded payloads

- **Layout:** `test/fixtures/otel/<claude-version>/{json,protobuf}/`, captured in L1. A script scrubs every string while keeping its length.
- **Checks:**
  - JSON and protobuf decode to the same allowlisted records;
  - truncated, oversized and wrong-wire-type inputs are refused without a crash;
  - a 10,000-mutation fuzz pass throws nothing past the request handler.

### 20.5 Perf (`test:perf`)

The §16 rows.

### 20.6 Live batches (owner's subscription; Terminal panel; scripts in `harness-wt/live`; a yes for each batch)

| Batch | Checks | Gates |
|---|---|---|
| L1 OTel capture | JSON and protobuf payloads with `OTEL_LOG_TOOL_DETAILS=1`: the names of the `api_request` token attributes; the `plugin_loaded` and `mcp_server_connection` fields; whether `Origin` is sent; payload sizes; retry when the receiver is down (Q3, Q4) | P2.3, P2.5 |
| L2 Skill names | project, user and plugin skills, verbatim or placeholder (Q2); `UserPromptExpansion` on a typed `/skill` (Q18) | P2.3 |
| L4 Async hooks | `async` on `PreCompact` and `PreModelSwitch` neither blocks nor injects; loss in `-p` (Q7) | P2.1 |
| L5 Sandbox and loopback | whether sandboxed Bash can reach the dashboard or receiver port (Q8) | P1.1, P2.3 |
| L6 Env precedence | shell `OTEL_*` against the user-settings `env` (Q5) | P2.4 |
| L7 Touchpoints | whether the receiver survives `-p` teardown and session end, and is restarted by the next hook or `harness dashboard` (Q-T4); a mid-session team and global opt-in in an open session shows no blocked-change notice, and a hand edit next to it still does (Q-T7) | P2.4, P2.9 |

### 20.7 Browser tests (CI only)

The owner approved Playwright for keyboard and axe tests, in CI only and never shipped (Q12).
- **Packages:** `@playwright/test` and `@axe-core/playwright`, each an exact-pinned `devDependency` at the version current when P1.2 is cut, with the lockfile integrity. Neither is in `dependencies` or the package `files`, and `build.mjs` never bundles them. A §20.1 test asserts that no served byte and no file in the packed tarball comes from either.
- **Where:** `test/browser/*.spec.ts`, run by `pnpm test:browser` against `harness dashboard --no-open --print-url` on fixture repos. `pnpm test` doesn't run them, so local runs need no browser.
- **Checks:**
  - every §10.5 key binding, the skip link, focus order, the focus trap and return in dialogs, and a visible focus ring on each focusable element;
  - `@axe-core/playwright` on every view in both themes, with zero WCAG 2.1 AA violations;
  - P4.1's uPlot page loads under the §10.2 CSP with Trusted Types required and logs no CSP violation.
- **CI job:** `dashboard-browser` in `.github/workflows/ci.yml`, on `ubuntu-latest`, Chromium only. Steps: checkout, pnpm and Node 22 as the other jobs, `pnpm install --frozen-lockfile`, restore the browser cache, `pnpm exec playwright install --with-deps chromium`, `pnpm build`, `pnpm test:browser`.
- **Browser cache:** `actions/cache` on `~/.cache/ms-playwright`, keyed by `runner.os` and the installed `@playwright/test` version read from the lockfile, so a version bump downloads a new browser once.
- **Lands in** P1.2, with the keyboard client; P1.3 to P1.5 and P4.1 add their views to it.

## 21. Rollout

- **Size.** Each PR is cut from `main`, stays within 400 changed non-test lines and 20 non-test files, and updates the README in the same PR. Sizes are estimates.
- **Order.** PRs go in phase order. Each depends only on earlier rows and on #250 where noted. Each phase ends shippable.

| # | PR | After | Live gate | Size (est.) |
|---|---|---|---|---|
| **Phase 1: See** | | | | |
| P1.1 | `collect()` to `src/report/collect.ts`; the `harness dashboard` server: bind, one-use token, cookie, Host/Origin/CSRF checks, headers, refusals, `PERSON_ONLY.dashboard`, opening the browser, the Overview view | — | L5 | ~380 |
| P1.2 | Design system: tokens, dark and light, shell, nav, keyboard client JS, focus, theme, contrast test; `build.mjs` inlines the client; Playwright and axe devDependencies, `test:browser` and the `dashboard-browser` CI job (§20.7) | P1.1 | — | ~390 |
| P1.3 | Gates view (blocked what and why, tallies, false blocks, latency, Stop steps) and Skills view | P1.2 | — | ~300 |
| P1.4 | Context, Tokens and Stop sandbox views; the per-model tables from transcripts (§7.4) | P1.2 | — | ~340 |
| P1.5 | Repo switcher (discovery, index only, re-root); docs | P1.3, P1.4 | — | ~250 |
| **Phase 2: Live** | | | | |
| P2.1 | `.harness/telemetry/` in protect, Edit deny, `denyWrite` and `HARNESS_LOCAL`; the `record.mjs` bundle; async hooks (`telemetry.fragment.json`); allowlist; rotation | P1.5, #250 | L4 | ~350 |
| P2.2 | `harness telemetry on\|off\|status` for the team level: previews, manifest, backups, the team write record (§9.1), uninstall; doctor and status lines | P2.1 | — | ~340 |
| P2.3 | Receiver core: OTLP/HTTP JSON, request checks, allowlist, announcements and routing, lock, idle exit, log; `dist/receiver.mjs` | P2.2 | L1, L2, L5 | ~390 |
| P2.4 | Receiver lifecycle (ensure from hooks and `harness dashboard`, restart), retention sweep and caps; the global level (env, port 4320 or a free one, bin copy, `receiver.json`, the global write record, global manifest, `uninstall --global`); doctor's missing-file checks | P2.3 | L6, L7 | ~390 |
| P2.5 | OTLP protobuf decoder, tested on recorded payloads | P2.3 | L1 | ~300 |
| P2.6 | Gap detection (hooks against OTel), reverse check, transcript back-fill, labels, Data health view, banners; transcript cache; OTel sources and metric cross-check for the per-model tables (§7.4) | P2.4 | — | ~395 |
| P2.7 | Sessions and the live session view: SSE, tokens-in-context gauge, timeline, per-skill and per-hook cost | P2.6 | — | ~360 |
| P2.8 | Inventory panel: hooks registered, plugins loaded, MCP connections (OTel), plus agents, commands and MCP from repo files | P2.7 | — | ~200 |
| P2.9 | ConfigChange allowance for harness's own telemetry block, team and global (§9.1), its tests, and the `~/.claude/harness/state` deny entries | P2.4 | L7 | ~250 |
| **Phase 3: Control** | | | | |
| P3.1 | `harness config set` (§11.3): validation, preview, backup, manifest, guard deny and ask classes, unattended refusal (D12) | P2.8, P2.9 | — | ~300 |
| P3.2 | Action runner: templates, preview, apply, hash recheck, audit event, copy-command path | P3.1 | — | ~350 |
| P3.3 | The §11.2 action table: task, tdd, context, config, remove, telemetry and uninstall flows | P3.2 | — | ~300 |
| **Phase 4: History and proof** | | | | |
| P4.1 | Daily rollups (SessionEnd, dashboard, report), retention, the Trends view with uPlot (exact-pinned devDependency, bundled asset, notices, a CSP and Trusted Types browser check) | P3.3 | — | ~380 |
| P4.2 | Done-contract verdicts over time, and the false-done trend | P4.1, done PR 7 | — | ~250 |
| P4.3 | Export schema 2 (counts only) and the export action | P4.1 | — | ~250 |
| P4.4 | Known limits, reference, README wrap-up, release | All | — | ~150 |

**That is 21 PRs.** Compared with revision 1, the status line PR and D0 are gone (D11 and #250), and `config set` is added. Revision 3 adds P2.9, and P2.2 covers the team level only.

**Closest to the limit:** P2.6, P2.3, P1.2, P2.4 and P1.1. If one grows past it:
- P2.6's banners move to P2.7;
- P2.3's log and `/shutdown` move to P2.4;
- P1.2's browser job becomes its own PR before P1.3;
- P2.4's sweep becomes its own PR;
- P1.1's Overview moves to P1.2.

## 22. Known limits

- **OTel is machine-wide** (D9). It can't be enabled per repo or for a team, so each person opts in globally. Sessions in other repos export to the receiver and are dropped after 10 minutes in memory.
- **OTel reaches a repo only while its hook log is on.** The hook log announces sessions and keeps the receiver up.
- **No rate limits and no context-window percentage:**
  - rate limits came only from the status line, which D11 removes;
  - **a context-window percentage isn't possible from Claude Code's built-in data without the status line.** No OTel metric, event or attribute and no hook input reports the window size; the related env variables and settings are overrides, not reports (§2.3). The gauge shows tokens only.
- **Files under `~/.claude/harness/` may be swept** (Q-T8). `bin/`, `receiver/`, `receiver.json` and `state/` sit inside Claude Code's config folder. The effect of Claude Code's retention sweep or plugin sync on unknown subfolders is unverified. Doctor detects a missing `receiver.json`, `bin/receiver.mjs` or `receiver/` folder and says so (§19). Until the person restores them, OTel isn't received.
- **Same-uid processes can read the receiver key and the dashboard cookie.**
  - The key is in `~/.claude/settings.json` and `receiver.json`, so a process with them can post fake OTel. That includes unsandboxed agent Bash in an attended session with the sandbox off.
  - The dashboard cookie lives in the browser profile.
  - The isolation spec's read block narrows both.
- **Gate rows can be planted.** They come from `events.jsonl`, which sandboxed Bash can append through harness commands (§4). They are labelled `harness log` and cross-checked.
- **Some data can be lost**, shown, and filled only where another source has the metric:
  - async hook lines in `-p` runs;
  - OTel data while the receiver is down.
- **Costs are estimates** from every source.
- **Transcript parsing breaks on format changes.** It shows as unknown, never zero, and CI catches it only for recorded versions.
- **Skill names may read as placeholders** if Q2 resolves against verbatim names.
- **A second browser needs a second launch.**
- **On Windows:** no `O_NOFOLLOW` (the folder checks stand alone), and the detached receiver's behaviour is unverified.

## 23. Spec points the owner can overrule

1. `http/json` set by harness; protobuf accepted; gRPC refused.
2. Logs left at Claude Code's 5 s default. (The 15 s metrics interval is now owner-confirmed, Q-T1.)
3. Receiver idle exit at 30 minutes; unannounced sessions held 10 minutes, 5 MB at most.
4. Retention: OTel 30 days and 50 MB per repo; rollups 400 days; the invocation log rotates at 5 MB, two files.
5. A one-use launch token.
6. Server-rendered pages, client JS for enhancement only, no framework. uPlot only for phase 4 trends (D10).
7. The name `harness telemetry`; guard `ask` for it, `deny` for `dashboard`.
8. The `config set` classes: `deny` for loosening changes, `ask` for the rest.
9. Collected data kept on `off` unless the person confirms deletion separately.
10. The Gates view lists the last 500 decisions.
11. `UserPromptSubmit` is added to the record hooks, to key prompts and keep the receiver up.

## 24. Open questions

Only questions that still need a live check remain. Every other question is answered or closed; §25 and §26 record where.

- **Q2:** The docs contradict each other on custom skill names. The cost-counter section says some names become "custom" or "third-party"; the `skill.name` bullet says user-defined names are verbatim; `skill_activated` says they are `custom_skill` unless `OTEL_LOG_TOOL_DETAILS=1` is set. Verify live (L2).
- **Q3:** Mon now names the `api_request` token attributes (§2.2). L1 confirms them in recorded payloads and measures typical payload sizes.
- **Q4:** Does Claude Code's OTLP exporter retry or buffer when the receiver is down? (L1)
- **Q5:** When shell `OTEL_*` variables and the user-settings `env` disagree, which wins? (L6)
- **Q7:** Does `async: true` keep `PreModelSwitch` and `PreCompact` from blocking or injecting output? If not, record only the post events. (L4; the last open touchpoint, T2)
- **Q8:** Can sandboxed Bash reach `127.0.0.1` ports? (L5)
- **Q18:** Does `UserPromptExpansion` fire for a typed `/skill`? (L2)
- **Q-T4 reaping:** approved, but whether Claude Code reaps a hook's detached child in `-p` teardown or at session end is still checked live (L7).

## 25. Revision 2 changes (owner answers, 2026-11-16)

| Owner answer | Change |
|---|---|
| Q1 accepted | D9. OTel only at the global level or in the shell; one receiver per user; the repo levels cover the hook log only (§2.1, §7.2, §9). Revision 3 leaves team as the only repo level (§26). |
| Q9 "Don't touch it" | D11. The status line snapshot, chaining, default line, `statusline-inner.json`, the status-line PR and its tests are removed. Live numbers come from OTel with a transcript fallback (§7.3). Gap detection now compares hooks with OTel and back-fills from transcripts (§8). Rate limits and the window percentage become limits (§22). `UserPromptSubmit` joins the record hooks to keep the receiver up and key prompts. |
| Q11 answered | D10. uPlot 1.6.32 (MIT; 51,081 bytes minified plus 1,857 bytes of CSS, from the npm tarball), exact-pinned and bundled with no CDN (§10.6); P4.1 carries it. Decisions D10 to D12 of the first draft became D11 to D13. |
| Q10 answered | D12. `harness config set` (§11.3) as P3.1, before the action runner. |
| New standing rule | D13. §15 lists the touchpoints; five need confirmation, moved into §24. |
| Q15 answered by #250 | D0 removed; §14.3 depends on `ensureRealDir` and `APPEND_NOFOLLOW` from #250. |
| PR count | 21 to 20. |

## 26. Revision 3 changes (owner answers, 2026-11-16)

| Owner answer | Change |
|---|---|
| Q-T1 confirmed as written | §9 records the confirmation of the global `env` list, `OTEL_LOG_TOOL_DETAILS=1` and the 15 s interval; §15 T1 resolved. This also answers Q13's interval. |
| Q-T3: drop the personal level | Two levels only, team and global. Harness never writes `.claude/settings.local.json`; any other `--level` exits 2 (§9). Removed from D9, §2.1, §7.1, §19, the tests (§20.1), L7 and P2.2. §15 T3 resolved by dropping the level. |
| Q-T4 approved | A record hook or `harness dashboard` restarts a dead receiver; the gap is back-filled with a notice (§7.2.1, §7.2.5, §20.2). L7 keeps the reaping check. §15 T4 resolved. |
| Q13 port | Default 4320, a free port picked at opt-in if busy, answered by the Q-T4 approval (§7.2.1, §18). |
| Q-T8 approved, as a known limit | `bin/`, `receiver/`, `receiver.json` and `state/` stay under `~/.claude/harness/`, honouring `CLAUDE_CONFIG_DIR` (§7.2.1). §22 states the unverified sweep effect; doctor names missing files (§19, §20.1). §15 T8 resolved. |
| Q-T7: allow harness's own block | New §9.1: a protected write record (`.harness/state/telemetry-write.json`, `~/.claude/harness/state/telemetry-write.json`) holding SHA-256 hashes of exactly what harness wrote; the ConfigChange gate allows only that, once; every other change stays blocked. Tests listed in §9.1; new PR P2.9. §15 T7 resolved. |
| Q12: Playwright, CI only | §20.7: `@playwright/test` and `@axe-core/playwright` as exact-pinned devDependencies, never shipped; `test:browser`; CI job `dashboard-browser`; browser cache `~/.cache/ms-playwright`. Lands in P1.2. |
| Q16: fan-out after phase 4 | §3 and §9 keep the refusal until then. |
| Q14: answered earlier | `events.jsonl` rotation is a separate PR, now, outside this spec (§13). |
| Q-new 1: per-model token usage, from Claude Code's own data | New §7.4: per day, per session and window tables of input, output, cache read, cache creation and cost per model, from `claude_code.api_request` events, cross-checked against `claude_code.token.usage` (`type`) and `claude_code.cost.usage`, back-filled from transcript `message.usage`. Names verified against Mon and a local transcript (§2.2). |
| Q-new 1: window percentage | Flagged: not possible from Claude Code's built-in data without the status line (§2.3, §22). The gauge shows tokens only; no per-model window table ships. |
| Answered questions | Q-T1, Q-T3, Q-T7, Q-T8, Q12, Q13, Q14, Q16 and Q-new 1 leave §24. Q3 narrows to a live confirmation. |
| PR count | 20 to 21 (P2.9). |
