/**
 * Provalta API — Vercel serverless entry.
 *
 * Uses the Express app in ./_app.js (same file the Netlify Function
 * re-exports), kept inside api/ with underscore-prefixed names so it is
 * bundled with this function and never exposed as its own route.
 * `bodyParser: false` keeps the raw request bytes available for the
 * Stripe webhook signature check (the app's first middleware parses
 * JSON from them and keeps req.rawBody).
 */
const { app } = require("./_app");

async function readRawBody(req) {
  // With bodyParser disabled the platform hands us the untouched stream —
  // collect it byte-for-byte (Stripe signature needs exact bytes).
  if (Buffer.isBuffer(req.body) && req.body.length > 0) return req.body;
  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on("data", (c) => chunks.push(c));
    req.on("end", resolve);
    req.on("error", reject);
  });
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  try {
    req.body = await readRawBody(req);
  } catch {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }
  // vercel.json rewrites /api/:path* here; strip the mount prefix so
  // Express sees the same paths as on Netlify (/create-plan-checkout…).
  if (typeof req.url === "string") {
    if (req.url === "/api") req.url = "/";
    else if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
  }
  app(req, res);
};

// NOTE: assigned AFTER module.exports — assigning the function first and the
// config second is what keeps both. Reversing this silently drops bodyParser
// disabling, Vercel pre-parses JSON bodies, and Stripe webhook signatures
// fail with "No signatures found matching..." (400s in event deliveries).
module.exports.config = { api: { bodyParser: false } };
