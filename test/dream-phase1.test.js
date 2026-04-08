import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPhase1 } from '../server/dream/phase1.js';
import { createMockPool } from './helpers.js';

describe('Dream Phase 1', () => {
  it('reduces TTL on aging context blocks', async () => {
    const pool = createMockPool({
      'SET expires_at = NOW()': {
        rows: [{ id: 'aging-1' }, { id: 'aging-2' }],
      },
      'DELETE FROM knowledge_blocks': { rows: [] },
    });
    // The first UPDATE query matches TTL reduction
    pool.query = async (sql, params) => {
      pool.getQueries().push({ sql, params });
      if (sql.includes('expires_at - NOW()) / 2')) {
        return { rows: [{ id: 'aging-1' }, { id: 'aging-2' }] };
      }
      if (sql.includes('old.entity = new.entity')) {
        return { rows: [{ id: 'superseded-1' }] };
      }
      if (sql.includes('DELETE FROM knowledge_blocks')) {
        return { rows: [{ id: 'expired-1' }, { id: 'expired-2' }, { id: 'expired-3' }] };
      }
      return { rows: [] };
    };

    const results = await runPhase1(pool);

    assert.equal(results.ttl_reduced, 2);
    assert.equal(results.superseded, 1);
    assert.equal(results.expired, 3);
  });

  it('handles empty database gracefully', async () => {
    const pool = createMockPool();
    // All queries return empty rows
    pool.query = async () => ({ rows: [] });

    const results = await runPhase1(pool);

    assert.equal(results.ttl_reduced, 0);
    assert.equal(results.superseded, 0);
    assert.equal(results.expired, 0);
  });
});
