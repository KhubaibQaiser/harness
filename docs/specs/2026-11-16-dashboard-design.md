# Harness dashboard: design

- Status: revision 1, for the owner's review, 2026-11-16. No code.
- Research and owner intent: `.superpowers/sdd/dashboard/research.md` (local, not committed), cited as "R".
- Claude Code facts are from the official docs, read on 2026-11-16, cited by URL:
  - monitoring and OpenTelemetry: https://code.claude.com/docs/en/monitoring-usage ("Mon");
  - status line: https://code.claude.com/docs/en/statusline ("SL");
  - hooks: https://code.claude.com/docs/en/hooks ("Hooks");
  - environment variables in settings files: https://code.claude.com/docs/en/env-vars ("Env").
- Code facts are from `main` at 16c59c2.
- Owner decisions D1 to D8 (2026-11-16) bind; §1 lists them. Where a doc fact forces a change to one, §2 says so and §23 asks the owner.

## 0. The non-goal this reverses

The original design lists "Web UI, remote telemetry, multi-repo dashboards" as non-goals for v1 (`docs/specs/2026-10-30-harness-design.md:47`). **The owner reverses that** for this feature:
- a web UI, served locally by `harness dashboard`;
- a multi-repo switcher, limited to repos on this machine that have harness installed.

It stays local. **There is still no remote telemetry.** Nothing leaves the machine, the page loads nothing from the network, and the OpenTelemetry data goes only to a receiver on `127.0.0.1`.

## 1. Owner decisions (2026-11-16)

| # | Decision | Where |
|---|---|---|
| D1 | A local web page served by `harness dashboard`: a Node `http` server on `127.0.0.1` only, a random token per launch, Host and Origin checks, a strict CSP, no external network, no remote scripts or fonts. It ships inside the npm package, with minimal or no new runtime dependencies. | §10, §14 |
| D2 | This repo by default, plus a switcher listing the other repos on this machine that have harness installed. Each repo's own `.harness` folder is read; there is no machine-wide database. | §10.4 |
| D3 | OpenTelemetry from the start, cross-checked so nothing is missed. Three capture sources: (a) harness hooks, adding an invocation log; (b) a status line snapshot; (c) an OTel receiver auto-started by a hook, robust and never blocking a hook. Gap detection shows "telemetry missed N" and back-fills from the status line, then transcripts, labelling every number with its source and exact or estimated. | §7, §8 |
| D4 | Opt-in at any time at three levels: personal (`.claude/settings.local.json`), team (`.claude/settings.json`), global (`~/.claude/settings.json`). Each is a previewed change with a confirm, reversible the same way, and removed by uninstall. | §9 (changed by a doc fact, §2.1) |
| D5 | Names on, content off: `OTEL_LOG_TOOL_DETAILS=1` for skill, hook and MCP names; never `OTEL_LOG_USER_PROMPTS`, tool content or raw bodies. | §7.3.4 |
| D6 | Controls (phase 3): every action runs an existing harness CLI command, shows the exact change first, and needs the person's click to apply. Backups as the CLI makes them. Nothing is deleted or overwritten without that yes. Unattended agents can't drive it. | §11 |
| D7 | A clean harness design: dark and light, dense tables, sparklines and gauges, keyboard navigation, accessible (WCAG AA contrast, focus states), no external fonts. | §10.5 |
| D8 | Four phases, each shippable for the owner to test while the next is built: 1 See, 2 Live, 3 Control, 4 History and proof. | §6, §7, §11, §12, §20 |

## 2. What the docs settled

### 2.1 OpenTelemetry can't be turned on from a repo's settings files

Env says `CLAUDE_CODE_ENABLE_TELEMETRY` is "Ignored in project and local settings … Set it in your shell, user settings, or managed settings." Mon says Claude Code "ignores the OpenTelemetry exporter variables in a repository's `.claude/settings.json` and `.claude/settings.local.json`, so a repository can't use them to turn telemetry on, choose where it goes, or capture content."

What this means for D4:
- **Personal and team levels can't enable OTel.** They turn on the hook invocation log and the status line snapshot only. Both of those are honoured in project files: hooks per Hooks' locations table, `statusLine` per SL ("user settings … or project settings").
- **OTel needs the global level** (`~/.claude/settings.json` `env`), or the person's shell. Global env applies to every session on the machine, in every repo.
- So **the receiver is one per user per machine**, on one fixed port, and it routes each session's data into that session's repo (§7.3.3). Data from sessions in repos without harness is never written.

This changes D4 and D3(c) as the owner pictured them. §23 Q1 asks the owner to accept it.

### 2.2 Other facts the design rests on

- **Protocols.** `OTEL_EXPORTER_OTLP_PROTOCOL` takes `grpc`, `http/json` or `http/protobuf`. The default is `http/protobuf` for an `http(s)://` endpoint, from v2.1.323 (Mon). Harness sets `http/json`. The receiver also accepts `http/protobuf` in case a higher layer forces it. It doesn't accept gRPC.
- **Export intervals.** Metrics every 60000 ms and logs every 5000 ms by default. Metric temporality is `delta` by default (Mon).
- **Events harness uses** (Mon): `api_request`, `skill_activated` (`skill.name`, `invocation_trigger` of `user-slash`, `claude-proactive` or `nested-skill`, and `skill.source`), `hook_execution_start` and `hook_execution_complete` (`hook_event`, `hook_name`, counts, `total_duration_ms`, `additional_context_chars`), `hook_registered`, `compaction` (`trigger`, `pre_tokens`, `post_tokens`), `subagent_completed`, `tool_decision`, `tool_result`, `user_prompt`, `plugin_loaded` and `mcp_server_connection`.
- **Metrics harness uses:** `claude_code.token.usage` and `claude_code.cost.usage`, with `model`, `query_source` (`main`, `subagent`, `auxiliary`), `agent.name` and `skill.name`.
- **Correlation:** `session.id` is on every metric and event. `prompt.id` is on events, never on metrics. `event.sequence` counts per process, not per session (Mon).
- **`OTEL_LOG_TOOL_DETAILS=1` also adds content:** Bash commands, tool input and `tool_parameters` (Mon). D5 wants names only, so **the receiver drops those attributes before anything reaches disk** (§7.3.4).
- **Always-on identity attributes:** `user.email` and `user.id`, plus `user.account_uuid` by default (Mon). The receiver drops them too.
- **Skill-name redaction**, three statements:
  - the cost counter section says skill names "redact some names to a `custom` or `third-party` placeholder";
  - the `skill.name` bullet says user-defined skill names "appear verbatim";
  - the `skill_activated` section says user-defined and third-party plugin skills read `custom_skill` "unless `OTEL_LOG_TOOL_DETAILS=1`".

  Harness sets that variable, so all three should give real names. That is unverified (§23 Q2).
- **Status line** (SL):
  - **When it runs:** at session start, then on each new assistant message, after `/compact`, on a permission-mode change, and at the other listed triggers.
  - **Timing:** it is debounced at 300 ms, and an in-flight script is cancelled when a new update starts.
  - **Fields:** `session_id`, `prompt_id`, `model.id`, `context_window.*`, `cost.total_cost_usd` ("estimated … at list price"), `prompt_cache`, `rate_limits` (Pro, Max and Ultra, or behind a gateway, after the first response), `version` and `transcript_path`.
  - **Failure:** a non-zero exit or no output blanks it.
  - **Trust:** it runs only after workspace trust, under the same rule as hooks.
  - **Side effect:** a custom status line "stops showing most of the footer's keyboard hints".
- **Hooks** (Hooks):
  - `UserPromptExpansion` gives `expansion_type`, `command_name`, `command_args`, `command_source` and `prompt`.
  - `SubagentStart` and `SubagentStop` give `agent_id` and `agent_type`; Stop also gives `last_assistant_message`.
  - `PreCompact` gives `trigger` and `custom_instructions`; `PostCompact` gives `trigger` and `compact_summary`.
  - The model-switch hooks give `from_model` and `to_model`.
  - `SessionStart` gives `source` and `model`; `SessionEnd` gives `reason`.
  - Every hook gets `prompt_id` once there is user input.
  - **`async: true`** runs a command hook "in the background without blocking", and `timeout` isn't enforced for it. In `-p` mode, async hooks still running at teardown are killed.
- **Transcripts** change format between versions (R). Harness already reads them defensively (`src/report/transcript.ts`, tested range `TESTED` 2.1.286 to 2.1.317).

