// @ts-check
// ============================================================
// Access Auth — optional, configurable access token for HTTP + WebSocket
//
// Design goals:
// - Default (QCLI_ACCESS_TOKEN unset): fully open (dev/local mode). This mirrors
//   the existing MCP auth behavior (auth only enforced when a token is configured),
//   so existing localhost usage is never broken.
// - When QCLI_ACCESS_TOKEN is set:
//     * Loopback clients (127.0.0.1 / ::1 / localhost) are exempt by default
//       (the browser UI is served from the same machine). Set
//       QCLI_TOKEN_REQUIRE_LOOPBACK=1 to also require the token for loopback.
//     * Remote clients MUST present the token via
//         Authorization: Bearer <token>   (HTTP)
//         ?token=<token>                  (WebSocket / query)
//
// Mount `requireToken` on sensitive routers (browser/*, plugins, uploads).
// Call `wsAllowed(req)` inside the WebSocket connection handler.
// ============================================================
const TOKEN = process.env.QCLI_ACCESS_TOKEN || '';
const REQUIRE_LOOPBACK = process.env.QCLI_TOKEN_REQUIRE_LOOPBACK === '1';

/** Whether access-token enforcement is active. */
const isAuthEnabled = !!TOKEN;

/**
 * True if the address is a loopback address.
 * @param {string} addr
 * @returns {boolean}
 */
function isLoopbackAddr(addr) {
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr === 'localhost'
  );
}

/**
 * True if an Origin/Referer header points at a loopback host.
 * @param {string} [origin]
 * @returns {boolean}
 */
function isLoopbackOrigin(origin) {
  if (!origin) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(origin);
}

/**
 * Extract a bearer token from an Express request (header or query).
 * @param {import('express').Request} req
 * @returns {string}
 */
function extractToken(req) {
  const auth = req.headers && req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '');
  }
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return '';
}

/**
 * Express middleware. No-op when auth is disabled. Otherwise enforces the
 * token policy described above.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireToken(req, res, next) {
  if (!isAuthEnabled) return next();

  const ip = (req.ip || req.connection?.remoteAddress || '');
  const origin = req.headers?.origin || '';
  const referer = req.headers?.referer || '';
  if (!REQUIRE_LOOPBACK && (isLoopbackAddr(ip) || isLoopbackOrigin(origin) || isLoopbackOrigin(referer))) {
    return next();
  }

  const t = extractToken(req);
  if (t && t === TOKEN) return next();

  return res.status(401).json({
    error: 'Unauthorized: missing or invalid access token.',
    hint: 'Set QCLI_ACCESS_TOKEN on the server, then pass it via ' +
      'Authorization: Bearer <token> (HTTP) or ?token=<token> (WebSocket).',
  });
}

/**
 * WebSocket connection guard. Returns true if the connection is allowed.
 * @param {object} req — the upgrade request (has .socket / .connection / .url)
 * @returns {boolean}
 */
function wsAllowed(req) {
  if (!isAuthEnabled) return true;
  const ip = (req.socket?.remoteAddress || req.connection?.remoteAddress || '');
  if (!REQUIRE_LOOPBACK && isLoopbackAddr(ip)) return true;
  const url = req.url || '';
  const m = url.match(/[?&]token=([^&]+)/);
  const t = m ? decodeURIComponent(m[1]) : '';
  return t === TOKEN;
}

module.exports = { requireToken, wsAllowed, isAuthEnabled, isLoopbackAddr, isLoopbackOrigin };
