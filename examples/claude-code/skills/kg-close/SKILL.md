---
name: kg-close
description: Close the Komplyt Zero session before context is lost. Records new decisions, observations and problems, re-activates the nodes this session relied on, resolves fixed problems, relates connected nodes and ends the session. Use at the end of a working session, before compacting context, or when the user says "close the session" or "kg-close".
---

# Close the Komplyt Zero session

Decay lowers every node in the project by 15 % each time a session starts. Anything this session learned but did not record is lost, and anything it relied on but did not re-activate starts sinking. Run these steps in order. If the `kg_*` tools are not available, say so and stop.

## 1. Record what is new

For each decision, reusable approach, hard-won observation and unresolved problem from this session:

1. Query first: `kg_query` with `read_only: true` and the topic as `text`. If a node already covers it, re-activate or relate that node instead of creating another.
2. Otherwise create it with `kg_node_create`:
   - decisions: `type: "decision"`, including the reason and, if there is one, the condition to revisit
   - patterns that worked: `type: "approach"`
   - facts worth knowing next time: `type: "observation"`
   - problems still open: `type: "problem"`, `status: "open"`

Keep nodes atomic: one node holds one decision, approach, observation or problem. If describing it takes an "and", split it into two nodes and relate them in step 4. Atomic nodes are retrieved precisely, decay on their own, and can be linked.

Write specific, searchable content: who or what, what happened or was decided, and why. Do not record todos, summaries of the conversation, or context that only matters for this session. Keep secrets and personal data out.

## 2. Re-activate everything this session relied on

Run `kg_query` with keywords from today's work. For every returned node that informed the work or is still relevant, call `kg_node_update` with only its `id`. Include nodes already quoted earlier in the session, because being returned by a query re-activates a node far less than an update does.

## 3. Resolve fixed problems

For each problem this session fixed, call `kg_node_update` with its `id` and `status: "resolved"`. If the fix itself is worth knowing, record it as a `mitigation` or `workaround` and relate it to the problem.

## 4. Relate connected nodes

For each pair of nodes that belong together, especially new nodes and the existing ones they build on, call `kg_relate` with `from` and `to`. Edges carry no type, so if the kind of connection matters, a node's content should already state it.

## 5. End the session

Call `kg_session_end`.

## Report

Finish with a short summary: what was recorded (type and one line each), how many nodes were re-activated, which problems were resolved and which relations were created.
