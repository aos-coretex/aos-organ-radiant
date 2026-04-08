/**
 * Vectr HTTP client for embedding generation.
 *
 * Graceful degradation: if Vectr is unreachable (5s timeout),
 * returns null instead of throwing. The caller stores the block
 * without an embedding and logs EMBEDDING_UNAVAILABLE.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * @param {string} vectrUrl - e.g. "http://127.0.0.1:3901"
 * @param {number} timeoutMs - request timeout (default 5000)
 */
export function createVectrClient(vectrUrl, timeoutMs = 5000) {
  /**
   * Generate a 384-dimensional embedding for the given text.
   * Text is truncated to 8192 characters before embedding.
   *
   * @param {string} text
   * @returns {Promise<number[]|null>} - embedding vector or null if unavailable
   */
  async function embed(text) {
    const truncated = text.slice(0, 8192);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(`${vectrUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: truncated }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        log('vectr_error', { status: res.status, url: vectrUrl });
        return null;
      }

      const data = await res.json();
      const embedding = data.embedding || data.vector;

      if (!embedding || !Array.isArray(embedding)) {
        log('vectr_invalid_response', { url: vectrUrl });
        return null;
      }

      if (embedding.length !== 384) {
        log('vectr_dimension_mismatch', {
          expected: 384,
          received: embedding.length,
          url: vectrUrl,
        });
        return null;
      }

      return embedding;
    } catch (err) {
      log('vectr_unavailable', {
        error: err.name === 'AbortError' ? 'timeout' : err.message,
        url: vectrUrl,
      });
      return null;
    }
  }

  /**
   * Check if Vectr is reachable.
   */
  async function isAvailable() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${vectrUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  return { embed, isAvailable };
}
