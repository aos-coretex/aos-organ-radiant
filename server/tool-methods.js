/**
 * Radiant organ tool methods — MP-TOOL-1 relay t8r-3.
 *
 * Thin wrappers over pool + vectr for the 10 declared Radiant MCP tools.
 * Each method:
 *   - accepts a single `params` object (fields per MCP input schema)
 *   - returns the `data` field of a SUCCESS response (serializable object)
 *   - throws typed errors (with `.code`) on validation/merge conflicts
 *
 * D7: no Spine OTM emissions — methods operate on pool (Postgres) + vectr
 * (HTTP sidecar for embeddings). Cross-organ reads would go over HTTP, but
 * Radiant's tool methods don't need them.
 *
 * The method bodies mirror the HTTP route implementations
 * (`server/routes/*.js`) — duplication is intentional: the existing Spine
 * handler (`server/handlers/messages.js`) already duplicates the routes.
 * When Radiant's internals are refactored into a service layer, both
 * duplications collapse together.
 */

function bad(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createToolMethods({ pool, vectr, getDreamState }) {
  return {
    /**
     * radiant__store_context — INSERT context block (embedded via Vectr).
     */
    storeContext: async (params) => {
      const {
        content,
        entity,
        session_id,
        created_by = 'agent',
        expires_in_days = 7,
        metadata = {},
      } = params || {};
      if (!content || !entity) {
        throw bad('EBADPARAM', 'content and entity are required');
      }
      const embedding = await vectr.embed(content);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expires_in_days);

      const result = await pool.query(
        `INSERT INTO knowledge_blocks
           (lifecycle, content, entity, session_id, created_by, metadata, embedding, expires_at)
         VALUES ('context', $1, $2, $3, $4, $5, $6, $7)
         RETURNING id, lifecycle, created_at, expires_at`,
        [
          content,
          entity,
          session_id || null,
          created_by,
          JSON.stringify(metadata),
          embedding ? JSON.stringify(embedding) : null,
          expiresAt.toISOString(),
        ]
      );

      const row = result.rows[0];
      return {
        id: row.id,
        lifecycle: row.lifecycle,
        embedded: embedding !== null,
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
    },

    /**
     * radiant__store_memory — INSERT permanent memory block.
     */
    storeMemory: async (params) => {
      const {
        content,
        entity,
        created_by = 'agent',
        source_sessions,
        metadata = {},
      } = params || {};
      if (!content || !entity) {
        throw bad('EBADPARAM', 'content and entity are required');
      }
      const embedding = await vectr.embed(content);

      const result = await pool.query(
        `INSERT INTO knowledge_blocks
           (lifecycle, content, entity, created_by, source_sessions, metadata, embedding)
         VALUES ('memory', $1, $2, $3, $4, $5, $6)
         RETURNING id, lifecycle, entity, created_at`,
        [
          content,
          entity,
          created_by,
          source_sessions || null,
          JSON.stringify(metadata),
          embedding ? JSON.stringify(embedding) : null,
        ]
      );
      const row = result.rows[0];
      return {
        id: row.id,
        lifecycle: row.lifecycle,
        entity: row.entity,
        embedded: embedding !== null,
        created_at: row.created_at,
      };
    },

    /**
     * radiant__query_context — SELECT from v_context with keyword/session filters.
     */
    queryContext: async (params = {}) => {
      const { keywords, session_id, limit = 20 } = params;
      let sql = 'SELECT * FROM v_context WHERE 1=1';
      const values = [];
      let idx = 1;

      if (keywords) { sql += ` AND content ILIKE $${idx}`; values.push(`%${keywords}%`); idx++; }
      if (session_id) { sql += ` AND session_id = $${idx}`; values.push(session_id); idx++; }
      sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
      values.push(parseInt(limit));

      const result = await pool.query(sql, values);
      return { count: result.rows.length, blocks: result.rows };
    },

    /**
     * radiant__query_memory — SELECT from v_memory with entity/keyword filters.
     */
    queryMemory: async (params = {}) => {
      const { entity, keywords, limit = 20 } = params;
      let sql = 'SELECT * FROM v_memory WHERE 1=1';
      const values = [];
      let idx = 1;

      if (entity) { sql += ` AND entity = $${idx}`; values.push(entity); idx++; }
      if (keywords) { sql += ` AND content ILIKE $${idx}`; values.push(`%${keywords}%`); idx++; }
      sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
      values.push(parseInt(limit));

      const result = await pool.query(sql, values);
      return { count: result.rows.length, blocks: result.rows };
    },

    /**
     * radiant__promote — promote context block to permanent memory.
     * Throws ENOTFOUND when block_id is not a context block.
     */
    promote: async (params) => {
      const { block_id, entity } = params || {};
      if (!block_id || !entity) {
        throw bad('EBADPARAM', 'block_id and entity are required');
      }
      const result = await pool.query(
        `UPDATE knowledge_blocks
         SET lifecycle = 'memory', entity = $2, promoted_at = NOW(), expires_at = NULL
         WHERE id = $1 AND lifecycle = 'context'
         RETURNING id, entity, promoted_at`,
        [block_id, entity]
      );
      if (result.rows.length === 0) {
        throw bad('ENOTFOUND', 'Block not found or already promoted');
      }
      const row = result.rows[0];
      return {
        status: 'promoted',
        id: row.id,
        entity: row.entity,
        promoted_at: row.promoted_at,
      };
    },

    /**
     * radiant__prune_expired — DELETE expired context blocks.
     * Potentially large batch. Caller may set timeout_ms; default 25s.
     */
    pruneExpired: async () => {
      const result = await pool.query(
        `DELETE FROM knowledge_blocks
         WHERE lifecycle = 'context'
           AND expires_at IS NOT NULL
           AND expires_at <= NOW()
         RETURNING id`
      );
      return {
        status: 'pruned',
        deleted_count: result.rows.length,
        deleted_ids: result.rows.map(r => r.id),
      };
    },

    /**
     * radiant__dream_stats — aggregate counts + dream state.
     */
    dreamStats: async () => {
      const [contextRes, entityRes, embeddingRes] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW() + INTERVAL '48 hours') AS expiring_48h
          FROM v_context
        `),
        pool.query(`
          SELECT
            entity,
            COUNT(*) AS count,
            ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400), 1) AS avg_age_days
          FROM v_memory
          GROUP BY entity
          ORDER BY count DESC
        `),
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
            COUNT(*) FILTER (WHERE embedding IS NULL) AS without_embedding,
            COUNT(*) AS total
          FROM knowledge_blocks
        `),
      ]);

      const ctx = contextRes.rows[0];
      const emb = embeddingRes.rows[0];
      const totalCount = parseInt(emb.total);
      const withEmb = parseInt(emb.with_embedding);
      const coveragePct = totalCount > 0 ? Math.round((withEmb / totalCount) * 100) : 100;

      const dreamState = typeof getDreamState === 'function' ? getDreamState() : null;
      let health = 'never_run';
      if (dreamState?.lastRun) {
        health = parseInt(ctx.expiring_48h) > 10 ? 'accumulating' : 'clean';
      }

      return {
        context: {
          total: parseInt(ctx.total),
          expiring_48h: parseInt(ctx.expiring_48h),
        },
        memory: {
          by_entity: entityRes.rows.map(r => ({
            entity: r.entity,
            count: parseInt(r.count),
            avg_age_days: parseFloat(r.avg_age_days),
          })),
        },
        embeddings: {
          with: withEmb,
          without: parseInt(emb.without_embedding),
          total: totalCount,
          coverage_pct: coveragePct,
        },
        last_dream: dreamState?.lastRun ? {
          timestamp: dreamState.lastRun,
          summary: dreamState.lastSummary || null,
        } : null,
        health,
      };
    },

    /**
     * radiant__merge_memories — atomic N→1 merge.
     * Surfaces MEMORY_MERGE_CONFLICT as TOOL_ERROR with `missing_ids` in meta.
     */
    mergeMemories: async (params) => {
      const { source_ids, merged_content, entity, metadata = {} } = params || {};
      if (!source_ids?.length || !merged_content || !entity) {
        throw bad('EBADPARAM', 'source_ids (non-empty), merged_content, and entity are required');
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const verify = await client.query(
          `SELECT id FROM knowledge_blocks WHERE id = ANY($1) AND lifecycle = 'memory'`,
          [source_ids]
        );
        const foundIds = verify.rows.map(r => r.id);
        const missing = source_ids.filter(id => !foundIds.includes(id));
        if (missing.length > 0) {
          await client.query('ROLLBACK');
          const err = bad('MEMORY_MERGE_CONFLICT', `Missing source blocks: ${missing.join(',')}`);
          err.missing_ids = missing;
          throw err;
        }

        const embedding = await vectr.embed(merged_content);
        const mergedMeta = { ...metadata, consolidated_from: source_ids };
        const ins = await client.query(
          `INSERT INTO knowledge_blocks
             (lifecycle, content, entity, created_by, metadata, embedding)
           VALUES ('memory', $1, $2, 'dreamer', $3, $4)
           RETURNING id, created_at`,
          [
            merged_content,
            entity,
            JSON.stringify(mergedMeta),
            embedding ? JSON.stringify(embedding) : null,
          ]
        );

        await client.query(
          `DELETE FROM knowledge_blocks WHERE id = ANY($1)`,
          [source_ids]
        );
        await client.query('COMMIT');

        const row = ins.rows[0];
        return {
          status: 'merged',
          new_id: row.id,
          created_at: row.created_at,
          deleted_count: source_ids.length,
          entity,
          embedded: embedding !== null,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    /**
     * radiant__find_similar — vector cosine similarity search.
     * Accepts either `content` (embed on the fly) or `block_id` (reuse embedding).
     */
    findSimilar: async (params) => {
      const {
        content,
        block_id,
        entity,
        lifecycle,
        threshold = 0.85,
        limit = 10,
      } = params || {};
      if (!content && !block_id) {
        throw bad('EBADPARAM', 'Either content or block_id is required');
      }

      let queryVector;
      if (block_id) {
        const blockResult = await pool.query(
          'SELECT embedding FROM knowledge_blocks WHERE id = $1 AND embedding IS NOT NULL',
          [block_id]
        );
        if (blockResult.rows.length === 0) {
          throw bad('ENOTFOUND', 'Block not found or has no embedding');
        }
        queryVector = blockResult.rows[0].embedding;
      } else {
        const embedding = await vectr.embed(content);
        if (!embedding) {
          throw bad('EMBEDDING_UNAVAILABLE', 'Vectr is not reachable — cannot embed content');
        }
        queryVector = JSON.stringify(embedding);
      }

      const maxDistance = 1 - threshold;
      let sql = `
        SELECT
          id, entity, lifecycle, content, metadata, created_at,
          1 - (embedding <=> $1::vector) AS similarity
        FROM knowledge_blocks
        WHERE embedding IS NOT NULL
          AND (embedding <=> $1::vector) < $2
      `;
      const values = [queryVector, maxDistance];
      let idx = 3;

      if (entity) { sql += ` AND entity = $${idx}`; values.push(entity); idx++; }
      if (lifecycle) { sql += ` AND lifecycle = $${idx}`; values.push(lifecycle); idx++; }
      if (block_id) { sql += ` AND id != $${idx}`; values.push(block_id); idx++; }

      sql += ` ORDER BY similarity DESC LIMIT $${idx}`;
      values.push(parseInt(limit));

      const result = await pool.query(sql, values);
      return {
        count: result.rows.length,
        results: result.rows.map(r => ({
          id: r.id,
          similarity: parseFloat(r.similarity),
          entity: r.entity,
          lifecycle: r.lifecycle,
          content_preview: r.content.slice(0, 200),
          metadata: r.metadata,
          created_at: r.created_at,
        })),
      };
    },

    /**
     * radiant__update_ttl — UPDATE expires_at on context blocks.
     */
    updateTtl: async (params) => {
      const { block_ids, expires_in_days } = params || {};
      if (!block_ids?.length || expires_in_days === undefined) {
        throw bad('EBADPARAM', 'block_ids (non-empty) and expires_in_days are required');
      }
      let expiresAt;
      if (expires_in_days === 0) {
        expiresAt = new Date();
      } else {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + expires_in_days);
      }
      const result = await pool.query(
        `UPDATE knowledge_blocks
         SET expires_at = $1
         WHERE id = ANY($2) AND lifecycle = 'context'
         RETURNING id, expires_at`,
        [expiresAt.toISOString(), block_ids]
      );
      const notFound = block_ids.length - result.rows.length;
      return {
        status: 'updated',
        updated_count: result.rows.length,
        blocks: result.rows.map(r => ({ id: r.id, new_expires_at: r.expires_at })),
        not_found: notFound,
      };
    },
  };
}
