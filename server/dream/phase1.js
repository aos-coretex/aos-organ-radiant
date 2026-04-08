/**
 * Dream Phase 1 — Deterministic.
 *
 * 1. Scan all context blocks
 * 2. Reduce TTL on entries past 50% of original TTL
 * 3. Detect supersession (same entity, overlapping content → TTL to 0)
 * 4. Prune all expired blocks
 *
 * No LLM required. Commits independently of Phase 2.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * Run Phase 1 of the dream cycle.
 *
 * @param {object} pool - pg Pool
 * @returns {Promise<{expired: number, ttl_reduced: number, superseded: number}>}
 */
export async function runPhase1(pool) {
  log('dream_phase1_start');
  const results = { expired: 0, ttl_reduced: 0, superseded: 0 };

  // Step 1: Reduce TTL on aging context blocks
  // Blocks past 50% of their original TTL get their remaining time halved
  const agingResult = await pool.query(`
    UPDATE knowledge_blocks
    SET expires_at = NOW() + (expires_at - NOW()) / 2
    WHERE lifecycle = 'context'
      AND expires_at IS NOT NULL
      AND expires_at > NOW()
      AND (expires_at - NOW()) < (expires_at - created_at) / 2
    RETURNING id
  `);
  results.ttl_reduced = agingResult.rows.length;

  // Step 2: Detect supersession
  // For blocks with the same entity, if a newer block's content overlaps
  // with an older block (substring match), set the older block's TTL to 0
  const supersessionResult = await pool.query(`
    UPDATE knowledge_blocks AS old
    SET expires_at = NOW()
    FROM knowledge_blocks AS new
    WHERE old.lifecycle = 'context'
      AND new.lifecycle = 'context'
      AND old.entity = new.entity
      AND old.id != new.id
      AND new.created_at > old.created_at
      AND old.expires_at > NOW()
      AND (
        old.content ILIKE '%' || LEFT(new.content, 100) || '%'
        OR new.content ILIKE '%' || LEFT(old.content, 100) || '%'
      )
    RETURNING old.id
  `);
  results.superseded = supersessionResult.rows.length;

  // Step 3: Prune all expired blocks
  const pruneResult = await pool.query(`
    DELETE FROM knowledge_blocks
    WHERE lifecycle = 'context'
      AND expires_at IS NOT NULL
      AND expires_at <= NOW()
    RETURNING id
  `);
  results.expired = pruneResult.rows.length;

  log('dream_phase1_complete', results);
  return results;
}
