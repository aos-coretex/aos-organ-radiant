import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSearchRouter } from '../server/routes/search.js';
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

describe('Search routes', () => {
  it('POST /similar returns results above threshold', async () => {
    const pool = createMockPool({
      'SELECT': {
        rows: [
          {
            id: 'sim-1',
            entity: 'llm-ops',
            lifecycle: 'memory',
            content: 'A memory block about platform architecture and design decisions',
            metadata: {},
            created_at: '2026-04-08T12:00:00Z',
            similarity: 0.92,
          },
        ],
      },
    });
    const vectr = createMockVectr(fakeEmbedding());

    const app = express();
    app.use(express.json());
    app.use('/', createSearchRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/similar', {
      content: 'platform architecture',
      threshold: 0.85,
      limit: 5,
    });

    assert.equal(status, 200);
    assert.equal(data.count, 1);
    assert.ok(data.results[0].similarity >= 0.85);
    assert.ok(data.results[0].content_preview);
  });

  it('POST /similar returns 400 when neither content nor block_id provided', async () => {
    const pool = createMockPool();
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/', createSearchRouter(pool, vectr));

    const { status } = await request(app, 'POST', '/similar', { threshold: 0.85 });
    assert.equal(status, 400);
  });

  it('POST /similar returns 503 when Vectr unavailable for content query', async () => {
    const pool = createMockPool();
    const vectr = createMockVectr(null); // Vectr unavailable

    const app = express();
    app.use(express.json());
    app.use('/', createSearchRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/similar', {
      content: 'test query',
    });

    assert.equal(status, 503);
    assert.equal(data.error, 'EMBEDDING_UNAVAILABLE');
  });
});
