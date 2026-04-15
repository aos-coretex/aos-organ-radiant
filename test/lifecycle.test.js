import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createLifecycleRouter } from '../server/routes/lifecycle.js';
import { createMockPool, createMockVectr, fakeEmbedding } from './helpers.js';

async function request(app, method, path, body) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    server.close();
  }
}

describe('Lifecycle routes', () => {
  it('POST /promote changes lifecycle and clears expiry', async () => {
    const pool = createMockPool({
      'UPDATE knowledge_blocks': {
        rows: [{ id: 'block-1', entity: 'llm-ops', promoted_at: '2026-04-08T12:00:00Z' }],
      },
    });
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/', createLifecycleRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/promote', {
      block_id: 'block-1',
      entity: 'llm-ops',
    });

    assert.equal(status, 200);
    assert.equal(data.status, 'promoted');
    assert.equal(data.id, 'block-1');
    assert.ok(data.promoted_at);
  });

  it('POST /promote returns 404 when block not found', async () => {
    const pool = createMockPool({
      'UPDATE knowledge_blocks': { rows: [] },
    });
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/', createLifecycleRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/promote', {
      block_id: 'nonexistent',
      entity: 'llm-ops',
    });

    assert.equal(status, 404);
    assert.equal(data.status, 'not_found');
  });

  it('POST /prune deletes only expired blocks', async () => {
    const pool = createMockPool({
      'DELETE FROM knowledge_blocks': {
        rows: [{ id: 'expired-1' }, { id: 'expired-2' }],
      },
    });
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/', createLifecycleRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/prune');

    assert.equal(status, 200);
    // repair-radiant-02: R7 tool_call_response payload shape.
    assert.equal(data.status, 'SUCCESS');
    assert.equal(data.tool, 'radiant__prune_expired');
    assert.equal(data.data.deleted_count, 2);
    assert.deepEqual(data.data.deleted_ids, ['expired-1', 'expired-2']);
    assert.equal(data.meta.transport, 'http');
    assert.equal(data.meta.organ, 'radiant');
    assert.ok(typeof data.elapsed_ms === 'number');
  });

  it('POST /merge performs atomic N→1 merge', async () => {
    const pool = createMockPool({
      'SELECT id FROM knowledge_blocks': {
        rows: [{ id: 'src-1' }, { id: 'src-2' }],
      },
      'INSERT INTO knowledge_blocks': {
        rows: [{ id: 'merged-1', created_at: '2026-04-08T12:00:00Z' }],
      },
      'DELETE FROM knowledge_blocks WHERE id': { rows: [] },
      'BEGIN': { rows: [] },
      'COMMIT': { rows: [] },
    });
    const vectr = createMockVectr(fakeEmbedding());

    const app = express();
    app.use(express.json());
    app.use('/', createLifecycleRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/merge', {
      source_ids: ['src-1', 'src-2'],
      merged_content: 'Consolidated memory block',
      entity: 'llm-ops',
    });

    assert.equal(status, 200);
    assert.equal(data.status, 'merged');
    assert.equal(data.deleted_count, 2);
    assert.equal(data.entity, 'llm-ops');
    assert.equal(data.embedded, true);
  });

  it('POST /merge fails when source IDs not found', async () => {
    const pool = createMockPool({
      'SELECT id FROM knowledge_blocks': { rows: [{ id: 'src-1' }] }, // only 1 of 2 found
      'BEGIN': { rows: [] },
      'ROLLBACK': { rows: [] },
    });
    const vectr = createMockVectr(fakeEmbedding());

    const app = express();
    app.use(express.json());
    app.use('/', createLifecycleRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/merge', {
      source_ids: ['src-1', 'src-missing'],
      merged_content: 'Consolidated',
      entity: 'llm-ops',
    });

    assert.equal(status, 400);
    assert.equal(data.error, 'MEMORY_MERGE_CONFLICT');
    assert.deepEqual(data.missing_ids, ['src-missing']);
  });

  it('PATCH /context/ttl updates expiry correctly', async () => {
    const pool = createMockPool({
      'UPDATE knowledge_blocks': {
        rows: [
          { id: 'ctx-1', expires_at: '2026-04-11T12:00:00Z' },
          { id: 'ctx-2', expires_at: '2026-04-11T12:00:00Z' },
        ],
      },
    });
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/', createLifecycleRouter(pool, vectr));

    const { status, data } = await request(app, 'PATCH', '/context/ttl', {
      block_ids: ['ctx-1', 'ctx-2'],
      expires_in_days: 3,
    });

    assert.equal(status, 200);
    assert.equal(data.status, 'updated');
    assert.equal(data.updated_count, 2);
    assert.equal(data.blocks.length, 2);
  });
});
