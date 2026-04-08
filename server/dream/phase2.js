/**
 * Dream Phase 2 — Probabilistic.
 *
 * Requires DREAM_AI_ENABLED=true and a configured LLM client.
 *
 * 1. Semantic clustering of related memory blocks per entity
 * 2. Value assessment of context blocks approaching expiry
 * 3. N→1 consolidation of overlapping memory clusters
 *
 * Uses the atomic merge operation for each consolidation.
 * If the LLM is unavailable, Phase 2 is skipped entirely.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * Run Phase 2 of the dream cycle.
 *
 * @param {object} pool - pg Pool
 * @param {object} vectr - Vectr client
 * @param {object} llmClient - LLM client (from organ-shared-lib)
 * @returns {Promise<{clusters_found: number, promoted: number, merged: number, let_expire: number}>}
 */
export async function runPhase2(pool, vectr, llmClient) {
  const results = { clusters_found: 0, promoted: 0, merged: 0, let_expire: 0 };

  if (!llmClient || !llmClient.isAvailable()) {
    log('dream_phase2_skipped', { reason: 'LLM unavailable' });
    return results;
  }

  log('dream_phase2_start');

  try {
    // Get entities with memory blocks for clustering
    const entities = await pool.query(`
      SELECT DISTINCT entity FROM v_memory WHERE entity IS NOT NULL
    `);

    for (const entityRow of entities.rows) {
      const entity = entityRow.entity;

      // Load memory blocks for this entity
      const memories = await pool.query(`
        SELECT id, content, metadata, created_at
        FROM v_memory
        WHERE entity = $1
        ORDER BY created_at DESC
        LIMIT 100
      `, [entity]);

      if (memories.rows.length < 2) continue;

      // Ask LLM to identify clusters of semantically overlapping memories
      const clusterPrompt = memories.rows
        .map((m, i) => `[${i}] ${m.content.slice(0, 300)}`)
        .join('\n');

      const clusterResponse = await llmClient.chat(
        [{ role: 'user', content: clusterPrompt }],
        {
          system: `You are a memory consolidation agent. Given a list of memory blocks for entity "${entity}", identify groups of 2+ blocks that express overlapping or redundant knowledge and should be merged. Return JSON: { "clusters": [[index1, index2, ...], ...] }. Only include clusters where merging would reduce redundancy. If no clusters found, return { "clusters": [] }.`,
          maxTokens: 1024,
          temperature: 0,
        },
      );

      let clusters;
      try {
        const parsed = JSON.parse(clusterResponse.content);
        clusters = parsed.clusters || [];
      } catch {
        log('dream_phase2_cluster_parse_error', { entity });
        continue;
      }

      results.clusters_found += clusters.length;

      // For each cluster, ask LLM to synthesize a merged version
      for (const cluster of clusters) {
        if (cluster.length < 2) continue;

        const sourceBlocks = cluster
          .filter(i => i < memories.rows.length)
          .map(i => memories.rows[i]);

        if (sourceBlocks.length < 2) continue;

        const mergePrompt = sourceBlocks
          .map(b => b.content)
          .join('\n---\n');

        const mergeResponse = await llmClient.chat(
          [{ role: 'user', content: mergePrompt }],
          {
            system: `Synthesize these ${sourceBlocks.length} memory blocks into a single consolidated block that preserves all unique information. Output ONLY the consolidated text, nothing else.`,
            maxTokens: 2048,
            temperature: 0,
          },
        );

        // Perform atomic merge
        const sourceIds = sourceBlocks.map(b => b.id);
        const embedding = await vectr.embed(mergeResponse.content);

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const mergedMeta = { consolidated_from: sourceIds, dream_phase: 2 };
          await client.query(`
            INSERT INTO knowledge_blocks (lifecycle, content, entity, created_by, metadata, embedding)
            VALUES ('memory', $1, $2, 'dreamer', $3, $4)
          `, [mergeResponse.content, entity, JSON.stringify(mergedMeta), embedding ? JSON.stringify(embedding) : null]);

          await client.query('DELETE FROM knowledge_blocks WHERE id = ANY($1)', [sourceIds]);
          await client.query('COMMIT');
          results.merged += sourceBlocks.length;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          log('dream_phase2_merge_error', { entity, error: err.message });
        } finally {
          client.release();
        }
      }
    }

    // Value assessment: check expiring context blocks
    const expiring = await pool.query(`
      SELECT id, content, entity FROM v_context
      WHERE expires_at IS NOT NULL
        AND expires_at <= NOW() + INTERVAL '48 hours'
        AND expires_at > NOW()
      LIMIT 50
    `);

    if (expiring.rows.length > 0) {
      const assessPrompt = expiring.rows
        .map((b, i) => `[${i}] entity=${b.entity}: ${b.content.slice(0, 200)}`)
        .join('\n');

      const assessResponse = await llmClient.chat(
        [{ role: 'user', content: assessPrompt }],
        {
          system: 'You are a memory triage agent. For each expiring context block, decide: PROMOTE (has lasting value as permanent memory) or EXPIRE (transient, let it go). Return JSON: { "decisions": [{"index": 0, "action": "promote"}, ...] }',
          maxTokens: 1024,
          temperature: 0,
        },
      );

      try {
        const parsed = JSON.parse(assessResponse.content);
        for (const decision of (parsed.decisions || [])) {
          if (decision.action === 'promote' && decision.index < expiring.rows.length) {
            const block = expiring.rows[decision.index];
            await pool.query(`
              UPDATE knowledge_blocks
              SET lifecycle = 'memory', promoted_at = NOW(), expires_at = NULL
              WHERE id = $1 AND lifecycle = 'context'
            `, [block.id]);
            results.promoted++;
          } else {
            results.let_expire++;
          }
        }
      } catch {
        log('dream_phase2_assess_parse_error');
      }
    }
  } catch (err) {
    log('dream_phase2_error', { error: err.message });
  }

  log('dream_phase2_complete', results);
  return results;
}
