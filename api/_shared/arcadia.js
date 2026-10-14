/**
 * Arcadia Plug API client — NJ auto-sync engine (server-side only).
 *
 * UtilityAPI's network covers ~17 utilities and nothing in NJ, so NJ
 * providers (PSE&G, JCP&L, ACE, RECO, ETG, NJNG, SJG) sync through Arcadia
 * Plug instead: credential connect (Arcadia Connect) → 12-24mo historical
 * statements → ongoing monthly extraction → webhooks on new statements.
 *
 * Docs: https://docs.arcadia.com (Plug API, Arcadia-Version 2024-02-21).
 * Auth: OAuth2 client_credentials → Bearer access token (valid ~2h).
 * Env (Vercel Dashboard → project → Settings → Environment Variables):
 *   ARCADIA_CLIENT_ID / ARCADIA_CLIENT_SECRET  (Dashboard → API keys)
 *   ARCADIA_ENV=sandbox|live                   (default sandbox)
 *   ARCADIA_CONNECT_URL                          (Dashboard → Connect Configuration)
 *   ARCADIA_METER_PRICE_ID=price_...            (Stripe flat recurring price, NJ)
 *   ARCADIA_COST_CENTS=1200                    (assumed Arcadia cost/meter/mo)
 *   ARCADIA_MIN_MARGIN_CENTS=500                (profit floor, default $5)
 *   ARCADIA_WEBHOOK_SECRET                     (optional webhook verification)
 *   ARCADIA_PROVIDER_NJ_PSEG=prv_...            (optional explicit provider IDs;
 *     NJ_JCPL, NJ_ACE, NJ_RECO, NJ_ETG, NJ_NJNG, NJ_SJG — otherwise resolved
 *     by name search against GET /plug/providers)
 */

const ARCADIA_API_VERSION = "2024-02-21";

/** Typed error the Express layer converts into an HTTP response. */
class ArcadiaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cfg() {
  return {
    clientId: (process.env.ARCADIA_CLIENT_ID || "").trim(),
    clientSecret: (process.env.ARCADIA_CLIENT_SECRET || "").trim(),
    env: String(process.env.ARCADIA_ENV || "sandbox").trim().toLowerCase() === "live" ? "live" : "sandbox",
    connectUrl: (process.env.ARCADIA_CONNECT_URL || "").trim(),
    meterPriceId: (process.env.ARCADIA_METER_PRICE_ID || "").trim(),
    costCents: Number.parseInt(process.env.ARCADIA_COST_CENTS || "1200", 10),
    minMarginCents: Number.parseInt(process.env.ARCADIA_MIN_MARGIN_CENTS || "500", 10),
    webhookSecret: (process.env.ARCADIA_WEBHOOK_SECRET || "").trim(),
  };
}

function configured() {
  const c = cfg();
  return !!(c.clientId && c.clientSecret);
}

function assertConfigured() {
  if (!configured()) {
    throw new ArcadiaError(
      500,
      "Arcadia (NJ auto-sync) is not configured. Add ARCADIA_CLIENT_ID + ARCADIA_CLIENT_SECRET in Vercel env vars and redeploy. NJ providers fall back to manual bill entry until then."
    );
  }
}

function baseUrl() {
  return cfg().env === "live" ? "https://api.arcadia.com" : "https://sandbox.api.arcadia.com";
}

// ─── Auth (cached access token) ──────────────────────────────────────────────
let tokenCache = { token: null, exp: 0 };

async function accessToken() {
  assertConfigured();
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const c = cfg();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: c.clientId,
    client_secret: c.clientSecret,
  });
  const res = await fetch(`${baseUrl()}/oauth2/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new ArcadiaError(502, `Arcadia auth failed (${res.status}): ${t.slice(0, 120)}`);
  }
  const data = await res.json();
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

async function arc(method, path, body) {
  const token = await accessToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "Arcadia-Version": ARCADIA_API_VERSION,
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    // Token may have expired early — drop cache once and retry.
    tokenCache = { token: null, exp: 0 };
    const retry = await accessToken();
    const res2 = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "Arcadia-Version": ARCADIA_API_VERSION,
        authorization: `Bearer ${retry}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res2.ok) {
      const t = await res2.text().catch(() => "");
      throw new ArcadiaError(502, `Arcadia error (${res2.status}): ${t.slice(0, 160)}`);
    }
    return res2.json();
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new ArcadiaError(502, `Arcadia error (${res.status}): ${t.slice(0, 160)}`);
  }
  return res.json();
}

