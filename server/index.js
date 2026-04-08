/**
 * Radiant ESB organ — entry point.
 *
 * Platform memory (Monad Leg 1) — ephemeral context + permanent memory.
 * Connects to existing PostgreSQL database `radiant` and exposes
 * its API via HTTP + Spine WebSocket.
 */

import { createOrgan } from '@coretex/organ-boot';
import { createLLMClient } from '@coretex/organ-boot/llm-client';
import { config } from './config.js';
import { createPool, verifySchema, checkDb } from './db/pool.js';
import { createVectrClient } from './vectr.js';
import { createContextRouter } from './routes/context.js';
import { createMemoryRouter } from './routes/memory.js';
import { createLifecycleRouter } from './routes/lifecycle.js';
import { createSearchRouter } from './routes/search.js';
import { createStatsRouter } from './routes/stats.js';
import { createMessageHandler } from './handlers/messages.js';
import { runPhase1 } from './dream/phase1.js';
import { runPhase2 } from './dream/phase2.js';

// --- Dream state ---

const dreamState = {
  lastRun: null,
  lastSummary: null,
  cycleNumber: 0,
  timer: null,
};

function getDreamState() {
  return dreamState;
}

// --- Dream cycle ---

async function runDreamCycle(pool, vectr, llmClient, phase = 'full') {
  const startTime = Date.now();
  dreamState.cycleNumber++;

  let p1Results = { expired: 0, ttl_reduced: 0, superseded: 0 };
  let p2Results = { clusters_found: 0, promoted: 0, merged: 0, let_expire: 0 };

  if (phase === 'full' || phase === 'phase1_only') {
    p1Results = await runPhase1(pool);
  }

  if ((phase === 'full' || phase === 'phase2_only') && config.dreamAiEnabled) {
    p2Results = await runPhase2(pool, vectr, llmClient);
  }

  dreamState.lastRun = new Date().toISOString();
  dreamState.lastSummary = `Phase 1: ${p1Results.expired} expired, ${p1Results.ttl_reduced} TTL reduced, ${p1Results.superseded} superseded. Phase 2: ${p2Results.clusters_found} clusters, ${p2Results.promoted} promoted, ${p2Results.merged} merged.`;

  return {
    status: 'complete',
    cycle_number: dreamState.cycleNumber,
    duration_ms: Date.now() - startTime,
    phase1: p1Results,
    phase2: p2Results,
  };
}

function startDreamTimer(pool, vectr, llmClient) {
  if (dreamState.timer) clearInterval(dreamState.timer);
  dreamState.timer = setInterval(
    () => runDreamCycle(pool, vectr, llmClient).catch(err => {
      const entry = { timestamp: new Date().toISOString(), event: 'dream_cycle_error', error: err.message };
      process.stdout.write(JSON.stringify(entry) + '\n');
    }),
    config.dreamIntervalMs,
  );
}

// --- Boot ---

const pool = createPool(config.db);
const vectr = createVectrClient(config.vectrUrl, config.vectrTimeoutMs);

// LLM client for Phase 2 dream consolidation
const dreamerLLM = createLLMClient({
  agentName: 'radiant-dreamer',
  defaultModel: 'claude-sonnet-4-6',
  defaultProvider: 'anthropic',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  maxTokens: 2048,
});

const triggerDream = (phase) => runDreamCycle(pool, vectr, dreamerLLM, phase);

const organ = await createOrgan({
  name: 'Radiant',
  port: config.port,
  binding: config.binding,
  spineUrl: config.spineUrl,

  routes: (app) => {
    app.use('/context', createContextRouter(pool, vectr));
    app.use('/memory', createMemoryRouter(pool, vectr));
    app.use('/', createLifecycleRouter(pool, vectr));
    app.use('/', createSearchRouter(pool, vectr));
    app.use('/', createStatsRouter(pool, getDreamState));
  },

  onMessage: createMessageHandler(pool, vectr, triggerDream),

  subscriptions: [
    { event_type: 'dream_trigger' },
  ],

  dependencies: ['Spine'],

  healthCheck: async () => ({
    db: await checkDb(pool),
    vectr: await vectr.isAvailable() ? 'ok' : 'degraded',
    dream: config.dreamEnabled ? 'enabled' : 'disabled',
    llm: dreamerLLM.isAvailable() ? 'available' : 'unavailable',
  }),

  introspectCheck: async () => ({
    dream_state: getDreamState(),
    llm_usage: dreamerLLM.getUsage(),
  }),

  onStartup: async () => {
    await verifySchema(pool);

    if (config.dreamEnabled) {
      startDreamTimer(pool, vectr, dreamerLLM);
    }
  },

  onShutdown: async () => {
    if (dreamState.timer) clearInterval(dreamState.timer);
    await pool.end();
  },
});
