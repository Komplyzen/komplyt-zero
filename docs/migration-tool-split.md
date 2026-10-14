# Tool names: migrating from the combined tools

Earlier versions exposed a few combined tools that took an `action` parameter
(`kg_session action=start`, `kg_node action=create`) or used older names
(`kg_record`, `kg_update`). OpenAI's connector review does not accept tools that
dispatch several operations through one parameter, so every tool now does one
thing, and the old names are no longer listed in `tools/list`.

## MCP tools

| Old call | New tool |
|----------|----------|
| `kg_session` action=start | `kg_session_start` |
| `kg_session` action=end | `kg_session_end` |
| `kg_session` action=info | `kg_session_info` (needs only `kg:read`) |
| `kg_session` action=status | `kg_status` |
| `kg_node` action=create, `kg_record` | `kg_node_create` |
| `kg_node` action=update, `kg_update` | `kg_node_update` |

`kg_query`, `kg_relate` and `kg_meta_model` keep their names. The annotations of
`kg_query` and `kg_relate` now declare that they write, because both update
usage scores (`kg_query` only when `read_only` is not set).

## REST (`/api/v1`)

| Old | New |
|-----|-----|
| `POST /session` | `POST /session/start`, `POST /session/end`, `GET /session/info` |
| `POST /record` | `POST /node/create` (response now includes `action: "created"`) |
| `POST /update` | `POST /node/update` (response is now `{action, id, new_decay_score, node}`) |
| `GET /status` | unchanged |

Callers outside this repo (agent skills, other repos' instructions, saved
connector prompts) must be updated to the new names.

## Temporary compatibility (MCP only)

ChatGPT keeps offering the old tool names from its last approved scan until
OpenAI re-reviews the new ones, so for a limited time the MCP endpoint still
accepts calls to `kg_session`, `kg_node`, `kg_record` and `kg_update` and routes
them to the new tools (`src/tools/legacy.ts`). They are never listed, so the
scan sees them as deleted. Each call logs `Deprecated tool name called`. The
aliases switch themselves off on 2026-11-06 (`LEGACY_TOOLS_UNTIL`); delete
`legacy.ts` and its references after that. REST routes have no such alias.
