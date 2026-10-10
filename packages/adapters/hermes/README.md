# Paperclip Adapters for Hermes Agent

A [Paperclip](https://paperclip.ing) adapter package that lets you run [Hermes Agent](https://github.com/NousResearch/hermes-agent) as a managed employee in a Paperclip company.

Hermes Agent is a full-featured AI agent by [Nous Research](https://nousresearch.com) with 30+ native tools, persistent memory, session persistence, 80+ skills, MCP support, and multi-provider model access.

This package owns both built-in Hermes adapter types:

- `hermes_local` runs the local Hermes CLI as a child process. The package root exports remain compatible with the original local adapter.
- `hermes_gateway` calls an already-running Hermes API server over HTTP/SSE. Gateway entrypoints live under the `./gateway` export namespace.

Choose `hermes_local` when Paperclip and Hermes run on the same trusted host
and Paperclip should start `hermes chat` for each heartbeat. Choose
`hermes_gateway` when Hermes is already running as an API server, often on
another host, in Docker, or behind a private-network/TLS endpoint. The adapter
type keys did not change during package consolidation.

## Key Features

This adapter provides:

- **8 inference providers** — Anthropic, OpenRouter, OpenAI, Nous, OpenAI Codex, ZAI, Kimi Coding, MiniMax
- **Skills integration** — Scans both Paperclip-managed and Hermes-native skills (`~/.hermes/skills/`), with sync/list/resolve APIs
- **Structured transcript parsing** — Raw Hermes stdout is parsed into typed `TranscriptEntry` objects so Paperclip renders proper tool cards with status icons and expand/collapse
- **Rich post-processing** — Converts Hermes ASCII banners, setext headings, and `+--+` table borders into clean GFM markdown
- **Comment-driven wakes** — Agents wake to respond to issue comments, not just task assignments
- **Auto model detection** — Reads `~/.hermes/config.yaml` to pre-populate the UI with the user's configured model
- **Session codec** — Structured validation and migration of session state across heartbeats
- **Benign stderr reclassification** — MCP init messages and structured logs are reclassified so they don't appear as errors in the UI
- **Session source tagging** — Sessions are tagged as `tool` source so they don't clutter the user's interactive history
- **Filesystem checkpoints** — Optional `--checkpoints` for rollback safety
- **Thinking effort control** — Passes `--reasoning-effort` for thinking/reasoning models

### Hermes Agent Capabilities

| Feature | Claude Code | Codex | Hermes Agent |
|---------|------------|-------|-------------|
| Persistent memory | ❌ | ❌ | ✅ Remembers across sessions |
| Native tools | ~5 | ~5 | 30+ (terminal, file, web, browser, vision, git, etc.) |
| Skills system | ❌ | ❌ | ✅ 80+ loadable skills |
| Session search | ❌ | ❌ | ✅ FTS5 search over past conversations |
| Sub-agent delegation | ❌ | ❌ | ✅ Parallel sub-tasks |
| Context compression | ❌ | ❌ | ✅ Auto-compresses long conversations |
| MCP client | ❌ | ❌ | ✅ Connect to any MCP server |
| Multi-provider | Anthropic only | OpenAI only | ✅ 8 providers out of the box |

## Installation

This package ships with Paperclip core as the built-in `hermes_local` and
`hermes_gateway` adapters. No Adapter manager installation is required for
normal Paperclip use.

### Prerequisites

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed (`pip install hermes-agent`)
- Python 3.10+
- At least one LLM API key (Anthropic, OpenRouter, or OpenAI)

## Quick Start

### 1. Optional: override the built-in for adapter development

For local adapter development, install the package from a local path in Adapter
manager, or add an entry to `~/.paperclip/adapter-plugins.json` and restart
Paperclip. The external package can override either built-in Hermes adapter
while it is enabled:

```json
[
  {
    "packageName": "@paperclipai/hermes-paperclip-adapter",
    "localPath": "/absolute/path/to/paperclip/packages/adapters/hermes",
    "type": "hermes_local",
    "installedAt": "2026-06-23T00:00:00.000Z"
  }
]
```

Use `"type": "hermes_gateway"` with the same package when testing a gateway
override.

The package root exports `createServerAdapter()` for the local server adapter,
a declarative config schema for the generic agent form, and `./ui-parser` for
local run transcript parsing. Gateway entrypoints are exported from `./gateway`,
`./gateway/server`, `./gateway/ui`, `./gateway/cli`, and `./gateway/ui-parser`.
Paperclip core imports these same package entrypoints for built-in adapter
registration.

### 2. Create a local Hermes agent in Paperclip

In the Paperclip UI or via API, create an agent with adapter type `hermes_local`:

```json
{
  "name": "Hermes Engineer",
  "adapterType": "hermes_local",
  "adapterConfig": {
    "model": "anthropic/claude-sonnet-4",
    "maxIterations": 50,
    "timeoutSec": 300,
    "persistSession": true,
    "enabledToolsets": ["terminal", "file", "web"]
  }
}
```

This mode shells out to the local `hermes` CLI. Paperclip injects runtime
environment variables and captures stdout/stderr from the child process.

### 3. Create a Hermes gateway agent in Paperclip

Start Hermes with its API server enabled first:

```bash
API_SERVER_ENABLED=true \
API_SERVER_KEY=<generated-secret> \
hermes gateway run --replace --accept-hooks
```

Then create an agent with adapter type `hermes_gateway`:

```json
{
  "name": "Hermes Gateway Engineer",
  "adapterType": "hermes_gateway",
  "adapterConfig": {
    "apiBaseUrl": "http://127.0.0.1:8642",
    "apiKey": "<same-value-as-API_SERVER_KEY>",
    "paperclipApiUrl": "http://127.0.0.1:3100",
    "sessionKeyStrategy": "issue",
    "timeoutSec": 600
  }
}
```

If the URL you have is the default Hermes dashboard at
`http://127.0.0.1:9119` or the default chat URL at
`http://127.0.0.1:9119/chat`, Paperclip maps it to
`http://127.0.0.1:9119/api` before calling Hermes API routes. `/chat` and the
dashboard root are browser UI routes; Paperclip tests `/api/health` and starts
runs with `/api/v1/runs` after mapping them to the API base.

This mode does not start Hermes. It creates runs with `POST /v1/runs`, streams
Hermes events with SSE, polls run status as a fallback, and stops timed-out runs
with `POST /v1/runs/{run_id}/stop`.

### Compatibility with the old gateway package

`@paperclipai/adapter-hermes-gateway` remains as a deprecated compatibility shim
for one release. It re-exports the gateway entrypoints from
`@paperclipai/hermes-paperclip-adapter/gateway` and preserves the legacy exports
for existing plugin installs. New installs and built-in Paperclip registrations
should use `@paperclipai/hermes-paperclip-adapter`; the adapter type remains
`hermes_gateway`.

### Runtime API guidance

Hermes receives Paperclip runtime identity through environment variables:

- `PAPERCLIP_API_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_RUN_ID`

Prompts should reference those variables directly. Command output may redact
secret values, so do not copy printed tokens into comments or config. Use
`Authorization: Bearer $PAPERCLIP_API_KEY` on Paperclip API requests and
`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on mutating issue requests. For
multiline comments or status updates, preserve newlines with a heredoc plus
`jq --arg`.

### Hermes-originated Paperclip tasks

The package includes a Hermes skill/helper for the reverse direction: a user
starts in Hermes and asks Hermes to create or update Paperclip work. This is not
the same as Paperclip waking Hermes through `hermes_local` or `hermes_gateway`.

Configure Paperclip access in Hermes env/profile secrets, not prompt text:

```bash
PAPERCLIP_API_URL=http://127.0.0.1:3100/api
PAPERCLIP_BRIDGE_API_KEY=<task-bridge-scoped-agent-api-key>
```

Optional env values:

- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_AGENT_ID`
- `PAPERCLIP_RUN_ID`

The bundled `paperclip-task-bridge` skill provides deterministic helper
commands:

```bash
node ./paperclip-task.mjs list-assigned
node ./paperclip-task.mjs create-task --parent-id "<approved-parent-issue-id>" --title "Investigate checkout failures" --description "Capture failing request and root cause."
node ./paperclip-task.mjs comment --issue PAP-123 --body "Found the failing request path."
node ./paperclip-task.mjs update-status --issue PAP-123 --status in_review --comment "Ready for review."
```

The helper reads credentials from environment variables and prints only JSON
summaries. It supports `create-task`, `comment`, `update-status`, and
`list-assigned`.

Create the bridge key with `scope.kind = "task_bridge"` plus a `parentIssueId`
or `projectId` boundary. Do not use a normal claimed agent API key for
internet-facing Hermes chat/webhook task-bridge operations.

### 4. Assign work

Create issues in Paperclip and assign them to your Hermes agent. On each heartbeat, Hermes will:

1. Receive the task instructions
2. Use its full tool suite to complete the work
3. Report results back to Paperclip
4. Persist session state for continuity

## Configuration Reference

### Core

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `anthropic/claude-sonnet-4` | Model in `provider/model` format |
| `provider` | string | *(auto-detected)* | API provider: `auto`, `openrouter`, `nous`, `openai-codex`, `zai`, `kimi-coding`, `minimax`, `minimax-cn` |
| `timeoutSec` | number | `300` | Execution timeout in seconds |
| `graceSec` | number | `10` | Grace period before SIGKILL |

### Tools

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolsets` | string | *(all)* | Comma-separated toolsets to enable (e.g. `"terminal,file,web"`) |
| `boundedExecution` | boolean | `false` | Request web-only bounded execution; the service must also pin the agent ID and dedicated `HERMES_HOME` |

Available toolsets: `terminal`, `file`, `web`, `browser`, `code_execution`, `vision`, `mcp`, `creative`, `productivity`

### Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cwd` | string | *(assigned task workspace)* | Absolute working directory override. Without an override, use Paperclip's resolved task workspace. |
| `persistSession` | boolean | `true` | Resume sessions across heartbeats |
| `worktreeMode` | boolean | `false` | Git worktree isolation |
| `checkpoints` | boolean | `false` | Enable filesystem checkpoints for rollback |

### Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hermesCommand` | string | `hermes` | Custom CLI binary path |
| `verbose` | boolean | `false` | Enable verbose output |
| `quiet` | boolean | `true` | Quiet mode (clean output, no banner/spinner) |
| `extraArgs` | string[] | `[]` | Additional CLI arguments |
| `env` | object | `{}` | Extra environment variables |
| `promptTemplate` | string | *(built-in)* | Custom prompt template |
| `paperclipApiUrl` | string | `http://127.0.0.1:3100/api` | Paperclip API base URL |

Standard mode retains the earlier unattended CLI behavior, including `--yolo`,
and the legacy host environment for existing agents. Managed AI connections
use only their selected runtime environment. Use bounded mode for new research
agents that must not bypass Hermes approvals.

Bounded mode requires a private, real `env.HERMES_HOME` directory owned by the
runtime user. The Paperclip service operator must set
`PAPERCLIP_HERMES_BOUNDED_HOME` to this exact absolute path in the server
environment, and `PAPERCLIP_HERMES_BOUNDED_AGENT_ID` to the saved agent ID.
Both are checked before every run and neither is passed to the child. The
agent ID pin prevents an adapter-config update from switching that agent back
to standard mode. Without the pin, a requested bounded run fails closed.
Use one dedicated home per bounded agent and a separate service process when
multiple agents require different homes. The home must be separate from the
host home, and `.env` and
`auth.json`, when present, must be private regular files. The only supported
toolset is `web`; all `extraArgs` and agent-configured command overrides are
rejected. Custom `promptTemplate` is ignored in bounded mode so a configured
terminal instruction cannot override the web-only task contract. The adapter passes `--ignore-user-config` and
`--ignore-rules`; the latter suppresses home instructions and memories without
disabling tool approvals. On Mini Hermes v0.14.0 plugins can load before those
flags take effect, so the dedicated home's plugins, hooks, skills, memories,
and cron directories must stay private and empty. Any skills prompt snapshot
must contain the exact empty structure. `active_profile` may only be absent or
`default`, and any `config.yaml` requires a matching operator-owned SHA-256 in
`PAPERCLIP_HERMES_CONFIG_SHA256`. A present `mcp.json` blocks startup. These
checks run before every bounded execution and environment probe. Its `.env` accepts only provider and
search connection keys. Server-added scratch and Git environment fields are
ignored. Bounded mode requires an explicit provider other than
`auto`, an explicit model, and a positive `maxTurnsPerRun`. The operator may
pin an absolute Hermes executable with the Paperclip server environment
variable `PAPERCLIP_HERMES_TRUSTED_COMMAND`; this value is not taken from agent
config or forwarded to Hermes.

On Mini Hermes v0.14.0, fresh `hermes auth add openai-codex --type oauth
--no-browser` stores a dedicated OAuth credential pool in `auth.json`, but the
first-run setup gate does not count that pool by itself. Provision a private
`config.yaml` with `model.provider: openai-codex` and only the three observed
`onboarding.seen` flags (`busy_input_prompt`, `tool_progress_prompt`,
`openclaw_residue_cleanup`) set to `true`. Compute the file's SHA-256 and set
`PAPERCLIP_HERMES_CONFIG_SHA256` in the Paperclip service environment to that
exact value. The CLI still receives an explicit `-m` and `--provider`; do not
put a token or API key in `config.yaml`. The current Hermes version reads some
home configuration before it applies `--ignore-user-config`, so changing the
config or upgrading Hermes requires a new source review and hash pin. For an
OAuth renewal that cannot refresh, list and remove the old dedicated-home
credential ID before running a fresh `auth add`; do not import the shared
`~/.codex/auth.json` into this home.

For sustained web research, configure an official Hermes search backend in
that dedicated `.env`, such as `TAVILY_API_KEY`. Enabling the `web` toolset
alone does not provide search. Store the key outside agent instructions and
never put it in an issue or a run prompt. Bounded mode currently returns
research output to Paperclip; issue updates and independent QA require a
separate control-plane path. See the [Hermes web-search guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/web-search.md).
It does not give Hermes the Paperclip run API token or runtime connector token.
The adapter ignores managed instruction files, connector guidance and agent
working directories, creates a fresh empty directory for each run, and refuses
worktree creation and checkpoints. Bounded runs use the server-owned task brief and
return their answer in the Run result for later review.
The bounded process runs under the Paperclip service user, so it can still
read its own provider authentication files. Protecting those credentials from
arbitrary code running as that same OS user requires a separate UID or a
credential broker; this mode does not promise such isolation.
The operator pin applies while this agent uses the Hermes adapter. An actor
authorized to change its adapter type can move the agent to another runtime;
restrict that permission for the pinned agent or use a separate service user.
For the COL-17 Mini pilot, the observed binding uses local `openai-codex`
authentication and no managed AI routing. A managed connection with additional
endpoint environment variables needs a separate compatibility check before use.

### Prompt Template Variables

Use `{{variable}}` syntax in `promptTemplate`:

| Variable | Description |
|----------|-------------|
| `{{agentId}}` | Paperclip agent ID |
| `{{agentName}}` | Agent display name |
| `{{companyId}}` | Company ID |
| `{{companyName}}` | Company name |
| `{{runId}}` | Current heartbeat run ID |
| `{{taskId}}` | Assigned task/issue ID |
| `{{taskTitle}}` | Task title |
| `{{taskBody}}` | Task instructions |
| `{{projectName}}` | Project name |
| `{{paperclipApiUrl}}` | Paperclip API base URL |
| `{{commentId}}` | Comment ID (when woken by a comment) |
| `{{wakeReason}}` | Reason this run was triggered |

Conditional sections:

- `{{#taskId}}...{{/taskId}}` — included only when a task is assigned
- `{{#noTask}}...{{/noTask}}` — included only when no task (heartbeat check)
- `{{#commentId}}...{{/commentId}}` — included only when woken by a comment

## Architecture

```
Paperclip                          Hermes Agent
┌──────────────────┐               ┌──────────────────┐
│  Heartbeat       │               │                  │
│  Scheduler       │───execute()──▶│  hermes chat -q  │
│                  │               │                  │
│  Issue System    │               │  30+ Tools       │
│  Comment Wakes   │◀──results─────│  Memory System   │
│                  │               │  Session DB      │
│  Cost Tracking   │               │  Skills          │
│                  │               │  MCP Client      │
│  Skill Sync      │◀──snapshot────│  ~/.hermes/skills│
│  Org Chart       │               │                  │
└──────────────────┘               └──────────────────┘
```

The adapter spawns Hermes Agent's CLI in single-query mode (`-q`). Hermes
processes the task using its full tool suite, then exits. The adapter:

1. **Captures** stdout/stderr and parses token usage, session IDs, and cost
2. **Parses** raw output into structured `TranscriptEntry` objects (tool cards with status icons)
3. **Post-processes** Hermes ASCII formatting (banners, setext headings, table borders) into clean GFM markdown
4. **Reclassifies** benign stderr (MCP init, structured logs) so they don't show as errors
5. **Tags** sessions as `tool` source to keep them separate from interactive usage
6. **Reports** results back to Paperclip with cost, usage, and session state

Session persistence works via Hermes's `--resume` flag — each run picks
up where the last one left off, maintaining conversation context,
memories, and tool state across heartbeats. The `sessionCodec` validates
and migrates session state between runs.

### Skills Integration

The adapter scans two skill sources and merges them:

- **Paperclip-managed skills** — bundled with the adapter, togglable from the UI
- **Hermes-native skills** — from `~/.hermes/skills/`, read-only, always loaded

The `listSkills` / `syncSkills` APIs expose a unified snapshot so the
Paperclip UI can display both managed and native skills in one view.

## Development

```bash
git clone https://github.com/paperclipai/paperclip
cd paperclip/packages/adapters/hermes
pnpm install
pnpm build
```

## License

MIT — see [LICENSE](LICENSE)

## Links

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — The AI agent this adapter runs
- [Paperclip](https://github.com/paperclipai/paperclip) — The orchestration platform
- [Nous Research](https://nousresearch.com) — The team behind Hermes
- [Paperclip Docs](https://docs.paperclip.ing) — Paperclip documentation
