/**
 * Stats route — dream stats and health dashboard.
 *
 * GET /stats — context/memory counts, embedding coverage, last dream info
 */

import { Router } from 'express';

export function createStatsRouter(pool, getDreamState) {
  const router = Router();

  router.get('/stats', async (req, res) => {
    try {
      // Context counts
      const contextResult = await pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW() + INTERVAL '48 hours') AS expiring_48h
        FROM v_context
      `);
      const ctx = contextResult.rows[0];

      // Memory counts by entity
      const entityResult = await pool.query(`
        SELECT
          entity,
          COUNT(*) AS count,
          ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400), 1) AS avg_age_days
        FROM v_memory
        GROUP BY entity
        ORDER BY count DESC
      `);

      // Embedding coverage
      const embeddingResult = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
          COUNT(*) FILTER (WHERE embedding IS NULL) AS without_embedding,
          COUNT(*) AS total
        FROM knowledge_blocks
      `);
      const emb = embeddingResult.rows[0];
      const coveragePct = parseInt(emb.total) > 0
        ? Math.round((parseInt(emb.with_embedding) / parseInt(emb.total)) * 100)
        : 100;

      // Dream state
      const dreamState = getDreamState ? getDreamState() : null;

      let health = 'never_run';
      if (dreamState?.lastRun) {
        health = parseInt(ctx.expiring_48h) > 10 ? 'accumulating' : 'clean';
      }

      res.json({
        context: {
          total: parseInt(ctx.total),
          expiring_48h: parseInt(ctx.expiring_48h),
        },
        memory: {
          by_entity: entityResult.rows.map(r => ({
            entity: r.entity,
            count: parseInt(r.count),
            avg_age_days: parseFloat(r.avg_age_days),
          })),
        },
        embeddings: {
          with: parseInt(emb.with_embedding),
          without: parseInt(emb.without_embedding),
          total: parseInt(emb.total),
          coverage_pct: coveragePct,
        },
        last_dream: dreamState?.lastRun ? {
          timestamp: dreamState.lastRun,
          summary: dreamState.lastSummary || null,
        } : null,
        health,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
