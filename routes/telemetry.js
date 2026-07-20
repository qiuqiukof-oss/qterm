// ============================================================
// Telemetry API (C1) — status, opt-in toggle, local snapshot
// Mounted at /api/telemetry
// ============================================================
const express = require('express');
const telemetry = require('../lib/telemetry');
const session = require('../lib/auth/session');

function createRouter() {
  const router = express.Router();

  // GET /api/telemetry — current status + aggregate snapshot (admin)
  router.get('/', session.requireAuth, session.requireRole('metrics:read'), (req, res) => {
    res.json({ enabled: telemetry.isEnabled(), snapshot: telemetry.snapshot() });
  });

  // POST /api/telemetry/enable
  router.post('/enable', session.requireAuth, session.requireRole('admin:all'), (req, res) => {
    const on = telemetry.setEnabled(true);
    res.json({ enabled: on });
  });

  // POST /api/telemetry/disable
  router.post('/disable', session.requireAuth, session.requireRole('admin:all'), (req, res) => {
    const off = telemetry.setEnabled(false);
    res.json({ enabled: off });
  });

  return router;
}

module.exports = { createRouter };
