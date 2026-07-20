// ============================================================
// Error Utilities — re-exported from shared http-client
// ============================================================
// All HTTP client code has been consolidated into ./http-client
const { tryParseError, apiGet } = require('./http-client');
module.exports = { tryParseError, apiGet };
