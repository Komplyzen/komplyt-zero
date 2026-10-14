# Examples

These files are meant to be copied into your own projects.

| File | What it is |
|------|------------|
| [sessions.md](sessions.md) | Five complete exchanges as tool calls, from recording a decision to closing a session |
| [claude-code/CLAUDE.md](claude-code/CLAUDE.md) | A block of agent instructions that makes Claude Code, or any agent that reads a project instruction file, use Zero well |
| [claude-code/skills/kg-close/SKILL.md](claude-code/skills/kg-close/SKILL.md) | The end-of-session routine from [docs/using-zero.md](../docs/using-zero.md) as a Claude Code skill |

The examples call the tools by their plain names (`kg_query`, `kg_node_create` and so on). Your client may show them with a prefix that depends on the name you registered the server under; the tools themselves are the same.
