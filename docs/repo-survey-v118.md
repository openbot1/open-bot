# Repo Survey v1.18 — Research notes for all 6 teams (wave v1.18)

> Written by Team T1 (memory v17), 2026-11-16. Sources checked
> 2026-11-16 via public web search (idea-level summaries only).
> **Nothing is copied from any repo: no code, no text, no assets.**
> All findings below are paraphrased ideas for open-bot to
> re-implement from scratch, local-first, free, no cloud VM /
> accounts / payments, no X data, no Grok Imagine.

## (a) Letta / MemGPT — memory blocks + sleep-time compute

**What it is (idea level).** MemGPT (2023, UC Berkeley paper
"MemGPT: Towards LLMs as Operating Systems", arXiv:2310.08560) treats
the LLM context window like OS RAM: small and precious, everything
else on disk, paged in on demand. Letta is the company / open-source
framework the same researchers built to ship the pattern. Three
memory tiers:

| Tier | Role | Access |
|---|---|---|
| Core | A few small editable blocks, always in the prompt | Always visible, edited by agent tool calls |
| Recall | Full conversation history | Exact search, paged in on demand |
| Archival | Long-term facts / documents | Semantic search, pulled in on demand |

**Blocks.** The original paper defines two blocks: **Human** (facts
about the user) and **Persona** (the agent's self-concept, tone,
constraints). Letta generalises to arbitrary user-defined blocks
(Task, Project, Safety, ...). Each block is a typed, persistent,
editable section with a size limit. The agent edits its own blocks
with ordinary tool calls (`core_memory_append` / `memory_replace` /
`archival_memory_insert` / `archival_memory_search` /
`conversation_search` in the public descriptions) — the same
mechanism as any other tool, aimed at its own prompt.

**Sleep-time compute (2025 Letta addition).** A second, background
agent runs while the primary agent is idle (between turns / between
sessions), off the critical path. It processes transcripts and
codebase context, writes `learned_context` into shared blocks, and
consolidates or invalidates archival records: dedup, summarise,
invalidate contradicted facts. Because it is not on the answer
path, it may run a stronger / slower model than the primary agent.
Letta V1 (2026) deprecates `send_message` / heartbeat and inline
`Thought:` tokens in favour of native reasoning.

**What open-bot already has / should take.** v15/v16/v17 already
implement the three tiers (V15BlockStore, TemporalGraphStore,
hybrid search), sleep consolidation v2 (v16) and a scheduled
sleep scheduler (v17). Ideas worth stealing next: (1) a `Safety`
block kind for hard constraints that no sleep pass may rewrite;
(2) sleep-time passes that run a *different* (stronger) model
than the live agent, chosen by the router; (3) MemFS-style
git-backed memory directory (Letta Code) — v17 block versioning
is the local equivalent, keep it file-based, never the repo's git.

**Caveat.** Vendor docs describe the pattern; the exact tool names
and limits differ across Letta versions — treat them as inspiration,
not a spec to clone.

## (b) OpenHands V1 SDK — event-sourced ConversationState, CodeAct, Repository Map

**What it is (idea level).** OpenHands (ex-OpenDevin, All-Hands-AI,
MIT) is an open-source autonomous software-engineering agent. V1
(Nov 2025 onward) is a modular SDK, described in the paper "The
OpenHands Software Agent SDK" (arXiv 2511.03690): four decoupled
packages, nine interlocking components — event-sourced state
management, LLM, tool system, agent, context-window management,
local conversation, secret registry, security/confirmation, and
deployment (local / remote workspace).

**Key ideas.**

- **Event-sourced state, single source of truth.** All components
  (Agent, Tool, LLM) are immutable and validated at construction.
  The *only* mutable thing is `ConversationState`: mutable metadata
  fields plus an **append-only EventLog** recording every
  interaction (`MessageEvent`, `ActionEvent`, `ObservationEvent`,
  `AgentErrorEvent`, `Condensation`, ...). Replaying the log
  reconstructs the whole conversation — replayable, debuggable,
  safe to parallelise. V0 had an explicit `AgentController` +
  `Runtime`; V1 collapsed them into Conversation + Workspace.
