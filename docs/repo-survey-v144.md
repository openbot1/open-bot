# Repo survey — v1.44 (2026-11-19)

Cycle research for wave v1.44. Ideas only — no code, text or assets copied
from any repo, from xAI, or from Cursor. Each section states what open-bot
takes as an architectural idea and what it deliberately does not take.

## 1. OpenHands SDK v1.60.1 (5 Nov 2026)

- Four sharp boundaries: **Agent / Conversation / Workspace / Agent Server**.
  A conversation is the unit of isolation; the server only orchestrates.
- One dedicated runtime (Docker container) per conversation since v1.49 —
  isolation is per-conversation, not per-agent-process.
- Secrets are scoped per profile, not global; an agent only sees the
  credentials its profile grants.
- **Agent Plugins** declared in `mcp.json` — plugins are capability
  packages, not ad-hoc tool lists.
- Post-training a model inside the harness: Snowflake Cortex RL, with tasks
  in the **Harbor** format (`instruction.md` + `environment/` +
  `tests/test.sh` as the reward signal).
- Idea taken: per-conversation runtime isolation (T6), Harbor-format eval
  tasks with `tests/test.sh` as reward (T2), plugin-style MCP packaging (T3).
  Not taken: Docker as the only runtime (open-bot stays local-first with
  bwrap/Docker as options), any cloud training path.

## 2. Letta v0.16.7 (March 2026)

- Memory blocks with **no size limit**, 128K context windows.
- **Conversations API**: several agents share one memory block — memory is
  a shared resource, not per-agent private state.
- March 2026 pivot to **git-backed memory (MemFS)**: memory is versioned
  files; history, diff and rollback come free from git semantics.
- Sleep-time agents run as **client-side subagents** that consolidate
  memory while the user is away.
- Letta Code became the flagship product — the agent that writes code is
  the product, not a demo.
- Idea taken: git-backed memory blocks with sharing between bots (T1),
  sleep-time consolidation as a client-side subagent (T1), time-travel
  reads over versioned memory (T1). Not taken: any hosted Letta service,
  any Letta code.

## 3. Mem0 v3 (September 2026, ts-v3.3.1)

- One LLM call per `add()`; append-only store; retrieval ordered by time.
- Graph memory moved to platform-only — the open core stays flat + temporal.
- **Zep / Graphiti bi-temporal knowledge graphs**: an old fact is
  invalidated, never deleted — the graph keeps both the fact and its
  validity window.
- **mnemograph**: event-sourced knowledge graph, versioned with git,
  time-travel reads (`get_state_at`, `diff_timerange`), MCP tools
  `remember` / `recall`.
- Idea taken: append-only temporal memory with invalidation instead of
  deletion (T1), JSONL adapter for a memory knowledge graph (T3),
  time-travel `get_state_at` / `diff_timerange` API shape (T1).
  Not taken: any hosted Mem0/Zep/Graphiti service, any of their code.

## What v1.44 builds from this

| Team | Survey source | Deliverable |
|------|--------------|-------------|
| T1 memory v28 | Letta MemFS + Mem0 v3 + mnemograph | git-backed shared memory blocks, sleep-time consolidation, time-travel |
| T2 eval harness v1 | OpenHands Harbor format | sandboxed eval tasks, test.sh reward, regression dashboard |
| T3 MCP 2.0 / Apps v2 | OpenHands Agent Plugins + mnemograph | MCP Apps UI, Tasks v2, JSONL memory-KG adapter |
| T4 voice v30 | — (continuation) | realtime full-duplex v2, barge-in, cost ledger |
| T5 router + provider v30 | — (continuation) | catalog refresh, latency/cost routing, CLI-agent auto-detect v2 |
| T6 fleet/UI v30 | OpenHands Agent Server isolation | per-conversation runtime isolation, A2A board v2 |

## Standing direction (Huy, 12 Nov 2026)

Brain = any model; no X data; no Grok Imagine (users plug their own
image/video keys); realtime voice; no cloud VM / accounts / payments —
free, local-first, public. Deep personalisation + super memory.
UI familiar to Grok Bot users, advanced features behind panels/menus.
