// @ts-check
// ============================================================
// Safe Storage — unified localStorage wrapper with error handling
//
// Replaces ad-hoc try/catch { /* ignore */ } patterns throughout
// the codebase with a consistent, logged approach.
//
// Usage:
//   import { safeStorage } from './lib/storage.js';
//   const val = safeStorage.get('my-key', 'default');
//   safeStorage.set('my-key', 'value');
// ============================================================

const MODULE = '[Storage]';

/**
 * Unified safe localStorage wrapper.
 * All methods silently handle errors (e.g. private browsing, quota exceeded)
 * with optional console.warn logging.
 */
export const safeStorage = {
  /**
   * Get an item from localStorage with a fallback.
   * @param {string} key
   * @param {*} [fallback=null]
   * @returns {string|null}
   */
  get(key, fallback = null) {
    try {
      const val = localStorage.getItem(key);
      return val !== null ? val : fallback;
    } catch (e) {
      console.warn(MODULE, `get("${key}") failed:`, e?.message);
      return fallback;
    }
  },

  /**
   * Set an item in localStorage.
   * @param {string} key
   * @param {*} value — will be converted to String
   * @returns {boolean} true on success
   */
  set(key, value) {
    try {
      localStorage.setItem(key, String(value));
      return true;
    } catch (e) {
      console.warn(MODULE, `set("${key}") failed:`, e?.message);
      return false;
    }
  },

  /**
   * Remove an item from localStorage.
   * @param {string} key
   * @returns {boolean} true on success
   */
  remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.warn(MODULE, `remove("${key}") failed:`, e?.message);
      return false;
    }
  },

  /**
   * Get and parse JSON from localStorage.
   * @param {string} key
   * @param {*} [fallback=null]
   * @returns {*}
   */
  getJSON(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn(MODULE, `getJSON("${key}") failed:`, e?.message);
      return fallback;
    }
  },

  /**
   * Store a JSON-serializable value in localStorage.
   * @param {string} key
   * @param {*} value — must be JSON-serializable
   * @returns {boolean} true on success
   */
  setJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn(MODULE, `setJSON("${key}") failed:`, e?.message);
      return false;
    }
  },

  /**
   * Get all keys that start with a given prefix.
   * @param {string} [prefix='']
   * @returns {string[]}
   */
  keys(prefix = '') {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (!prefix || k.startsWith(prefix))) {
          keys.push(k);
        }
      }
      return keys;
    } catch (e) {
      console.warn(MODULE, `keys("${prefix}") failed:`, e?.message);
      return [];
    }
  },
};

// Legacy global export for non-ESM code.
// Guarded so this module can be imported in non-browser contexts (e.g. Node
// unit tests) without throwing "window is not defined".
if (typeof window !== 'undefined') {
  const Q = /** @type {import('../types').QCLI} */ (window.QCLI = window.QCLI || {});
  Q.safeStorage = safeStorage;
}
