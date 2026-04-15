/**
 * Radiant organ configuration.
 *
 * Ports: 3906 (SAAS) / 4006 (AOS)
 * Database: PostgreSQL `radiant` on localhost:5432
 */

export const config = {
  port: parseInt(process.env.RADIANT_PORT || '4006', 10),
  binding: '127.0.0.1',
  spineUrl: process.env.SPINE_URL || 'http://127.0.0.1:4000',

  db: {
    host: process.env.RADIANT_DB_HOST || 'localhost',
    port: parseInt(process.env.RADIANT_DB_PORT || '5432', 10),
    database: process.env.RADIANT_DB_NAME || 'radiant',
    user: process.env.RADIANT_DB_USER || 'graphheight_sys',
    max: 5,
  },

  vectrUrl: process.env.LLM_OPS_EMBEDDING_URL || 'http://127.0.0.1:4001',
  vectrTimeoutMs: 5000,

  dreamEnabled: process.env.DREAM_ENABLED === 'true',
  dreamAiEnabled: process.env.DREAM_AI_ENABLED === 'true',
  dreamIntervalMs: parseInt(process.env.DREAM_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10),
};
