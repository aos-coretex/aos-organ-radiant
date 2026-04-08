/**
 * Lifecycle management routes.
 *
 * POST  /promote    — promote context → memory
 * POST  /prune      — delete all expired context blocks
 * POST  /merge      — atomic N→1 memory merge
 * PATCH /context/ttl — update TTL on context blocks
 */

import { Router } from 'express';

export function createLifecycleRouter(pool, vectr) {
  const router = Router();

  // POST /promote — promote context block to permanent memory
  router.post('/promote', async (req, res) => {
    try {
      const { block_id, entity } = req.body;

      if (!block_id || !entity) {
        return res.status(400).json({ error: 'block_id and entity are required' });
      }

      const result = await pool.query(`
        UPDATE knowledge_blocks
        SET lifecycle = 'memory',
            entity = $2,
            promoted_at = NOW(),
            expires_at = NULL
        WHERE id = $1
          AND lifecycle = 'context'
        RETURNING id, entity, promoted_at
      `, [block_id, entity]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 'not_found',
          error: 'Block not found or already promoted',
        });
      }

      const row = result.rows[0];
      res.json({
        status: 'promoted',
        id: row.id,
        entity: row.entity,
        promoted_at: row.promoted_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /prune — delete all expired context blocks
  router.post('/prune', async (req, res) => {
    try {
      const result = await pool.query(`
        DELETE FROM knowledge_blocks
        WHERE lifecycle = 'context'
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        RETURNING id
      `);

      res.json({
        status: 'pruned',
        deleted_count: result.rows.length,
        deleted_ids: result.rows.map(r => r.id),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /merge — atomic N→1 memory merge
  router.post('/merge', async (req, res) => {
    const { source_ids, merged_content, entity, metadata = {} } = req.body;

    if (!source_ids || source_ids.length === 0 || !merged_content || !entity) {
      return res.status(400).json({
        error: 'source_ids (non-empty), merged_content, and entity are required',
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verify all source IDs exist and are memories
      const verify = await client.query(`
        SELECT id FROM knowledge_blocks
        WHERE id = ANY($1) AND lifecycle = 'memory'
      `, [source_ids]);

      const foundIds = verify.rows.map(r => r.id);
      const missingIds = source_ids.filter(id => !foundIds.includes(id));

      if (missingIds.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'MEMORY_MERGE_CONFLICT',
          missing_ids: missingIds,
        });
      }

      // Generate embedding for merged content
      const embedding = await vectr.embed(merged_content);
      const embedded = embedding !== null;

      // Insert merged block
      const mergedMeta = { ...metadata, consolidated_from: source_ids };
      const insertResult = await client.query(`
        INSERT INTO knowledge_blocks
          (lifecycle, content, entity, created_by, metadata, embedding)
        VALUES
          ('memory', $1, $2, 'dreamer', $3, $4)
        RETURNING id, created_at
      `, [
        merged_content,
        entity,
        JSON.stringify(mergedMeta),
        embedding ? JSON.stringify(embedding) : null,
      ]);

      // Delete source blocks
      await client.query(`
        DELETE FROM knowledge_blocks WHERE id = ANY($1)
      `, [source_ids]);

      await client.query('COMMIT');

      const row = insertResult.rows[0];
      res.json({
        status: 'merged',
        new_id: row.id,
        created_at: row.created_at,
        deleted_count: source_ids.length,
        entity,
        embedded,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // PATCH /context/ttl — update TTL on context blocks
  router.patch('/context/ttl', async (req, res) => {
    try {
      const { block_ids, expires_in_days } = req.body;

      if (!block_ids || block_ids.length === 0 || expires_in_days === undefined) {
        return res.status(400).json({
          error: 'block_ids (non-empty) and expires_in_days are required',
        });
      }

      let expiresAt;
      if (expires_in_days === 0) {
        expiresAt = new Date(); // expire immediately
      } else {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + expires_in_days);
      }

      const result = await pool.query(`
        UPDATE knowledge_blocks
        SET expires_at = $1
        WHERE id = ANY($2)
          AND lifecycle = 'context'
        RETURNING id, expires_at
      `, [expiresAt.toISOString(), block_ids]);

      const notFound = block_ids.length - result.rows.length;

      res.json({
        status: 'updated',
        updated_count: result.rows.length,
        blocks: result.rows.map(r => ({ id: r.id, new_expires_at: r.expires_at })),
        not_found: notFound,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
