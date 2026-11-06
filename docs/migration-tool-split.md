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

## Removed compatibility aliases (MCP only)

For a transition period the MCP endpoint still accepted calls to the old names
`kg_session`, `kg_node`, `kg_record` and `kg_update` and routed them to the new
tools, because ChatGPT keeps offering tool names from its last approved scan
until OpenAI re-reviews the new ones. The aliases switched themselves off on
2026-11-06 and the code (`src/tools/legacy.ts`) has been deleted. A call to an old
name now returns `Unknown tool`. OpenAI's rescan showed no errors before the
removal. REST routes never had such an alias.
