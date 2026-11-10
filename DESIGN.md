# DESIGN

## What it is
A streaming chat agent with one tool, `web_search`. The goal: answer fast, be right about *time*, and read like a person wrote it. The example questions ("has any of them changed since Monday?", "what did I ask on 3 Nov, is it still correct?") are all about **time and memory**, not just search, so that is where the architecture spends its effort.

## How it works
```
user msg ─► temporal pre-step (no LLM, ~0 ms) ─► agent loop (≤4 rounds) ─► SSE stream
              │ chrono-node: "last Tuesday" → 2026-11-03        │ model ⇄ parallel web_search
              │ pull that day's exchanges from the log          │ last round forced to answer
              ▼                                                 ▼
        <recalled_conversations> + CURRENT DATE           cited sources [n], persisted with turn
```
1. **Temporal pre-step (deterministic).** Models are poor at calendar math and the only tool is web search, so it cannot look up its own past. The harness resolves date phrases to absolute dates and injects the stored exchanges from those days (across all sessions) plus the current date. "What did I ask on 3 Nov?" becomes a lookup, not a guess; if nothing exists, the model is told so and says it has no record instead of inventing one.
2. **Timestamped history.** Every turn is stored with a timestamp, and past user messages are prefixed with when they were sent. "Since Monday" resolves against real dates, and "is your answer still correct" has a dated baseline (the old answer) to re-verify claim by claim.
3. **One tool, shaped for the job.** `web_search(query, topic, published_after, published_before)`. The date filters turn "what changed since X" into a bounded search instead of hoping the ranker surfaces fresh pages. The prompt tells the model to fan out one search per entity *in parallel* (5 CRMs = 5 simultaneous calls), so latency is one round trip, not five.
4. **Bounded loop.** Max 4 rounds; the final round sets `tool_choice: none` so it always ends with an answer. Searches are time-boxed (8 s), retried once, cached 10 min, and a failure becomes a tool error the model can explain rather than a crash.
5. **Fast by default.** No router call, no planner call. Simple questions never touch the tool (the prompt defines when to search). The static system prompt is cache-controlled; per-request context (date, recalled turns) sits in a separate uncached block so the prefix stays hot. Tokens stream immediately; the UI shows a live "Searching: …" status.
6. **Honest answers.** Citations use ids the harness issued, and only cited sources are shown. "No changes found" must name what was checked (absence of evidence ≠ no change). Search results are wrapped as untrusted data to blunt prompt injection.

## Why this shape
Quality here comes from *context engineering* more than from more machinery: the right date, the right history, the right filters. A dedicated router/planner/verifier pipeline adds latency and failure modes for a one-tool agent; the model already plans well when handed good context.

## Considered and rejected
- **A `recall_memory` tool.** The brief gives one tool. A deterministic pre-step is also faster and can't be "forgotten" by the model.
- **Vector/RAG over history.** Overkill; the queries are date-addressed, so a date index is exact.
- **Multi-agent planner + critic.** 2–3× latency for little gain at this scope.
- **LLM-based date parsing.** Slower and less reliable than chrono-node.
- **Framework (LangChain etc.).** The loop is ~80 lines; owning it keeps behaviour explainable.

## Limits (honest)
JSON-file store (fine for a demo, not for scale); one server timezone assumed for "last Tuesday"; recall is by date, not by topic ("what did I ask about Postgres?" works only via the model reading in-session history); Tavily snippets are short, so pricing pages sometimes need a second look.

## With another week
1. **Eval harness**: a fixed set of time-sensitive questions with expected behaviours (baseline found? date filter set? "no record" handled?), run on every change.
2. **SQLite + FTS** for topic-based recall across sessions, plus per-user timezone.
3. **Page fetch for top hits** on pricing/changelog questions (snippet → full page), gated by a latency budget.
4. **Standing watches**: remember "the 5 CRMs we shortlisted" as an entity set and diff against it automatically.
5. Tune the model split: small model for trivial turns, larger for multi-source synthesis.
