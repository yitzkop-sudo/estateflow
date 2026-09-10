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
  // Vercel gives us the raw stream when bodyParser is off — collect it
  // into the Buffer shape the app's middleware expects (same as
  // serverless-http provides on Netlify).
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    // vercel.json rewrites /api/:path* here; strip the mount prefix so
    // Express sees the same paths as on Netlify (/create-plan-checkout…).
    if (typeof req.url === "string") {
      if (req.url === "/api") req.url = "/";
      else if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
    }
    req.body = Buffer.concat(chunks);
    app(req, res);
  });
  req.on("error", () => {
    res.statusCode = 400;
    res.end("Bad request");
  });
};
