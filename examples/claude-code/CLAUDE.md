## Memory (Komplyt Zero)

This project uses Komplyt Zero as shared memory across sessions and tools. Project name: `<your-project>`.

- At the start of a task, call `kg_session_start` with `project: "<your-project>"`, then `kg_query` for the topic before reading code or asking questions that may already be answered.
- Before recording anything, query for it. Update or relate an existing node instead of creating a near-duplicate.
- Record decisions (with the reason and when to revisit them), problems (`status: "open"`), hard-won observations and reusable approaches. Do not record todos, conversation summaries or anything that is only true for this session.
- Write each node so it makes sense on its own: name the subject, state the fact or choice, give the reason.
- Never overwrite a decision. Create the new one with the old id in `relates_to`, then append a dated "superseded by" line to the old one, keeping its original text.
- Never put secrets, credentials or personal data into a node.
- Before finishing, run the `kg-close` skill.
