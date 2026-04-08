import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createContextRouter } from '../server/routes/context.js';
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

describe('Context routes', () => {
  it('POST /context stores a context block and returns UUID', async () => {
    const mockId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const pool = createMockPool({
      'INSERT INTO knowledge_blocks': {
        rows: [{
          id: mockId,
          lifecycle: 'context',
          created_at: '2026-04-08T12:00:00Z',
          expires_at: '2026-04-15T12:00:00Z',
        }],
      },
    });
    const vectr = createMockVectr(fakeEmbedding());

    const app = express();
    app.use(express.json());
    app.use('/context', createContextRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/context', {
      content: 'Test context block',
      entity: 'llm-ops',
      session_id: 'sess-001',
    });

    assert.equal(status, 201);
    assert.equal(data.id, mockId);
    assert.equal(data.lifecycle, 'context');
    assert.equal(data.embedded, true);
    assert.ok(data.expires_at);
  });

  it('POST /context returns 400 when content is missing', async () => {
    const pool = createMockPool();
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/context', createContextRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/context', { entity: 'llm-ops' });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('POST /context stores without embedding when Vectr unavailable', async () => {
    const pool = createMockPool({
      'INSERT INTO knowledge_blocks': {
        rows: [{
          id: 'some-id',
          lifecycle: 'context',
          created_at: '2026-04-08T12:00:00Z',
          expires_at: '2026-04-15T12:00:00Z',
        }],
      },
    });
    const vectr = createMockVectr(null); // Vectr unavailable

    const app = express();
    app.use(express.json());
    app.use('/context', createContextRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/context', {
      content: 'Block without embedding',
      entity: 'llm-ops',
    });

    assert.equal(status, 201);
    assert.equal(data.embedded, false);
  });

  it('GET /context queries active context blocks with keyword filter', async () => {
    const pool = createMockPool({
      'SELECT * FROM v_context': {
        rows: [
          { id: 'id-1', content: 'matching block', entity: 'llm-ops', created_at: '2026-04-08T12:00:00Z' },
        ],
      },
    });
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/context', createContextRouter(pool, vectr));

    const { status, data } = await request(app, 'GET', '/context?keywords=matching&limit=10');

    assert.equal(status, 200);
    assert.equal(data.count, 1);
    assert.equal(data.blocks[0].content, 'matching block');
  });
});
