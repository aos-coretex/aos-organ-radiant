/**
 * PostgreSQL connection pool for the Radiant organ.
 *
 * Connects to the existing `radiant` database on localhost:5432.
 * Does NOT create tables — verifies schema at startup.
 */

import pg from 'pg';

const { Pool } = pg;

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createPool(dbConfig) {
  return new Pool(dbConfig);
}

/**
 * Verify the database schema exists and is correct.
 * Fails fast if the expected tables/views are missing.
 */
export async function verifySchema(pool) {
  const client = await pool.connect();
  try {
    // Verify pgvector extension
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    // Verify knowledge_blocks table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'knowledge_blocks'
      ) AS exists
    `);
    if (!tableCheck.rows[0].exists) {
      throw new Error('Table knowledge_blocks does not exist — database not initialized');
    }

    // Verify views exist
    for (const view of ['v_context', 'v_memory']) {
      const viewCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.views
          WHERE table_name = $1
        ) AS exists
      `, [view]);
      if (!viewCheck.rows[0].exists) {
        throw new Error(`View ${view} does not exist — database not initialized`);
      }
    }

    // Log block counts
    const counts = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE lifecycle = 'context') AS context_count,
        COUNT(*) FILTER (WHERE lifecycle = 'memory') AS memory_count,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded_count,
        COUNT(*) AS total
      FROM knowledge_blocks
    `);

    const { context_count, memory_count, embedded_count, total } = counts.rows[0];
    const coveragePct = total > 0 ? Math.round((embedded_count / total) * 100) : 100;

    log('radiant_db_verified', {
      context_count: parseInt(context_count),
      memory_count: parseInt(memory_count),
      embedding_coverage_pct: coveragePct,
      total: parseInt(total),
    });

    return { context_count, memory_count, embedded_count, total, coveragePct };
  } finally {
    client.release();
  }
}

/**
 * Health check — verify the pool is connected.
 */
export async function checkDb(pool) {
  try {
    await pool.query('SELECT 1');
    return 'ok';
  } catch {
    return 'down';
  }
}
