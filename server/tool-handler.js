/**
 * Radiant organ tool_call_request handler — MP-TOOL-1 relay t8r-3.
 *
 * D1: composes over factory default (universal fallback → NOT_IMPLEMENTED).
 * D4: method lookup from the per-organ slice of tool-declarations.json.
 * D5: fail-fast at construction — missing methods throw, never at runtime.
 * D7: no Spine OTM inside tool methods.
 *
 * Same shape as Graph's `server/tool-handler.js` — the `ORGAN_NAME` constant
 * and the `createToolMethods(deps)` import are the only deltas. Methods are
 * async (pool + vectr are both async).
 */

import { readFileSync } from 'node:fs';
import {
  success,
  toolNotFound,
  toolError,
  toolTimeout,
  organDegraded,
} from '@coretex/organ-boot/tool-errors';
import { createToolMethods } from './tool-methods.js';

const DEFAULT_DECLARATIONS_PATH = '/Library/AI/AI-AOS/AOS-organ-dev/AOS-organ-mcp-router/AOS-organ-mcp-router-src/config/tool-declarations.json';
const DEFAULT_TIMEOUT_MS = 25000;
const ORGAN_NAME = 'radiant';

/**
 * Mirror of health.js::createHealthRouter derivation. Kept inline rather than
 * imported from shared-lib — R2 flagged this for possible promotion to
 * shared-lib once R3/R4/R5/R6 all need it.
 */
function deriveHealthStatus(checks) {
  if (!checks || typeof checks !== 'object') return 'ok';
  const values = Object.values(checks);
  if (values.some(v => v === 'down' || v === 'error')) return 'down';
  if (values.some(v => v === 'degraded' || v === 'warning')) return 'degraded';
  return 'ok';
}

/**
 * @param {object} deps
 * @param {object} deps.pool          — pg Pool
 * @param {object} deps.vectr         — Vectr client
 * @param {function} [deps.getDreamState] — () => dream state object (for dream_stats)
 * @param {object} [options]
 * @param {function} [options.healthCheck]       — async () => flat checks object
 * @param {string}   [options.declarationsPath]
 * @param {object}   [options.declarations]      — pre-parsed override for tests
 * @returns {function(object): Promise<object>}
 */
export function createToolHandler(deps, options = {}) {
  const {
    healthCheck,
    declarationsPath = DEFAULT_DECLARATIONS_PATH,
    declarations: providedDeclarations,
  } = options;

  const declarations = providedDeclarations
    ?? JSON.parse(readFileSync(declarationsPath, 'utf-8'));

  const organEntry = declarations.organs?.[ORGAN_NAME];
  if (!organEntry) {
    throw new Error(`tool-declarations.json has no entry for organ "${ORGAN_NAME}"`);
  }

  const methods = createToolMethods(deps);

  // D5 fail-fast: every declared tool has an implementation method.
  const map = new Map();
  for (const [action, decl] of Object.entries(organEntry.tools)) {
    const toolName = `${ORGAN_NAME}__${action}`;
    const method = methods[decl.method];
    if (typeof method !== 'function') {
      throw new Error(
        `${toolName}: declared method '${decl.method}' is not implemented on Radiant tool-methods`
      );
    }
    map.set(toolName, {
      method,
      timeout_ms: decl.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    });
  }

  return async function handleToolCallRequest(envelope) {
    const tool = envelope?.payload?.tool;
    const params = envelope?.payload?.params ?? {};

    // 1. Health gate — fail-closed on degraded
    if (typeof healthCheck === 'function') {
      let status = 'ok';
      try {
        const checks = await healthCheck();
        status = deriveHealthStatus(checks);
      } catch {
        status = 'down';
      }
      if (status !== 'ok') {
        return organDegraded(tool ?? 'unknown', status);
      }
    }

    // 2. Tool lookup
    const entry = typeof tool === 'string' ? map.get(tool) : undefined;
    if (!entry) {
      return toolNotFound(tool ?? 'unknown', ORGAN_NAME);
    }

    // 3. Dispatch with per-tool timeout
    const start = Date.now();
    let timer;
    try {
      const data = await Promise.race([
        Promise.resolve().then(() => entry.method(params)),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`tool ${tool} exceeded ${entry.timeout_ms}ms`);
            err._timeout = true;
            reject(err);
          }, entry.timeout_ms);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      return success(tool, data);
    } catch (err) {
      const elapsed = Date.now() - start;
      if (err && err._timeout) {
        return toolTimeout(tool, elapsed, entry.timeout_ms);
      }
      const code = (err && err.code) || 'internal_error';
      const message = (err && err.message) || String(err);
      const meta = {};
      if (err && err.missing_ids) meta.missing_ids = err.missing_ids;
      return Object.keys(meta).length
        ? toolError(tool, code, message, meta)
        : toolError(tool, code, message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
