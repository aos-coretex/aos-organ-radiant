/**
 * Spine directed message dispatcher for Radiant.
 *
 * Routes incoming OTM messages by payload.event_type to the
 * corresponding handler. Returns a response payload that the
 * live loop sends back as a correlated OTM.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * @param {object} pool - pg Pool
 * @param {object} vectr - Vectr client
 * @param {function} triggerDream - triggers a dream cycle
 */
export function createMessageHandler(pool, vectr, triggerDream) {
  return async function handleMessage(envelope) {
    const { payload, message_id } = envelope;
    const eventType = payload?.event_type;

    log('radiant_message_received', { event_type: eventType, message_id });

    switch (eventType) {
      case 'store_context':
        return await handleStoreContext(pool, vectr, payload);

      case 'store_memory':
        return await handleStoreMemory(pool, vectr, payload);

      case 'query_context':
        return await handleQueryContext(pool, payload);

      case 'query_memory':
        return await handleQueryMemory(pool, payload);

      case 'promote':
        return await handlePromote(pool, payload);

      case 'merge':
        return await handleMerge(pool, vectr, payload);

      case 'dream_trigger':
        return await handleDreamTrigger(triggerDream, payload);

      case 'stats':
        return await handleStats(pool);

      default:
        log('radiant_unknown_event_type', { event_type: eventType, message_id });
        return { error: 'unknown_event_type', event_type: eventType };
    }
  };
}

async function handleStoreContext(pool, vectr, payload) {
  const { content, entity, session_id, created_by = 'agent', expires_in_days = 7, metadata = {} } = payload;
  if (!content || !entity) return { error: 'content and entity required' };

  const embedding = await vectr.embed(content);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expires_in_days);

  const result = await pool.query(`
    INSERT INTO knowledge_blocks (lifecycle, content, entity, session_id, created_by, metadata, embedding, expires_at)
    VALUES ('context', $1, $2, $3, $4, $5, $6, $7)
    RETURNING id, lifecycle, created_at, expires_at
  `, [content, entity, session_id || null, created_by, JSON.stringify(metadata), embedding ? JSON.stringify(embedding) : null, expiresAt.toISOString()]);

  const row = result.rows[0];
  return { event_type: 'store_response', id: row.id, lifecycle: row.lifecycle, embedded: embedding !== null, created_at: row.created_at, expires_at: row.expires_at };
}

async function handleStoreMemory(pool, vectr, payload) {
  const { content, entity, created_by = 'agent', source_sessions, metadata = {} } = payload;
  if (!content || !entity) return { error: 'content and entity required' };

  const embedding = await vectr.embed(content);

  const result = await pool.query(`
    INSERT INTO knowledge_blocks (lifecycle, content, entity, created_by, source_sessions, metadata, embedding)
    VALUES ('memory', $1, $2, $3, $4, $5, $6)
    RETURNING id, lifecycle, entity, created_at
  `, [content, entity, created_by, source_sessions || null, JSON.stringify(metadata), embedding ? JSON.stringify(embedding) : null]);

  const row = result.rows[0];
  return { event_type: 'store_response', id: row.id, lifecycle: row.lifecycle, entity: row.entity, embedded: embedding !== null, created_at: row.created_at };
}

async function handleQueryContext(pool, payload) {
  const filters = payload.filters || payload.data || {};
  const { keywords, session_id, limit = 20 } = filters;

  let query = 'SELECT * FROM v_context WHERE 1=1';
  const params = [];
  let idx = 1;

  if (keywords) { query += ` AND content ILIKE $${idx}`; params.push(`%${keywords}%`); idx++; }
  if (session_id) { query += ` AND session_id = $${idx}`; params.push(session_id); idx++; }
  query += ` ORDER BY created_at DESC LIMIT $${idx}`;
  params.push(parseInt(limit));

  const result = await pool.query(query, params);
  return { event_type: 'query_response', count: result.rows.length, blocks: result.rows };
}

async function handleQueryMemory(pool, payload) {
  const filters = payload.filters || payload.data || {};
  const { entity, keywords, limit = 20 } = filters;

  let query = 'SELECT * FROM v_memory WHERE 1=1';
  const params = [];
  let idx = 1;

  if (entity) { query += ` AND entity = $${idx}`; params.push(entity); idx++; }
  if (keywords) { query += ` AND content ILIKE $${idx}`; params.push(`%${keywords}%`); idx++; }
  query += ` ORDER BY created_at DESC LIMIT $${idx}`;
  params.push(parseInt(limit));

  const result = await pool.query(query, params);
  return { event_type: 'query_response', count: result.rows.length, blocks: result.rows };
}

async function handlePromote(pool, payload) {
  const { block_id, entity } = payload;
  if (!block_id || !entity) return { error: 'block_id and entity required' };

  const result = await pool.query(`
    UPDATE knowledge_blocks SET lifecycle = 'memory', entity = $2, promoted_at = NOW(), expires_at = NULL
    WHERE id = $1 AND lifecycle = 'context' RETURNING id, entity, promoted_at
  `, [block_id, entity]);

  if (result.rows.length === 0) return { status: 'not_found', error: 'Block not found or already promoted' };
  const row = result.rows[0];
  return { event_type: 'promote_response', status: 'promoted', id: row.id, entity: row.entity, promoted_at: row.promoted_at };
}

async function handleMerge(pool, vectr, payload) {
  const { source_ids, merged_content, entity, metadata = {} } = payload;
  if (!source_ids?.length || !merged_content || !entity) return { error: 'source_ids, merged_content, and entity required' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const verify = await client.query('SELECT id FROM knowledge_blocks WHERE id = ANY($1) AND lifecycle = \'memory\'', [source_ids]);
    const foundIds = verify.rows.map(r => r.id);
    const missing = source_ids.filter(id => !foundIds.includes(id));
    if (missing.length > 0) { await client.query('ROLLBACK'); return { error: 'MEMORY_MERGE_CONFLICT', missing_ids: missing }; }

    const embedding = await vectr.embed(merged_content);
    const mergedMeta = { ...metadata, consolidated_from: source_ids };
    const ins = await client.query(`
      INSERT INTO knowledge_blocks (lifecycle, content, entity, created_by, metadata, embedding)
      VALUES ('memory', $1, $2, 'dreamer', $3, $4) RETURNING id, created_at
    `, [merged_content, entity, JSON.stringify(mergedMeta), embedding ? JSON.stringify(embedding) : null]);

    await client.query('DELETE FROM knowledge_blocks WHERE id = ANY($1)', [source_ids]);
    await client.query('COMMIT');

    const row = ins.rows[0];
    return { event_type: 'merge_response', status: 'merged', new_id: row.id, deleted_count: source_ids.length, entity, embedded: embedding !== null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function handleDreamTrigger(triggerDream, payload) {
  if (triggerDream) {
    const phase = payload.phase || 'full';
    const result = await triggerDream(phase);
    return { event_type: 'dream_response', ...result };
  }
  return { event_type: 'dream_response', status: 'dream_disabled' };
}

async function handleStats(pool) {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE lifecycle = 'context') AS context_total,
      COUNT(*) FILTER (WHERE lifecycle = 'memory') AS memory_total,
      COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding,
      COUNT(*) AS total
    FROM knowledge_blocks
  `);
  const row = result.rows[0];
  return {
    event_type: 'stats_response',
    context_total: parseInt(row.context_total),
    memory_total: parseInt(row.memory_total),
    embedding_coverage_pct: parseInt(row.total) > 0
      ? Math.round((parseInt(row.with_embedding) / parseInt(row.total)) * 100)
      : 100,
  };
}