## 3. Goal and non-goals

**Goal:** one local page that answers "what is harness doing in this repo, what did it cost, and did anything get missed":
- gates blocked: what, and why;
- skills: installed vs used;
- the per-file context budget;
- tokens by session, model and destination;
- the Stop sandbox state;
- a live session view;
- trends;
- done-contract proof;
- control of harness, behind the person's click.

**Success:**
- Every number on the page names its source and says whether it is exact or estimated.
- A capture gap is shown and filled, never silent.
- No agent can drive a control.

**Non-goals:**
- Remote telemetry, a hosted UI, or any upload.
- A machine-wide database. The receiver's routing table (§7.3.3) holds only session-to-repo announcements, pruned after 7 days.
- Driving Claude Code sessions (starting, prompting or stopping them), as opcode and claudecodeui do (R).
- Editing CLAUDE.md, skills or MCP config from the page beyond what an existing CLI command does.
- OTel fan-out to the person's own collector (§23 Q16).
- gRPC OTLP.
- Desktop-app or VS Code panes (R: their extension API is unverified).

## 4. Data sources and trust

| Source | Written by | Agent can plant it? | Gives |
|---|---|---|---|
| `.harness/logs/events.jsonl` | harness hooks and CLI | **Yes**, from sandboxed Bash through harness commands: `.harness/logs` is in `DENY_WRITE_SKIPPED` (`src/checks/protect.ts:31`); protect guards the raw text only | gate decisions, reasons, files |
| `.harness/logs/timing.jsonl` | dispatcher | Same folder: yes | hook latency |
| `.harness/state/*` (stop record, session state) | hooks | No (denyWrite, Edit deny) | Stop sandbox, gates |
| `.harness/telemetry/**` (new) | record hook, status line snapshot, receiver | No: denyWrite, Edit deny, protect (§14.3) | invocations, live snapshots, OTel |
| Session transcripts (`~/.claude/projects/…`) | Claude Code | Content yes (the agent's own words and tool calls), files no | per-request tokens, tool uses, compactions |
| `.claude/skills`, settings, config | person or harness | Edit-denied for settings and config; skills are repo files | installed inventory, budget |

Rule: **every value is untrusted for display** (escaped, capped). **No value from any source is ever used as a path to write to or as a command argument** (§14).

## 5. Components at a glance

```
Claude Code session
  |-- hooks (existing dispatch.mjs, sync) -------> events.jsonl, timing.jsonl
  |-- hooks (new record.mjs, async) -------------> telemetry/invocations.jsonl
  |        `-- SessionStart, status line, hooks: ensure receiver, announce session
  |-- statusLine (record.mjs --statusline) ------> telemetry/statusline.jsonl, then the inner status line
  `-- OTLP/HTTP (global env only) ---> receiver (one per user, 127.0.0.1:<port>)
                                          `-> routed per session ---> <repo>/.harness/telemetry/otel/<day>.jsonl
harness dashboard (person-run, 127.0.0.1:<random>)
  reads all of the above + transcripts + config ---> HTML pages, JSON, SSE
  actions ---> spawns the harness CLI: --dry-run (diff shown), then --yes on click
```

| Component | Ships in | New file |
|---|---|---|
| Dashboard server, pages, client JS | `dist/cli.mjs` (client JS and CSS inlined as strings at build) | `src/dashboard/**` |
| Record hook and status line snapshot | `dist/hooks/record.mjs`, copied to `.harness/hooks/record.mjs` | `src/telemetry/record.ts` |
| OTel receiver | `dist/receiver.mjs`, copied to `~/.claude/harness/bin/receiver.mjs` at global opt-in | `src/telemetry/receiver/**` |
| Opt-in command | `dist/cli.mjs` | `src/cli/telemetry.ts` |
| Gap detection and back-fill | `dist/cli.mjs` | `src/telemetry/gaps.ts` |

**Runtime dependencies: none.** This matches today, where `package.json` has no `dependencies` and esbuild bundles `yaml` and `picomatch`. The page uses hand-written SVG, extending `src/report/svg.ts`. A chart library is §23 Q11.

## 6. Phase 1: See (no new capture)

Everything comes from what `harness report` already computes. The page is the report, served with navigation.

**Reuse:**
- `collect()` moves out of `src/cli/report.ts` into `src/report/collect.ts`, unchanged, so the report and the dashboard share it.
- The page renders from the same accumulators: `gatesAcc`, `skillsAcc`, `usageAcc`, `windowsAcc`, `alwaysLoadedSafe`, `contextSet`, `recommend`, `readStopRecord` and `stopSandboxLine`.
- `h()` escapes every string.

| View | Content | From |
|---|---|---|
| Overview | Gate on/off lines; Stop sandbox line; context total vs `context.budget_tokens` (gauge); 14-day token sparkline; probable false blocks; hook p95; untested Claude Code versions; config errors | `status` logic, report summary |
| Gates | **Blocked what and why:** the last 500 `deny`, `ask` and `block` events (time, check, decision, reason, files, session), with filters by check and decision. Also tallies, overrides, probable false blocks by signal, latency rows, Stop steps (runs, blocks, flakes, p50, p95) and hallucination counts | `readEvents`, `gatesAcc` |
| Skills | Installed vs listed vs invoked when relevant, invoked otherwise, typed or carried, dropped from listing, before and after compaction, by turn bucket | `installedSkills`, `skillsAcc` |
| Context | Per-file always-loaded rows (tokens, owner) against the budget, on-demand rows, and recommendations. **Offline estimate only;** an exact count is a phase 3 action, because it uploads text to the count API | `contextSet(… offline)`, `recommend` |
| Tokens | Totals, main vs subagent, by model, by day, by session (peak context, compactions), tool result characters | `usageAcc` |
| Stop sandbox | `srt` found or not, the last preflight record, allowed domains, writable paths | `readStopRecord`, `stopSandboxLine` |

Window: `--days N`, default 14, as in the report. Phase 1 writes nothing.

## 7. Phase 2: Live capture

All three sources are opt-in (§9) and append-only. Each one is a no-op when its level is off.

### 7.1 Invocation log (record hook)

New async hook groups, added by `harness telemetry on` (§9). Each runs `node ${CLAUDE_PROJECT_DIR}/.harness/hooks/record.mjs` with `"async": true`. The existing hooks stay as they are.

| Event | Matcher | Recorded |
|---|---|---|
| `PreToolUse` | `Skill` | `skill` name, `use` (the `tool_use_id`) |
| `UserPromptExpansion` | all | `name` (`command_name`), `source` (`command_source`), `kind` (`expansion_type`). **Never `command_args` or `prompt`** |
| `SubagentStart`, `SubagentStop` | all | `agent` (`agent_type`), `aid` (`agent_id`). **Never `last_assistant_message`** |
| `PreCompact`, `PostCompact` | all | `trigger`. **Never `custom_instructions` or `compact_summary`** |
| `PreModelSwitch`, `PostModelSwitch` | all | `from`, `to` (model ids) |
| `SessionStart` | all | `source`, `model`, `otel` (below). Also ensures the receiver and announces the session (§7.3) |
| `SessionEnd` | all | `reason`. Also triggers the rollup (§12.1) |

Rules:
- **`record.mjs` is its own small bundle.** It imports no check, parses stdin, keeps only the listed fields, appends one line, and exits 0. It never writes stdout: PreCompact stdout would become compaction instructions (Hooks), and async output reaches the next turn.
- **Names are validated:** at most 128 characters matching `^[A-Za-z0-9:._@/-]+$`, else `other`. Model ids must match `src/report/export.ts`'s `MODEL_RE`, else `other`. So content can't ride in a name field.
- **`otel` on SessionStart** is `harness` when the hook's environment has `CLAUDE_CODE_ENABLE_TELEMETRY=1` and an endpoint equal to `~/.claude/harness/receiver.json`'s URL. It is `other` when telemetry is on with another endpoint, and `off` otherwise. Gap detection only expects OTel for `harness` sessions.
- **Async means Claude Code doesn't wait:** zero added turn latency (Hooks). `-p` runs can lose in-flight lines at teardown. Gap detection shows that loss (§8).

### 7.2 Status line snapshot

`statusLine: { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.harness/hooks/record.mjs\" --statusline" }` at the personal or team level. Whether `$CLAUDE_PROJECT_DIR` reaches the status line command is §23 Q6. At the global level the command points to `~/.claude/harness/bin/record.mjs` by absolute path.

On each run:
1. Read stdin, capped at 1 MB.
2. Find the repo: `workspace.project_dir`, if it has a regular-file `.harness/manifest.json` and telemetry is on there. Otherwise skip to step 5.
3. Append a snapshot, but only if the dedupe key changed. The key is `session`, `prompt_id`, `model.id`, `context_window.total_input_tokens`, `total_output_tokens` and `cost.total_cost_usd`. Fields are whitelisted (§13).
4. Ensure the receiver if this machine opted in globally (§7.3.5). That is cheap: a lock read and `kill(pid, 0)`.
5. **Chain** to the inner status line (below) and pass its output and exit code through.

**Chaining, so the person's status line is never clobbered.**

The inner command is resolved at run time, not stored, so each teammate keeps their own:

| Harness's entry is in | Inner is the first non-harness `statusLine` in |
|---|---|
| `.claude/settings.local.json` | project `.claude/settings.json`, then user `~/.claude/settings.json` |
| `.claude/settings.json` | user settings |
| user settings (global) | the command harness replaced, saved at opt-in in `~/.claude/harness/statusline-inner.json` (and in the global backup) |

- **How the inner runs:** a harness entry is recognised by its `record.mjs --statusline` command. The inner gets the same stdin bytes, through the shell, as Claude Code would run it. Its stdout passes through (capped at 64 KB) with its exit code.
- **Cancellation:** SIGTERM and SIGINT are forwarded, so Claude Code's cancellation (SL) reaches it.
- **Recursion guard:** the child gets `HARNESS_STATUSLINE=1`. When it is already set, `record.mjs` skips recording and runs only the inner.
- **No inner:** harness prints one line: `<model> · ctx <pct>% · ~$<cost> est.`. The opt-in preview says that adding a status line where none existed hides Claude Code's footer hints (SL). Whether that is wanted is §23 Q9.
- **Never blank because of harness:** an error in harness's own part is caught, and the inner still runs.

### 7.3 OTel receiver

#### 7.3.1 Process

- One per user, started detached by `record.mjs`. Global opt-in copies the bundle to `~/.claude/harness/bin/receiver.mjs`. It runs with `process.execPath`, `stdio: 'ignore'` and a minimal environment.
- It binds `127.0.0.1:<port>`, where `<port>` is written to `~/.claude/harness/receiver.json` at global opt-in (§17).
- **Single instance.** A lock directory `~/.claude/harness/receiver/lock` holds the owner pid, nonce, port, version and start time. It uses the same pattern as `withSessionLock`: `mkdir`, an owner file, and breaking a stale lock when the pid is dead. `EADDRINUSE` on bind is a second guard: the receiver exits 0 and logs.
- **Idle exit** after 30 minutes with no accepted request. The next hook or status line run restarts it.
- **Crash restart:** the next SessionStart, status line or record hook sees a dead pid and starts it again. A receiver is never killed by a hook; a newer harness version takes over only when the old one has exited.

#### 7.3.2 Endpoints

| Path | Method | Notes |
|---|---|---|
| `/v1/logs`, `/v1/metrics` | POST | `application/json` or `application/x-protobuf` (§7.3.6); `/v1/traces` answers 404 (tracing is beta and off) |
| `/health` | GET | `{ ok, version, pid }`, for doctor |
| `/shutdown` | POST | used by `harness telemetry off --level global` |

**Every request must have:**
- `Host` exactly `127.0.0.1:<port>`;
- **no** `Origin` header (a browser sends one; Claude Code's exporter, as far as is known, doesn't: confirmed in L1);
- the header `x-harness-key: <key>`, which harness puts in `OTEL_EXPORTER_OTLP_HEADERS` at global opt-in. The key is 32 random bytes in base64url, and is also stored in `receiver.json` with mode 0600;
- a body of at most 4 MB, read with a 10 s timeout.

Anything else gets 403 or 413, is counted in `receiver.log`, and has its body discarded. **The custom header also forces a CORS preflight**, which the receiver refuses, so a web page can't post to it.

#### 7.3.3 Routing and announcements

- On SessionStart, `record.mjs` writes `~/.claude/harness/receiver/announce/<session>.json` containing `{ root, ts }`. It uses `O_EXCL|O_NOFOLLOW`, mode 0600, and a safe session id (`isSafeSessionId`).
- The receiver routes each record by `session.id`, after checking the announced root:
  - its `realpath` has a regular-file `.harness/manifest.json`;
  - telemetry is on there;
  - no component from the root to `.harness/telemetry/otel` is a symlink (`lstat` chain).
- **Cross-check:** once the session's transcript exists, its first `cwd` (read as `locate.ts`'s `firstCwd` does) must be inside the root. A mismatch drops the announcement and logs `announce-mismatch`.
- **Unannounced sessions** (other repos, or a SessionStart that didn't run) are held in memory for up to 10 minutes, capped at 5 MB in total. They are written if an announcement arrives, else dropped. Data from repos without harness never reaches disk.
- Announcements are pruned after 7 days, and the folder is capped at 10,000 files.

#### 7.3.4 Allowlist: names on, content off (D5)

Records are reduced before any write. **An attribute not listed here is dropped:**
- `user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`, `terminal.type` and `vcs.*` are all dropped;
- so are `tool_parameters`, `tool_input`, Bash command strings, `error` text, `prompt`, `hook_definitions` and any body event.

| Record | Kept |
|---|---|
| all | `session.id`, `prompt.id`, `event.sequence`, `event.timestamp`, `app.version` if present |
| `api_request` | `model`, `cost_usd`, `duration_ms`, the four token counts, `request_id`, `query_source`, `speed` |
| `skill_activated` | `skill.name`, `invocation_trigger`, `skill.source`, `skill.kind`, `plugin.name`, `marketplace.name` |
| `hook_execution_start` / `hook_execution_complete` | `hook_event`, `hook_name`, `num_*` counts, `total_duration_ms`, `*_chars` counts, `hook_source` |
| `hook_registered` | `hook_event`, `hook_type`, `hook_source`, `hook_matcher`, `plugin.name` |
| `compaction` | `trigger`, `success`, `duration_ms`, `pre_tokens`, `post_tokens` |
| `subagent_completed` | `agent_type`, `agent.source`, `is_built_in`, `is_async`, `total_tokens`, `total_tool_uses`, `duration_ms`, `model`, `final_model`, `model_swapped` |
| `tool_decision` / `tool_result` | `tool_name`, `decision`, `source`, `decision_source`, `success`, `duration_ms`, `tool_use_id`, and `mcp_server_name`, `mcp_tool_name`, `skill_name` or `subagent_type` from the parameters (names only) |
| `user_prompt` | `prompt_length` and command names (name rule as in §7.1) |
| `plugin_loaded`, `mcp_server_connection` | name, source and status fields; exact names pinned in L1 |
| `token.usage`, `cost.usage` metrics | value, `type`, `model`, `query_source`, `agent.name`, `skill.name`, `plugin.name`, `mcp_server.name`, `mcp_tool.name` |

- Name values pass the §7.1 name rule, else `other`.
- **Pinned from recorded payloads:** the exact token attribute names on `api_request` aren't spelled out in Mon. L1 records them, and the allowlist is pinned to the recorded names (§23 Q3).
- Harness never sets `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` or the beta tracing variables. Doctor warns when any of them is set in a layer harness reads.

#### 7.3.5 Ensure (from hooks and the status line)

`ensureReceiver()` runs only when the machine opted in globally and the session's `otel` is `harness`. Its steps:
1. Read the lock owner.
2. Check `kill(pid, 0)`.
3. If the receiver isn't running, spawn it detached and return **without waiting**.

Budget: under 15 ms on top of the record work (§15). A spawn failure is one invocation-log line, `receiver-start-failed` with the `code` only. It never throws to Claude Code.

#### 7.3.6 Protobuf

- **Decoder:** a hand-written decoder for the subset of OTLP `ExportLogsServiceRequest` and `ExportMetricsServiceRequest` that the allowlist reads: resource and scope attributes, log records with attributes, and sum data points. No dependency.
- **Bounds:** unknown fields are skipped by wire type, with length bounds checked and a nesting depth of at most 32.
- **Testing:** tested against recorded payloads (§19.4).
- **Why it exists:** harness itself sets `http/json`; protobuf is for when a managed or shell value overrides it (§23 Q5).

#### 7.3.7 Responses

The receiver answers 200 with an empty `{}` (JSON) or an empty protobuf body as soon as the body is parsed. Writes are queued and flushed every 1 s. A write failure is logged and counted, never returned as a 5xx: retry behaviour is unknown (§23 Q4), and a retry storm would cost more than the gap check recovers.

## 8. Gap detection and back-fill

### 8.1 Keys

Sources are joined on `session` (`session_id` = `session.id`), on `prompt` (`prompt_id` = `prompt.id`), and on the request (OTel `request_id` = the transcript's `requestId`, and transcript responses are deduped by message id plus request id as `usageAcc` does).

### 8.2 Checks (per session, in the window)

| Check | Missed when |
|---|---|
| Session seen | A session in the invocation log (SessionStart), status line, or transcripts has `otel: harness` but no OTel record |
| Prompts | A `prompt_id` from hooks or the status line has no OTel event with that `prompt.id` |
| Requests | A transcript response has no `api_request` with its request id |
| Skills | A Skill `PreToolUse` or `UserPromptExpansion` in the invocation log has no `skill_activated`; or a transcript Skill tool use has no invocation-log line (record hook missed) |
| Hooks | Harness `timing.jsonl` lines for an event vs OTel `hook_execution_complete` for that `hook_event` (counts per session) |
| Status line | A session with transcript responses but no snapshot while the status line level was on |

### 8.3 Back-fill order (D3: OTel, then the status line, then transcripts)

For each metric, the first source in that order that has it is used:

| Metric | OTel | Status line | Transcript |
|---|---|---|---|
| Tokens per request | exact | no (context totals only) | exact (API usage as logged) |
| Session tokens | exact (sum) | no | exact (sum) |
| Cost | estimate (`cost_usd`) | estimate (`total_cost_usd`, list price) | not computed (no price table in harness) |
| Context used | `api_request` input sums: estimate | exact (`used_percentage`, `current_usage`) | estimate (peak input + cache, as `usageAcc` does) |
| Model | exact | exact | exact |
| Skill invoked | exact (named under §2.2) | no | exact for Skill tool uses; typed commands from `invoked_skills` attachments |
| Compactions | exact | no | exact (`compact_boundary`) |
| Rate limits | no | exact | no |

Context used is the one metric where the status line is better than OTel, so that row prefers it.

### 8.4 Labels

- **Every number carries a source badge** (`OTel`, `status line`, `hooks`, `transcript`, `harness log`) and `exact` or `est.`.
- **Its tooltip** states the method, for example "estimate, characters / 4", using the report's existing `ESTIMATE` text.
- **Mixed sources:** a total made from mixed sources shows the split, for example `12,400 (OTel 11,900 · transcript 500)`.

### 8.5 What the person sees

- **A banner on every page with a gap:** "Telemetry missed 3 prompts and 12 requests in the last 14 days. Filled from transcripts (12 requests) and the status line (cost, 3 prompts)."
- **Gaps that can't be filled:** "4 requests found in no source except the status line: tokens unknown."
- **The Data health view** lists each source (on or off, last record, records in the window, dropped counts from `receiver.log`, and parse failures) and each gap by session.
- **Missing sources:** a source that is off isn't a gap; it shows as "off" with the opt-in. A transcript removed by Claude Code's retention sweep is labelled "transcript deleted (retention)", never zero.

## 9. Opt-in levels (D4, changed by §2.1)

`harness telemetry on|off --level personal|team|global [--dry-run|--yes]` and `harness telemetry status`. The dashboard's opt-in buttons run exactly these.

| Level | Writes | Turns on |
|---|---|---|
| personal | `.claude/settings.local.json` (hooks, `statusLine`), `.harness/hooks/record.mjs` | invocation log, status line snapshot, for this person in this repo |
| team | `.claude/settings.json` (committed), `.harness/hooks/record.mjs` | the same for everyone who opens the repo |
| global | `~/.claude/settings.json` `env` (below) and `statusLine`; `~/.claude/harness/bin/{record,receiver}.mjs`; `receiver.json`; `statusline-inner.json` | OTel to the harness receiver for every session on the machine (routed to harness repos only), and the status line snapshot in every harness repo |

**Global `env`:**
- `CLAUDE_CODE_ENABLE_TELEMETRY=1`;
- `OTEL_METRICS_EXPORTER=otlp` and `OTEL_LOGS_EXPORTER=otlp`;
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`;
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>`;
- `OTEL_EXPORTER_OTLP_HEADERS=x-harness-key=<key>`;
- `OTEL_LOG_TOOL_DETAILS=1`;
- `OTEL_METRIC_EXPORT_INTERVAL=15000` (§23 Q13).

**Rules:**
- **Preview first.** `--dry-run`, and the dashboard's preview, print the exact diff of each file, what it turns on, the footer-hint side effect when a status line is added, and, for team, that it binds every teammate. A personal or team opt-in also says: "OTel can only be turned on in your user settings (Claude Code ignores it in repo files); turn on global too?" That is a second, separate confirm.
- **Never clobber:**
  - when any layer the hook can see already sets `CLAUDE_CODE_ENABLE_TELEMETRY` or an `OTEL_EXPORTER_OTLP_*` endpoint, global opt-in refuses, naming the layer. Doctor says "OTel goes to `<host>`; harness uses hooks, the status line and transcripts";
  - an existing `statusLine` is chained (§7.2), never dropped.
- **Recorded like every harness change.**
  - The repo levels use the existing manifest blocks, `mergeSettings` style, with backups in `.harness/backup/<ts>`, so `harness uninstall` and `off` remove them.
  - The global level uses `GLOBAL_STATE` (`~/.claude/harness/manifest.json`, `src/cli/preset.ts:61`) and its backup folder, so `harness uninstall --global` and `off --level global` remove them and restore the replaced `statusLine` exactly.
- **`off` is the same preview and confirm in reverse.** It never deletes the collected `.harness/telemetry/` data. The preview offers that as a separate, explicit "delete collected data" confirm that lists the files.
- **Guard:** `telemetry` joins `PERSON_ONLY` (`src/checks/guard.ts:93`) as `ask`, allowed for `status` and `--dry-run`, like `context apply`. Unattended turns the ask into a deny, as today.

## 10. Server and page

### 10.1 `harness dashboard [--days N] [--repo <path>] [--no-open] [--print-url]`

- **Refuses to start:**
  - inside Claude Code (`insideClaude`, `src/cli/claude-only.ts`) or unattended (`src/core/unattended.ts` signals), with the message: `Run harness dashboard from your own terminal, not inside Claude Code or an unattended run.`;
  - when the agent runs it, through `PERSON_ONLY.dashboard` as a `deny`.
- **Binds** `127.0.0.1` on a random port (`listen(0)`). IPv6 and other interfaces are never bound.
- **Launch token:** 32 random bytes in base64url. The launch URL is `http://127.0.0.1:<port>/launch?t=<token>`, opened with `openCommand` (`src/cli/report.ts`).
  - The URL is printed only when stdout is a TTY, or with `--print-url` (for tests).
  - **One use only:** the exchange sets a session cookie `hd=<random>` (`HttpOnly`, `SameSite=Strict`, `Path=/`) and answers 303 to `/`.
  - **A second exchange is refused** and shown on the page and in the terminal: "a second client tried to open the dashboard". To use another browser, start another dashboard.
- **Lifetime:** the server ends on Ctrl-C or when the terminal closes (SIGHUP). It keeps no state on disk.

### 10.2 Request checks (every request)

- **Host and Origin:**
  - `Host` must equal `127.0.0.1:<port>`; otherwise 421. This blocks DNS rebinding.
  - When `Origin` is present it must equal `http://127.0.0.1:<port>`; otherwise 403.
- **Auth:** the cookie is required everywhere except `/launch`; otherwise 401 with a plain "start harness dashboard again" page.
- **Writes:** `POST` also needs `x-harness-csrf` equal to the per-session value rendered into the page. JSON bodies only, 64 KB at most.
- **Headers on every response:**
  - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'`;
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`;
  - `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
- Static assets are served from strings in the bundle, never from disk paths.

### 10.3 Rendering

- **Pages are rendered on the server,** reusing the report's renderers and `h()`. One page per view, and every link works without JS.
- **Client JS** (one file, no framework) only adds:
  - keyboard navigation;
  - theme toggle;
  - table filter and sort;
  - SSE live patches (phase 2);
  - action previews (phase 3).

  It sets text with `textContent` only. With Trusted Types required and no policy defined, `innerHTML` can't be used.
- **JSON API** (`/api/<view>`) returns the same data, for live patches and tests.
- **SSE** (`/api/live`, phase 2): the server polls the stat of the repo's telemetry files and the active transcripts every 1 s, at most 64 files, and pushes deltas. It never uses `fs.watch` (unreliable across platforms).

### 10.4 Repo switcher (D2)

**Discovery,** read-only and bounded:
1. List `~/.claude/projects/*/`, at most 20,000 entries, as `locate.ts` bounds them.
2. In each folder, read the newest session file's first `cwd` (`firstCwd`).
3. Find its git root.
4. Keep it if `<root>/.harness/manifest.json` is a regular file.
5. Add `--repo` if given.

The result is cached for the server's lifetime, with a refresh button.

- The client gets an **index** into that list, never a path. Switching re-roots the server's reads to that repo.
- Each repo's data is read from its own `.harness` and its own transcripts.
- Actions (phase 3) in another repo run the CLI with that repo as `cwd`, and say so in the confirm.

### 10.5 Design (D7)

- **Tokens.**
  - The report's CSS variables (`src/report/html-parts.ts`) become the base: `--bg`, `--fg`, `--mute`, `--line`, `--card`, `--bar`, `--warn`, `--s0` to `--s3`.
  - New tokens: `--ok`, `--bad`, `--focus`, and `--badge-*` per source.
  - Dark and light come from `prefers-color-scheme`, with a manual override on `:root[data-theme]` stored in `localStorage` (try/catch).
  - The system font stack only, monospace for numbers and ids, no web fonts.
- **Layout:**
  - a top bar with the repo switcher, window, data-health dot and theme;
  - a left nav (Overview, Gates, Skills, Context, Tokens, Sessions, Data health, Actions, History);
  - dense tables: 13 px, a sticky header, numbers right-aligned in tabular numerals, rows of at most 28 px;
  - tiles with sparklines, and gauges for context and rate limits.
- **Charts:**
  - inline SVG with `role="img"`, an `aria-label`, `<title>` per mark, and a text table next to each chart (the report's `chart()` pattern);
  - colours from tokens only;
  - no animation under `prefers-reduced-motion`.
- **Keyboard:**

  | Keys | Action |
  |---|---|
  | `g` then `o`, `g`, `s`, `c`, `t`, `l`, `h`, `a`, `y` | go to a view |
  | `/` | filter |
  | `j` / `k` | row up and down |
  | `Enter` | open a row |
  | `[` / `]` | change the window |
  | `r` | switch repo |
  | `?` | help |
  | `Esc` | close |

  Also: a skip link; `:focus-visible` rings of at least 2 px in `--focus`; native buttons and links only; dialogs with focus trap and return.
- **Accessibility:**
  - WCAG 2.1 AA, with text contrast at least 4.5:1 and UI parts and chart marks against the background at least 3:1, checked by a test over the token pairs (§19.1);
  - headings in order and `th scope`;
  - status never by colour alone: each badge has text.

## 11. Phase 3: Control (D6)

### 11.1 How an action runs

1. **List.** The Actions view lists what can be done in this repo now (§11.2), each with the exact command.
2. **Preview.** On "Preview", the server spawns the CLI with `--dry-run`: `process.execPath` with the packaged `dist/cli.mjs`, `cwd` set to the repo, `shell: false`, and an environment without `CLAUDECODE`. It shows the output and the diff verbatim, escaped.
3. **Apply.** On "Apply" (a second click, with the CSRF header), it spawns the same command with `--yes` and shows the result. A command that has no `--dry-run` shows the text of what it will change, from a fixed table, and a confirm.
4. **Arguments come from fixed templates.** Ids must pass `ID_RE` and file arguments must be paths the server listed (for example `.harness/tmp/<w>/task.json`, `realpath` inside the repo). No free text from the page or from repo files reaches argv.
5. **Changes are the CLI's.** Backups, locks and the manifest come from the CLI as today (`.harness/backup/<ts>`, `apply.lock`). The dashboard never writes a repo file itself.
6. **Audit.** Each applied action appends a `dashboard` / `action-applied` event (command id, exit code) to `events.jsonl`.
7. **Nothing is deleted or overwritten without that click,** and the click applies exactly the previewed command. If a file changed between preview and apply (hash compare), apply refuses and asks for a new preview.

### 11.2 Actions

| Action | Command | Preview |
|---|---|---|
| Pause or resume TDD | `harness tdd off` / `on` | fixed text |
| Approve, edit or close a task contract | `harness task approve <file> --yes`, and the other subcommands | criteria shown by `task` |
| Apply context recommendations | `harness context apply <n> --dry-run` / `--yes` | diff |
| Count context exactly (uploads text to the count API) | `harness context --json` | fixed text naming the upload |
| Remove an item | `harness remove <id> --dry-run` / `--yes` | diff |
| Remember a decision | `harness remember …` (read-only forms run directly) | as the CLI prints |
| Telemetry on or off | `harness telemetry … --dry-run` / `--yes` | diff |
| Uninstall | `harness uninstall --dry-run` / `--yes` | diff |
| Report and export | `harness report [--export]` | none (writes `.harness/reports/` only) |
| Gate toggles (`checks.*`) | **No CLI exists today** (§23 Q10) | — |
| Add an item, update, sync, init | these refuse outside Claude Code (`refuseOutsideClaude`) | shown as a copyable `/harness:<cmd> …` line to run in Claude Code |

**Commands that refuse inside Claude Code** (`tdd off`, and the person-only ones):
- They run normally from the dashboard, because the dashboard itself refuses to start inside Claude Code and spawns the CLI without `CLAUDECODE`.
- The person's click is the person-only step.

### 11.3 Why an agent can't drive it

- **The agent can't start it.** `PERSON_ONLY.dashboard` denies it, and it refuses inside Claude Code and unattended.
- **The launch token is one-use.** By the time an agent could read the opener's argv or the browser history, the token is spent. A second exchange is refused and shown.
- **The session lives in an `HttpOnly`, `SameSite=Strict` browser cookie.** Reading it means reading the browser profile's cookie store (§21).
- **`POST` needs the CSRF value** rendered into the page.
- **Cross-site requests and rebinding are refused** (§10.2).
- **Sandboxed Bash and loopback:** whether sandboxed Bash can reach a `127.0.0.1` port at all is §23 Q8.

## 12. Phase 4: History and proof

### 12.1 Daily rollups

- **File:** `.harness/telemetry/daily/<YYYY-MM-DD>.json`, counts only, built for each completed day not yet rolled.
- **Built by:**
  - the async SessionEnd record hook, which rolls harness's own logs (events, timing, invocations, status line, OTel);
  - the dashboard and `harness report` when they run, which add the transcript counts for days whose transcripts still exist.
- **Schema:** the report export's counters (`buildExport` fields), plus the invocation, OTel and gap counters.
- **Retention:** kept for `telemetry.rollup_days` (default 400). Rollups outlive transcripts, which Claude Code's retention sweep removes (R pitfall).

### 12.2 Views

- **Trends** of tokens, cost, gates, false blocks, skills hit rate, context total and hook p95, by day and week.
- **Done-contract verdicts over time** (`.harness/verdicts/<commit>.json`, done PR 4 and later, not on `main` yet): outcomes, the false-done rate (blocked claims divided by done claims, done spec §6), tamper denies and blocked reasons. Until those PRs land, the view shows only the `false-done-claim` events that exist today (`src/checks/stop/done-claim.ts:74`).
- **Team export:** `harness report --export`, extended to schema 2 with the invocation, OTel and gap counters under the same allowlist (`exportProblems` refuses anything else). The dashboard runs it as an action and shows the file. **Counts only, as now.**

## 13. On-disk formats and retention

All new repo files live under `.harness/telemetry/`. It is added to:
- `HARNESS_LOCAL` (gitignored);
- `PROTECTED` and `PROTECTED_CONCRETE`;
- the `Edit(./.harness/telemetry/**)` deny;
- the sandbox `denyWrite`. It is **not** in `DENY_WRITE_SKIPPED`: only hooks, the status line and the receiver write it, all outside the sandbox.

Every line starts with `"v":1`. Writes go through the no-follow helpers (§14.3).

| File | Line | Bound |
|---|---|---|
| `telemetry/invocations.jsonl` | `{v, ts, session, prompt?, event, name?, source?, kind?, agent?, aid?, trigger?, from?, to?, reason?, model?, otel?, use?}`; `event` is one of `skill`, `command`, `subagent-start`, `subagent-stop`, `compact-pre`, `compact-post`, `model-pre`, `model-post`, `session-start`, `session-end`, `receiver-start-failed` | rotated at 5 MB to `.1` (two files) |
| `telemetry/statusline.jsonl` | `{v, ts, session, prompt?, model, ctx: {size, pct, in, out, cur: {i, o, cw, cr}}, cost: {usd, ms, api_ms, add, del}, cache: {numeric and boolean leaves of prompt_cache, names matching ^[a-z_]{1,32}$, at most 16}, rl: {h5: {pct, reset}, d7: {pct, reset}}, ver, effort?, fast?}`; never `cwd`, `transcript_path`, `workspace.*`, `session_name` or `output_style` | changed lines only; rotated at 5 MB to `.1` |
| `telemetry/otel/<YYYY-MM-DD>.jsonl` | `{v, rx, kind: "log" or "metric", name, session, prompt?, seq?, ts, value?, attrs: {allowlisted}}`; metrics as delta values | `telemetry.retention_days` (default 30) and `telemetry.max_mb` (default 50) per repo; the oldest day goes first |
| `telemetry/daily/<YYYY-MM-DD>.json` | counts only (§12.1) | `telemetry.rollup_days` (default 400) |
| `telemetry/cache/<session>.json` | transcript-derived per-session counts, keyed by transcript size and mtime, so the dashboard doesn't re-parse | 5,000 files and 90 days |
| `~/.claude/harness/receiver.json` | `{v, port, key, created}`, mode 0600 | one file |
| `~/.claude/harness/receiver/lock/owner` | `{pid, nonce, port, version, started}` | one |
| `~/.claude/harness/receiver/announce/<session>.json` | `{v, root, ts}`, mode 0600 | 7 days, 10,000 files |
| `~/.claude/harness/receiver/receiver.log` | one line per error class, with counts and no payloads | 1 MB, two files |
| `~/.claude/harness/statusline-inner.json` | `{v, statusLine}`: the replaced global entry | one, and in the global backup |

**The retention sweep** runs in the receiver (hourly) and in the SessionEnd record hook. It deletes only:
- harness-created files under `.harness/telemetry/` and `~/.claude/harness/receiver/`;
- matched by the exact name patterns above;
- after `lstat` shows a regular file, never through a symlink.

It never touches anything else. These are harness's own logs, not the person's files. The person's data under `off` is deleted only by the separate confirm (§9).

**Existing files:** `events.jsonl` is never rotated today and stays so (§23 Q14).

## 14. Security

### 14.1 Threat model

**The actor:** the drifted or prompt-injected agent of the isolation spec (§2.1 there). It runs as the person's uid, writes repo files, runs Bash, sandboxed or not, and its words and tool calls are in the transcripts.

**What it wants, and what answers:**

| It tries to | Answer |
|---|---|
| Inject script or markup through a file name, skill name, reason text, transcript text, or another repo's `.harness` | Server-side `h()` on every string (HTML plus control, zero-width and bidi characters); client `textContent` only; Trusted Types required; CSP `script-src 'self'` with no inline script. **Tests feed hostile fixtures to every view** (§19.2) |
| Plant numbers the dashboard trusts | `.harness/telemetry/` is outside the agent's sandbox write set and Edit-denied. `events.jsonl` and `timing.jsonl` stay plantable (§4), so gate rows from them are labelled `harness log`, and gap checks compare them with OTel `hook_execution_complete` where available. Every parser caps lines (the `MAX_LINE` rule) and keys (the `MAX_KEYS` pattern) |
| Make the dashboard or receiver write elsewhere: a symlinked `.harness/telemetry`, `otel` or day file; a forged announcement | No-follow writes with an `lstat` chain from the repo root (§14.3); the announced root must have a manifest and match the transcript `cwd`; no write path ever comes from file content, config values, or the page |
| Drive a control | §11.3 |
| Turn content capture on | The receiver's allowlist drops content whatever Claude Code sends. Doctor flags content variables in any layer |
| Post fake OTel from a web page or another local process | Header key, no `Origin`, the Host check, and the CORS preflight refused (§7.3.2). A same-uid process that reads `~/.claude/settings.json` can post fake records (§21) |
| DNS rebinding or CSRF on either server | `Host` must be exactly `127.0.0.1:<port>`; `SameSite=Strict` cookie plus a CSRF header; `frame-ancestors 'none'` |
| Exhaust disk or memory | §13 bounds; body caps; the unannounced buffer cap; at most 64 polled files; the SSE client count is capped at 8 |

**Out of scope,** as in the isolation spec: the person, kernel escapes, and a compromised Claude Code or Node.

### 14.2 Other local users

On a shared machine, other uids can connect to `127.0.0.1`:
- the dashboard needs the one-use token and then the cookie;
- the receiver needs the key, stored with mode 0600.

### 14.3 The no-follow write helpers (dependency)

`main` has `writeAtomic` (`src/core/atomic.ts`), which follows symlinks. `O_NOFOLLOW` appears only in read paths (`src/report/locate.ts:74`, `src/checks/pr-size/untracked.ts:11`).

**The no-follow write helpers aren't merged yet.** This spec needs `appendNoFollow(root, rel, line)` and `writeNoFollow(root, rel, data)`:
- `lstat` every component from `root`, refusing a symlink or a non-directory;
- open with `O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW` (or `O_EXCL` for new files), mode 0600;
- `fstat` to confirm a regular file with `st_nlink` 1;
- on Windows, `O_NOFOLLOW` is undefined, so the `lstat` chain stands alone, as `locate.ts` does today.

If the isolation track's helpers (its P11 and R3-I1 rules) have landed by then, they are reused; otherwise PR D0 adds them (§20).

## 15. Performance budgets

Budgets reuse `test/perf/overhead.ts` (paired spawns against a bare `node`). Numbers are targets, checked in `test:perf`.

| What | Budget |
|---|---|
| Turn latency added by the record hooks | 0 (async; Claude Code doesn't wait, per Hooks) |
| `record.mjs` hook process, above bare node | under `OVERHEAD_MS` (100 ms Linux, 150 macOS, 450 Windows); median measured and printed |
| `record.mjs --statusline`, own part above bare node, before the inner runs | under `OVERHEAD_MS`; ensure step under 15 ms |
| Existing sync hooks | unchanged: no new code in `dispatch.mjs` |
| `record.mjs` bundle | under 60 KB (no check imports) |
| Receiver memory | RSS under 80 MB steady after 50,000 records; unannounced buffer 5 MB at most |
| Receiver CPU | 1 % of one core or less when idle; a 4 MB body parsed in under 200 ms |
| Dashboard first page | under 3 s on 14 days and 200 sessions (cached transcripts make later pages faster) |
| Dashboard memory | under 300 MB on the same fixture (transcripts are streamed, as now) |
| SSE poll | 64 stats per second at most |

## 16. Failure modes

**Rule: capture fails open and quiet, and is shown. Controls fail closed.**

| Failure | Effect | Shown as |
|---|---|---|
| Record hook crashes or can't write | the line is lost, Claude Code is unaffected (async, exit 0) | a gap (§8) |
| Async hook killed at `-p` teardown | the line is lost | a gap |
| Status line: harness part fails | the inner still runs; no snapshot | a gap; doctor |
| Status line: inner fails or hangs | passed through, as without harness; Claude Code cancels | the person's own status line behaviour |
| Receiver down, crashed, idle-exited, or port busy | OTel data for that window is lost; the next hook or status line restarts it | a gap with back-fill; doctor `receiver: not running (<reason>)` |
| Receiver write error, disk full | the record is dropped and counted in `receiver.log` | Data health "dropped N" |
| Malformed OTLP or an unknown field | skipped and counted; 200 returned for the rest | Data health |
| Transcript format change | unknown counts, never zero; untested-version banner (existing) | banner, "unknown" cells |
| Transcript deleted by retention | rollups remain | "transcript deleted (retention)" |
| A teammate has no global opt-in | no OTel for them | "OTel off on this machine" with the opt-in |
| Dashboard crash | nothing lost (no state); restart it | — |
| Action: preview and apply differ, CLI non-zero, lock held | not applied, or the CLI's own rollback | the CLI's message verbatim |
| Settings file unreadable during opt-in | refused, nothing written | the CLI message |

## 17. Config keys

`.harness/config.yaml` (protected), added to the rule table in `src/core/config.ts`; the generated reference picks them up:

| Key | Default | What |
|---|---|---|
| `telemetry.retention_days` | `30` | days of `telemetry/otel/` kept (1 to 365) |
| `telemetry.max_mb` | `50` | `telemetry/otel/` size cap per repo (5 to 1000) |
| `telemetry.rollup_days` | `400` | days of `telemetry/daily/` kept (30 to 3650) |

Not in config:
- **The opt-in state** is the settings entries themselves; `harness telemetry status` reads them.
- **The receiver port** is in `~/.claude/harness/receiver.json`, picked at global opt-in: default 4320 if free, else a free port (§23 Q13).

## 18. CLI, guard, doctor, status, uninstall

| Command | Who | What |
|---|---|---|
| `harness dashboard [--days N] [--repo <path>] [--no-open] [--print-url]` | person only (guard `deny`; refuses inside Claude Code and unattended) | §10 |
| `harness telemetry on\|off --level personal\|team\|global [--dry-run\|--yes]` | person (guard `ask`, preview allowed) | §9 |
| `harness telemetry status` | anyone | levels on, sources and last record, receiver state, gap counts |
| `node record.mjs [--statusline]` | hooks and Claude Code only | §7.1, §7.2 |
| `node receiver.mjs` | spawned by `record.mjs` | §7.3 |

- **Doctor** gains:
  - receiver health, version, port and lock;
  - a foreign OTel endpoint;
  - content variables set;
  - the status line chain resolved, showing the inner it would run;
  - `.harness/telemetry` protected (denyWrite, Edit deny);
  - `record.mjs` present and hash-matched to the manifest;
  - for team level, the note that each teammate must opt in globally for OTel.
- **Status** gains one line: `Live data: hooks on (team), status line on (personal), OTel on (global, receiver running), gaps last 7 days: 3`.
- **Uninstall:** repo entries and `record.mjs` are removed by `harness uninstall`; global entries, the bin files, `receiver.json` and the `statusLine` restore by `harness uninstall --global`. Collected `.harness/telemetry/` data is listed and kept unless the person confirms its deletion.
- **README:** updated in each PR (owner rule).

## 19. Testing

### 19.1 Unit (no network, no `claude`)

- **Server:** Host, Origin and cookie matrix; the one-use exchange and the refused second; CSRF; body caps; every security header present on every route (a table test over routes); refusal inside Claude Code and unattended; `PERSON_ONLY.dashboard` in every spelling the guard tests use; the switcher accepts an index only.
- **Escaping:** each view rendered with hostile values (`<script>`, `"><svg onload>`, bidi and zero-width, 16 MB lines, 10,000 distinct names), asserting no raw `<` from data and the caps held.
- **Contrast:** every text and background token pair is at least 4.5:1 and every UI or mark pair at least 3:1, in both themes (computed from the CSS source).
- **Record hook:** the field allowlist per event. `command_args`, `prompt`, `custom_instructions`, `compact_summary` and `last_assistant_message` never reach the file (asserted on bytes); the name rule; no stdout ever; the `otel` field values; rotation.
- **Status line:**
  - inner resolution for each level and layer;
  - a harness entry skipped;
  - the recursion guard;
  - no inner (the default line);
  - inner non-zero and inner hang with SIGTERM forwarded;
  - stdout cap;
  - dedupe;
  - the whitelist never writing `cwd` or `transcript_path`;
  - a harness-part failure still running the inner.
- **Receiver:**
  - the allowlist drops identity and content attributes;
  - routing by announcement, the transcript `cwd` cross-check, unannounced TTL and cap;
  - a symlink at each path component refused;
  - the header key, `Origin` refused, `Host`, 413;
  - the lock, stale break, `EADDRINUSE`, idle exit, `/shutdown` with the key;
  - the retention sweep deletes only pattern-matched regular files, with symlinks and foreign names left alone.
- **No-follow helpers:** each `lstat` refusal, `O_EXCL`, `st_nlink` 2, the Windows path.
- **Gaps:** every §8.2 check and the §8.3 matrix, with sources missing one at a time; labels and splits; "deleted (retention)" vs "unknown".
- **Opt-in:** previews per level are exact; a foreign OTel refuses; `off` restores byte for byte; manifest and backup entries; `uninstall` and `uninstall --global`.
- **Actions:** templates only; a preview/apply hash mismatch refuses; the environment without `CLAUDECODE`; copy-only commands are never spawned.

### 19.2 End to end (temp repos, fake `HOME`, no network)

- **Server:** `harness dashboard --no-open --print-url` started for real; the exchange; every view fetched with hostile fixtures; CSP and headers; no URL in any served byte other than `127.0.0.1` (a scan of HTML, JS and CSS); a rebinding `Host`, a cross-site `POST` and a missing CSRF all refused.
- **SSE:** a telemetry line appended appears in under 2 s.
- **Switcher:** two fixture repos plus one without harness, and only the two listed.
- **Actions:** `context apply` preview, apply, the backup present, and the uninstall path.
- **Receiver:** a real receiver process fed recorded payloads through `fetch`, then the files on disk checked. A kill followed by a status line run restarts it.

### 19.3 Transcript parser fixtures

- **Layout:** `test/fixtures/transcripts/<claude-version>/` holds recorded transcripts, scrubbed of text by the existing `make.ts` approach, with an `expected.json` of counts (responses, usage sums, Skill uses, compactions, listings).
- **Cases:** one folder per version in `TESTED`, plus each newly seen version.
- **Assertions:** the counts match; unknown record types are counted, never fatal; duplicate streamed entries are deduped; sidechain and resumed sessions handled.

### 19.4 OTel recorded payloads

- **Layout:** `test/fixtures/otel/<claude-version>/{json,protobuf}/{logs,metrics}-*.bin|json`, captured in L1, with content scrubbed by a script that replaces strings while keeping lengths.
- **Tests:** JSON and protobuf decode to the same allowlisted records; truncated, oversized and wrong-wire-type inputs are refused without a crash; a fuzz pass of 10,000 random mutations finds no throw past the request handler.

### 19.5 Perf (`test:perf`)

The §15 rows: `record.mjs` and the status line part against bare node, receiver RSS after 50,000 records, and dashboard first page on the large fixture.

### 19.6 Live batches (owner's subscription; Terminal panel; scripts in `harness-wt/live`; a yes per batch)

| Batch | Checks | Gates |
|---|---|---|
| L1 OTel capture | Record JSON and protobuf payloads from a scratch session with `OTEL_LOG_TOOL_DETAILS=1`: names of `api_request` token attributes, the `plugin_loaded` and `mcp_server_connection` fields, whether the exporter sends `Origin`, payload sizes, retry when the receiver is down (Q3, Q4) | P2.4, P2.6 |
| L2 Skill names | project, user and plugin skills under `OTEL_LOG_TOOL_DETAILS=1`: verbatim or placeholder in `skill_activated` and `token.usage` (Q2); `UserPromptExpansion` fires for a typed `/skill` (Q18) | P2.4 |
| L3 Status line | `$CLAUDE_PROJECT_DIR` and `cwd` in the status line command, chaining with a real user status line, cancellation, footer hints; Windows shell if a machine exists (Q6, Q9) | P2.2 |
| L4 Async hooks | `async` on `PreCompact` and `PreModelSwitch` neither blocks nor injects output; loss in `-p` (Q7) | P2.1 |
| L5 Sandbox and loopback | can sandboxed Bash reach the dashboard or receiver port (Q8) | P1.1, P2.4 |
| L6 Env precedence | shell `OTEL_*` vs user-settings `env` (Q5) | P2.5 |

## 20. Rollout

- **Size.** Each PR is cut from `main`, stays within 400 changed non-test lines and 20 non-test files, and updates the README in the same PR. Sizes are estimates.
- **Order.** Phase order; each PR depends only on earlier rows. Each phase ends shippable for the owner to test.

| # | PR | After | Live gate | Size (est.) |
|---|---|---|---|---|
| D0 | No-follow write and append helpers (§14.3), unless the isolation track landed them | — | — | ~150 |
| **Phase 1: See** | | | | |
| P1.1 | `collect()` moved to `src/report/collect.ts`; `harness dashboard` server: bind, one-use token, cookie, Host/Origin/CSRF, headers, refusals, `PERSON_ONLY.dashboard`, open, Overview view | D0 | L5 | ~380 |
| P1.2 | Design system: tokens, dark/light, shell, nav, keyboard client JS, focus, theme, contrast test; `build.mjs` inlines the client | P1.1 | — | ~350 |
| P1.3 | Gates view (blocked what and why, tallies, false blocks, latency, Stop steps) and Skills view | P1.2 | — | ~300 |
| P1.4 | Context, Tokens and Stop sandbox views | P1.2 | — | ~300 |
| P1.5 | Repo switcher (discovery, index-only, re-root); docs | P1.3, P1.4 | — | ~250 |
| **Phase 2: Live** | | | | |
| P2.1 | `.harness/telemetry/` paths in protect, Edit deny, denyWrite and `HARNESS_LOCAL`; `record.mjs` bundle; invocation hooks (`telemetry.fragment.json`, async); allowlist; rotation | P1.5 | L4 | ~350 |
| P2.2 | Status line snapshot, chaining, recursion guard, dedupe, default line | P2.1 | L3 | ~330 |
| P2.3 | `harness telemetry on\|off\|status` for personal and team; previews; manifest and backups; uninstall; doctor and status lines | P2.2 | — | ~380 |
| P2.4 | Receiver core: OTLP/HTTP JSON, auth checks, allowlist, announcements and routing, lock, idle exit, log; `dist/receiver.mjs` | P2.3 | L1, L2, L5 | ~390 |
| P2.5 | Receiver lifecycle (ensure, restart), retention sweep and caps, the global level (env, bin copies, `receiver.json`, inner status line save and restore, global manifest, `uninstall --global`) | P2.4 | L6 | ~380 |
| P2.6 | OTLP protobuf decoder with recorded payloads | P2.4 | L1 | ~300 |
| P2.7 | Gap detection, back-fill, source and exactness labels, Data health view, banners; transcript cache | P2.5 | — | ~380 |
| P2.8 | Sessions and the live session view: SSE, context gauge, rate limits, timeline, per-skill and per-hook cost | P2.7 | — | ~380 |
| P2.9 | Inventory panel: hooks registered, plugins loaded, MCP connections (OTel), plus agents, commands and MCP from repo files | P2.8 | — | ~200 |
| **Phase 3: Control** | | | | |
| P3.1 | Action runner: templates, preview, apply, hash recheck, audit event, the copy-command path | P2.9 | — | ~350 |
| P3.2 | The §11.2 action table and the task, tdd and context flows; gate toggles if Q10 says so | P3.1 | — | ~300 |
| **Phase 4: History and proof** | | | | |
| P4.1 | Daily rollups (SessionEnd, dashboard, report), retention, the Trends view with sparklines | P3.2 | — | ~350 |
| P4.2 | Done-contract verdicts over time and the false-done trend (needs done PRs 4 to 7) | P4.1, done PR 7 | — | ~250 |
| P4.3 | Export schema 2 (counts only) and the export action | P4.1 | — | ~250 |
| P4.4 | Known limits, reference, README wrap-up, release | All | — | ~150 |

**That is 21 PRs, D0 included.**

**Closest to the limit:** P2.4, P1.1, P2.3, P2.5, P2.7 and P2.8. If one grows past, the splits are:
- P2.4's log and `/shutdown` move to P2.5;
- P1.1's Overview moves to P1.2;
- P2.3's doctor lines become their own PR;
- P2.7's banners move to P2.8.

## 21. Known limits

- **OTel is machine-wide** (§2.1). It can't be turned on per repo or for a team; each person opts in globally. Sessions in other repos export to the receiver and are dropped after 10 minutes in memory.
- **The receiver key and the cookie can be read by a same-uid process.** The key is in `~/.claude/settings.json` and `receiver.json`, so such a process (unsandboxed agent Bash in an attended sandbox-off session included) can post fake OTel records. The dashboard cookie is in the browser's profile store; reading it there drives the dashboard. The isolation spec's read block narrows both.
- **Gate rows can be planted.** They come from `events.jsonl`, which sandboxed Bash can append through harness commands (§4). They are labelled, and cross-checked against OTel hook counts where those exist.
- **Async hook lines can be lost** in `-p` runs, and OTel data while the receiver is down. Gaps are shown, but filled only where the status line or transcripts have the metric.
- **Costs are estimates** from every source (list price).
- **Transcript parsing breaks on format changes;** it shows as unknown, not zero, and the fixtures catch it in CI only for recorded versions.
- **A harness status line where none existed hides Claude Code's footer hints** (SL).
- **Rate limits** appear only for Pro, Max and Ultra, or behind a gateway (SL).
- **Skill names** may read as placeholders if Q2 resolves against verbatim names.
- **A second browser needs a second launch.**
- **Windows:** no `O_NOFOLLOW` (the `lstat` chain only), and status line shell behaviour is unverified.

## 22. Spec points the owner can overrule

1. One receiver per user, routing by announced session, with no per-repo receivers (forced by §2.1).
2. `http/json` set by harness; protobuf accepted; gRPC not.
3. Metrics export interval 15 s (default 60 s); logs left at 5 s.
4. Receiver idle exit at 30 minutes; unannounced buffer of 10 minutes and 5 MB.
5. Retention: OTel 30 days and 50 MB per repo; rollups 400 days; rotation at 5 MB × 2 for the invocation and status line logs.
6. A one-use launch token; a second browser needs a second launch.
7. Pages rendered on the server, client JS for enhancement only, no framework, no chart library.
8. `harness telemetry` as the command name; guard `ask` for it, `deny` for `dashboard`.
9. Default status line output when there is no inner (`<model> · ctx <pct>% · ~$<cost> est.`).
10. Back-fill prefers the status line over OTel for context used (§8.3).
11. Collected data kept on `off` unless separately confirmed.
12. The Gates view lists the last 500 decisions.

## 23. Open questions

1. **OTel only at the global level:** Claude Code ignores the OTel variables in repo settings (§2.1). Does the owner accept OTel only at the global level, with personal and team covering hooks and the status line?
2. **Custom skill-name redaction:** the docs contradict each other on custom skill names. Are they verbatim under `OTEL_LOG_TOOL_DETAILS=1`? Verify live (L2).
3. **`api_request` token attributes:** what are their exact names, and how large are typical payloads? Pin from L1 recordings.
4. **Exporter retry:** does Claude Code's OTLP exporter retry or buffer when the receiver is down? (L1)
5. **Env precedence:** when shell `OTEL_*` and user-settings `env` disagree, which wins? (L6)
6. **The status line command's environment:** does `$CLAUDE_PROJECT_DIR` reach it, what is its `cwd`, and which shell runs it on Windows? (L3)
7. **Async on pre-events:** does `async: true` keep `PreModelSwitch` and `PreCompact` from blocking or injecting output? If not, record only the Post events. (L4)
8. **Loopback from the sandbox:** can sandboxed Bash reach `127.0.0.1` ports? (L5)
9. **Default status line:** when the person has none, should harness add one (hiding the footer hints), or require an existing status line?
10. **Gate toggles:** there is no CLI for the `checks.*` toggles. Add `harness config set checks.<key> on|off [--dry-run|--yes]`, or leave toggles out of phase 3?
11. **Chart library for phase 4 trends:** hand-written SVG, or a library such as uPlot? Its licence and size must be confirmed from its repo before adoption.
12. **Keyboard and axe tests:** add Playwright as a devDependency for them, or keep structural tests plus an owner live check?
13. **Receiver port and metrics interval:** default port 4320 and a 15 s metrics interval: acceptable values?
14. **`events.jsonl`:** it is never rotated and sandbox-writable (`.harness/logs` is skipped). Rotate and protect it in this feature, or separately?
15. **No-follow write helpers:** they aren't on `main`. Land them as D0 here, or wait for the isolation track?
16. **Existing collectors:** for people who already send OTel to their own collector, is fan-out to harness's receiver wanted later, or never?
17. **`prompt_cache` field names:** they aren't listed in the part of SL that was read. Is whitelisting numeric and boolean leaves by a name pattern acceptable until L3 pins them?
18. **Typed `/skill` commands:** does `UserPromptExpansion` fire for them? The docs say the matcher covers "skill or command names". Verify live (L2).

## 24. Not in scope

- Remote telemetry, uploads, or a hosted dashboard.
- Starting, prompting or stopping Claude Code sessions from the page.
- OTel traces and the beta tracing variables.
- gRPC OTLP.
- Fan-out to other collectors.
- Desktop-app and VS Code panes.
- A price table for transcript-only cost.
- Rotating `events.jsonl` (Q14).
