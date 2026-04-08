# Radiant — ESB Organ

## What this is

Radiant is the platform memory organ (Monad Leg 1). It manages ephemeral context and permanent memory as knowledge blocks in PostgreSQL with pgvector embeddings. This is the ESB organ — a new process on port 4006 (AOS) / 3906 (SAAS), separate from the existing MCP server.

## Architecture

- **Runtime:** Node.js, Express 5, ES modules
- **Test runner:** Node.js built-in (`node --test`)
- **Database:** PostgreSQL `radiant` on localhost:5432 (existing — do NOT create tables)
- **Spine:** WebSocket connection to Spine ESB at ws://127.0.0.1:4000
- **Embedding:** Vectr sidecar at http://127.0.0.1:3901 (graceful degradation)
- **Boot:** Uses `createOrgan()` from `@coretex/organ-boot`

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/context` | POST/GET | Store/query ephemeral context blocks |
| `/memory` | POST/GET | Store/query permanent memory blocks |
| `/promote` | POST | Promote context → memory |
| `/prune` | POST | Delete expired context blocks |
| `/merge` | POST | Atomic N→1 memory merge |
| `/context/ttl` | PATCH | Update TTL on context blocks |
| `/similar` | POST | Vector cosine similarity search |
| `/stats` | GET | Dream stats and health dashboard |
| `/health` | GET | Standard health endpoint (via organ-boot) |
| `/introspect` | GET | Standard introspect endpoint (via organ-boot) |

## Dream Cycle

- **Phase 1 (deterministic):** TTL reduction, supersession detection, prune expired
- **Phase 2 (probabilistic):** Semantic clustering, value assessment, N→1 consolidation
- **Default:** DISABLED (`DREAM_ENABLED=false`). The monolith continues running production dreams.
- **LLM:** Phase 2 uses `claude-sonnet-4-6` via `@coretex/organ-boot/llm-client`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `RADIANT_PORT` | `4006` | HTTP port (4006=AOS, 3906=SAAS) |
| `RADIANT_DB_HOST` | `localhost` | PostgreSQL host |
| `RADIANT_DB_PORT` | `5432` | PostgreSQL port |
| `RADIANT_DB_NAME` | `radiant` | Database name |
| `RADIANT_DB_USER` | `graphheight_sys` | Database user |
| `SPINE_URL` | `http://127.0.0.1:4000` | Spine ESB URL |
| `LLM_OPS_EMBEDDING_URL` | `http://127.0.0.1:3901` | Vectr embedding URL |
| `DREAM_ENABLED` | `false` | Enable automatic dream timer |
| `DREAM_AI_ENABLED` | `false` | Enable Phase 2 (LLM) |
| `ANTHROPIC_API_KEY` | — | Required for Phase 2 dream |

## Running

```bash
npm install
npm test           # Run unit tests (mock DB)
npm start          # Start organ (requires Spine + PostgreSQL)
```

## Zero Cross-Contamination Rules

- Never reference `ai-kb.db` or `AI-Datastore/`
- Never reference `AOS-software-dev/` paths
- Never use ports 3800-3851 (monolith range)
- Never import from monolith MCP packages