- **CodeAct.** The agent acts by emitting code actions that a
  Workspace executes (local process or Docker container) and
  returns observations. The loop is: stateless Agent emits Actions
  → Conversation runs the loop and persists the EventLog →
  Workspace executes → Observations return.
- **Repository Map.** Large-codebase support: a map of the repo
  (symbols, modules, call edges) is built once and budgeted into
  context, so the agent navigates without reading whole files.
  (OpenHands ships a "Large Codebase SDK" for this.)
- **Provider portability via LiteLLM.** The LLM layer is wrapped
  so the same agent talks to Claude, GPT, Gemini, or a local
  Ollama model — the benchmark number follows the model, not the
  scaffold.
- **Security / confirmation layer.** V1.0 (Sep 2026) headline is a
  security layer: confirmation policy for risky actions, secret
  registry — not a new capability, a production requirement.

**Benchmarks (vendor-reported, read with care).** The V1 paper
reports **72.8% on SWE-Bench Verified with Claude Sonnet 4.5**
(extended thinking) at the evaluated commit, 67.9% on GAIA val
with the same model; a fully open self-hostable configuration
scores ~32% on SWE-Bench Verified. Other write-ups cite ~77% for
the full OpenHands app with the same model — the gap is harness +
app vs SDK. Treat every number as harness-dependent (±15–20
points by harness alone, per independent write-ups).

**What open-bot should take.** (1) The event-sourced pattern is
already partly present (event-log, durable runs); the next step is
making *one* append-only log the single source of truth per
conversation, with replay as a first-class operation (replay →
rebuild state, resume after crash). (2) Confirmation policy as a
typed, per-action setting (already partly present in approval
flows — generalise it). (3) Repository Map with a token budget
is directly reusable for the coding agent (v1.18 T4 area).

## (c) Mem0 2026 — hybrid vector + graph, consolidation, LoCoMo

**What it is (idea level).** Mem0 (mem0ai/mem0, Apache-2.0) is a
drop-in memory layer for LLM agents: `add()` stores what matters,
`search()` recalls it, scoped per user / session / agent. The
**April 2026 algorithm** (the "new memory algorithm") changed the
pipeline:

- **Single-pass ADD-only extraction.** One LLM call, no
  UPDATE/DELETE at write time. Memories accumulate; nothing is
  overwritten. Contradictions coexist and are resolved at
  retrieval time.
- **Hybrid storage.** Each memory lands across three stores: a
  vector DB (semantic similarity), a key-value store (exact scoped
  lookup by user_id / agent_id / app_id / run_id), and a graph
  store (relationships between entities). Note: graph memory was
  removed from the open-source package and is now a Platform
  feature (native graph linking people/places/concepts, no
  external Neo4j/Memgraph to provision) — self-hosters on the OSS
  edition do *not* get it.
- **Multi-signal retrieval, single pass.** Semantic + BM25 keyword
  + entity matching scored in parallel and fused (no agentic
  loops in the April 2026 algorithm). Agent-generated facts are
  first-class (when an agent confirms an action, that is stored
  with equal weight). Entity linking: entities are extracted,
  embedded, and linked across memories for retrieval boosting.
- **Defaults.** OpenAI `text-embedding-3-small` for embeddings,
  `gpt-5-mini` for extraction; works with any LLM including local
  Ollama; local Qdrant on disk by default for dev.

**Benchmarks (vendor-reported, reproducible harness).** The README
reports **92.5 on LoCoMo** (up from 71.4, +21) and **94.4 on
LongMemEval** (up from 67.8, +27), ~7K tokens, ~1s p50 latency,
single-pass retrieval at top-200 budget. The evaluation framework
is open-sourced (mem0ai/memory-benchmarks), so the numbers are
vendor-reported *but* reproducible — run them before betting on
them. Independent coverage (Dec 2025 audit of LoCoMo) found 6.4%
of the answer key wrong and the LLM judge accepting up to 63% of
deliberately incorrect answers; when Zep and Mem0 disagreed
publicly on LoCoMo the same configuration was reported as 84%,
then 58%, then 75% depending on who counted. **Do not quote 92.5
as a settled fact — quote it as "Mem0 reports 92.5 on LoCoMo
(April 2026 algorithm, managed platform)".**

