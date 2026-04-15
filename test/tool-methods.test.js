/**
 * Radiant tool methods — MP-TOOL-1 relay t8r-3.
 *
 * Thin-wrapper tests using the existing mock helpers (mock pool + mock vectr).
 * Each method is verified for param plumbing, SQL shape, and error-code
 * surfacing. No real Postgres required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolMethods } from '../server/tool-methods.js';
import { createMockPool, createMockVectr, fakeEmbedding } from './helpers.js';

function makeDeps(overrides = {}) {
  return {
    pool: overrides.pool ?? createMockPool({
      'INSERT INTO knowledge_blocks': {
        rows: [{
          id: 1, lifecycle: 'context', entity: 'leon',
          created_at: '2026-04-15T00:00:00Z', expires_at: '2026-04-22T00:00:00Z',
        }],
      },
      'SELECT * FROM v_context': { rows: [{ id: 1, content: 'abc' }] },
      'SELECT * FROM v_memory': { rows: [] },
      'UPDATE knowledge_blocks': { rows: [{ id: 1, entity: 'leon', promoted_at: '2026-04-15T00:00:00Z', expires_at: '2026-04-22T00:00:00Z' }] },
      'DELETE FROM knowledge_blocks': { rows: [{ id: 5 }, { id: 6 }] },
      'FROM v_context': { rows: [{ total: '3', expiring_48h: '1' }] },
      'FROM v_memory': { rows: [] },
      'FROM knowledge_blocks': { rows: [{ with_embedding: '2', without_embedding: '1', total: '3' }] },
    }),
    vectr: overrides.vectr ?? createMockVectr(fakeEmbedding()),
    getDreamState: overrides.getDreamState ?? (() => ({ lastRun: null, lastSummary: null })),
  };
}

describe('Radiant tool-methods', () => {
  it('exposes exactly the 10 declared methods', () => {
    const methods = createToolMethods(makeDeps());
    const expected = [
      'storeContext', 'storeMemory', 'queryContext', 'queryMemory',
      'promote', 'pruneExpired', 'dreamStats', 'mergeMemories',
      'findSimilar', 'updateTtl',
    ];
    for (const name of expected) {
      assert.equal(typeof methods[name], 'function', `methods.${name} missing`);
    }
  });

  it('storeContext requires content + entity', async () => {
    const methods = createToolMethods(makeDeps());
    await assert.rejects(
      () => methods.storeContext({ content: 'x' }),
      (err) => err.code === 'EBADPARAM'
    );
  });

  it('storeContext calls vectr.embed and pool.query with correct lifecycle', async () => {
    const deps = makeDeps();
    const methods = createToolMethods(deps);
    const res = await methods.storeContext({
      content: 'hello world',
      entity: 'leon',
      session_id: 's1',
    });
    assert.equal(res.lifecycle, 'context');
    assert.equal(res.embedded, true);
    assert.equal(deps.vectr.getEmbedCalls(), 1);
    const queries = deps.pool.getQueries();
    assert.ok(queries.some(q => q.sql.includes('INSERT INTO knowledge_blocks') && q.sql.includes('context')));
  });

  it('storeMemory sets lifecycle=memory', async () => {
    const deps = makeDeps({
      pool: createMockPool({
        'INSERT INTO knowledge_blocks': {
          rows: [{ id: 2, lifecycle: 'memory', entity: 'leon', created_at: '2026-04-15T00:00:00Z' }],
        },
      }),
    });
    const methods = createToolMethods(deps);
    const res = await methods.storeMemory({ content: 'x', entity: 'leon' });
    assert.equal(res.lifecycle, 'memory');
    assert.equal(res.entity, 'leon');
  });

  it('queryContext applies keywords + session_id + limit filters', async () => {
    const deps = makeDeps();
    const methods = createToolMethods(deps);
    const res = await methods.queryContext({ keywords: 'foo', session_id: 's1', limit: 5 });
    assert.equal(typeof res.count, 'number');
    const q = deps.pool.getQueries().find(x => x.sql.includes('v_context'));
    assert.ok(q.sql.includes('content ILIKE'));
    assert.ok(q.sql.includes('session_id'));
    assert.deepEqual(q.params, ['%foo%', 's1', 5]);
  });

  it('queryMemory applies entity + keyword filters', async () => {
    const deps = makeDeps();
    const methods = createToolMethods(deps);
    await methods.queryMemory({ entity: 'leon', keywords: 'bar' });
    const q = deps.pool.getQueries().find(x => x.sql.includes('v_memory'));
    assert.ok(q.sql.includes('entity = $1'));
    assert.ok(q.sql.includes('content ILIKE $2'));
  });

  it('promote throws ENOTFOUND when block is not a context block', async () => {
    const deps = makeDeps({
      pool: createMockPool({}), // default empty rows
    });
    const methods = createToolMethods(deps);
    await assert.rejects(
      () => methods.promote({ block_id: 'nope', entity: 'leon' }),
      (err) => err.code === 'ENOTFOUND'
    );
  });

  it('pruneExpired returns deleted_count + ids', async () => {
    const deps = makeDeps();
    const methods = createToolMethods(deps);
    const res = await methods.pruneExpired();
    assert.equal(res.status, 'pruned');
    assert.equal(res.deleted_count, 2);
    assert.deepEqual(res.deleted_ids, [5, 6]);
  });

  it('mergeMemories surfaces MEMORY_MERGE_CONFLICT on missing ids', async () => {
    // SELECT for verification returns empty → all source_ids missing
    const pool = createMockPool({
      'SELECT id FROM knowledge_blocks': { rows: [] },
    });
    const methods = createToolMethods({ pool, vectr: createMockVectr(fakeEmbedding()) });
    await assert.rejects(
      () => methods.mergeMemories({
        source_ids: ['a', 'b'],
        merged_content: 'merged',
        entity: 'leon',
      }),
      (err) => err.code === 'MEMORY_MERGE_CONFLICT' && Array.isArray(err.missing_ids) && err.missing_ids.length === 2
    );
  });

  it('findSimilar requires content or block_id', async () => {
    const methods = createToolMethods(makeDeps());
    await assert.rejects(
      () => methods.findSimilar({}),
      (err) => err.code === 'EBADPARAM'
    );
  });

  it('findSimilar surfaces EMBEDDING_UNAVAILABLE when vectr returns null', async () => {
    const methods = createToolMethods({
      pool: createMockPool({}),
      vectr: createMockVectr(null), // embed returns null
    });
    await assert.rejects(
      () => methods.findSimilar({ content: 'hello' }),
      (err) => err.code === 'EMBEDDING_UNAVAILABLE'
    );
  });

  it('updateTtl rejects missing block_ids or expires_in_days', async () => {
    const methods = createToolMethods(makeDeps());
    await assert.rejects(
      () => methods.updateTtl({ block_ids: [] }),
      (err) => err.code === 'EBADPARAM'
    );
    await assert.rejects(
      () => methods.updateTtl({ block_ids: ['a'] }),
      (err) => err.code === 'EBADPARAM'
    );
  });

  it('updateTtl accepts expires_in_days=0 (immediate expiry)', async () => {
    const pool = createMockPool({
      'UPDATE knowledge_blocks': { rows: [{ id: 1, expires_at: '2026-04-15T00:00:00Z' }] },
    });
    const methods = createToolMethods({ pool, vectr: createMockVectr() });
    const res = await methods.updateTtl({ block_ids: ['a'], expires_in_days: 0 });
    assert.equal(res.status, 'updated');
    assert.equal(res.updated_count, 1);
  });

  it('dreamStats returns combined aggregate', async () => {
    const deps = makeDeps({
      getDreamState: () => ({ lastRun: '2026-04-14T00:00:00Z', lastSummary: 'ok' }),
    });
    const methods = createToolMethods(deps);
    const res = await methods.dreamStats();
    assert.equal(typeof res.context.total, 'number');
    assert.equal(typeof res.embeddings.coverage_pct, 'number');
    assert.equal(res.last_dream.timestamp, '2026-04-14T00:00:00Z');
  });
});
