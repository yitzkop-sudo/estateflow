/**
 * Netlify Function entry (rollback hosting path).
 *
 * The Express app lives in api/_app.js (underscore-prefixed so Vercel does
 * not expose it as a route) so the Vercel serverless function is
 * self-contained. This file just re-exports it; Netlify's bundler follows
 * the require and includes api/_app.js + api/_shared/utilityapi.js.
 */
module.exports = require("../../api/_app");