**What open-bot should take.** v15/v16 already implement the
add-only + 4-signal hybrid search + entity linking locally.
Remaining ideas: (1) retrieval *scoring* that fuses relevance +
importance + recency in one pass (v17 archival scoring is the
local version — keep extending it); (2) agent-generated facts as
first-class memories (an agent's confirmed action is a memory,
not just a log line); (3) a reproducible local eval harness for
memory (v15/v16/v17 evals are the seed — run them on every wave).

## (d) LiteLLM-style multi-provider routing

**What it is (idea level).** LiteLLM is a library / proxy that
presents one OpenAI-compatible interface over 100+ LLM providers
(OpenAI, Anthropic, Gemini, Groq, Bedrock, DeepSeek, Ollama, any
OpenAI-compatible endpoint, llama.cpp). The pattern: the *agent*
never talks to a provider directly; it talks to a router that
maps a logical model name to a provider, API key, base URL, and
per-provider quirks (message format, tool-call format, rate
limits, cost accounting).

**Key ideas.**

- **One interface, many backends.** Same `chat/completions` call
  shape; the router translates. New providers are config, not
  code.
- **Fallbacks + retries.** Per-request fallback chains (primary →
  secondary provider), retry with backoff, timeout budgets.
- **Cost / latency tracking.** Per-call token + cost accounting,
  so the router can pick the cheapest model that meets the task.
- **Local-first variant.** Ollama / llama.cpp are just providers
  in the same table — no special-casing, so "no key, use local"
  is a routing decision, not a separate code path.
- **What OpenHands does with it.** OpenHands routes through
  LiteLLM, which is why the same scaffold scores 72% with a
  frontier model and 32% fully open: the scaffold is
  provider-agnostic, the model is the variable.

**What open-bot should take.** open-bot already routes across
providers (Grok/OpenAI/Anthropic/Gemini/Ollama + detected CLI
logins). The LiteLLM lesson is architectural: (1) keep the router
table-driven (provider = config row, not a code branch); (2)
fallback chains per task type (sleep-time consolidation may use a
stronger model than live chat — same idea as Letta sleep-time);
(3) account cost/latency per call so the router can learn; (4)
never let a provider outage fail a turn — degrade to local.

## Cross-cutting notes for this wave (all teams)

1. **Numbers need definitions.** Every benchmark above is
   vendor-reported unless stated otherwise. When open-bot reports
   its own numbers (lines, tools, tests), define them up front:
   product code on current main only, tests excluded, real code
   vs blank lines/comments.
2. **Local-first is the constraint, not the fallback.** Mem0's
   graph is Platform-only; Letta's managed pieces are hosted.
   open-bot re-implements the *ideas* locally — that is the point.
3. **Event-sourcing + git-style history are converging.** v17
   block versioning (hash-chained commits, audit log) and the
   conversation event log are the same pattern at two levels:
   append-only, replayable, never erase. Prefer that shape for
   every new stateful feature.
4. **No live API calls were made for this survey** (search
   results only, 2026-11-16). Benchmark figures are as reported
   by the vendors / papers cited; re-verify before quoting them
   in user-facing text.

## Sources consulted (2026-11-16, idea-level only)

- sureprompts.com/blog/letta-memgpt-walkthrough (per task brief;
  also papertocode.dev "Memory Blocks Sleep Time Compute",
  seekvana.com "MemGPT & Letta", kenhuangus.substack.com "How AI
  Agents Actually Remember", frenchydigital.com "AI Agent Memory
  Architecture: The 2026 Guide")
- datacamp.com/tutorial/openhands (per task brief; also arxiv.org
  arXiv:2511.03690 "The OpenHands Software Agent SDK",
  dev.to/truongpx396 "OpenHands — Deep Dive & Build-Your-Own
  Guide", dev.to/lynkr/run-openhands-on-any-model-you-want-1mnd
  per task brief)
- mem0.ai/research + github.com/mem0ai/mem0 README (April 2026
  algorithm, LoCoMo 92.5 / LongMemEval 94.4), runlocalai.co Mem0
  profile, diego-rodriguez.work Mem0 2026 guide, automem.ai
  "Agent Memory in 2026: An Honest Comparison", ssdnodes.com
  Hindsight vs Mem0
- LiteLLM pattern: as used by OpenHands (arXiv 2511.03690 §4.3)
  and Hindsight provider docs (LiteLLM-backed, 100+ providers)
