/**
 * Memory routes — permanent knowledge block storage and queries.
 *
 * POST /memory — store a permanent memory block (with optional Vectr embedding)
 * GET  /memory — query memory blocks by entity and/or keywords
 */

import { Router } from 'express';

export function createMemoryRouter(pool, vectr) {
  const router = Router();

  // POST /memory — store permanent memory block
  router.post('/', async (req, res) => {
    try {
      const {
        content,
        entity,
        created_by = 'agent',
        source_sessions,
        metadata = {},
      } = req.body;

      if (!content || !entity) {
        return res.status(400).json({ error: 'content and entity are required' });
      }

      // Generate embedding (graceful degradation)
      const embedding = await vectr.embed(content);
      const embedded = embedding !== null;

      const result = await pool.query(`
        INSERT INTO knowledge_blocks
          (lifecycle, content, entity, created_by, source_sessions, metadata, embedding)
        VALUES
          ('memory', $1, $2, $3, $4, $5, $6)
        RETURNING id, lifecycle, entity, created_at
      `, [
        content,
        entity,
        created_by,
        source_sessions || null,
        JSON.stringify(metadata),
        embedding ? JSON.stringify(embedding) : null,
      ]);

      const row = result.rows[0];
      res.status(201).json({
        id: row.id,
        lifecycle: row.lifecycle,
        entity: row.entity,
        embedded,
        created_at: row.created_at,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /memory — query permanent memory blocks
  router.get('/', async (req, res) => {
    try {
      const { entity, keywords, limit = 20 } = req.query;

      let query = 'SELECT * FROM v_memory WHERE 1=1';
      const params = [];
      let idx = 1;

      if (entity) {
        query += ` AND entity = $${idx}`;
        params.push(entity);
        idx++;
      }

      if (keywords) {
        query += ` AND content ILIKE $${idx}`;
        params.push(`%${keywords}%`);
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
