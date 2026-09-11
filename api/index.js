/**
 * EstateFlow API — Vercel serverless entry.
 *
 * Uses the Express app in ./_app.js (same file the Netlify Function
 * re-exports), kept inside api/ with underscore-prefixed names so it is
 * bundled with this function and never exposed as its own route.
 * `bodyParser: false` keeps the raw request bytes available for the
 * Stripe webhook signature check (the app's first middleware parses
 * JSON from them and keeps req.rawBody).
 */
const { app } = require("./_app");

module.exports.config = { api: { bodyParser: false } };

module.exports = (req, res) => {
  const run = () => {
    let raw = req.body;
    if (raw !== undefined && raw !== null && !Buffer.isBuffer(raw)) {
      // The platform pre-parsed the body (object) or handed us text:
      // normalize back to bytes for the app's middleware.
      try {
        raw = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(JSON.stringify(raw));
      } catch {
        raw = Buffer.alloc(0);
      }
    }
    if (!Buffer.isBuffer(raw)) raw = Buffer.alloc(0);
    // vercel.json rewrites /api/:path* here; strip the mount prefix so
    // Express sees the same paths as on Netlify (/create-plan-checkout…).
    if (typeof req.url === "string") {
      if (req.url === "/api") req.url = "/";
      else if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
    }
    req.body = raw;
    app(req, res);
  };

  // If the platform already finished/pre-parsed the body, run immediately —
  // waiting for stream events that will never fire leaves POSTs hanging.
  // Otherwise (normal in-flight body, or bodiless GET/OPTIONS) collect it.
  const preParsed = req.body !== undefined && req.body !== null;
  const alreadyEnded = req.readableEnded === true || req.complete === true;
  if (preParsed || alreadyEnded) {
    run();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    req.body = Buffer.concat(chunks);
    run();
  });
  req.on("error", () => {
    res.statusCode = 400;
    res.end("Bad request");
  });
};