// ─── Pricing (profit guaranteed) ─────────────────────────────────────────────
// The NJ meter price must clear (assumed Arcadia cost + minimum margin).
// Checkout refuses to start otherwise, so a misconfigured price can never
// sell NJ auto-sync at a loss. UtilityAPI's $20/mo path is untouched.
async function getPricing(stripe) {
  const c = cfg();
  if (!/^price_[A-Za-z0-9]+$/.test(c.meterPriceId)) {
    throw new ArcadiaError(
      500,
      "NJ auto-sync billing is misconfigured. ARCADIA_METER_PRICE_ID must be a Stripe price ID like price_... . Fix it in env vars and redeploy."
    );
  }
  const price = await stripe.prices.retrieve(c.meterPriceId);
  const priceCents = price.unit_amount || 0;
  const costCents = Number.isFinite(c.costCents) && c.costCents >= 0 ? c.costCents : 1200;
  const minMarginCents = Number.isFinite(c.minMarginCents) && c.minMarginCents >= 0 ? c.minMarginCents : 500;
  const marginCents = priceCents - costCents;
  if (marginCents < minMarginCents) {
    throw new ArcadiaError(
      500,
      `NJ auto-sync price ($${(priceCents / 100).toFixed(2)}/mo) does not clear cost ($${(costCents / 100).toFixed(2)}) + margin ($${(minMarginCents / 100).toFixed(2)}). Raise the ARCADIA_METER_PRICE_ID amount in Stripe.`
    );
  }
  return {
    priceId: c.meterPriceId,
    priceCents,
    priceDollars: (priceCents / 100).toFixed(2),
    costCents,
    marginCents,
    currency: price.currency || "usd",
    engine: "arcadia",
  };
}

// ─── Providers ───────────────────────────────────────────────────────────────
let providersCache = { at: 0, data: null };

