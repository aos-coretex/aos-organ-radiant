import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../server/handlers/messages.js';
import { createMockPool, createMockVectr, fakeEmbedding } from './helpers.js';

describe('Spine message handler', () => {
  it('routes store_context and returns response', async () => {
    const pool = createMockPool({
      'INSERT INTO knowledge_blocks': {
        rows: [{ id: 'ctx-new', lifecycle: 'context', created_at: '2026-04-08T12:00:00Z', expires_at: '2026-04-15T12:00:00Z' }],
      },
    });
    const vectr = createMockVectr(fakeEmbedding());
    const handler = createMessageHandler(pool, vectr, null);

    const result = await handler({
      message_id: 'otm-001',
      payload: {
        event_type: 'store_context',
        content: 'New context via Spine',
        entity: 'llm-ops',
      },
    });

    assert.equal(result.event_type, 'store_response');
    assert.equal(result.id, 'ctx-new');
    assert.equal(result.embedded, true);
  });

  it('routes query_memory with filters', async () => {
    const pool = createMockPool({
      'SELECT * FROM v_memory': {
        rows: [
          { id: 'mem-1', content: 'Memory about radiant', entity: 'llm-ops' },
        ],
      },
    });
    const vectr = createMockVectr(null);
    const handler = createMessageHandler(pool, vectr, null);

    const result = await handler({
      message_id: 'otm-002',
      payload: {
        event_type: 'query_memory',
        data: { entity: 'llm-ops', limit: 5 },
      },
    });

    assert.equal(result.event_type, 'query_response');
    assert.equal(result.count, 1);
    assert.equal(result.blocks[0].entity, 'llm-ops');
  });

  it('routes promote and returns response', async () => {
    const pool = createMockPool({
      'UPDATE knowledge_blocks': {
        rows: [{ id: 'block-promote', entity: 'llm-ops', promoted_at: '2026-04-08T12:00:00Z' }],
      },
    });
    const vectr = createMockVectr(null);
    const handler = createMessageHandler(pool, vectr, null);

    const result = await handler({
      message_id: 'otm-003',
      payload: {
        event_type: 'promote',
        block_id: 'block-promote',
        entity: 'llm-ops',
      },
    });

    assert.equal(result.event_type, 'promote_response');
    assert.equal(result.status, 'promoted');
  });

  it('routes dream_trigger and returns disabled status when no trigger', async () => {
    const handler = createMessageHandler(createMockPool(), createMockVectr(null), null);

    const result = await handler({
      message_id: 'otm-004',
      payload: { event_type: 'dream_trigger', phase: 'full' },
    });

    assert.equal(result.event_type, 'dream_response');
    assert.equal(result.status, 'dream_disabled');
  });

  it('returns error for unknown event_type', async () => {
    const handler = createMessageHandler(createMockPool(), createMockVectr(null), null);

    const result = await handler({
      message_id: 'otm-005',
      payload: { event_type: 'nonexistent_action' },
    });

    assert.equal(result.error, 'unknown_event_type');
  });
});
