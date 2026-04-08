/**
 * Test helpers — mock pg Pool and mock Vectr client.
 */

/**
 * Create a mock pg Pool that returns preset results.
 * @param {object} queryMap - map of SQL pattern → { rows: [...] }
 */
export function createMockPool(queryMap = {}) {
  const queries = [];
  let defaultResult = { rows: [] };

  function findResult(sql) {
    for (const [pattern, result] of Object.entries(queryMap)) {
      if (sql.includes(pattern)) return result;
    }
    return defaultResult;
  }

  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return findResult(sql);
    },
    connect: async () => {
      let released = false;
      return {
        query: async (sql, params) => {
          queries.push({ sql, params });
          return findResult(sql);
        },
        release: () => { released = true; },
        isReleased: () => released,
      };
    },
    end: async () => {},
    getQueries: () => queries,
    setDefault: (result) => { defaultResult = result; },
  };

  return pool;
}

/**
 * Create a mock Vectr client.
 * @param {number[]|null} embedding - preset embedding to return
 */
export function createMockVectr(embedding = null) {
  let embedCalls = 0;

  return {
    embed: async (text) => {
      embedCalls++;
      return embedding;
    },
    isAvailable: async () => embedding !== null,
    getEmbedCalls: () => embedCalls,
  };
}

/**
 * Create a 384-dim fake embedding for tests.
 */
export function fakeEmbedding() {
  return Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1));
}
