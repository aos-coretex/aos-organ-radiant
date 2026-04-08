import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMemoryRouter } from '../server/routes/memory.js';
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

describe('Memory routes', () => {
  it('POST /memory stores a memory block and returns UUID', async () => {
    const mockId = 'mem-aaaa-bbbb-cccc-ddddeeeeeeee';
    const pool = createMockPool({
      'INSERT INTO knowledge_blocks': {
        rows: [{
          id: mockId,
          lifecycle: 'memory',
          entity: 'graphheight',
          created_at: '2026-04-08T12:00:00Z',
        }],
      },
    });
    const vectr = createMockVectr(fakeEmbedding());

    const app = express();
    app.use(express.json());
    app.use('/memory', createMemoryRouter(pool, vectr));

    const { status, data } = await request(app, 'POST', '/memory', {
      content: 'Graphheight kernel architecture decision',
      entity: 'graphheight',
    });

    assert.equal(status, 201);
    assert.equal(data.id, mockId);
    assert.equal(data.lifecycle, 'memory');
    assert.equal(data.entity, 'graphheight');
    assert.equal(data.embedded, true);
  });

  it('POST /memory returns 400 when entity is missing', async () => {
    const pool = createMockPool();
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/memory', createMemoryRouter(pool, vectr));

    const { status } = await request(app, 'POST', '/memory', { content: 'Test' });
    assert.equal(status, 400);
  });

  it('GET /memory queries by entity', async () => {
    const pool = createMockPool({
      'SELECT * FROM v_memory': {
        rows: [
          { id: 'mem-1', content: 'Memory about graphheight', entity: 'graphheight', created_at: '2026-04-08T12:00:00Z' },
          { id: 'mem-2', content: 'Another graphheight fact', entity: 'graphheight', created_at: '2026-04-07T12:00:00Z' },
        ],
      },
    });
    const vectr = createMockVectr(null);

    const app = express();
    app.use(express.json());
    app.use('/memory', createMemoryRouter(pool, vectr));

    const { status, data } = await request(app, 'GET', '/memory?entity=graphheight');

    assert.equal(status, 200);
    assert.equal(data.count, 2);
    assert.equal(data.blocks[0].entity, 'graphheight');
  });
});
