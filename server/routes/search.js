/**
 * Semantic search route.
 *
 * POST /similar — vector cosine similarity search
 */

import { Router } from 'express';

export function createSearchRouter(pool, vectr) {
  const router = Router();

  // POST /similar — vector cosine similarity search
  router.post('/similar', async (req, res) => {
    try {
      const {
        content,
        block_id,
        entity,
        lifecycle,
        threshold = 0.85,
        limit = 10,
      } = req.body;

      if (!content && !block_id) {
        return res.status(400).json({
          error: 'Either content or block_id is required',
        });
      }

      let queryVector;

      if (block_id) {
        // Use existing block's embedding
        const blockResult = await pool.query(
          'SELECT embedding FROM knowledge_blocks WHERE id = $1 AND embedding IS NOT NULL',
          [block_id],
        );
        if (blockResult.rows.length === 0) {
          return res.status(404).json({
            error: 'Block not found or has no embedding',
          });
        }
        queryVector = blockResult.rows[0].embedding;
      } else {
        // Embed the provided content via Vectr
        const embedding = await vectr.embed(content);
        if (!embedding) {
          return res.status(503).json({
            error: 'EMBEDDING_UNAVAILABLE',
            message: 'Vectr is not reachable — cannot perform content-based similarity search',
          });
        }
        queryVector = JSON.stringify(embedding);
      }

      // Cosine distance threshold: similarity = 1 - distance
      // threshold 0.85 means distance < 0.15
      const maxDistance = 1 - threshold;

      let query = `
        SELECT
          id, entity, lifecycle, content, metadata, created_at,
          1 - (embedding <=> $1::vector) AS similarity
        FROM knowledge_blocks
        WHERE embedding IS NOT NULL
          AND (embedding <=> $1::vector) < $2
      `;
      const params = [queryVector, maxDistance];
      let idx = 3;

      if (entity) {
        query += ` AND entity = $${idx}`;
        params.push(entity);
        idx++;
      }

      if (lifecycle) {
        query += ` AND lifecycle = $${idx}`;
        params.push(lifecycle);
        idx++;
      }

      // Exclude the source block from results if using block_id
      if (block_id) {
        query += ` AND id != $${idx}`;
        params.push(block_id);
        idx++;
      }

      query += ` ORDER BY similarity DESC LIMIT $${idx}`;
      params.push(parseInt(limit));

      const result = await pool.query(query, params);

      res.json({
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
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