// Env-override keys per NJ directory uid, e.g. NJ-PSEG → ARCADIA_PROVIDER_NJ_PSEG.
function envProviderId(njUid) {
  const key = `ARCADIA_PROVIDER_${String(njUid || "").replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  return (process.env[key] || "").trim() || null;
}

// Name keywords for live search fallback (GET /plug/providers).
const NJ_PROVIDER_KEYWORDS = {
  "NJ-PSEG": ["public service electric", "pse&g", "pseg"],
  "NJ-JCPL": ["jersey central", "jcp&l", "firstenergy", "first energy"],
  "NJ-ACE": ["atlantic city electric"],
  "NJ-RECO": ["rockland electric"],
  "NJ-ETG": ["elizabethtown gas"],
  "NJ-NJNG": ["new jersey natural gas", "njng"],
  "NJ-SJG": ["south jersey gas"],
};

async function listProviders() {
  assertConfigured();
  if (Date.now() - providersCache.at < 3600000 && providersCache.data) return providersCache.data;
  const data = await arc("GET", "/plug/providers?page=0&size=200");
  const list = data.providers || data.content || data || [];
  providersCache = { at: Date.now(), data: Array.isArray(list) ? list : [] };
  return providersCache.data;
}

/** Resolve an NJ directory uid (NJ-PSEG…) to an Arcadia providerId. */
async function resolveNjProviderId(njUid) {
  assertConfigured();
  const override = envProviderId(njUid);
  if (override) return override;
  const keywords = NJ_PROVIDER_KEYWORDS[String(njUid || "").toUpperCase()] || [];
  const providers = await listProviders();
  const norm = (s) => String(s || "").toLowerCase();
  for (const kw of keywords) {
    const hit = providers.find((p) => norm(p.name || p.providerName).includes(kw));
    if (hit && (hit.id || hit.providerId)) return hit.id || hit.providerId;
  }
  throw new ArcadiaError(
    404,
    `No Arcadia provider mapped for ${njUid} yet. Set ARCADIA_PROVIDER_${String(njUid || "").replace(/[^A-Za-z0-9]/g, "_").toUpperCase()} in env vars (see GET /arcadia-providers), or contact support.`
  );
}

// ─── Connect (credential handoff) ────────────────────────────────────────────
// MVP flow mirrors UtilityAPI's: server mints a correlationId, the app opens
// the Arcadia Connect URL in a browser where the user picks their NJ utility
// and signs in, then the app polls credential status and links statements.
function newCorrelationId(uid) {
  return `estf_${uid}_${Date.now().toString(36)}`;
}

async function createConnect(correlationId) {
  assertConfigured();
  const c = cfg();
  if (!c.connectUrl) {
    throw new ArcadiaError(
      500,
      "ARCADIA_CONNECT_URL is not set. Copy it from the Arcadia Dashboard → Connect Configuration into env vars."
    );
  }
  const sep = c.connectUrl.includes("?") ? "&" : "?";
  return {
    correlationId,
    url: `${c.connectUrl}${sep}correlationId=${encodeURIComponent(correlationId)}`,
  };
}

/** Submit credentials server-side (alternative to the Connect widget). */
async function createCredential({ providerId, username, password, correlationId }) {
  assertConfigured();
  if (!providerId || !username || !password) {
    throw new ArcadiaError(400, "Missing providerId, username or password.");
  }
  return arc("POST", "/plug/credentials", {
    providerId,
    username,
    password,
    ...(correlationId ? { correlationId } : {}),
  });
}

async function credentialStatus(credentialId) {
  assertConfigured();
  if (!credentialId) throw new ArcadiaError(400, "Missing credentialId.");
  const cred = await arc("GET", `/plug/credentials/${encodeURIComponent(credentialId)}`);
  const status = String(cred.status || "").toUpperCase();
  const done = status.includes("SUCCESS") || (cred.totalAccounts || 0) > 0;
  return {
    completed: done,
    status: cred.status || null,
    statusDetail: cred.statusDetail || null,
    totalAccounts: cred.totalAccounts || 0,
    credentialId: cred.id || credentialId,
  };
}

/** Has any credential finished connecting for this correlationId? */
async function checkConnectStatus(correlationId) {
  assertConfigured();
  const data = await arc("GET", `/plug/credentials?search=correlationIds%3D%3D${encodeURIComponent(correlationId)}&page=0&size=20`);
  const list = data.credentials || data.content || [];
  const creds = Array.isArray(list) ? list : [];
  const connected = creds.find((c) => {
    const s = String(c.status || "").toUpperCase();
    return s.includes("SUCCESS") || (c.totalAccounts || 0) > 0;
  });
  return {
    completed: !!connected,
    credentialId: connected ? connected.id : null,
    status: connected ? connected.status : creds[0]?.status || null,
    credentialCount: creds.length,
  };
}

// ─── Statements → normalized bill ────────────────────────────────────────────
function num(...candidates) {
  for (const v of candidates) {
    const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function statementAmount(st) {
  // Plug statement shapes vary by provider; probe the common total fields.
  // Field order = most-authoritative first. Logs carry the raw keys on miss.
  return num(
    st.totalCost,
    st.totalAmount,
    st.total_amount,
    st.amountDue,
    st.amount_due,
    st.balance,
    st.currentCharges,
    st.current_charges,
    st.billTotal,
    st.bill_total
  );
}

function statementDueDay(st, fallback = 15) {
  const raw = st.dueDate || st.due_date || st.billDueDate || st.bill_due_date || st.periodEndDate || st.period_end_date;
  if (raw) {
    const d = new Date(raw).getDate();
    if (Number.isInteger(d) && d >= 1 && d <= 31) return d;
  }
  return fallback;
}

function statementProvider(st) {
  return st.providerName || st.provider?.name || st.utilityName || "NJ utility (Arcadia)";
}

function statementExternalId(st) {
  return String(st.accountId || st.account_id || st.credentialId || st.credential_id || st.id || "");
}

async function fetchStatements({ correlationId, accountId, size = 10 }) {
  assertConfigured();
  const search = accountId
    ? `accountIds%3D%3D${encodeURIComponent(accountId)}`
    : `correlationIds%3D%3D${encodeURIComponent(correlationId)}`;
  const data = await arc("GET", `/plug/statements?search=${search}&page=0&size=${size}`);
  const list = data.statements || data.content || [];
  return Array.isArray(list) ? list : [];
}

function normalizeStatement(st) {
  const amount = statementAmount(st);
  if (amount === null) {
    console.warn("Arcadia statement without readable total; keys:", Object.keys(st || {}).join(","));
    throw new ArcadiaError(404, "Arcadia returned a statement without a readable bill total.");
  }
  const externalId = statementExternalId(st);
  if (!externalId) throw new ArcadiaError(404, "Arcadia statement has no account reference.");
  return {
    amount: amount.toFixed(2),
    provider: statementProvider(st),
    dueDay: statementDueDay(st),
    externalId,
  };
}

/** Latest bill for a just-connected correlationId (link step). */
async function latestBill({ correlationId }) {
  const statements = await fetchStatements({ correlationId, size: 10 });
  if (!statements.length) throw new ArcadiaError(404, "No Arcadia statements yet — credential may still be extracting. Try again in a bit.");
  const sorted = [...statements].sort((a, b) => {
    const da = new Date(a.periodEndDate || a.statementDate || a.createdAt || 0).getTime() || 0;
    const db = new Date(b.periodEndDate || b.statementDate || b.createdAt || 0).getTime() || 0;
    return db - da;
  });
  return normalizeStatement(sorted[0]);
}

/** Latest bill for an already-linked Arcadia meter (refresh / webhook). */
async function refreshBill(externalId) {
  const statements = await fetchStatements({ accountId: externalId, size: 5 });
  if (!statements.length) {
    // Fall back to correlation search (externalId may be a credential id).
    const byCorr = await fetchStatements({ correlationId: externalId, size: 5 });
    if (!byCorr.length) throw new ArcadiaError(404, "No Arcadia statements yet for this meter. Try again in a bit.");
    return normalizeStatement(byCorr[0]);
  }
  return normalizeStatement(statements[0]);
}

module.exports = {
  ArcadiaError,
  configured,
  assertConfigured,
  getPricing,
  listProviders,
  resolveNjProviderId,
  newCorrelationId,
  createConnect,
  createCredential,
  credentialStatus,
  checkConnectStatus,
  latestBill,
  refreshBill,
  NJ_PROVIDER_KEYWORDS,
};
