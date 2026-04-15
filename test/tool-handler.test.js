/**
 * Radiant tool_call_request handler — MP-TOOL-1 relay t8r-3.
 *
 * Same pattern as Graph's tool-handler tests: dispatch, fail-fast on missing
 * method, TOOL_NOT_FOUND, TOOL_ERROR, TOOL_TIMEOUT, ORGAN_DEGRADED,
 * schema validation, live-file integration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandler } from '../server/tool-handler.js';
import { createMockPool, createMockVectr, fakeEmbedding } from './helpers.js';

const DECLARATIONS_FIXTURE = {
  organs: {
    radiant: {
      organ_number: 60,
      organ_port: 4006,
      timeout_ms: 45000,
      tools: {
        store_context:   { method: 'storeContext',  timeout_ms: 43000 },
        store_memory:    { method: 'storeMemory',   timeout_ms: 43000 },
        query_context:   { method: 'queryContext' },
        query_memory:    { method: 'queryMemory' },
        promote:         { method: 'promote' },
        prune_expired:   { method: 'pruneExpired' },
        dream_stats:     { method: 'dreamStats' },
        merge_memories:  { method: 'mergeMemories', timeout_ms: 43000 },
        find_similar:    { method: 'findSimilar',   timeout_ms: 43000 },
        update_ttl:      { method: 'updateTtl' },
      },
    },
  },
};

function envelope(tool, params = {}) {
  return {
    message_id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    target_organ: 'Radiant',
    reply_to: 'mcp-router',
    payload: { event_type: 'tool_call_request', tool, params },
  };
}

function makeDeps() {
  return {
    pool: createMockPool({
      'SELECT * FROM v_context': { rows: [] },
      'SELECT * FROM v_memory': { rows: [] },
      'FROM v_context': { rows: [{ total: '0', expiring_48h: '0' }] },
      'FROM v_memory': { rows: [] },
      'FROM knowledge_blocks': { rows: [{ with_embedding: '0', without_embedding: '0', total: '0' }] },
    }),
    vectr: createMockVectr(fakeEmbedding()),
    getDreamState: () => ({ lastRun: null }),
  };
}

describe('Radiant tool-handler — D4 dispatch', () => {
  it('constructs with fixture declarations (all 10 methods resolve)', () => {
    const h = createToolHandler(makeDeps(), { declarations: DECLARATIONS_FIXTURE });
    assert.equal(typeof h, 'function');
  });

  it('fails fast when a decl points to a missing method (D5)', () => {
    const broken = {
      organs: { radiant: { tools: { store_context: { method: 'doesNotExist' } } } },
    };
    assert.throws(
      () => createToolHandler(makeDeps(), { declarations: broken }),
      /doesNotExist/
    );
  });

  it('dispatches radiant__query_context → SUCCESS', async () => {
    const handler = createToolHandler(makeDeps(), { declarations: DECLARATIONS_FIXTURE });
    const res = await handler(envelope('radiant__query_context', { keywords: 'x' }));
    assert.equal(res.event_type, 'tool_call_response');
    assert.equal(res.status, 'SUCCESS');
    assert.equal(res.tool, 'radiant__query_context');
    assert.equal(typeof res.data.count, 'number');
  });

  it('unknown tool → TOOL_NOT_FOUND', async () => {
    const handler = createToolHandler(makeDeps(), { declarations: DECLARATIONS_FIXTURE });
    const res = await handler(envelope('radiant__bogus'));
    assert.equal(res.status, 'TOOL_NOT_FOUND');
    assert.equal(res.tool, 'radiant__bogus');
  });

  it('method validation failure → TOOL_ERROR with EBADPARAM', async () => {
    const handler = createToolHandler(makeDeps(), { declarations: DECLARATIONS_FIXTURE });
    const res = await handler(envelope('radiant__store_context', {}));
    assert.equal(res.status, 'TOOL_ERROR');
    assert.equal(res.error.code, 'EBADPARAM');
  });

  it('MEMORY_MERGE_CONFLICT surfaces with missing_ids in meta', async () => {
    const deps = {
      pool: createMockPool({
        'SELECT id FROM knowledge_blocks': { rows: [] }, // none found → all missing
      }),
      vectr: createMockVectr(fakeEmbedding()),
      getDreamState: () => ({ lastRun: null }),
    };
    const handler = createToolHandler(deps, { declarations: DECLARATIONS_FIXTURE });
    const res = await handler(envelope('radiant__merge_memories', {
      source_ids: ['a', 'b'],
      merged_content: 'x',
      entity: 'leon',
    }));
    assert.equal(res.status, 'TOOL_ERROR');
    assert.equal(res.error.code, 'MEMORY_MERGE_CONFLICT');
    assert.ok(res.meta);
    assert.deepEqual(res.meta.missing_ids, ['a', 'b']);
  });

  it('ORGAN_DEGRADED when healthCheck reports db down', async () => {
    const handler = createToolHandler(makeDeps(), {
      declarations: DECLARATIONS_FIXTURE,
      healthCheck: async () => ({ db: 'down' }),
    });
    const res = await handler(envelope('radiant__query_context'));
    assert.equal(res.status, 'ORGAN_DEGRADED');
    assert.equal(res.checks_status, 'down');
  });

  it('ORGAN_DEGRADED when healthCheck itself throws (fail-closed)', async () => {
    const handler = createToolHandler(makeDeps(), {
      declarations: DECLARATIONS_FIXTURE,
      healthCheck: async () => { throw new Error('boom'); },
    });
    const res = await handler(envelope('radiant__query_context'));
    assert.equal(res.status, 'ORGAN_DEGRADED');
    assert.equal(res.checks_status, 'down');
  });

  it('TOOL_TIMEOUT when method exceeds declared timeout_ms', async () => {
    // Force one method to sleep longer than its tight timeout.
    const slowPool = createMockPool({});
    slowPool.query = () => new Promise(r => setTimeout(() => r({ rows: [] }), 100));
    const tightDecl = {
      organs: {
        radiant: {
          tools: { query_context: { method: 'queryContext', timeout_ms: 20 } },
        },
      },
    };
    const handler = createToolHandler(
      { pool: slowPool, vectr: createMockVectr(), getDreamState: () => ({}) },
      { declarations: tightDecl }
    );
    const res = await handler(envelope('radiant__query_context'));
    assert.equal(res.status, 'TOOL_TIMEOUT');
    assert.equal(res.limit_ms, 20);
    assert.ok(res.elapsed_ms >= 20);
  });

  it('payload response passes tool-response-schema validation', async () => {
    const { validateToolResponse } = await import('@coretex/organ-boot/tool-response-schema');
    const handler = createToolHandler(makeDeps(), { declarations: DECLARATIONS_FIXTURE });
    const res = await handler(envelope('radiant__query_context'));
    assert.equal(validateToolResponse(res), true);
  });
});

describe('Radiant tool-handler — live file integration', () => {
  it('resolves all 10 Radiant tools against the live tool-declarations.json', () => {
    // Single regression guard: any drift between method names and declarations
    // fails at construction time, not runtime.
    const handler = createToolHandler(makeDeps());
    assert.equal(typeof handler, 'function');
  });
});
