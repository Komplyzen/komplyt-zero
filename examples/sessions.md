# Example sessions

Five exchanges from a fictional team working on a service called `acme-api`, written as the tool calls an agent makes. Ids like `node:<decision-id>` stand for the ids returned by earlier calls. The habits behind each step are explained in [docs/using-zero.md](../docs/using-zero.md).

## 1. Record a decision with its reason

The team is choosing how to deliver webhooks. The agent starts a session (creating the project the first time) and checks whether the question was settled before.

```json
{"tool": "kg_session_start", "arguments": {"project": "acme-api", "create_project": true, "notes": "Choosing a queue for webhook delivery"}}
{"tool": "kg_query", "arguments": {"text": "queue choice for webhook delivery", "project": "acme-api", "limit": 5, "read_only": true}}
```

Nothing relevant comes back, so the agent records the decision, with the reason and the condition under which it should be revisited:

```json
{"tool": "kg_node_create", "arguments": {
  "type": "decision",
  "project": "acme-api",
  "tags": ["architecture", "webhooks", "queue"],
  "content": "Webhook delivery uses a Postgres job table (SKIP LOCKED) instead of Redis or SQS. Why: under 1k jobs/min, Postgres already runs, and enqueueing in the same transaction as the business write means no lost events. Revisit above 10k jobs/min sustained."
}}
```

## 2. Find it later by meaning

Weeks later a different developer, in a different client, wonders why there is no Redis in the stack:

```json
{"tool": "kg_session_start", "arguments": {"project": "acme-api"}}
{"tool": "kg_query", "arguments": {"text": "why don't we use Redis for background jobs?", "project": "acme-api", "spread": true, "spread_hops": 2, "limit": 10}}
```

The decision ranks first, although the question shares almost no words with it. Because `spread` is on, nodes linked to the decision come back as well, such as the problem recorded in the next example. Since `read_only` is not set, the returned nodes are slightly reinforced, which is correct here: the agent is about to use them.

## 3. Track a problem to resolution

A retry storm hits a slow customer endpoint. The agent records the problem, links it to the delivery decision, and closes it once the fix is deployed.

```json
{"tool": "kg_node_create", "arguments": {
  "type": "problem",
  "status": "open",
  "project": "acme-api",
  "tags": ["webhooks", "retries"],
  "content": "Webhook retries overwhelm slow receivers: fixed 5 s backoff without jitter sent 40 requests/s to one endpoint during its outage."
}}
{"tool": "kg_relate", "arguments": {"from": "node:<problem-id>", "to": "node:<decision-id>"}}
```

After the fix:

```json
{"tool": "kg_node_create", "arguments": {
  "type": "mitigation",
  "project": "acme-api",
  "relates_to": ["node:<problem-id>"],
  "content": "Webhook retries now use exponential backoff with full jitter (base 2 s, cap 10 min) and a per-endpoint circuit breaker that pauses delivery after 20 consecutive failures."
}}
{"tool": "kg_node_update", "arguments": {"id": "node:<problem-id>", "status": "resolved"}}
```

## 4. Supersede a decision without losing its history

Six months on, volume has passed the threshold the first decision named. The agent records the new decision and points it at the old one:

```json
{"tool": "kg_node_create", "arguments": {
  "type": "decision",
  "project": "acme-api",
  "relates_to": ["node:<decision-id>"],
  "content": "Webhook delivery moves to SQS, superseding node:<decision-id>. Why: sustained 25k jobs/min since the partner launch; the Postgres job table caused lock contention on the orders table."
}}
```

The response contains `"edges_created": 1`, which confirms the old id existed. Then the agent marks the old decision, re-sending its full original text with a dated line appended, because an update replaces the content:

```json
{"tool": "kg_node_update", "arguments": {
  "id": "node:<decision-id>",
  "content": "Webhook delivery uses a Postgres job table (SKIP LOCKED) instead of Redis or SQS. Why: under 1k jobs/min, Postgres already runs, and enqueueing in the same transaction as the business write means no lost events. Revisit above 10k jobs/min sustained.\n\nSUPERSEDED 2027-03-02 by node:<new-decision-id>: volume passed the revisit threshold."
}}
```

Anyone who finds either node now sees both the old reasoning and why it no longer holds.

## 5. Close the session

At the end of the working session, the agent re-activates what it relied on and ends the session. This is the short form of the [kg-close skill](claude-code/skills/kg-close/SKILL.md):

```json
{"tool": "kg_query", "arguments": {"text": "webhook delivery retries queue", "project": "acme-api", "limit": 10}}
{"tool": "kg_node_update", "arguments": {"id": "node:<each-node-the-session-relied-on>"}}
{"tool": "kg_session_end", "arguments": {}}
```

## Bonus: a read-only overview

For a dashboard or a stand-up summary that should not influence future rankings:

```json
{"tool": "kg_status", "arguments": {"project": "acme-api"}}
{"tool": "kg_query", "arguments": {"type": "problem", "status": "open", "project": "acme-api", "read_only": true}}
```
