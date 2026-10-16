# Using Zero well

The tools are simple enough that an agent can call them without any instructions at all, but a graph filled that way, without a few habits, turns into a heap of near-duplicate notes that rank each other down. This guide collects the habits that made the difference for us, the mistakes we made before we learned them, and a routine for closing a session. All examples use the current tool names; schemas are in `src/contracts.ts`.

## The model in one paragraph

A node is a piece of text with a type, a status, a project, optional tags and an embedding. Edges connect nodes and get stronger each time they are reinforced. A session belongs to a project, and starting one multiplies the decay score of every node in that project by 0.85, so scores fall off exponentially. Querying a node lifts its score a little toward a ceiling of 0.85, updating it lifts it more, and new nodes start at 1.0. Search ranks by meaning first (70 %) and recency of use second (30 %), then follows edges to bring in neighbours. Everything below follows from those mechanics.

## What to record

Record what a future session would otherwise have to work out again, or would get wrong:

- **decision**: a choice that was made, with the reason and, where one exists, the condition under which it should be revisited
- **problem**: something broken or blocking, with status `open` until it is fixed
- **observation**: a fact learned the hard way, such as an API that behaves differently from its documentation
- **approach**: a way of doing something that worked and should be reused
- **mitigation** and **workaround**: what was done about a problem, permanently or for now
- **argument**: a case for or against an option, when the decision is not made yet

Leave out todos that a task tracker already holds, summaries of the conversation, and anything that is only true for the next ten minutes. They crowd the results for the things that matter, and they decay at the same rate as everything else, so the graph spends its ranking budget on them.

Write the content so it stands on its own. The content is the only part that gets embedded, so a node that says "decided to go with option B" will never be found by someone asking about the thing option B was for. Name the subject, state the choice, give the reason. A useful test is whether the node could be pasted into a design document without editing.

## Habits that pay off

**Query before you record.** Zero does not deduplicate. Two agents that learn the same thing in two sessions will create two nodes, and from then on each one splits the ranking the other would have had. A quick `kg_query` with `read_only: true` before every `kg_node_create` avoids this.

**Start every session in the right project.** Decay, inheritance and filtering all key on `project`. A node created without a project takes the session's project, and working in project A never decays the nodes of project B. Omitting `project` from queries searches the whole tenant, which is sometimes what you want and often the reason an answer from an unrelated project turns up first.

**Re-activate what you relied on.** Calling `kg_node_update` with only an `id` changes nothing in the node but lifts its decay score back toward the 0.85 ceiling. Without that, a node keeps only 85 % of its score each session in its project and drops out of the top results after a few dozen sessions, however important it is. The end-of-session routine below does this systematically.

**Relate nodes when you see a connection.** Edges are what spreading activation follows, and nodes in a dense neighbourhood get a larger boost when they are used. Edges carry no type, so if the nature of the link matters ("this replaces that", "this was caused by that"), say so in the content of one of the nodes.

**Use `read_only: true` when you are only looking.** Every query without it slightly reinforces the nodes it returns. That is the right behaviour for an agent that is about to use the results, and the wrong one for a dashboard, a benchmark or a smoke test, which would otherwise keep their own probe nodes artificially fresh. The flag must be a JSON boolean or the string `"true"`; any other string is read as false.

**Close resolved problems.** Open problems and todos are listed by `kg_status` until their status changes. A problem that was fixed but never set to `resolved` keeps appearing as a blocker in every session.

## Changing your mind without losing the history

There is no delete, and `kg_node_update` replaces content wholesale. If you overwrite an old decision with a new one, you lose the reasoning that led to the first, which is often exactly what someone needs when they wonder why the new decision was necessary. We replace decisions in three ordered steps instead:

1. Create the new decision, naming the node it supersedes and why, and pass the old id in `relates_to`.
2. Update the old node, keeping its full original text and appending a dated line that points to the new one.
3. Check that the create response reports `edges_created: 1`. An id in `relates_to` that does not exist is skipped silently.

The order matters because there are no transactions across calls. If a session dies halfway, the state that remains is still correct and the remaining steps can be run again.

Since an update replaces the content, always start from the node's current text (from a `kg_query` result) rather than from memory, or you will silently cut what someone else added.

## Things we noticed

**Negated questions retrieve badly.** "Who is not our target customer" embeds close to "who is our target customer" and returned the wrong nodes twice before we rephrased it positively. Ask for the thing itself.

**Dense clusters keep stale nodes alive.** A superseded technology choice kept surfacing for weeks because it had accumulated well over a hundred co-activation edges, and every query that touched its neighbours lifted it again. Marking it as superseded in its content fixed the answers, if not the ranking, so relate nodes when the connection means something rather than out of habit.

**The `author` field records who made the tool call.** When an agent records someone else's notes, the node's author is the agent's user. Put the original writer and the date of the original note into the content, and resolve relative dates ("yesterday", "next week") against that date, not against the day of import.

**Bulk import needs precise instructions.** When we let a small model extract memory from chat transcripts with the instruction "keep what matters", it produced a handful of vague summaries, skipped whole sessions and labelled small talk as decisions. Telling it to extract atomic facts with the date they happened in worked far better. The node types are designed for work, not for personal conversation.

**Spreading activation costs time.** It is on by default, and on a large, dense graph a query can hit the server's time limit. The response then carries `timeout` or `truncated` and a `hint` saying what to turn down: `spread: false`, `spread_hops: 1`, `include_edges: false` or a lower `limit`.

**Some clients ask before every search.** Because `kg_query` writes usage scores, it does not declare itself read-only, and some MCP clients ask for confirmation each time. Allowing the tool permanently in the client fixes this.

**Keep secrets out of nodes.** Content is stored as plain text and is visible to everyone with access to its container. Treat the graph like a shared wiki, not like a password manager.

## Closing a session

Most of the value is lost at the end of a session, when the agent has learned something and the context is about to be cleared. We close every working session with the same five steps, in this order:

1. **Record what is new.** Query first, then create decisions, approaches, observations and open problems that came out of the session.
2. **Re-activate what you used.** Query with keywords from the session's work and call `kg_node_update` with only the id for every node that informed it, including the ones already quoted earlier in the session.
3. **Resolve what was fixed.** Set `status: "resolved"` on problems the session closed.
4. **Relate what belongs together.** Create edges between the new nodes and the existing ones they build on.
5. **End the session** with `kg_session_end`.

[examples/claude-code/skills/kg-close/SKILL.md](../examples/claude-code/skills/kg-close/SKILL.md) is this routine as a Claude Code skill. Copy it into `.claude/skills/` in your project, or adapt it to whatever your client uses for reusable prompts.

## Checking that retrieval still works

A graph can degrade without anyone noticing: embeddings fail silently for a few nodes, decay pushes important answers down, or a change to the ranking breaks spreading activation. We keep a handful of questions whose correct answer we know, run them with `read_only: true` every so often, and record the result as an observation in the graph itself, so the trend is visible next time. Keep the nodes those questions should find activated, or decay will make the check fail for the wrong reason.

## Examples

[examples/sessions.md](../examples/sessions.md) walks through five complete exchanges as tool calls: recording a decision, finding it later by meaning, tracking a problem to resolution, superseding a decision, and closing a session. [examples/claude-code/CLAUDE.md](../examples/claude-code/CLAUDE.md) is a short block of instructions to add to a project's agent instructions so that agents use Zero this way without being told each time.
