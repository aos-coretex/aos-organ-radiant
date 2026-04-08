/**
 * Context routes — ephemeral knowledge block storage and queries.
 *
 * POST /context — store a context block (with optional Vectr embedding)
 * GET  /context — query active (non-expired) context blocks
 */

import { Router } from 'express';

export function createContextRouter(pool, vectr) {
  const router = Router();

  // POST /context — store ephemeral context block
  router.post('/', async (req, res) => {
    try {
      const {
        content,
        entity,
        session_id,
        created_by = 'agent',
        expires_in_days = 7,
        metadata = {},
      } = req.body;

      if (!content || !entity) {
        return res.status(400).json({ error: 'content and entity are required' });
      }

      // Generate embedding (graceful degradation)
      const embedding = await vectr.embed(content);
      const embedded = embedding !== null;

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expires_in_days);

      const result = await pool.query(`
        INSERT INTO knowledge_blocks
          (lifecycle, content, entity, session_id, created_by, metadata, embedding, expires_at)
        VALUES
          ('context', $1, $2, $3, $4, $5, $6, $7)
        RETURNING id, lifecycle, created_at, expires_at
      `, [
        content,
        entity,
        session_id || null,
        created_by,
        JSON.stringify(metadata),
        embedding ? JSON.stringify(embedding) : null,
        expiresAt.toISOString(),
      ]);

      const row = result.rows[0];
      res.status(201).json({
        id: row.id,
        lifecycle: row.lifecycle,
        embedded,
        created_at: row.created_at,
        expires_at: row.expires_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /context — query active context blocks
  router.get('/', async (req, res) => {
    try {
      const { keywords, session_id, limit = 20 } = req.query;

      let query = 'SELECT * FROM v_context WHERE 1=1';
      const params = [];
      let idx = 1;

      if (keywords) {
        query += ` AND content ILIKE $${idx}`;
        params.push(`%${keywords}%`);
        idx++;
      }

      if (session_id) {
        query += ` AND session_id = $${idx}`;
        params.push(session_id);
        idx++;
      }

      query += ` ORDER BY created_at DESC LIMIT $${idx}`;
      params.push(parseInt(limit));

      const result = await pool.query(query, params);

      res.json({
        count: result.rows.length,
        blocks: result.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
