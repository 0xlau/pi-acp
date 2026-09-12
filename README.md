# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent).

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Fork differences

This is [0xlau](https://github.com/0xlau/pi-acp)'s fork of
[svkozak/pi-acp](https://github.com/svkozak/pi-acp). On top of upstream `0.0.33` it adds:

- **Extension commands are advertised by default** (upstream hides every command whose
  `source` is `extension`). `/goal`, `/subagents`, `/websearch`, ... now appear in the ACP
  client's `/` menu. Opt out with `piAcp.extensionCommands: false` or
  `PI_ACP_EXTENSION_COMMANDS=0`.
- **Extension dialogs are bridged through ACP elicitation**, so `input` and `editor`
  actually work instead of being cancelled. This is what makes pi's guided `/goal` flow
  usable from an editor. See [Extension UI](#extension-ui).
- **Command-only turns complete.** Extension commands that never start an agent loop no
  longer leave the ACP prompt hanging. See
  [Turn completion for command-only prompts](#turn-completion-for-command-only-prompts).
- **Fire-and-forget requests are no longer answered** (`notify`, `setStatus`, `setWidget`,
  `setTitle`, `set_editor_text`), matching pi's RPC contract.
- `piAcp` settings block with env overrides, resolved per session cwd.

Upstream rationale for the old behaviour is in
[svkozak/pi-acp#20](https://github.com/svkozak/pi-acp/pull/20).

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support, other clients may have varying levels of compatibility.

Expect some minor breaking changes.

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Skills are loaded by pi directly and are available in ACP sessions
- (Zed) `pi-acp` emits “startup info” block into the session (pi version, context, skills, prompts, extensions - similar to `pi` in the terminal). You can disable it by setting `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`). When `quietStartup` is enabled, `pi-acp` will still emit a 'New version available' message if the installed pi version is outdated.
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js 22+
- `pi` v0.80.4+ installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

#### Using ACP Registry in Zed or other clients that support it:

In Zed launch the registry with `zed: acp registry` command and select `pi ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "pi-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version):

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "pi-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Environment variables

- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext` support to the client.
- Default: unset/any other value means `false`.
- When disabled, compliant ACP clients should avoid sending embedded `resource` blocks. If they send them anyway, `pi-acp` still degrades gracefully by converting them into plain-text prompt context.

You can add the environment variable in the Zed settings with:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {
          "PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
      }
    }
  }
```

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/queue all|one-at-a-time` – set pi queue mode (unstable feature)
- `/changelog` – print the installed pi changelog (best-effort)
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - pats to `pi` Follow-up Mode, get/set

Other built-in commands:

- `/model` - not implemented (use the model selector UI in Zed)
- `/thinking` - maps to 'mode' selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

#### 4) Extension commands

Commands registered by pi extensions (`pi.registerCommand()`, for example `/goal` from
`pi-goal-x`, or `/subagents` from `pi-subagents`) are read from pi's `get_commands` RPC and
advertised to the ACP client, so they show up in the `/` menu and execute normally.

They are advertised **by default**. If you prefer a smaller command list, turn them off in
pi settings or via the environment:

```json
{
  "piAcp": { "extensionCommands": false }
}
```

```bash
PI_ACP_EXTENSION_COMMANDS=0 pi-acp
```

Extension **dialogs** are bridged to the client as well — see [Extension UI](#extension-ui).

## Extension UI

pi extensions interact with the user through `ctx.ui.*` (`select`, `confirm`, `input`,
`editor`, `notify`, ...). In RPC mode pi turns those into `extension_ui_request` events;
`pi-acp` maps them onto ACP:

| pi method                                               | ACP mechanism                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `select`                                                | elicitation form (single-select enum), or `session/request_permission` for clients without elicitation            |
| `confirm`                                               | elicitation form (boolean), or `session/request_permission` for clients without elicitation                       |
| `input`                                                 | elicitation form (string, `placeholder` as description)                                                           |
| `editor`                                                | elicitation form (string, `prefill` as default)                                                                   |
| `notify`                                                | `agent_message_chunk`, tagged with `_meta.piAcp.notify.level`                                                     |
| `setStatus`, `setWidget`, `setTitle`, `set_editor_text` | no ACP surface; dropped silently (echoed when `PI_ACP_EXTENSION_UI_DEBUG=1`)                                      |
| `custom`                                                | not renderable over ACP (pi already returns `undefined` for `custom()` in RPC mode); declined with an explanation |

Dialog methods are always answered exactly once so extension promises settle; fire-and-forget
methods are never answered. If pi includes a `timeout` on a dialog, `pi-acp` stops waiting at
the same deadline without sending a response, because pi resolves its own side.

Configure the strategy with:

```json
{
  "piAcp": { "extensionUi": "auto" }
}
```

- `auto` (default): elicitation when the client advertises `clientCapabilities.elicitation.form`, otherwise permission dialogs where possible.
- `permission`: never use elicitation. `select`/`confirm` use permission dialogs; `input`/`editor` are declined with an explanation.
- `off`: never prompt. Every dialog is declined with an explanation.

Environment overrides: `PI_ACP_EXTENSION_UI=auto|permission|off`,
`PI_ACP_EXTENSION_COMMANDS=0|1`, `PI_ACP_EXTENSION_UI_DEBUG=1`. Precedence is
environment > project `.pi/settings.json` > `~/.pi/agent/settings.json` > defaults.

## Turn completion for command-only prompts

pi's RPC `prompt` response only acknowledges acceptance; turn completion normally comes from
the `agent_settled` event. Extension commands that never start an agent loop (for example
`/goal-list`, `/goal-status`, `/subagents-models`) never emit `agent_settled`, which would
leave the ACP `session/prompt` pending forever.

`pi-acp` therefore probes pi's session state (`get_state`) after the acknowledgement. If no
agent loop started and the session is idle (`isStreaming`, `isCompacting`,
`pendingMessageCount` all clear) the turn is completed with `end_turn`. The probe runs at
120/370/870 ms; a real agent turn emits `agent_start` in the same tick as the
acknowledgement, so live turns are never cut short.

## Local Zed setup (this fork)

Zed launches pi-acp from a stable launcher so the config does not depend on the active node
version:

```bash
# ~/bin/pi-acp-fork
#!/usr/bin/env bash
set -euo pipefail
exec /Users/liupeiqiang/.asdf/shims/node \
  /Users/liupeiqiang/Studio/OpenSource/pi-acp/dist/index.js "$@"
```

`~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "pi-acp": {
      "type": "custom",
      "command": "/Users/liupeiqiang/bin/pi-acp-fork",
      "args": [],
      "env": {}
    }
  }
}
```

After changing sources, rebuild and restart the agent in Zed:

```bash
cd /Users/liupeiqiang/Studio/OpenSource/pi-acp
npm run build
```

The previous ACP-registry install (`.../Zed/external_agents/registry/npx/pi-acp`) has been
removed.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally.
- MCP servers are accepted in ACP params and stored in session state, but not wired through to pi in this adapter. If you use [pi MCP adapter](https://github.com/nicobailon/pi-mcp-adapter) it will be available in the ACP client.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Queue is implemented client-side and should work like pi's `one-at-a-time`
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)).
