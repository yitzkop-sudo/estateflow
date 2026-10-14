/**
 * Provalta API — Netlify serverless version.
 *
 * Replaces the Firebase Cloud Functions (functions/index.js). Hosts the Stripe
 * + UtilityAPI logic on Netlify's free tier so Firebase stays on the Spark plan
 * (no Blaze, no card required for Auth/Firestore).
 *
 * The app/portal call these plain HTTP endpoints and send a Firebase ID token in
 * the `Authorization: Bearer <token>` header, which we verify with firebase-admin
 * — preserving the same security model the callable functions used (req.auth).
 *
 * Env vars (set in Netlify dashboard):
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 *   UTILITYAPI_TOKEN, UTILITY_PLAN_PRICE_ID, UTILITY_AUTO_METER_LIMIT,
 *   WEB_BASE_URL, PLATFORM_FEE_PERCENT
 */
const express = require("express");
const admin = require("firebase-admin");
const stripeFactory = require("stripe");
const { ApiError, utilityApi } = require("./_shared/utilityapi");
const arcadia = require("./_shared/arcadia");

// ─── Sync-engine routing ────────────────────────────────────────────────────
// UtilityAPI ($20/mo) covers its 17-utility network (incl. National Grid NY).
// Arcadia (higher NJ price, margin-guarded) covers NJ providers only.
// providerUid prefix NJ- (or explicit engine=arcadia) selects Arcadia.
function isNjProviderUid(providerUid) {
  return /^NJ-/i.test(String(providerUid || "").trim());
}

function engineForProvider(providerUid, explicit) {
  if (explicit === "arcadia" || isNjProviderUid(providerUid)) return "arcadia";
  return "utilityapi";
}

// Arcadia meterUids are stored as `arcadia:<externalId>` so refresh, gates
// and the webhook can route without extra lookups.
function isArcadiaMeterUid(meterUid) {
  return /^arcadia:/i.test(String(meterUid || "").trim());
}

function arcadiaExternalId(meterUid) {
  return String(meterUid || "").replace(/^arcadia:/i, "");
}

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccount) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceAccount)) });
} else {
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();

// ─── Configure helpers ────────────────────────────────────────────────────────
function stripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function webBaseUrl() {
  const base = (process.env.WEB_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new ApiError(500, "WEB_BASE_URL is not configured.");
  }
  if (!/^https:\/\/[^/\s]+\.[^/\s]+/i.test(base)) {
    throw new ApiError(
      500,
      `WEB_BASE_URL must be a public https:// URL (got: ${base.slice(0, 80)}). Fix it in env vars and redeploy.`
    );
  }
  return base;
}

function platformFeePercent() {
  const n = Number.parseFloat(process.env.PLATFORM_FEE_PERCENT || "0");
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 0;
}

const dollarsToCents = (v) => Math.round(Number(v || 0) * 100);

const normalizeName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

function assertTenantOwnership(tenant, token) {
  const email = String(token.email || "").trim().toLowerCase();
  const storedEmail = String(tenant.tenantEmail || "").trim().toLowerCase();
  const displayName = normalizeName(token.name);
  const emailPrefix = email.split("@")[0] ? normalizeName(email.split("@")[0]) : "";
  const tenantName = normalizeName(tenant.tenantName);

  if (storedEmail) {
    if (email && storedEmail === email) return;
    throw new ApiError(403, "This rental is linked to a different tenant account.");
  }
  if ((displayName && displayName === tenantName) || (emailPrefix && emailPrefix === tenantName)) return;
  throw new ApiError(403, "Could not verify that you are the tenant for this rental. Link your account first.");
}

async function getLandlordConnect(ownerId) {
  const snap = await db.collection("users").doc(ownerId).get();
  if (!snap.exists) return { exists: false };
  const data = snap.data() || {};
  return {
    exists: true,
    stripeAccountId: data.stripeAccountId || null,
    payoutsEnabled: !!data.stripePayoutsEnabled,
    chargesEnabled: !!data.stripeChargesEnabled,
  };
}

// ─── Utility auto-sync subscription helpers ───────────────────────────────────
function utilityPlanPriceId() {
  const id = process.env.UTILITY_PLAN_PRICE_ID || "";
  if (!id) {
    throw new ApiError(500, "Utility auto-sync plan is not configured. Add UTILITY_PLAN_PRICE_ID to Netlify env.");
  }
  return id;
}

// Billing is per utility: one $20/mo subscription per utility key (Electric,
// Water, …). A subscription tagged Electric never covers Water.
const UTILITY_KEYS = ["Electric", "Water", "Gas", "Oil", "Sewer", "Trash"];

function normalizeUtilityKey(key) {
  const k = String(key || "").trim();
  return UTILITY_KEYS.includes(k) ? k : null;
}

function subRecordActive(rec) {
  if (!rec || !rec.active) return false;
  const end = rec.currentPeriodEnd?.toDate?.() || rec.currentPeriodEnd || null;
  const endMs = end instanceof Date ? end.getTime() : typeof end === "number" ? end : null;
  return !(endMs && endMs < Date.now());
}

async function getUtilityEntitlement(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const ua = snap.exists ? snap.data()?.utilityAuto || {} : {};
  const subs = { ...(ua.subs || {}) };
  // No grandfathering: only explicit per-key subscriptions count. Old
  // single-subscription records (pre-launch tests) cover nothing — each
  // utility needs its own $20/mo subscription.
  const activeKeys = UTILITY_KEYS.filter((k) => subRecordActive(subs[k]));
  return {
    active: activeKeys.length > 0,
    activeKeys,
    subs,
    ua,
    stripeCustomerId: ua.stripeCustomerId || null,
  };
}

/** Is this utility key covered by its own active subscription? */
function keyCovered(ent, key) {
  if (!key || !UTILITY_KEYS.includes(key)) return false;
  return subRecordActive(ent.subs?.[key]);
}

function assertUtilityEntitlement(ent) {
  if (!ent.active) {
    throw new ApiError(
      403,
      "Auto utility sync requires a subscription for this utility ($20/month each). Connect it to continue, or enter utilities manually for free."
    );
  }
}

function assertUtilityEntitlementForKey(ent, key) {
  if (!keyCovered(ent, key)) {
    throw new ApiError(
      403,
      `This utility (${key || "unknown"}) needs its own $20/month subscription. Complete payment for it first, or enter utilities manually for free.`
    );
  }
}

function meterLimit() {
  const n = Number.parseInt(process.env.UTILITY_AUTO_METER_LIMIT || "10", 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/** Collect every linked meter uid on a utility: legacy single + meters[]. */
function eachLinkedMeterUid(u, cb) {
  if (!u || typeof u !== "object") return;
  if (u.meterUid) cb(String(u.meterUid));
  if (Array.isArray(u.meters)) {
    u.meters.forEach((m) => {
      if (m && m.meterUid) cb(String(m.meterUid));
    });
  }
}

async function countLinkedMeters(uid) {
  const snap = await db.collection("properties").where("ownerId", "==", uid).get();
  const seen = new Set();
  snap.docs.forEach((doc) => {
    const utilities = doc.data()?.utilities || {};
    Object.values(utilities).forEach((u) => {
      eachLinkedMeterUid(u, (id) => seen.add(id));
    });
  });
  return { count: seen.size, meterUids: seen };
}

function assertUnderMeterLimit(current, limit) {
  if (current >= limit) {
    throw new ApiError(
      409,
      `Your plan includes ${limit} linked meters and you've reached that limit. Remove a linked utility or contact support to add meter capacity. You can still enter utilities manually for free.`
    );
  }
}

async function createBillingPortal(stripe, customerId) {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${webBaseUrl()}/portal.html?portal=1`,
  });
  return session.url;
}

async function setUtilitySubscription(uid, stripeSub, utilityKeyHint) {
  if (!uid) return;
  const status = stripeSub.status;
  const active = status === "active" || status === "trialing";
  const periodEnd = stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000) : null;
  // Synthetic objects (healed dead subs) carry no metadata, so callers pass
  // the key explicitly — otherwise healing would write the legacy record and
  // leave the per-key ghost untouched.
  const key = normalizeUtilityKey(stripeSub.metadata?.utilityKey) || normalizeUtilityKey(utilityKeyHint);
  const record = {
    active,
    engine: stripeSub.metadata?.engine === "arcadia" ? "arcadia" : "utilityapi",
    providerUid: stripeSub.metadata?.providerUid || null,
    stripeSubId: stripeSub.id,
    stripeCustomerId: stripeSub.customer || null,
    stripePriceId: stripeSub.items?.data?.[0]?.price?.id || null,
    status: status || "unknown",
    currentPeriodEnd: periodEnd ? admin.firestore.Timestamp.fromDate(periodEnd) : null,
    cancelAtPeriodEnd: !!stripeSub.cancel_at_period_end,
    cancelAt: stripeSub.cancel_at
      ? admin.firestore.Timestamp.fromDate(new Date(stripeSub.cancel_at * 1000))
      : null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const usersRef = db.collection("users").doc(uid);
  const snap = await usersRef.get();
  const ua = snap.exists ? snap.data()?.utilityAuto || {} : {};
  const md = stripeSub.metadata || {};
  const msubs = { ...(ua.meterSubs || {}) };
  const pend = { ...(ua.pendingMeterSubs || {}) };

  // Per-meter checkout, meter already known (reconnect): write the meter record.
  if (md.newMeter && md.meterUid && key) {
    msubs[md.meterUid] = { utilityKey: key, ...record };
    if (Array.isArray(pend[key])) pend[key] = pend[key].filter((id) => id !== stripeSub.id);
    await usersRef.set({ utilityAuto: { meterSubs: msubs, pendingMeterSubs: pend } }, { merge: true });
    return;
  }
  // Per-meter checkout, meter not yet known: park as a pending claim for the
  // key. The key record is untouched so the first meter's coverage never moves.
  // Still propagate to an already-assigned meter record with the same sub id
  // (e.g. its cancel/delete events arriving later).
  if (md.newMeter && key) {
    const list = Array.isArray(pend[key]) ? pend[key].filter((id) => id !== stripeSub.id) : [];
    list.push(stripeSub.id);
    pend[key] = list;
    for (const [mUid, entry] of Object.entries(msubs)) {
      if (entry && entry.stripeSubId === stripeSub.id) msubs[mUid] = { ...(entry), ...record, utilityKey: entry.utilityKey || key };
    }
    await usersRef.set({ utilityAuto: { pendingMeterSubs: pend, meterSubs: msubs } }, { merge: true });
    return;
  }

  if (!key) {
    // Legacy subscription with no utility tag (old base plan): keep the
    // previous behavior — one record covering everything.
    await usersRef.set(
      {
        utilityAuto: {
          ...record,
          plan: "utility-auto",
        },
      },
      { merge: true }
    );
    return;
  }
  // Per-utility subscription: upsert this key's record, then recompute the
  // top-level flag from all keys (legacy record included).
  const subs = { ...(ua.subs || {}), [key]: record };
  const anyActive = UTILITY_KEYS.some((k) => subRecordActive(subs[k])) || (!!ua.active && !!ua.stripeSubId);
  // Propagate to meter records carrying the same subscription id.
  for (const [mUid, entry] of Object.entries(msubs)) {
    if (entry && entry.stripeSubId === stripeSub.id) msubs[mUid] = { ...(entry), ...record, utilityKey: entry.utilityKey || key };
  }
  await usersRef.set(
    {
      utilityAuto: {
        active: anyActive,
        plan: "utility-auto",
        stripeCustomerId: stripeSub.customer || ua.stripeCustomerId || null,
        subs,
        meterSubs: msubs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    },
    { merge: true }
  );
}

/**
 * Per-meter billing: attach a subscription to a linked meter.
 *
 * Order of preference: already assigned → oldest pending paid checkout for
 * the key → legacy adoption (key active, no meter assigned under it yet).
 * Throws 403 when nothing covers the meter (caller must complete checkout).
 * Returns the meter's subscription record.
 */
async function claimMeterSub(uid, key, meterUid) {
  const usersRef = db.collection("users").doc(uid);
  const snap = await usersRef.get();
  const ua = snap.exists ? snap.data()?.utilityAuto || {} : {};
  const msubs = { ...(ua.meterSubs || {}) };
  if (msubs[meterUid]) return msubs[meterUid];
  const pend = { ...(ua.pendingMeterSubs || {}) };
  const queue = Array.isArray(pend[key]) ? [...pend[key]] : [];
  while (queue.length > 0) {
    const subId = queue.shift();
    let rec = null;
    if (stripeConfigured()) {
      try {
        const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
        const sub = await stripe.subscriptions.retrieve(subId);
        const isActive = sub.status === "active" || sub.status === "trialing";
        rec = {
          utilityKey: key,
          engine: sub.metadata?.engine === "arcadia" || isArcadiaMeterUid(meterUid) ? "arcadia" : "utilityapi",
          active: isActive,
          stripeSubId: sub.id,
          stripeCustomerId: sub.customer || ua.stripeCustomerId || null,
          status: sub.status || "unknown",
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        };
        if (!isActive) continue;
      } catch (e) {
        console.warn("claimMeterSub retrieve failed:", e?.message || e);
        continue;
      }
    } else {
      rec = { utilityKey: key, active: true, stripeSubId: subId };
    }
    msubs[meterUid] = rec;
    pend[key] = queue;
    await usersRef.set({ utilityAuto: { meterSubs: msubs, pendingMeterSubs: pend } }, { merge: true });
    return rec;
  }
  // Legacy adoption: the key's own subscription covers the first meter.
  const hasKeyMeters = Object.values(msubs).some((e) => e && e.utilityKey === key);
  const keyRec = (ua.subs || {})[key];
  if (!hasKeyMeters && keyRec && subRecordActive(keyRec)) {
    msubs[meterUid] = { ...keyRec, utilityKey: key };
    await usersRef.set({ utilityAuto: { meterSubs: msubs } }, { merge: true });
    return msubs[meterUid];
  }
  throw new ApiError(403, "Payment required — complete the $20/mo checkout for this meter first.");
}

/** Is this meter covered: assigned active meter-sub, else legacy key coverage. */
function meterSubCovered(ent, key, meterUid) {
  const ua = ent.ua || {};
  const entry = (ua.meterSubs || {})[meterUid];
  if (entry) return !!entry.active;
  if (Object.values(ua.meterSubs || {}).some((e) => e && e.utilityKey === key)) return false;
  return keyCovered(ent, key);
}

/** Pending (paid, unlinked) checkouts for a key. */
function pendingMeterCount(ent, key) {
  const list = (ent.ua || {}).pendingMeterSubs?.[key];
  return Array.isArray(list) ? list.length : 0;
}

/** Billed meter count for a key: unique active subscription ids behind it. */
function billedMeterCount(ent, key) {
  const ids = new Set();
  const rec = ent.subs?.[key];
  if (rec && subRecordActive(rec) && rec.stripeSubId) ids.add(rec.stripeSubId);
  for (const e of Object.values((ent.ua || {}).meterSubs || {})) {
    if (e && e.utilityKey === key && e.active && e.stripeSubId) ids.add(e.stripeSubId);
  }
  return ids.size;
}

// ─── Plan subscription helpers (Starter / Professional / Auto-Sync) ───────────
// Marketing-site checkout writes entitlements to users/{uid}.planStatus and
// mirrors them to planSubscriptions/{email} so a visitor can subscribe before
// they ever create a Provalta account (merged on first /plan-status call).
const PLAN_META = {
  starter: { tier: 1, label: "Starter" },
  professional: { tier: 2, label: "Professional" },
  autosync: { tier: 3, label: "Auto-Sync" },
};

function planTier(plan) {
  return PLAN_META[plan]?.tier || 0;
}

/**
 * Effective plan tier for a user, counting both the marketing-site plan
 * subscription (planStatus) and a legacy in-app utility auto-sync
 * subscription (utilityAuto → treated as the Auto-Sync tier).
 */
async function getOwnerPlanTier(ownerId) {
  const snap = await db.collection("users").doc(ownerId).get();
  const data = snap.exists ? snap.data() || {} : {};
  const ps = data.planStatus || null;
  const psEnd = ps?.currentPeriodEnd?.toDate?.() || ps?.currentPeriodEnd || null;
  const psActive = !!ps?.active && (!psEnd || psEnd.getTime() >= Date.now());
  const ua = data.utilityAuto || {};
  const uaEnd = ua.currentPeriodEnd?.toDate?.() || ua.currentPeriodEnd || null;
  const uaActive = !!ua.active && (!uaEnd || uaEnd.getTime() >= Date.now());
  return Math.max(psActive ? planTier(ps.plan) : 0, uaActive ? 3 : 0);
}

function planPriceId(plan) {
  const envKey =
    plan === "starter"
      ? "STARTER_PLAN_PRICE_ID"
      : plan === "professional"
        ? "PROFESSIONAL_PLAN_PRICE_ID"
        : "UTILITY_PLAN_PRICE_ID"; // Auto-Sync reuses the auto-sync plan price
  const id = process.env[envKey] || "";
  if (!id) {
    throw new ApiError(
      500,
      `The ${PLAN_META[plan]?.label || plan} plan is not configured. Add ${envKey} to Netlify env.`
    );
  }
  return id;
}

async function findUidByEmail(email) {
  if (!email) return null;
  try {
    const user = await admin.auth().getUserByEmail(email);
    return user.uid;
  } catch {
    return null; // no Provalta account (yet) — planSubscriptions keeps the plan
  }
}

async function setPlanSubscription({ plan, email, subObj, uid = null }) {
  const status = subObj.status;
  const active = status === "active" || status === "trialing";
  const periodEnd = subObj.current_period_end ? new Date(subObj.current_period_end * 1000) : null;
  const resolvedUid = uid || (await findUidByEmail(email));
  const planStatus = {
    plan: plan || null,
    active,
    tier: planTier(plan),
    stripeSubId: subObj.id || null,
    stripeCustomerId: subObj.customer || null,
    status: status || "unknown",
    currentPeriodEnd: periodEnd ? admin.firestore.Timestamp.fromDate(periodEnd) : null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (resolvedUid) {
    await db
      .collection("users")
      .doc(resolvedUid)
      .set({ planStatus, plan: active ? plan : null }, { merge: true });
  }
  if (email) {
    await db
      .collection("planSubscriptions")
      .doc(String(email).toLowerCase())
      .set({ email: String(email).toLowerCase(), ...planStatus }, { merge: true });
  }
  // Auto-Sync also drives the utility auto-sync entitlement the app checks.
  if (plan === "autosync" && resolvedUid) {
    await setUtilitySubscription(resolvedUid, subObj);
  }
}

// NOTE: billing is per utility key (one flat $20/mo subscription each), so
// there is no quantity syncing — each subscription is simply quantity 1.

// ─── Express app + auth middleware ────────────────────────────────────────────
const app = express();

// CORS: the marketing site / tenant portal may be served from a different
// origin than this function (e.g. Firebase Hosting + Netlify API).
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Body parsing: serverless-http hands us a raw Buffer in req.body. Parse JSON
// bodies ourselves (so every route gets an object), and keep the exact bytes in
// req.rawBody for the Stripe webhook signature check.
app.use((req, res, next) => {
  const raw = req.body;
  req.rawBody = Buffer.isBuffer(raw) ? raw : raw != null ? Buffer.from(String(raw)) : Buffer.alloc(0);
  const type = String(req.headers["content-type"] || "");
  if (type.includes("application/json") && req.rawBody.length > 0) {
    try {
      req.body = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ error: "INVALID_ARGUMENT", message: "Invalid JSON body." });
      return;
    }
  } else {
    req.body = req.body && req.body !== undefined && !Buffer.isBuffer(req.body) ? req.body : {};
  }
  next();
});

// Verify a Firebase ID token from `Authorization: Bearer <token>`.
async function requireAuth(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "UNAUTHENTICATED", message: "Sign in to continue." });
      return;
    }
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.token = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "UNAUTHENTICATED", message: "Invalid or expired session. Sign in again." });
  }
}

// ─── Tenant: create a Checkout session for one month's rent ───────────────────
app.post("/create-rent-checkout-session", requireAuth, async (req, res) => {
  const tenantId = String(req.body?.tenantId || "").trim();
  const monthKey = String(req.body?.monthKey || "").trim();
  if (!tenantId || !/^\d{4}-\d{2}$/.test(monthKey)) {
    res.status(400).json({ error: "INVALID_ARGUMENT", message: "Missing tenantId or monthKey." });
    return;
  }
  const base = webBaseUrl();
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    res.status(404).json({ error: "NOT_FOUND", message: "Rental record not found." });
    return;
  }
  const tenant = tenantSnap.data() || {};
  if (!tenant.ownerId) {
    res.status(409).json({ error: "FAILED_PRECONDITION", message: "Rental has no landlord assigned." });
    return;
  }
  assertTenantOwnership(tenant, req.token);

  // Card rent collection is a Professional-plan feature — gate it on the
  // landlord's / property manager's plan tier.
  const ownerTier = await getOwnerPlanTier(tenant.ownerId);
  if (ownerTier < 2) {
    res.status(403).json({
      error: "PLAN_REQUIRED",
      message:
        "Card rent collection is part of the Professional plan. Ask your landlord or property manager to upgrade on the Provalta website.",
    });
    return;
  }

  const connect = await getLandlordConnect(tenant.ownerId);
  if (!connect.exists || !connect.stripeAccountId) {
    res.status(409).json({ error: "FAILED_PRECONDITION", message: "Your landlord hasn't connected their payout account yet. Ask them to set up payouts in the Provalta app." });
    return;
  }
  if (!connect.payoutsEnabled) {
    res.status(409).json({ error: "FAILED_PRECONDITION", message: "Your landlord's payout setup isn't finished yet, so payments can't be accepted right now." });
    return;
  }
  const unitAmount = dollarsToCents(tenant.rentAmount);
  if (!unitAmount || unitAmount < 100) {
    res.status(400).json({ error: "INVALID_ARGUMENT", message: "Rent amount must be at least $1.00." });
    return;
  }

  const feePercent = platformFeePercent();
  // Stripe requires application_fee_amount to be positive — a rounded-down 0
  // must be omitted, never sent (it would fail the whole checkout).
  const rawFee = feePercent > 0 ? Math.min(Math.round((unitAmount * feePercent) / 100), unitAmount - 1) : 0;
  const applicationFee = rawFee > 0 ? rawFee : undefined;
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const amountLabel = `$${Number(tenant.rentAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  const description = `Rent for ${tenant.propertyName} (${tenant.tenantName}) — ${monthKey}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Cards only: no "Pay later" / installment options, just "Pay in full".
      payment_method_types: ["card"],
      customer_email: req.token.email || undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: unitAmount,
            product_data: {
              name: `${amountLabel} Rent — ${tenant.propertyName}`,
              description,
            },
          },
        },
      ],
      payment_intent_data: {
        description,
        ...(applicationFee !== undefined ? { application_fee_amount: applicationFee } : {}),
        // Destination charge: goes straight to the landlord's Connect account.
        // (transfer_data lives here on Checkout Sessions, not top-level.)
        transfer_data: { destination: connect.stripeAccountId },
        metadata: { ownerId: tenant.ownerId, tenantId, monthKey },
      },
      metadata: {
        ownerId: tenant.ownerId,
        tenantId,
        monthKey,
        tenantUid: req.uid,
        tenantName: String(tenant.tenantName || ""),
        propertyName: String(tenant.propertyName || ""),
        rentAmountDollars: String(tenant.rentAmount),
      },
      success_url: `${base}/portal.html?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/portal.html?canceled=1`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout session failed:", err.message);
    res.status(500).json({ error: "INTERNAL", message: `Stripe checkout could not be created: ${err.message || err}` });
  }
});

// ─── Landlord: one-time Stripe Express onboarding ─────────────────────────────

// ─── Tenant: read their OWN utilities ─────────────────────────────────────────
// Invite-only: tenantEmail on the tenant doc must match the caller's email.
// Backed by tenant_utilities/{authUid} — the landlord's property doc is never
// touched, so the two sides stay fully decoupled.
app.get("/tenant-property-utilities", requireAuth, async (req, res) => {
  try {
    const store = await tenantStoreContext(req, req.query?.tenantId);
    res.json({ utilities: store.utilities });
  } catch (err) {
    res.status(err.status || 403).json({ error: "PERMISSION_DENIED", message: err.message });
  }
});

// ─── Tenant: save their OWN utilities (same fields as the app) ───────────────
app.post("/tenant-property-utilities", requireAuth, async (req, res) => {
  const incoming = req.body?.utilities;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    res.status(400).json({ error: "INVALID_ARGUMENT", message: "Missing utilities." });
    return;
  }
  let store;
  try {
    store = await tenantStoreContext(req, req.body?.tenantId);
  } catch (err) {
    res.status(err.status || 403).json({ error: "PERMISSION_DENIED", message: err.message });
    return;
  }
  const existing = store.utilities;

  // Validate: same rules as the app (numeric amount, dueDay 1-31 or "last").
  // Incoming is always the full map (portal sends everything); keys missing
  // from it are deletions. Bindings (meterUid/auto) are preserved per key.
  const next = {};
  for (const [key, val] of Object.entries(incoming)) {
    const normKey = normalizeUtilityKey(key);
    if (!normKey || !val || typeof val !== "object") {
      res.status(400).json({ error: "INVALID_ARGUMENT", message: `Invalid utility: ${key}.` });
      return;
    }
    const amount = String(val.amount ?? "").trim();
    if (amount === "" || Number.isNaN(Number(amount)) || Number(amount) < 0) {
      res.status(400).json({ error: "INVALID_ARGUMENT", message: `Invalid amount for ${normKey}.` });
      return;
    }
    let dueDay = val.dueDay;
    if (dueDay !== "last") {
      const d = Number(dueDay);
      if (!Number.isInteger(d) || d < 1 || d > 31) {
        res.status(400).json({ error: "INVALID_ARGUMENT", message: `Invalid due day for ${normKey}.` });
        return;
      }
      dueDay = d;
    }
    const cur = existing[normKey] || {};
    next[normKey] = {
      amount,
      provider: String(val.provider ?? "").trim(),
      dueDay,
      notify: val.notify === false ? false : true,
      ...(cur.meterUid ? { meterUid: cur.meterUid } : {}),
      ...(cur.auto ? { auto: cur.auto } : {}),
    };
  }

  // Plain set (no merge): merge would leave removed keys behind since it
  // never deletes omitted map entries.
  await store.ref.set({ utilities: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  // Removed meters no longer feed any key: stop collection (best-effort).
  try {
    const freed = [];
    for (const [k, u] of Object.entries(existing)) {
      if (next[k] || !u || typeof u !== "object") continue;
      eachLinkedMeterUid(u, (id) => freed.push(id));
    }
    const stillUsed = new Set();
    Object.values(next).forEach((u) => eachLinkedMeterUid(u, (id) => stillUsed.add(id)));
    const stoppable = freed.filter((id) => !stillUsed.has(id));
    if (stoppable.length > 0) await utilityApi.stopMeterMonitoring(stoppable);
  } catch (e) {
    console.warn("stopMeterMonitoring after tenant remove failed:", e?.message || e);
  }

  res.json({ utilities: next });
});

// ─── Tenant auto-sync: shared helpers (tenant pays on their own account) ───
// Tenant utilities live in the tenant's OWN store (tenant_utilities/{authUid})
// — never on the landlord's property doc. Whatever the landlord and tenant
// agreed is between them; in the portal the tenant manages their own bills
// (manual or $20/mo auto-sync) and the landlord's app never sees or touches
// them. The Stripe webhook needs no changes: it routes purely on subscription
// metadata estateflowUid (= tenant auth uid).
async function tenantStoreContext(req, needTenantId) {
  if (needTenantId) {
    const tenantSnap = await db.collection("tenants").doc(String(needTenantId || "").trim()).get();
    if (!tenantSnap.exists) throw new ApiError(404, "Rental record not found.");
    const tenant = tenantSnap.data() || {};
    assertTenantOwnership(tenant, req.token);
  } else {
    // Invite must exist for this email (same gate as the portal login).
    const email = String(req.token.email || "").trim().toLowerCase();
    const snap = await db.collection("tenants").where("tenantEmail", "==", email).limit(1).get();
    if (snap.empty) throw new ApiError(403, "No rental found for this account.");
    assertTenantOwnership(snap.docs[0].data() || {}, req.token);
  }
  const ref = db.collection("tenant_utilities").doc(req.uid);
  const doc = await ref.get();
  return { ref, utilities: (doc.exists && doc.data()?.utilities) || {} };
}

/** Meters linked in a utilities map (tenant cap is scoped to their own store). */
function countStoreMeters(utilities) {
  const seen = new Set();
  Object.values(utilities || {}).forEach((u) => eachLinkedMeterUid(u, (id) => seen.add(id)));
  return { count: seen.size, meterUids: seen };
}

/** Which utility keys in the map use this meter? */
function storeKeysForMeter(utilities, meterUid) {
  const keys = [];
  for (const [key, u] of Object.entries(utilities || {})) {
    if (!UTILITY_KEYS.includes(key)) continue;
    let found = false;
    eachLinkedMeterUid(u, (id) => { if (id === String(meterUid)) found = true; });
    if (found) keys.push(key);
  }
  return keys;
}

async function buildTenantUtilityStatus(tenantUid, store) {
  const ent = await getUtilityEntitlement(tenantUid);
  let portalUrl = null;
  if (ent.active && ent.stripeCustomerId && stripeConfigured()) {
    try {
      portalUrl = await createBillingPortal(stripeFactory(process.env.STRIPE_SECRET_KEY), ent.stripeCustomerId);
    } catch (err) {
      console.warn("Tenant billing portal session failed:", err.message);
    }
  }
  const linked = countStoreMeters(store.utilities);
  const toIso = (v) => {
    const d = v?.toDate?.() || v || null;
    return d instanceof Date ? d.toISOString() : d || null;
  };
  const subscriptions = {};
  for (const key of UTILITY_KEYS) {
    const rec = ent.subs?.[key];
    const billed = billedMeterCount(ent, key);
    const pending = pendingMeterCount(ent, key);
    subscriptions[key] = rec
      ? {
        active: subRecordActive(rec),
        currentPeriodEnd: toIso(rec.currentPeriodEnd),
        cancelAtPeriodEnd: !!rec.cancelAtPeriodEnd,
        cancelAt: toIso(rec.cancelAt),
        billedMeters: billed,
        pendingMeters: pending,
      }
      : { active: false, currentPeriodEnd: null, cancelAtPeriodEnd: false, cancelAt: null, billedMeters: billed, pendingMeters: pending };
  }
  return {
    active: ent.active,
    portalUrl,
    meterLimit: meterLimit(),
    linkedMeters: linked.count,
    subscriptions,
    activeKeys: ent.activeKeys,
  };
}

// ─── Tenant: subscribe ONE utility to auto-sync ($20/mo on their own bill) ───
app.post("/create-tenant-utility-subscription", requireAuth, async (req, res) => {
  const tenantUid = req.uid;
  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  if (!utilityKey) throw new ApiError(400, "Missing utility (Electric, Water, Gas, Oil, Sewer or Trash).");
  const tenantDocId = String(req.body?.tenantId || "").trim();
  await tenantStoreContext(req, tenantDocId || undefined);
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);

  const ent = await getUtilityEntitlement(tenantUid);
  if (keyCovered(ent, utilityKey) && ent.stripeCustomerId) {
    const url = await createBillingPortal(stripe, ent.stripeCustomerId);
    res.json({ url, alreadyActive: true });
    return;
  }

  let customerId = ent.stripeCustomerId;
  if (!customerId) {
    const snap = await db.collection("users").doc(tenantUid).get();
    customerId = snap.exists ? snap.data()?.stripeCustomerId || null : null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.token.email || undefined,
        metadata: { estateflowUid: tenantUid, tenantId: tenantDocId },
      });
      customerId = customer.id;
      await db.collection("users").doc(tenantUid).set({ stripeCustomerId: customerId }, { merge: true });
    }
  }

  const meterPriceId = (process.env.UTILITY_METER_PRICE_ID || "").trim();
  if (!/^price_[A-Za-z0-9]+$/.test(meterPriceId)) {
    throw new ApiError(500, "Per-meter billing is misconfigured. Ask support to check UTILITY_METER_PRICE_ID.");
  }
  const base = webBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: meterPriceId, quantity: 1 }],
    subscription_data: { metadata: { estateflowUid: tenantUid, utilityKey, tenantId: tenantDocId, kind: "tenant-utility" } },
    metadata: { estateflowUid: tenantUid, utilityKey, tenantId: tenantDocId, kind: "tenant-utility" },
    success_url: `${base}/portal.html?utility=subscribed&session_id={CHECKOUT_SESSION_ID}&key=${utilityKey}`,
    cancel_url: `${base}/portal.html?utility=canceled`,
  });
  res.json({ url: session.url, alreadyActive: false });
});

// ─── Tenant: auto-sync status (own subscription + own meter count) ──────────
app.get("/tenant-utility-status", requireAuth, async (req, res) => {
  const store = await tenantStoreContext(req, req.query?.tenantId);
  res.json(await buildTenantUtilityStatus(req.uid, store));
});

// ─── Tenant: start provider authorization (returns a browser URL) ─────────────
app.post("/tenant-utility-auth-form", requireAuth, async (req, res) => {
  const store = await tenantStoreContext(req, req.body?.tenantId);
  const ent = await getUtilityEntitlement(req.uid);
  assertUtilityEntitlement(ent);
  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  if (!utilityKey) throw new ApiError(400, "Utility is required (Electric, Water, Gas, Oil, Sewer or Trash).");
  assertUtilityEntitlementForKey(ent, utilityKey);
  const linked = countStoreMeters(store.utilities);
  assertUnderMeterLimit(linked.count, meterLimit());
  const utilityUid = String(req.body?.utilityUid || "").trim();
  res.json(await utilityApi.createAuthForm(utilityUid || null));
});

// ─── Tenant: has the provider sign-in finished? (for polling) ────────────────
app.get("/tenant-utility-auth-form-status", requireAuth, async (req, res) => {
  await tenantStoreContext(req, req.query?.tenantId);
  const ent = await getUtilityEntitlement(req.uid);
  assertUtilityEntitlement(ent);
  const formUid = String(req.query?.formUid || "").trim();
  if (!formUid) throw new ApiError(400, "Missing formUid.");
  res.json(await utilityApi.checkAuthFormStatus({ formUid }));
});

// ─── Tenant: finish linking and write the meter into their own store ──────────
app.post("/tenant-utility-link", requireAuth, async (req, res) => {
  const store = await tenantStoreContext(req, req.body?.tenantId);
  const ent = await getUtilityEntitlement(req.uid);
  assertUtilityEntitlement(ent);
  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  if (!utilityKey) throw new ApiError(400, "Utility is required (Electric, Water, Gas, Oil, Sewer or Trash).");
  assertUtilityEntitlementForKey(ent, utilityKey);
  const formUid = String(req.body?.formUid || "").trim();
  if (!formUid) throw new ApiError(400, "Missing formUid.");

  const linked = countStoreMeters(store.utilities);
  assertUnderMeterLimit(linked.count, meterLimit());
  const data = await utilityApi.linkForProperty({ formUid });
  if (data.meterUid && !linked.meterUids.has(String(data.meterUid))) {
    assertUnderMeterLimit(linked.count + 1, meterLimit());
  }

  const existing = store.utilities?.[utilityKey] || {};
  const bill = {
    amount: data.amount !== undefined && data.amount !== null ? String(data.amount) : String(existing.amount || ""),
    provider: data.provider || existing.provider || "",
    dueDay: data.dueDay || existing.dueDay || 15,
    notify: existing.notify !== false,
    meterUid: data.meterUid,
    auto: true,
  };
  const next = { ...(store.utilities || {}), [utilityKey]: bill };
  await store.ref.set({ utilities: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  // Per-meter billing on the tenant's own subscription: the new meter claims
  // a paid checkout (or the key's first subscription). Throws 403 when
  // nothing was paid for it.
  let billedMeters = 1;
  if (data.meterUid) {
    await claimMeterSub(req.uid, utilityKey, String(data.meterUid));
    billedMeters = billedMeterCount(await getUtilityEntitlement(req.uid), utilityKey);
  }
  res.json({ utilities: next, amount: bill.amount, provider: bill.provider, dueDay: bill.dueDay, meterUid: data.meterUid, billedMeters });
});

// ─── Tenant: refresh an already-linked meter in their own store ──────────────
app.post("/tenant-utility-refresh", requireAuth, async (req, res) => {
  const store = await tenantStoreContext(req, req.body?.tenantId);
  const meterUid = String(req.body?.meterUid || "").trim();
  if (!meterUid) throw new ApiError(400, "Missing meterUid.");
  // Covered when the tenant's own subscription covers the meter.
  const keys = storeKeysForMeter(store.utilities, meterUid);
  const tenantEnt = await getUtilityEntitlement(req.uid);
  const covered = keys.length === 0 || keys.some((k) => meterSubCovered(tenantEnt, k, meterUid));
  if (!covered) {
    throw new ApiError(403, "The subscription covering this utility is no longer active. Reconnect it ($20/month per meter) or enter bills manually.");
  }
  res.json(await utilityApi.refreshMeter({ meterUid }));
});

// ─── Tenant: cancel (or resume) their own utility subscription ───────────────
// Cascades to every per-meter subscription under the key (no orphan billing).
app.post("/tenant-utility-cancel", requireAuth, async (req, res) => {
  await tenantStoreContext(req, req.body?.tenantId);
  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  if (!utilityKey) throw new ApiError(400, "Missing utility (Electric, Water, Gas, Oil, Sewer or Trash).");
  const resume = req.body?.resume === true;
  const ent = await getUtilityEntitlement(req.uid);
  const subId = ent.subs?.[utilityKey]?.stripeSubId;
  if (!subId) throw new ApiError(404, `No subscription found for ${utilityKey}.`);
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const subIds = new Set([subId]);
  for (const e of Object.values(ent.ua.meterSubs || {})) {
    if (e && e.utilityKey === utilityKey && e.stripeSubId) subIds.add(e.stripeSubId);
  }
  let updated = null;
  for (const id of subIds) {
    try {
      const u = await stripe.subscriptions.update(id, { cancel_at_period_end: !resume });
      await setUtilitySubscription(req.uid, u);
      if (id === subId) updated = u;
    } catch (err) {
      console.warn("Tenant key-cancel sub update failed:", err?.message || err);
    }
  }
  if (!updated) throw new ApiError(404, `No subscription found for ${utilityKey}.`);
  const end = updated.current_period_end ? new Date(updated.current_period_end * 1000).toISOString() : null;
  res.json({
    active: updated.status === "active" || updated.status === "trialing",
    cancelAtPeriodEnd: !!updated.cancel_at_period_end,
    currentPeriodEnd: end,
  });
});

// Tenant: cancel (or resume) ONE meter's own subscription in their own store.
app.post("/tenant-meter-cancel", requireAuth, async (req, res) => {
  const store = await tenantStoreContext(req, req.body?.tenantId);
  const meterUid = String(req.body?.meterUid || "").trim();
  if (!meterUid) throw new ApiError(400, "Missing meterUid.");
  if (!storeKeysForMeter(store.utilities, meterUid).length) {
    throw new ApiError(404, "Meter not found in your utilities.");
  }
  res.json(await cancelMeterSub(req.uid, meterUid, req.body?.resume === true, true));
});

// ─── Tenant: hosted card-collection (Setup mode, returns to the portal) ────
// Separate from the landlord flow: operates only on the tenant's own Stripe
// customer, and the landlord's billing is never touched.
app.post("/tenant-billing-card-setup", requireAuth, async (req, res) => {
  await tenantStoreContext(req, req.body?.tenantId);
  const stripe = billingStripe();
  const customerId = await getBillingCustomerId(req.uid);
  const base = webBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    payment_method_types: ["card"],
    success_url: `${base}/portal.html?billing=setup`,
    cancel_url: `${base}/portal.html?billing=canceled`,
  });
  res.json({ url: session.url });
});

// ─── Tenant: confirm a just-completed rent checkout without webhooks ─────────
// The portal calls this with the Stripe session_id from its return URL, so a
// missed/slow webhook can never leave a paid tenant looking unpaid.
app.post("/confirm-rent-payment", requireAuth, async (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "INVALID_ARGUMENT", message: "Missing sessionId." });
    return;
  }
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    res.status(404).json({ error: "NOT_FOUND", message: "Checkout session not found." });
    return;
  }
  if (!session || session.mode !== "payment" || session.payment_status !== "paid") {
    res.json({ recorded: false, detail: "Session is not a paid rent checkout yet." });
    return;
  }
  const md = session.metadata || {};
  const { ownerId, tenantId, monthKey } = md;
  if (!ownerId || !tenantId || !monthKey) {
    res.status(400).json({ error: "INVALID_ARGUMENT", message: "Session is not a rent payment." });
    return;
  }
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    res.status(404).json({ error: "NOT_FOUND", message: "Rental record not found." });
    return;
  }
  try {
    assertTenantOwnership(tenantSnap.data() || {}, req.token);
  } catch (err) {
    res.status(err.status || 403).json({ error: "PERMISSION_DENIED", message: err.message });
    return;
  }
  const Timestamp = admin.firestore.FieldValue.serverTimestamp();
  const paymentRef = db.collection("payments").doc(ownerId)
    .collection("months").doc(monthKey).collection("payments").doc(tenantId);
  let recorded = true;
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(paymentRef);
    if (existing.exists && existing.data()?.stripeSessionId === session.id && existing.data()?.recordedAt) {
      recorded = false;
      return;
    }
    tx.set(paymentRef, {
      rentAmount: Number(md.rentAmountDollars || 0),
      tenantName: md.tenantName || null,
      propertyName: md.propertyName || null,
      paidAt: Timestamp,
      paidBy: md.tenantUid || "stripe",
      method: "card",
      currency: session.currency,
      amountPaidCents: session.amount_total,
      applicationFeeCents: session.application_fee_amount || 0,
      stripeSessionId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
      recordedAt: Timestamp,
    });
    tx.set(db.collection("tenants").doc(tenantId), { lastPaidAt: Timestamp }, { merge: true });
  });
  res.json({ recorded });
});

// ─── Tenant: set up monthly autopay (one subscription, charged every month) ─
// One Stripe subscription per rental: the tenant's card is charged the rent
// automatically each month as a destination charge into the landlord's
// Connect account (minus card + platform fees). Cancel anytime — access runs
// to the paid-through date.
app.post("/create-rent-autopay-checkout", requireAuth, async (req, res) => {
  const tenantId = String(req.body?.tenantId || "").trim();
  if (!tenantId) {
    res.status(400).json({ error: "INVALID_ARGUMENT", message: "Missing tenantId." });
    return;
  }
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    res.status(404).json({ error: "NOT_FOUND", message: "Rental record not found." });
    return;
  }
  const tenant = tenantSnap.data() || {};
  try {
    assertTenantOwnership(tenant, req.token);
  } catch (err) {
    res.status(err.status || 403).json({ error: "PERMISSION_DENIED", message: err.message });
    return;
  }
  if (!tenant.ownerId) {
    res.status(409).json({ error: "FAILED_PRECONDITION", message: "Rental has no landlord assigned." });
    return;
  }
  const ownerTier = await getOwnerPlanTier(tenant.ownerId);
  if (ownerTier < 2) {
    res.status(403).json({ error: "PLAN_REQUIRED", message: "Autopay needs your landlord's Professional plan." });
    return;
  }
  const connect = await getLandlordConnect(tenant.ownerId);
  if (!connect.exists || !connect.stripeAccountId || !connect.payoutsEnabled) {
    res.status(409).json({ error: "FAILED_PRECONDITION", message: "Your landlord's payout setup isn't finished yet." });
    return;
  }
  const unitAmount = dollarsToCents(tenant.rentAmount);
  if (!unitAmount || unitAmount < 100) {
    res.status(400).json({ error: "INVALID_ARGUMENT", message: "Rent amount must be at least $1.00." });
    return;
  }
  // Already on autopay for this rental? Send them to manage it, not double-pay.
  const autoSnap = await db.collection("users").doc(req.uid).get();
  const auto = autoSnap.exists ? autoSnap.data()?.rentAutopay || {} : {};
  if (auto.active && auto.tenantId === tenantId && auto.stripeSubId) {
    res.json({ alreadyActive: true });
    return;
  }
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const feePercent = platformFeePercent();
  const base = webBaseUrl();
  const amountLabel = `$${Number(tenant.rentAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: req.token.email || undefined,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: unitAmount,
            recurring: { interval: "month" },
            product_data: { name: `${amountLabel}/mo Rent — ${tenant.propertyName}` },
          },
        },
      ],
      subscription_data: {
        description: `Monthly rent for ${tenant.propertyName} (${tenant.tenantName})`,
        transfer_data: { destination: connect.stripeAccountId },
        ...(feePercent > 0 ? { application_fee_percent: Math.min(feePercent, 50) } : {}),
        metadata: { kind: "rent-autopay", ownerId: tenant.ownerId, tenantId, tenantUid: req.uid, tenantName: String(tenant.tenantName || ""), propertyName: String(tenant.propertyName || ""), rentAmountDollars: String(tenant.rentAmount) },
      },
      metadata: { kind: "rent-autopay", ownerId: tenant.ownerId, tenantId, tenantUid: req.uid },
      success_url: `${base}/portal.html?autopay=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/portal.html?autopay=canceled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Autopay checkout failed:", err.message);
    res.status(500).json({ error: "INTERNAL", message: `Autopay checkout could not be created: ${err.message || err}` });
  }
});

// ─── Tenant: autopay status for one rental ────────────────────────────────────
app.get("/rent-autopay-status", requireAuth, async (req, res) => {
  const tenantId = String(req.query?.tenantId || "").trim();
  const snap = await db.collection("users").doc(req.uid).get();
  const auto = snap.exists ? snap.data()?.rentAutopay || {} : {};
  if (!tenantId || auto.tenantId !== tenantId) {
    res.json({ active: false });
    return;
  }
  let live = null;
  if (auto.stripeSubId && stripeConfigured()) {
    try {
      const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
      live = await stripe.subscriptions.retrieve(auto.stripeSubId);
    } catch {
      live = null;
    }
  }
  const status = live ? live.status : auto.status || "unknown";
  const active = live
    ? live.status === "active" || live.status === "trialing"
    : !!auto.active;
  res.json({
    active,
    status,
    cancelAtPeriodEnd: live ? !!live.cancel_at_period_end : !!auto.cancelAtPeriodEnd,
    currentPeriodEnd: live?.current_period_end
      ? new Date(live.current_period_end * 1000).toISOString()
      : auto.currentPeriodEnd?.toDate?.()?.toISOString?.() || auto.currentPeriodEnd || null,
    amount: auto.rentAmountDollars || null,
  });
});

// ─── Tenant: confirm a just-completed autopay checkout ────────────────────────
app.post("/confirm-rent-autopay", requireAuth, async (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "INVALID_ARGUMENT", message: "Missing sessionId." });
    return;
  }
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
  } catch {
    res.status(404).json({ error: "NOT_FOUND", message: "Checkout session not found." });
    return;
  }
  const sub = session.subscription && typeof session.subscription === "object" ? session.subscription : null;
  const md = session.metadata || {};
  if (!sub || md.kind !== "rent-autopay" || (sub.status !== "active" && sub.status !== "trialing")) {
    res.json({ active: false, detail: "No active autopay subscription on this checkout yet." });
    return;
  }
  const tenantId = String(md.tenantId || "");
  const tenantSnap = tenantId ? await db.collection("tenants").doc(tenantId).get() : null;
  if (!tenantSnap || !tenantSnap.exists) {
    res.status(404).json({ error: "NOT_FOUND", message: "Rental record not found." });
    return;
  }
  try {
    assertTenantOwnership(tenantSnap.data() || {}, req.token);
  } catch (err) {
    res.status(err.status || 403).json({ error: "PERMISSION_DENIED", message: err.message });
    return;
  }
  await setRentAutopay(req.uid, tenantId, sub);
  res.json({ active: true });
});

// ─── Tenant: cancel (or resume) autopay — runs to the paid-through date ──────
app.post("/cancel-rent-autopay", requireAuth, async (req, res) => {
  const tenantId = String(req.body?.tenantId || "").trim();
  const resume = req.body?.resume === true;
  const snap = await db.collection("users").doc(req.uid).get();
  const auto = snap.exists ? snap.data()?.rentAutopay || {} : {};
  if (!tenantId || auto.tenantId !== tenantId || !auto.stripeSubId) {
    res.status(404).json({ error: "NOT_FOUND", message: "No autopay subscription found." });
    return;
  }
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const updated = await stripe.subscriptions.update(auto.stripeSubId, { cancel_at_period_end: !resume });
  await setRentAutopay(req.uid, tenantId, updated);
  res.json({
    active: updated.status === "active" || updated.status === "trialing",
    cancelAtPeriodEnd: !!updated.cancel_at_period_end,
  });
});

/** Persist autopay state on the tenant's account + a badge on the tenant doc. */
async function setRentAutopay(uid, tenantId, subObj) {
  const status = subObj.status;
  const active = status === "active" || status === "trialing";
  const periodEnd = subObj.current_period_end ? new Date(subObj.current_period_end * 1000) : null;
  const record = {
    active,
    status: status || "unknown",
    stripeSubId: subObj.id || null,
    stripeCustomerId: typeof subObj.customer === "string" ? subObj.customer : subObj.customer?.id || null,
    tenantId,
    cancelAtPeriodEnd: !!subObj.cancel_at_period_end,
    currentPeriodEnd: periodEnd ? admin.firestore.Timestamp.fromDate(periodEnd) : null,
    rentAmountDollars: subObj.metadata?.rentAmountDollars || subObj.items?.data?.[0]?.price?.unit_amount / 100 || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection("users").doc(uid).set({ rentAutopay: record }, { merge: true });
  try {
    await db.collection("tenants").doc(tenantId).set(
      { autopay: { active, cancelAtPeriodEnd: !!subObj.cancel_at_period_end, updatedAt: admin.firestore.FieldValue.serverTimestamp() } },
      { merge: true }
    );
  } catch (e) {
    console.warn("Autopay tenant badge failed:", e?.message || e);
  }
}

// ─── Tenant: autopay payment-method management (own card, own account) ───────
// The rent subscription charges this customer; the landlord's billing is
// never involved.
async function getRentAutopayContext(req) {
  const tenantId = String(req.body?.tenantId || req.query?.tenantId || "").trim();
  await tenantStoreContext(req, tenantId || undefined);
  const snap = await db.collection("users").doc(req.uid).get();
  const auto = snap.exists ? snap.data()?.rentAutopay || {} : {};
  if (!tenantId || auto.tenantId !== tenantId) {
    throw new ApiError(404, "No autopay subscription found for this rental.");
  }
  let customerId = auto.stripeCustomerId || null;
  if (!customerId && auto.stripeSubId && stripeConfigured()) {
    try {
      const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
      const sub = await stripe.subscriptions.retrieve(auto.stripeSubId);
      customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id || null;
      if (customerId) {
        await db.collection("users").doc(req.uid).set({ rentAutopay: { stripeCustomerId: customerId } }, { merge: true });
      }
    } catch {
      customerId = null;
    }
  }
  if (!customerId) throw new ApiError(404, "No billing account yet — set up autopay first.");
  return { tenantId, auto, customerId };
}

function autopayDefaultPm(sub, customer) {
  if (sub && typeof sub.default_payment_method === "string" && sub.default_payment_method) return sub.default_payment_method;
  return customerDefaultPm(customer);
}

app.get("/rent-payment-methods", requireAuth, async (req, res) => {
  const { auto } = await getRentAutopayContext(req);
  const stripe = billingStripe();
  const sub = auto.stripeSubId ? await stripe.subscriptions.retrieve(auto.stripeSubId).catch(() => null) : null;
  const customerId = auto.stripeCustomerId || (sub && (typeof sub.customer === "string" ? sub.customer : sub.customer?.id));
  if (!customerId) throw new ApiError(404, "No billing account yet — set up autopay first.");
  const [customer, pms] = await Promise.all([
    stripe.customers.retrieve(customerId),
    stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 20 }),
  ]);
  if (typeof customer !== "string" && customer.deleted) throw new ApiError(404, "Billing account not found.");
  const def = autopayDefaultPm(sub && typeof sub !== "string" ? sub : null, customer);
  res.json({
    methods: (pms.data || []).map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand || "card",
      last4: pm.card?.last4 || "••••",
      expMonth: pm.card?.exp_month || null,
      expYear: pm.card?.exp_year || null,
      isDefault: pm.id === def,
    })),
  });
});

app.post("/rent-payment-methods/default", requireAuth, async (req, res) => {
  const { auto, customerId } = await getRentAutopayContext(req);
  const paymentMethodId = String(req.body?.paymentMethodId || "").trim();
  if (!paymentMethodId) throw new ApiError(400, "Missing paymentMethodId.");
  const stripe = billingStripe();
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  if (auto.stripeSubId) {
    try {
      await stripe.subscriptions.update(auto.stripeSubId, { default_payment_method: paymentMethodId });
    } catch (err) {
      console.warn("Autopay sub default-pm update failed:", err.message);
    }
  }
  res.json({ ok: true });
});

app.post("/rent-payment-methods/detach", requireAuth, async (req, res) => {
  const { customerId } = await getRentAutopayContext(req);
  const paymentMethodId = String(req.body?.paymentMethodId || "").trim();
  if (!paymentMethodId) throw new ApiError(400, "Missing paymentMethodId.");
  const stripe = billingStripe();
  const pms = await stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 20 });
  const ids = (pms.data || []).map((pm) => pm.id);
  if (!ids.includes(paymentMethodId)) throw new ApiError(404, "Card not found.");
  if (ids.length <= 1) {
    throw new ApiError(400, "Add a new card first — autopay needs one card on file.");
  }
  const customer = await stripe.customers.retrieve(customerId);
  if (customerDefaultPm(customer) === paymentMethodId) {
    const next = ids.find((id) => id !== paymentMethodId);
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: next } });
  }
  await stripe.paymentMethods.detach(paymentMethodId);
  res.json({ ok: true });
});

// Hosted card collection for autopay (Setup mode: no charge). Returns to the
// portal, which then calls /rent-payment-methods/finish-setup to make it live.
app.post("/rent-payment-methods/setup", requireAuth, async (req, res) => {
  const { customerId } = await getRentAutopayContext(req);
  const stripe = billingStripe();
  const base = webBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    payment_method_types: ["card"],
    success_url: `${base}/portal.html?billing=setup&autopay_card=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/portal.html?billing=canceled`,
  });
  res.json({ url: session.url });
});

// Make a just-added setup card the autopay default.
app.post("/rent-payment-methods/finish-setup", requireAuth, async (req, res) => {
  const { auto, customerId } = await getRentAutopayContext(req);
  const sessionId = String(req.body?.sessionId || "").trim();
  if (!sessionId) throw new ApiError(400, "Missing sessionId.");
  const stripe = billingStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["setup_intent"] });
  const si = session.setup_intent && typeof session.setup_intent === "object" ? session.setup_intent : null;
  const pmId = si && typeof si.payment_method === "string" ? si.payment_method : null;
  if (!pmId) throw new ApiError(400, "No card found on that session.");
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pmId } });
  if (auto.stripeSubId) {
    try {
      await stripe.subscriptions.update(auto.stripeSubId, { default_payment_method: pmId });
    } catch (err) {
      console.warn("Autopay sub default-pm update failed:", err.message);
    }
  }
  res.json({ ok: true, paymentMethodId: pmId });
});

// ─── Landlord: one-time Stripe Express onboarding ─────────────────────────────
app.post("/create-connect-onboarding", requireAuth, async (req, res) => {
  const uid = req.uid;
  try {
    const base = webBaseUrl();
    if (!stripeConfigured()) {
      res.status(500).json({ error: "INTERNAL", message: "Stripe is not configured on the server (STRIPE_SECRET_KEY)." });
      return;
    }
    const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);

    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    let accountId = snap.exists ? snap.data()?.stripeAccountId || null : null;

    if (!accountId) {
      // Prefill the business context so Stripe knows this is property
      // management (MCC 6513 = Real Estate Agents/Managers–Rentals) instead
      // of asking the landlord to pick an industry. Everything stays
      // editable in the hosted onboarding.
      const displayName = String(req.token.name || "").trim();
      const [firstName, ...restName] = displayName.split(/\s+/).filter(Boolean);
      const account = await stripe.accounts.create({
        type: "express",
        email: req.token.email || undefined,
        business_type: "individual",
        ...(firstName
          ? {
            individual: {
              first_name: firstName,
              ...(restName.length > 0 ? { last_name: restName.join(" ") } : {}),
              ...(req.token.email ? { email: req.token.email } : {}),
            },
          }
          : {}),
        business_profile: {
          name: "Provalta Property Management",
          product_description: "Collecting rent for rental properties",
          mcc: "6513",
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      accountId = account.id;
      await userRef.set(
        {
          stripeAccountId: accountId,
          stripePayoutsEnabled: false,
          stripeChargesEnabled: false,
          stripeOnboardedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${base}/connect-refresh.html`,
      return_url: `${base}/connect-return.html`,
      type: "account_onboarding",
      collection_options: { fields: "eventually_due", future_requirements: "include" },
    });
    res.json({ url: link.url });
  } catch (err) {
    console.error("Connect onboarding failed:", err.message);
    res.status(500).json({ error: "INTERNAL", message: `Could not start payout onboarding: ${err.message || err}` });
  }
});

// ─── Landlord: current Connect status ─────────────────────────────────────────
app.get("/connect-status", requireAuth, async (req, res) => {
  const uid = req.uid;
  const snap = await db.collection("users").doc(uid).get();
  const data = snap.exists ? snap.data() || {} : {};
  let connected = !!data.stripeAccountId;
  let payoutsEnabled = !!data.stripePayoutsEnabled;
  let chargesEnabled = !!data.stripeChargesEnabled;

  if (connected && stripeConfigured()) {
    try {
      const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
      const acct = await stripe.accounts.retrieve(data.stripeAccountId);
      payoutsEnabled = !!acct.payouts_enabled;
      chargesEnabled = !!acct.charges_enabled;
      await db.collection("users").doc(uid).set(
        {
          stripePayoutsEnabled: payoutsEnabled,
          stripeChargesEnabled: chargesEnabled,
          stripeStatusSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (err) {
      console.warn("Account status sync failed:", err.message);
    }
  }

  res.json({
    connected,
    payoutsEnabled: connected && payoutsEnabled && chargesEnabled,
    accountId: data.stripeAccountId || null,
  });
});

// ─── Landlord: rent payout activity, viewed in-app (no Stripe site needed) ──
// Transfers = rent received into the Stripe balance. Payouts = Stripe sending
// the balance to the bank. Balance = what's sitting there right now.
app.get("/connect-activity", requireAuth, async (req, res) => {
  const snap = await db.collection("users").doc(req.uid).get();
  const accountId = snap.exists ? snap.data()?.stripeAccountId || null : null;
  if (!accountId) {
    res.status(409).json({ error: "FAILED_PRECONDITION", message: "Connect a Stripe payouts account first." });
    return;
  }
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  try {
    const [transfers, payouts, balance, banks, acct] = await Promise.all([
      stripe.transfers.list({ destination: accountId, limit: 20 }),
      stripe.payouts.list({ limit: 10 }, { stripeAccount: accountId }),
      stripe.balance.retrieve({ stripeAccount: accountId }),
      stripe.accounts.listExternalAccounts(accountId, { object: "bank_account", limit: 5 }).catch(() => ({ data: [] })),
      stripe.accounts.retrieve(accountId).catch(() => null),
    ]);
    const bankList = banks.data || [];
    const bank = bankList.find((b) => b.default_for_currency) || bankList[0] || null;
    const sum = (arr) => (arr || []).reduce((t, b) => t + (b.amount || 0), 0);
    res.json({
      balance: {
        available: sum(balance.available),
        pending: sum(balance.pending),
        currency: (balance.available?.[0] || balance.pending?.[0] || {}).currency || "usd",
      },
      payoutSchedule: {
        interval: acct?.settings?.payouts?.schedule?.interval || "daily",
        delayDays: acct?.settings?.payouts?.schedule?.delay_days ?? null,
      },
      bank: bank
        ? { last4: bank.last4 || "••••", bankName: bank.bank_name || "", currency: bank.currency || "usd" }
        : null,
      transfers: (transfers.data || []).map((t) => ({
        id: t.id,
        amount: t.amount,
        currency: t.currency,
        description: t.description || "",
        created: t.created ? new Date(t.created * 1000).toISOString() : null,
      })),
      payouts: (payouts.data || []).map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        arrival: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null,
        created: p.created ? new Date(p.created * 1000).toISOString() : null,
      })),
    });
  } catch (err) {
    console.error("Connect activity failed:", err.message);
    res.status(500).json({ error: "INTERNAL", message: `Could not load payout activity: ${err.message || err}` });
  }
});

// ─── Paid: subscribe one utility to auto bill sync ($20/mo per meter) ─────────
// Billing is per utility key AND per meter: paying for Electric never covers
// Water, and every linked meter carries its own $20/mo subscription (tracked
// per meterUid, never shared). Extra meters always check out (forceNew).
app.post("/create-utility-subscription", requireAuth, async (req, res) => {
  const uid = req.uid;
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);

  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  if (!utilityKey) throw new ApiError(400, "Missing utility (Electric, Water, Gas, Oil, Sewer or Trash).");

  const ent = await getUtilityEntitlement(uid);

  // Already covered → billing portal (manage/cancel), unless this is a NEW
  // meter checkout: each linked meter bills its own $20/mo subscription, so
  // an extra meter always goes through checkout (tagged newMeter for the
  // webhook to park as a pending claim until the meter links).
  const forceNew = req.body?.forceNew === true;
  if (keyCovered(ent, utilityKey) && ent.stripeCustomerId && !forceNew) {
    const url = await createBillingPortal(stripe, ent.stripeCustomerId);
    res.json({ url, alreadyActive: true });
    return;
  }

  let customerId = ent.stripeCustomerId;
  if (!customerId) {
    const snap = await db.collection("users").doc(uid).get();
    customerId = snap.exists ? snap.data()?.stripeCustomerId || null : null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.token.email || undefined,
        metadata: { estateflowUid: uid },
      });
      customerId = customer.id;
      await db.collection("users").doc(uid).set({ stripeCustomerId: customerId }, { merge: true });
    }
  }

  // Meter-only billing: no base plan — the user pays per connected meter.
  // Engine pricing: UtilityAPI meters bill UTILITY_METER_PRICE_ID ($20/mo);
  // NJ (Arcadia) meters bill ARCADIA_METER_PRICE_ID (higher — must clear
  // Arcadia cost + margin, enforced by getPricing, so NJ can never sell
  // at a loss). Metered/usage prices take no quantity.
  const providerUid = String(req.body?.providerUid || "").trim() || null;
  const engine = engineForProvider(providerUid, req.body?.engine);
  let meterPriceId;
  let pricingNote = null;
  if (engine === "arcadia") {
    const pricing = await arcadia.getPricing(stripe);
    meterPriceId = pricing.priceId;
    pricingNote = `NJ auto-sync $${pricing.priceDollars}/mo`;
  } else {
    meterPriceId = (process.env.UTILITY_METER_PRICE_ID || "").trim();
  }
  if (!/^price_[A-Za-z0-9]+$/.test(meterPriceId)) {
    throw new ApiError(
      500,
      engine === "arcadia"
        ? "Per-meter billing is misconfigured. ARCADIA_METER_PRICE_ID must be a Stripe price ID like price_... . Fix it in env vars and redeploy."
        : "Per-meter billing is misconfigured. UTILITY_METER_PRICE_ID must be a Stripe price ID like price_... . Fix it in env vars and redeploy."
    );
  }
  const base = webBaseUrl(); // throws a clear error before hitting Stripe

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    // Flat per-meter price (UtilityAPI $20 / Arcadia NJ higher) → due today.
    line_items: [{ price: meterPriceId, quantity: 1 }],
    subscription_data: {
      metadata: { estateflowUid: uid, utilityKey, engine, ...(providerUid ? { providerUid } : {}), ...(forceNew ? { newMeter: "true" } : {}) },
    },
    metadata: { estateflowUid: uid, utilityKey, engine, ...(providerUid ? { providerUid } : {}), ...(forceNew ? { newMeter: "true" } : {}) },
    success_url: `${base}/utility-return.html?utility=subscribed&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/utility-return.html?utility=canceled`,
  });

  res.json({ url: session.url, alreadyActive: false, engine, pricingNote });
});

// ─── Paid: confirm a just-completed checkout without waiting for webhooks ────
// Webhooks can lag (or be misconfigured); the app calls this when the user
// returns from Stripe so payment flows straight into authorization. It finds
// the user's subscription via the estateflowUid metadata Stripe was given at
// checkout (or a specific session id), activates the entitlement exactly like
// the webhook would, and reports whether it's live yet.
async function findActiveUtilitySub(stripe, uid, customerId, utilityKey) {
  const isLive = (s) =>
    (s.status === "active" || s.status === "trialing") &&
    s.metadata?.estateflowUid === uid &&
    (!utilityKey || s.metadata?.utilityKey === utilityKey);
  // Direct customer lookup first: strongly consistent, no search-index lag,
  // so a subscription created seconds ago is visible immediately.
  if (customerId) {
    try {
      const subs = await stripe.subscriptions.list({ customer: customerId, limit: 10, status: "all" });
      const all = subs.data || [];
      const hit = all.find(isLive);
      if (hit) return { sub: hit, checked: all.length };
      return { sub: null, checked: all.length, searched: false };
    } catch (err) {
      console.warn("Customer subscription list failed:", err.message);
    }
  }
  // Fallback: metadata search (indexed, can lag a few seconds on new subs).
  const found = await stripe.subscriptions.search({
    query: `metadata['estateflowUid']:'${uid}'`,
    limit: 10,
  });
  const all = found.data || [];
  return { sub: all.find(isLive) || null, checked: all.length, searched: true };
}

app.post("/confirm-utility-subscription", requireAuth, async (req, res) => {
  const uid = req.uid;
  // Which utility is being paid for (optional; falls back to overall status).
  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  const before = await getUtilityEntitlement(uid);
  const covered = (ent) => (utilityKey ? keyCovered(ent, utilityKey) : ent.active);
  if (covered(before)) {
    // Verify the stored flag against Stripe: a canceled subscription whose
    // delete-webhook never arrived would otherwise skip payment forever.
    // A stale record is healed here so the user lands on the pay card.
    try {
      const rec = utilityKey ? before.subs?.[utilityKey] : null;
      const subId = rec?.stripeSubId || before.ua?.stripeSubId;
      if (subId && stripeConfigured()) {
        const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
        let live = null;
        try {
          live = await stripe.subscriptions.retrieve(subId);
        } catch (err) {
          if (err?.code === "resource_missing" || /no such subscription/i.test(err?.message || "")) {
            live = { status: "canceled", id: subId, customer: before.ua?.stripeCustomerId || null };
          } else {
            throw err;
          }
        }
        if (live) {
          const stillActive = live.status === "active" || live.status === "trialing";
          if (!stillActive) {
            await setUtilitySubscription(uid, live, utilityKey);
            res.json({ active: false, healed: true });
            return;
          }
        }
      }
    } catch (err) {
      console.warn("Subscription verify failed, trusting stored flag:", err.message);
    }
    res.json({ active: true, alreadyActive: true });
    return;
  }
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const sessionId = String(req.body?.sessionId || "").trim();
  let sub = null;
  let detail = "no matching subscription found";
  if (sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
      const candidate = session.subscription && typeof session.subscription === "object" ? session.subscription : null;
      if (
        candidate &&
        candidate.metadata?.estateflowUid === uid &&
        (!utilityKey || candidate.metadata?.utilityKey === utilityKey) &&
        (candidate.status === "active" || candidate.status === "trialing")
      ) {
        sub = candidate;
      } else {
        detail = "checkout session has no active subscription for this user yet";
      }
    } catch (err) {
      console.warn("Checkout session lookup failed:", err.message);
      detail = "could not read the checkout session";
    }
  }
  if (!sub) {
    try {
      let customerId = before.ua?.stripeCustomerId || null;
      if (!customerId) {
        const snap = await db.collection("users").doc(uid).get();
        customerId = snap.exists ? snap.data()?.stripeCustomerId || null : null;
      }
      if (!customerId) {
        detail = "no Stripe customer on file for this user";
      } else {
        const found = await findActiveUtilitySub(stripe, uid, customerId, utilityKey);
        sub = found.sub;
        if (!sub) {
          detail = found.searched
            ? "subscription search found nothing for this user yet"
            : `checked ${found.checked} subscription(s) on file, none active for this user`;
        }
      }
    } catch (err) {
      console.warn("Subscription lookup failed:", err.message);
      detail = "subscription lookup failed";
    }
  }
  if (!sub) {
    res.json({ active: false, detail });
    return;
  }
  await setUtilitySubscription(uid, sub);
  res.json({ active: true });
});

// ─── Paid: current auto-sync subscription status + portal link ────────────────
async function buildUtilityStatus(uid) {
  const ent = await getUtilityEntitlement(uid);

  let portalUrl = null;
  if (ent.active && ent.stripeCustomerId && stripeConfigured()) {
    try {
      portalUrl = await createBillingPortal(stripeFactory(process.env.STRIPE_SECRET_KEY), ent.stripeCustomerId);
    } catch (err) {
      console.warn("Billing portal session failed:", err.message);
    }
  }

  const limit = meterLimit();
  const linked = await countLinkedMeters(uid);

  const subscriptions = {};
  const toIso = (v) => {
    const d = v?.toDate?.() || v || null;
    return d instanceof Date ? d.toISOString() : d || null;
  };
  for (const key of UTILITY_KEYS) {
    const rec = ent.subs?.[key];
    const billed = billedMeterCount(ent, key);
    const pending = pendingMeterCount(ent, key);
    if (rec) {
      subscriptions[key] = {
        active: subRecordActive(rec),
        currentPeriodEnd: toIso(rec.currentPeriodEnd),
        cancelAtPeriodEnd: !!rec.cancelAtPeriodEnd,
        cancelAt: toIso(rec.cancelAt),
        billedMeters: billed,
        pendingMeters: pending,
      };
    } else {
      subscriptions[key] = { active: false, currentPeriodEnd: null, cancelAtPeriodEnd: false, cancelAt: null, billedMeters: billed, pendingMeters: pending };
    }
  }

  return {
    active: ent.active,
    plan: ent.active ? ent.ua.plan || "utility-auto" : null,
    currentPeriodEnd: ent.currentPeriodEnd ? ent.currentPeriodEnd.toISOString() : null,
    portalUrl,
    meterLimit: limit,
    linkedMeters: linked.count,
    subscriptions,
    activeKeys: ent.activeKeys,
  };
}

app.get("/utility-subscription-status", requireAuth, async (req, res) => {
  res.json(await buildUtilityStatus(req.uid));
});

// ─── Paid: reconcile every stored subscription against Stripe ────────────────
// Cancellations made outside the app (or missed webhooks) leave ghost "active"
// records behind. This re-reads each one from Stripe and persists the truth,
// so the app never shows coverage that no longer exists.
app.post("/reconcile-utility-subscriptions", requireAuth, async (req, res) => {
  const uid = req.uid;
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const ent = await getUtilityEntitlement(uid);
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const seen = new Set();
  const wasActive = {};
  for (const key of UTILITY_KEYS) wasActive[key] = subRecordActive(ent.subs?.[key]);
  const check = async (subId, keyHint) => {
    if (!subId || seen.has(subId)) return;
    seen.add(subId);
    try {
      const live = await stripe.subscriptions.retrieve(subId);
      await setUtilitySubscription(uid, live, keyHint);
      // Just ended (covers the missed-webhook case): stop UtilityAPI
      // collection for the key. No-op if still covered.
      const nowActive = live.status === "active" || live.status === "trialing";
      if (keyHint && wasActive[keyHint] && !nowActive) {
        await stopMonitoringForEndedKey(uid, keyHint);
      }
    } catch (err) {
      if (err?.code === "resource_missing" || /no such subscription/i.test(err?.message || "")) {
        await setUtilitySubscription(
          uid,
          {
            status: "canceled",
            id: subId,
            customer: ent.ua?.stripeCustomerId || ent.stripeCustomerId || null,
          },
          keyHint
        );
        if (keyHint && wasActive[keyHint]) {
          await stopMonitoringForEndedKey(uid, keyHint);
        }
      } else {
        console.warn("Reconcile retrieve failed:", err.message);
      }
    }
  };
  for (const key of UTILITY_KEYS) {
    const rec = ent.subs?.[key];
    if (rec?.stripeSubId) await check(rec.stripeSubId, key);
  }
  if (ent.ua?.stripeSubId) await check(ent.ua.stripeSubId, null);
  // Per-meter records + pending claims: re-verify every known subscription id
  // against Stripe so meter coverage can never go stale. setUtilitySubscription
  // routes each live object back to its own record via metadata.
  try {
    const fresh = await getUtilityEntitlement(uid);
    const ids = new Set();
    for (const key of UTILITY_KEYS) {
      const rec = fresh.subs?.[key];
      if (rec?.stripeSubId) ids.add(rec.stripeSubId);
      for (const m of Object.values((fresh.ua.meterSubs || {}))) {
        if (m && m.stripeSubId) ids.add(m.stripeSubId);
      }
      for (const id of (fresh.ua.pendingMeterSubs || {})[key] || []) ids.add(id);
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const live = await stripe.subscriptions.retrieve(id);
        await setUtilitySubscription(uid, live);
      } catch (e) {
        if (e?.code === "resource_missing" || /no such subscription/i.test(e?.message || "")) {
          await setUtilitySubscription(uid, { status: "canceled", id, customer: fresh.ua?.stripeCustomerId || null });
        } else {
          console.warn("Reconcile meter retrieve failed:", e.message);
        }
      }
    }
  } catch (e) {
    console.warn("Reconcile meter sweep failed:", e?.message || e);
  }
  res.json(await buildUtilityStatus(uid));
});

// ─── Paid: cancel (or resume) one utility's subscription, in-app ─────────────
// Canceling sets cancel_at_period_end so access runs to the paid-through date
// instead of cutting off instantly. Resume clears it. Canceling a key also
// cancels every per-meter subscription under it (no orphan billing).
app.post("/cancel-utility-subscription", requireAuth, async (req, res) => {
  const uid = req.uid;
  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  if (!utilityKey) throw new ApiError(400, "Missing utility (Electric, Water, Gas, Oil, Sewer or Trash).");
  const resume = req.body?.resume === true;
  const ent = await getUtilityEntitlement(uid);
  const rec = ent.subs?.[utilityKey];
  const subId = rec?.stripeSubId;
  if (!subId) {
    throw new ApiError(404, `No subscription found for ${utilityKey}.`);
  }
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const subIds = new Set([subId]);
  for (const e of Object.values(ent.ua.meterSubs || {})) {
    if (e && e.utilityKey === utilityKey && e.stripeSubId) subIds.add(e.stripeSubId);
  }
  let updated = null;
  for (const id of subIds) {
    try {
      const u = await stripe.subscriptions.update(id, { cancel_at_period_end: !resume });
      await setUtilitySubscription(uid, u);
      if (id === subId) updated = u;
    } catch (err) {
      console.warn("Key-cancel sub update failed:", err?.message || err);
    }
  }
  if (!updated) throw new ApiError(404, `No subscription found for ${utilityKey}.`);
  const end = updated.current_period_end ? new Date(updated.current_period_end * 1000).toISOString() : null;
  res.json({
    active: updated.status === "active" || updated.status === "trialing",
    cancelAtPeriodEnd: !!updated.cancel_at_period_end,
    currentPeriodEnd: end,
  });
});

// ─── Paid: cancel (or resume) ONE meter's own subscription ───────────────────
async function cancelMeterSub(uid, meterUid, resume, isTenant) {
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const ent = await getUtilityEntitlement(uid);
  const entry = (ent.ua.meterSubs || {})[meterUid];
  if (!entry?.stripeSubId) throw new ApiError(404, "No separate subscription found for this meter.");
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const updated = await stripe.subscriptions.update(entry.stripeSubId, { cancel_at_period_end: !resume });
  await setUtilitySubscription(uid, updated);
  const end = updated.current_period_end ? new Date(updated.current_period_end * 1000).toISOString() : null;
  if (!resume) {
    // Stop collection for just this meter when nothing else covers it.
    try {
      const fresh = await getUtilityEntitlement(uid);
      const stillCovered = meterSubCovered(fresh, entry.utilityKey, meterUid);
      if (!stillCovered) await utilityApi.stopMeterMonitoring([meterUid]);
    } catch (e) {
      console.warn("meter stop-monitoring failed:", e?.message || e);
    }
  }
  return {
    active: updated.status === "active" || updated.status === "trialing",
    cancelAtPeriodEnd: !!updated.cancel_at_period_end,
    currentPeriodEnd: end,
  };
}

// Landlord: meter must live on one of their properties.
app.post("/cancel-meter-subscription", requireAuth, async (req, res) => {
  const meterUid = String(req.body?.meterUid || "").trim();
  if (!meterUid) throw new ApiError(400, "Missing meterUid.");
  const keys = await findUtilityKeysForMeter(req.uid, meterUid);
  if (keys.length === 0) throw new ApiError(404, "Meter not found on your properties.");
  res.json(await cancelMeterSub(req.uid, meterUid, req.body?.resume === true, false));
});

// ─── Billing hub: payment methods, profile, invoices (in-app Stripe) ─────────
// Lets users manage everything without leaving the app. All calls run on the
// user's own Stripe customer record; secrets never leave the server.
function billingStripe() {
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  return stripeFactory(process.env.STRIPE_SECRET_KEY);
}

async function getBillingCustomerId(uid) {
  const ent = await getUtilityEntitlement(uid);
  let customerId = ent.stripeCustomerId || null;
  if (!customerId) {
    const snap = await db.collection("users").doc(uid).get();
    customerId = snap.exists ? snap.data()?.stripeCustomerId || null : null;
  }
  if (!customerId) {
    throw new ApiError(404, "No billing account yet — subscribe to a utility first.");
  }
  return customerId;
}

function customerDefaultPm(customer) {
  if (!customer || typeof customer === "string") return null;
  const def = customer.invoice_settings?.default_payment_method;
  return typeof def === "string" ? def : def?.id || null;
}

app.get("/billing-payment-methods", requireAuth, async (req, res) => {
  const stripe = billingStripe();
  const customerId = await getBillingCustomerId(req.uid);
  const [customer, pms] = await Promise.all([
    stripe.customers.retrieve(customerId),
    stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 20 }),
  ]);
  if (typeof customer !== "string" && customer.deleted) {
    throw new ApiError(404, "Billing account not found.");
  }
  const def = customerDefaultPm(customer);
  res.json({
    methods: (pms.data || []).map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand || "card",
      last4: pm.card?.last4 || "••••",
      expMonth: pm.card?.exp_month || null,
      expYear: pm.card?.exp_year || null,
      isDefault: pm.id === def,
    })),
  });
});

app.post("/billing-payment-methods/default", requireAuth, async (req, res) => {
  const stripe = billingStripe();
  const customerId = await getBillingCustomerId(req.uid);
  const paymentMethodId = String(req.body?.paymentMethodId || "").trim();
  if (!paymentMethodId) throw new ApiError(400, "Missing paymentMethodId.");
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  res.json({ ok: true });
});

app.post("/billing-payment-methods/detach", requireAuth, async (req, res) => {
  const stripe = billingStripe();
  const customerId = await getBillingCustomerId(req.uid);
  const paymentMethodId = String(req.body?.paymentMethodId || "").trim();
  if (!paymentMethodId) throw new ApiError(400, "Missing paymentMethodId.");
  const customer = await stripe.customers.retrieve(customerId);
  if (customerDefaultPm(customer) === paymentMethodId) {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: "" },
    });
  }
  await stripe.paymentMethods.detach(paymentMethodId);
  res.json({ ok: true });
});

// Hosted card-collection for adding a card (Setup mode: no charge).
app.post("/billing-payment-methods/setup", requireAuth, async (req, res) => {
  const stripe = billingStripe();
  const customerId = await getBillingCustomerId(req.uid);
  const base = webBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    payment_method_types: ["card"],
    success_url: `${base}/utility-return.html?billing=setup&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/utility-return.html?billing=canceled`,
  });
  res.json({ url: session.url });
});

app.get("/billing-profile", requireAuth, async (req, res) => {
  const stripe = billingStripe();
  const customer = await stripe.customers.retrieve(await getBillingCustomerId(req.uid));
  if (typeof customer === "string" || customer.deleted) {
    throw new ApiError(404, "Billing account not found.");
  }
  res.json({
    name: customer.name || "",
    email: customer.email || "",
    phone: customer.phone || "",
    address: {
      line1: customer.address?.line1 || "",
      line2: customer.address?.line2 || "",
      city: customer.address?.city || "",
      state: customer.address?.state || "",
      postalCode: customer.address?.postal_code || "",
      country: customer.address?.country || "",
    },
  });
});

app.post("/billing-profile", requireAuth, async (req, res) => {
  const stripe = billingStripe();
  const customerId = await getBillingCustomerId(req.uid);
  const body = req.body || {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const patch = {};
  if (typeof body.name === "string") patch.name = str(body.name);
  if (typeof body.phone === "string") patch.phone = str(body.phone);
  if (typeof body.email === "string" && /.+@.+\..+/.test(body.email.trim())) {
    patch.email = body.email.trim();
  }
  if (body.address && typeof body.address === "object") {
    const current = await stripe.customers.retrieve(customerId);
    const cur = typeof current === "string" || current.deleted ? {} : current.address || {};
    patch.address = {
      line1: body.address.line1 !== undefined ? str(body.address.line1) : cur.line1 || "",
      line2: body.address.line2 !== undefined ? str(body.address.line2) : cur.line2 || "",
      city: body.address.city !== undefined ? str(body.address.city) : cur.city || "",
      state: body.address.state !== undefined ? str(body.address.state) : cur.state || "",
      postal_code: body.address.postalCode !== undefined ? str(body.address.postalCode) : cur.postal_code || "",
      country: body.address.country !== undefined ? str(body.address.country).toUpperCase() : cur.country || "",
    };
  }
  if (Object.keys(patch).length === 0) throw new ApiError(400, "Nothing to update.");
  await stripe.customers.update(customerId, patch);
  res.json({ ok: true });
});

app.get("/billing-invoices", requireAuth, async (req, res) => {
  const stripe = billingStripe();
  const customerId = await getBillingCustomerId(req.uid);
  const rawLimit = Number(req.query?.limit);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 10, 1), 25);
  const inv = await stripe.invoices.list({ customer: customerId, limit });
  res.json({
    invoices: (inv.data || []).map((i) => ({
      id: i.id,
      number: i.number || "",
      description: i.lines?.data?.[0]?.description || "",
      amountDue: i.amount_due ?? 0,
      amountPaid: i.amount_paid ?? 0,
      currency: i.currency || "usd",
      status: i.status || "",
      created: i.created ? new Date(i.created * 1000).toISOString() : null,
      hostedUrl: i.hosted_invoice_url || null,
      pdfUrl: i.invoice_pdf || null,
    })),
  });
});

// ─── Provider catalog for the in-app picker (no subscription needed — users
// pick a provider BEFORE paying, so this stays outside the entitlement gate).
let supportedUtilitiesCache = { at: 0, data: null };
app.get("/supported-utilities", requireAuth, async (req, res) => {
  if (Date.now() - supportedUtilitiesCache.at < 3600000 && supportedUtilitiesCache.data) {
    res.json(supportedUtilitiesCache.data);
    return;
  }
  const list = await utilityApi.listUtilities();
  supportedUtilitiesCache = { at: Date.now(), data: list };
  res.json(list);
});

// ─── Paid: start the UtilityAPI authorization (returns a browser URL) ─────────
// Accepts an optional { utilityUid } so the hosted page opens straight on the
// provider the user already picked in the app.
app.post("/create-utility-auth-form", requireAuth, async (req, res) => {
  const uid = req.uid;
  const ent = await getUtilityEntitlement(uid);
  assertUtilityEntitlement(ent);

  const linked = await countLinkedMeters(uid);
  assertUnderMeterLimit(linked.count, meterLimit());

  // Per-utility gate: this key must have its own active subscription. The
  // key is REQUIRED (no keyless path) so no client can bypass per-key payment.
  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  if (!utilityKey) {
    throw new ApiError(400, "Utility is required (Electric, Water, Gas, Oil, Sewer or Trash). Update the app and try again.");
  }
  assertUtilityEntitlementForKey(ent, utilityKey);

  const utilityUid = String(req.body?.utilityUid || "").trim();
  const data = await utilityApi.createAuthForm(utilityUid || null);
  res.json(data);
});

// ─── Paid: has the user finished the provider sign-in for this form? ────────
// Powers the Connect screen's auto-advance: it polls this after opening the
// provider tab and auto-finishes linking — no manual "finish" tap needed.
app.get("/auth-form-status", requireAuth, async (req, res) => {
  const ent = await getUtilityEntitlement(req.uid);
  assertUtilityEntitlement(ent);
  const formUid = String(req.query?.formUid || "").trim();
  if (!formUid) throw new ApiError(400, "Missing formUid.");
  res.json(await utilityApi.checkAuthFormStatus({ formUid }));
});

// ─── Paid: finish linking an authorization and return bill data ───────────────
app.post("/link-utility-auto", requireAuth, async (req, res) => {
  const uid = req.uid;
  const ent = await getUtilityEntitlement(uid);
  assertUtilityEntitlement(ent);

  const formUid = String(req.body?.formUid || "").trim();
  if (!formUid) throw new ApiError(400, "Missing formUid.");

  // Per-utility gate: linking this key needs its own active subscription.
  // Each subscription is flat $20/mo, so no quantity syncing is needed.
  // The key is REQUIRED (no keyless path) so no client can bypass payment.
  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  if (!utilityKey) {
    throw new ApiError(400, "Utility is required (Electric, Water, Gas, Oil, Sewer or Trash). Update the app and try again.");
  }
  assertUtilityEntitlementForKey(ent, utilityKey);

  const { count, meterUids } = await countLinkedMeters(uid);
  assertUnderMeterLimit(count, meterLimit());

  const data = await utilityApi.linkForProperty({ formUid });
  if (data.meterUid && !meterUids.has(String(data.meterUid))) {
    assertUnderMeterLimit(count + 1, meterLimit());
  }
  // Per-meter billing: the new meter claims a paid checkout (or the key's
  // first subscription). Throws 403 when nothing was paid for it.
  let billedMeters = 1;
  if (data.meterUid) {
    await claimMeterSub(uid, utilityKey, String(data.meterUid));
    const after = await getUtilityEntitlement(uid);
    billedMeters = billedMeterCount(after, utilityKey);
  }
  res.json({ ...data, billedMeters });
});

// ─── Paid: refresh one already-linked meter's bill ────────────────────────────
app.post("/refresh-utility-auto", requireAuth, async (req, res) => {
  const uid = req.uid;
  const ent = await getUtilityEntitlement(req.uid);
  assertUtilityEntitlement(ent);

  const meterUid = String(req.body?.meterUid || "").trim();
  if (!meterUid) throw new ApiError(400, "Missing meterUid.");

  // Per-meter gate: the meter must be covered by its key's subscription.
  // Falls back to any-active when the meter isn't found (e.g. not saved to
  // a property).
  const keys = await findUtilityKeysForMeter(uid, meterUid);
  if (keys.length > 0 && !keys.some((k) => meterSubCovered(ent, k, meterUid))) {
    throw new ApiError(
      403,
      `The subscription covering this utility is no longer active. Reconnect it ($20/month per meter) or enter bills manually.`
    );
  }

  // Engine routing: `arcadia:` meters refresh from Arcadia Plug (monthly
  // statements keep flowing after link + webhook auto-update); everything
  // else refreshes from UtilityAPI as before.
  if (isArcadiaMeterUid(meterUid)) {
    const bill = await arcadia.refreshBill(arcadiaExternalId(meterUid));
    res.json({ amount: bill.amount, provider: bill.provider, dueDay: bill.dueDay, engine: "arcadia" });
    return;
  }

  const data = await utilityApi.refreshMeter({ meterUid });
  res.json(data);
});

// ─── Arcadia NJ auto-sync ───────────────────────────────────────────────────
// Same shape as the UtilityAPI flow, but for NJ providers via Arcadia Plug:
// pricing (margin-guarded) → connect (browser credential handoff) → link
// (latest statement) → refresh + monthly webhook auto-update. UtilityAPI's
// $20/mo path is untouched.

// What the app shows on NJ provider rows ($/mo, engine). No sub needed.
app.get("/arcadia-pricing", requireAuth, async (req, res) => {
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  res.json(await arcadia.getPricing(stripe));
});

// Arcadia provider catalog (for mapping NJ uids → providerIds). Authed.
app.get("/arcadia-providers", requireAuth, async (req, res) => {
  const list = await arcadia.listProviders();
  res.json(
    list.map((p) => ({ id: p.id || p.providerId, name: p.name || p.providerName })).filter((p) => p.id && p.name)
  );
});

// Start an NJ credential handoff: returns a browser URL + correlationId.
// Stores the mapping so the monthly webhook can route back to this user.
app.post("/arcadia-connect", requireAuth, async (req, res) => {
  const uid = req.uid;
  const ent = await getUtilityEntitlement(uid);
  assertUtilityEntitlement(ent);
  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  if (!utilityKey) throw new ApiError(400, "Utility is required (Electric, Water, Gas, Oil, Sewer or Trash).");
  assertUtilityEntitlementForKey(ent, utilityKey);
  const linked = await countLinkedMeters(uid);
  assertUnderMeterLimit(linked.count, meterLimit());
  const providerUid = String(req.body?.providerUid || "").trim();
  if (!isNjProviderUid(providerUid)) {
    throw new ApiError(400, "Arcadia connect is for NJ providers only (PSE&G, JCP&L, Atlantic City Electric…).");
  }
  const correlationId = arcadia.newCorrelationId(uid);
  const conn = await arcadia.createConnect(correlationId);
  await db.collection("users").doc(uid).set(
    { arcadiaLinks: { [correlationId]: { utilityKey, providerUid, createdAt: admin.firestore.FieldValue.serverTimestamp() } } },
    { merge: true }
  );
  res.json({ ...conn, providerUid, utilityKey });
});

// Has the NJ provider sign-in finished? (for polling)
app.get("/arcadia-status", requireAuth, async (req, res) => {
  const ent = await getUtilityEntitlement(req.uid);
  assertUtilityEntitlement(ent);
  const correlationId = String(req.query?.correlationId || "").trim();
  if (!correlationId) throw new ApiError(400, "Missing correlationId.");
  res.json(await arcadia.checkConnectStatus(correlationId));
});

// Finish NJ linking: pull the latest Arcadia statement into bill data.
app.post("/link-arcadia", requireAuth, async (req, res) => {
  const uid = req.uid;
  const ent = await getUtilityEntitlement(uid);
  assertUtilityEntitlement(ent);
  const utilityKey = normalizeUtilityKey(req.body?.utilityKey);
  if (!utilityKey) throw new ApiError(400, "Utility is required (Electric, Water, Gas, Oil, Sewer or Trash).");
  assertUtilityEntitlementForKey(ent, utilityKey);
  const correlationId = String(req.body?.correlationId || "").trim();
  if (!correlationId) throw new ApiError(400, "Missing correlationId.");
  const { count, meterUids } = await countLinkedMeters(uid);
  assertUnderMeterLimit(count, meterLimit());
  const bill = await arcadia.latestBill({ correlationId });
  const meterUid = `arcadia:${bill.externalId}`;
  if (!meterUids.has(meterUid)) assertUnderMeterLimit(count + 1, meterLimit());
  await db.collection("users").doc(uid).set(
    {
      arcadiaLinks: {
        [correlationId]: {
          utilityKey,
          externalId: bill.externalId,
          meterUid,
          linkedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
    },
    { merge: true }
  );
  let billedMeters = 1;
  await claimMeterSub(uid, utilityKey, meterUid);
  const after = await getUtilityEntitlement(uid);
  billedMeters = billedMeterCount(after, utilityKey);
  res.json({ amount: bill.amount, provider: bill.provider, dueDay: bill.dueDay, meterUid, billedMeters, engine: "arcadia" });
});

// Monthly engine: Arcadia posts here on new statements. We resolve the
// correlation mapping → user's properties → matching `arcadia:` meter and
// write the fresh bill in, so NJ data shows up without manual entry.
app.post("/arcadia-webhook", async (req, res) => {
  try {
    const secret = (process.env.ARCADIA_WEBHOOK_SECRET || "").trim();
    if (secret) {
      const got = String(req.get("x-arcadia-signature") || req.get("x-webhook-secret") || "");
      if (got !== secret) {
        res.status(401).json({ error: "UNAUTHORIZED", message: "Bad webhook signature." });
        return;
      }
    }
    const body = req.body || {};
    const correlationId =
      body.correlationId || body.correlation_id || body.data?.correlationId || body.data?.credential?.correlationId || null;
    const eventType = body.eventType || body.event_type || body.type || "unknown";
    console.log(`Arcadia webhook: ${eventType} correlation=${correlationId || "none"}`);
    if (!correlationId) {
      res.json({ ok: true, skipped: "no-correlation" });
      return;
    }
    // Find the owner via the stored connect mapping.
    const usersSnap = await db.collection("users").where(`arcadiaLinks.${correlationId}.utilityKey`, "!=", null).limit(1).get();
    // Firestore can't query dynamic map keys with !=; fall back to scan of
    // recent linkers via collection group on properties instead: match the
    // externalId embedded in the event.
    let ownerUid = null;
    let mapping = null;
    if (!usersSnap.empty) {
      ownerUid = usersSnap.docs[0].id;
      mapping = usersSnap.docs[0].data()?.arcadiaLinks?.[correlationId];
    } else {
      const allUsers = await db.collection("users").limit(500).get();
      for (const doc of allUsers.docs) {
        const m = doc.data()?.arcadiaLinks?.[correlationId];
        if (m) {
          ownerUid = doc.id;
          mapping = m;
          break;
        }
      }
    }
    if (!ownerUid || !mapping?.externalId) {
      res.json({ ok: true, skipped: "no-mapping" });
      return;
    }
    let bill;
    try {
      bill = await arcadia.refreshBill(mapping.externalId);
    } catch (e) {
      console.warn("Arcadia webhook refresh failed:", e?.message || e);
      res.json({ ok: true, skipped: "no-bill" });
      return;
    }
    const meterUid = `arcadia:${mapping.externalId}`;
    const props = await db.collection("properties").where("ownerId", "==", ownerUid).get();
    let updated = 0;
    for (const doc of props.docs) {
      const data = doc.data() || {};
      const utilities = { ...(data.utilities || {}) };
      let touched = false;
      for (const [key, u] of Object.entries(utilities)) {
        if (!u || typeof u !== "object") continue;
        const matches =
          u.meterUid === meterUid ||
          (Array.isArray(u.meters) && u.meters.some((m) => m && m.meterUid === meterUid));
        if (!matches) continue;
        const setBill = (b) => ({
          ...b,
          amount: bill.amount,
          provider: bill.provider || b.provider,
          dueDay: bill.dueDay || b.dueDay,
          auto: true,
        });
        if (u.meterUid === meterUid) {
          utilities[key] = setBill(u);
          touched = true;
        }
        if (Array.isArray(u.meters)) {
          utilities[key] = {
            ...utilities[key],
            amount: bill.amount,
            provider: bill.provider || u.provider,
            auto: true,
            meters: u.meters.map((m) => (m && m.meterUid === meterUid ? setBill(m) : m)),
          };
          touched = true;
        }
      }
      if (touched) {
        await doc.ref.set({ utilities, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        updated += 1;
      }
    }
    res.json({ ok: true, updatedProperties: updated, amount: bill.amount });
  } catch (err) {
    console.error("Arcadia webhook failed:", err?.message || err);
    res.status(500).json({ error: "INTERNAL", message: "Webhook handling failed." });
  }
});

/** Which utility keys use this meter across the user's properties? */
async function findUtilityKeysForMeter(uid, meterUid) {
  const snap = await db.collection("properties").where("ownerId", "==", uid).get();
  const keys = new Set();
  snap.docs.forEach((doc) => {
    const utilities = doc.data()?.utilities || {};
    Object.entries(utilities).forEach(([key, u]) => {
      if (!UTILITY_KEYS.includes(key)) return;
      let found = false;
      eachLinkedMeterUid(u, (id) => {
        if (id === String(meterUid)) found = true;
      });
      if (found) keys.add(key);
    });
  });
  return [...keys];
}

/**
 * Stop UtilityAPI collection for a utility whose paid period just ended.
 * Non-destructive (synced bills stay) and skipped while the key is still
 * covered (late webhooks, resubscribes) or when a meter is shared with
 * another still-covered key. Never throws — callers must not fail on this.
 */
async function stopMonitoringForEndedKey(uid, key) {
  try {
    if (!key || !UTILITY_KEYS.includes(key)) return;
    const ent = await getUtilityEntitlement(uid);
    if (keyCovered(ent, key)) return;
    const snap = await db.collection("properties").where("ownerId", "==", uid).get();
    const wanted = new Set();
    snap.docs.forEach((doc) => {
      eachLinkedMeterUid(doc.data()?.utilities?.[key], (id) => wanted.add(id));
    });
    if (wanted.size === 0) return;
    const stoppable = [];
    for (const id of wanted) {
      const keys = await findUtilityKeysForMeter(uid, id);
      const sharedCovered = keys.some((k) => k !== key && keyCovered(ent, k));
      if (!sharedCovered) stoppable.push(id);
    }
    if (stoppable.length === 0) return;
    await utilityApi.stopMeterMonitoring(stoppable);
    console.log(`Stopped UtilityAPI monitoring for ${stoppable.length} meter(s) of ${key}.`);
    const { archived } = await utilityApi.archiveMeterAuthorizations(stoppable);
    if (archived.length > 0) {
      console.log(`Archived ${archived.length} UtilityAPI authorization(s) for ${key}.`);
    }
  } catch (e) {
    console.warn("stopMonitoringForEndedKey failed:", e?.message || e);
  }
}

// ─── Plans: Stripe Checkout from the marketing site ───────────────────────────
app.post("/create-plan-checkout", async (req, res) => {
  try {
    const plan = String(req.body?.plan || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!PLAN_META[plan]) throw new ApiError(400, "Unknown plan.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, "Enter a valid email address.");
    }
    if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");

    const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
    const base = webBaseUrl();
    const lineItems = [{ quantity: 1, price: planPriceId(plan) }];
    // Optional metered add-on ($20/meter/month) for the Auto-Sync plan.
    const meterPriceId = process.env.UTILITY_METER_PRICE_ID || "";
    if (plan === "autosync" && meterPriceId) lineItems.push({ price: meterPriceId });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: lineItems,
      subscription_data: { metadata: { kind: "plan", plan, email } },
      metadata: { kind: "plan", plan, email },
      success_url: `${base}/index.html?checkout=success&plan=${plan}`,
      cancel_url: `${base}/index.html?checkout=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: "APPLICATION_ERROR", message: err.message });
      return;
    }
    console.error("Plan checkout failed:", err.message);
    res.status(500).json({ error: "INTERNAL", message: "Could not start checkout. Please try again." });
  }
});

// ─── Plans: the signed-in user's entitlements (gates app features) ────────────
app.get("/plan-status", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const email = String(req.token.email || "").trim().toLowerCase();
    const snap = await db.collection("users").doc(uid).get();
    const data = snap.exists ? snap.data() || {} : {};
    let plan = data.planStatus?.plan || null;
    let active = !!data.planStatus?.active;
    const periodEnd =
      data.planStatus?.currentPeriodEnd?.toDate?.() || data.planStatus?.currentPeriodEnd || null;
    if (active && periodEnd && periodEnd.getTime() < Date.now()) active = false;

    // Subscribed from the website before creating an account? Merge it in.
    if (email) {
      const subSnap = await db.collection("planSubscriptions").doc(email).get();
      if (subSnap.exists) {
        const s = subSnap.data() || {};
        const sEnd = s.currentPeriodEnd?.toDate?.() || s.currentPeriodEnd || null;
        const sActive = !!s.active && (!sEnd || sEnd.getTime() >= Date.now());
        if (sActive && planTier(s.plan) >= (active ? planTier(plan) : 0)) {
          plan = s.plan;
          active = true;
          await db
            .collection("users")
            .doc(uid)
            .set({ planStatus: { ...s }, plan: s.plan }, { merge: true });
        }
      }
    }

    // A legacy utility auto-sync subscription also unlocks the Auto-Sync tier.
    const ua = data.utilityAuto || {};
    const uaEnd = ua.currentPeriodEnd?.toDate?.() || ua.currentPeriodEnd || null;
    const uaActive = !!ua.active && (!uaEnd || uaEnd.getTime() >= Date.now());
    const tier = Math.max(active ? planTier(plan) : 0, uaActive ? 3 : 0);
    const effectivePlan = tier === 0 ? null : tier >= 3 ? "autosync" : plan;

    res.json({
      plan: effectivePlan,
      tier,
      active: tier > 0,
      features: {
        exports: tier >= 2, // Excel exports — Professional+
        portal: tier >= 2, // Tenant portal website — Professional+
        autosync: tier >= 3, // Utility auto-sync — Auto-Sync only
      },
      websiteUrl: (process.env.WEB_BASE_URL || "").replace(/\/+$/, "") || null,
    });
  } catch (err) {
    console.error("Plan status failed:", err.message);
    res.status(500).json({ error: "INTERNAL", message: "Could not load your plan." });
  }
});

// ─── Plans: does this tenant's landlord include the portal? ───────────────────
app.get("/portal-entitlement", requireAuth, async (req, res) => {
  try {
    const email = String(req.token.email || "").trim().toLowerCase();
    if (!email) {
      res.json({ linked: false, plan: null, portalAccess: false });
      return;
    }
    const snap = await db
      .collection("tenants")
      .where("tenantEmail", "==", email)
      .limit(1)
      .get();
    if (snap.empty) {
      res.json({ linked: false, plan: null, portalAccess: false });
      return;
    }
    const tenant = snap.docs[0].data() || {};
    const tier = tenant.ownerId ? await getOwnerPlanTier(tenant.ownerId) : 0;
    const plan = tier >= 3 ? "autosync" : tier === 2 ? "professional" : tier === 1 ? "starter" : null;
    res.json({ linked: true, plan, portalAccess: tier >= 2 });
  } catch (err) {
    console.error("Portal entitlement failed:", err.message);
    res.status(500).json({ error: "INTERNAL", message: "Could not check portal access." });
  }
});

/** Record one autopay cycle: month derived from the invoice period. */
async function recordRentAutopayInvoice(subObj, inv) {
  const md = subObj.metadata || {};
  const { ownerId, tenantId, tenantUid, tenantName, propertyName, rentAmountDollars } = md;
  if (!ownerId || !tenantId) {
    console.warn("rent-autopay invoice without owner/tenant metadata", inv.id);
    return;
  }
  const periodStart = inv.lines?.data?.[0]?.period?.start || inv.created;
  const d = new Date((periodStart || Math.floor(Date.now() / 1000)) * 1000);
  const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const Timestamp = admin.firestore.FieldValue.serverTimestamp();
  const paymentRef = db.collection("payments").doc(ownerId)
    .collection("months").doc(monthKey).collection("payments").doc(tenantId);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(paymentRef);
    if (existing.exists && existing.data()?.stripeInvoiceId === inv.id && existing.data()?.recordedAt) return;
    tx.set(paymentRef, {
      rentAmount: Number(rentAmountDollars || 0),
      tenantName: tenantName || null,
      propertyName: propertyName || null,
      paidAt: Timestamp,
      paidBy: tenantUid || "stripe-autopay",
      method: "card-autopay",
      currency: inv.currency,
      amountPaidCents: inv.amount_paid,
      stripeInvoiceId: inv.id,
      stripeSubId: typeof inv.subscription === "string" ? inv.subscription : subObj.id,
      recordedAt: Timestamp,
    });
    tx.set(db.collection("tenants").doc(tenantId), { lastPaidAt: Timestamp }, { merge: true });
  });
  if (tenantUid) await setRentAutopay(tenantUid, tenantId, subObj);
  await db.collection("notifications").doc(ownerId).collection("items")
    .doc(`autopay-${tenantId}-${monthKey}`)
    .set(
      {
        type: "rent_paid",
        tenantName: tenantName || "",
        propertyName: propertyName || "",
        amount: Number(rentAmountDollars || 0),
        method: "card-autopay",
        message: `${tenantName || "Tenant"} paid $${Number(rentAmountDollars || 0).toLocaleString()} rent for ${propertyName} (autopay)`,
        read: false,
        createdAt: Timestamp,
      },
      { merge: false }
    );
}

// ─── Stripe webhook ───────────────────────────────────────────────────────────
app.post("/stripe-webhook", async (req, res) => {
  // Trim: pasted secrets often carry a trailing newline, which makes every
  // signature check fail with "No signatures found matching...".
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set.");
    res.status(500).send("Webhook not configured");
    return;
  }
  if (!stripeConfigured()) {
    console.error("STRIPE_SECRET_KEY is not set.");
    res.status(500).send("Stripe not configured");
    return;
  }

  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const signature = req.get("stripe-signature");
  // Diagnostic: if the platform pre-parsed and re-serialized the body,
  // byte length won't match content-length and verification always fails.
  const claimed = Number(req.get("content-length") || 0);
  const actual = Buffer.isBuffer(req.rawBody) ? req.rawBody.length : -1;
  if (claimed > 0 && actual >= 0 && claimed !== actual) {
    console.error(
      `Webhook body altered in transit (content-length ${claimed} vs ${actual} bytes). ` +
        `Check bodyParser/raw-body handling in the serverless entry.`
    );
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, signature, secret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    const Timestamp = admin.firestore.FieldValue.serverTimestamp();

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode === "subscription") {
          const sub = session.subscription;
          const md = session.metadata || {};
          if (typeof sub === "string" && md.kind === "plan") {
            // Marketing-site plan checkout (Starter / Professional / Auto-Sync).
            try {
              const subObj = await stripe.subscriptions.retrieve(sub);
              await setPlanSubscription({ plan: md.plan, email: md.email, subObj });
            } catch (err) {
              console.error("Failed to activate plan subscription on checkout:", err.message);
            }
          } else if (typeof sub === "string" && md.estateflowUid) {
            try {
              const subObj = await stripe.subscriptions.retrieve(sub);
              await setUtilitySubscription(md.estateflowUid, subObj);
            } catch (err) {
              console.error("Failed to activate utility subscription on checkout:", err.message);
            }
          }
          break;
        }

        if (session.payment_status !== "paid") break;
        const md = session.metadata || {};
        const { ownerId, tenantId, monthKey } = md;
        if (!ownerId || !tenantId || !monthKey) {
          console.warn("checkout.session.completed without Provalta metadata", session.id);
          break;
        }

        const paymentRef = db
          .collection("payments")
          .doc(ownerId)
          .collection("months")
          .doc(monthKey)
          .collection("payments")
          .doc(tenantId);

        await db.runTransaction(async (tx) => {
          const existing = await tx.get(paymentRef);
          if (existing.exists && existing.data()?.stripeSessionId === session.id && existing.data()?.recordedAt) return;
          tx.set(paymentRef, {
            rentAmount: Number(md.rentAmountDollars || 0),
            tenantName: md.tenantName || null,
            propertyName: md.propertyName || null,
            paidAt: Timestamp,
            paidBy: md.tenantUid || "stripe",
            method: "card",
            currency: session.currency,
            amountPaidCents: session.amount_total,
            applicationFeeCents: session.application_fee_amount || 0,
            stripeSessionId: session.id,
            stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
            recordedAt: Timestamp,
          });
          tx.set(db.collection("tenants").doc(tenantId), { lastPaidAt: Timestamp }, { merge: true });
        });

        await db
          .collection("notifications")
          .doc(ownerId)
          .collection("items")
          .doc(`payment-${md.tenantUid || tenantId}-${monthKey}`)
          .set(
            {
              type: "rent_paid",
              tenantName: md.tenantName || "",
              propertyName: md.propertyName || "",
              amount: Number(md.rentAmountDollars || 0),
              method: "card",
              message: `${md.tenantName || "Tenant"} paid $${Number(md.rentAmountDollars || 0).toLocaleString()} rent for ${md.propertyName} via Stripe`,
              read: false,
              createdAt: Timestamp,
            },
            { merge: false }
          );
        break;
      }

      case "invoice.paid": {
        const inv = event.data.object;
        if (inv.billing_reason === "subscription_create" || inv.billing_reason === "subscription_cycle") {
          const subId = inv.subscription;
          if (!subId || typeof subId !== "string") break;
          try {
            const subObj = await stripe.subscriptions.retrieve(subId);
            if (subObj.metadata?.kind === "plan") {
              await setPlanSubscription({
                plan: subObj.metadata.plan,
                email: subObj.metadata.email,
                subObj,
              });
            } else if (subObj.metadata?.kind === "rent-autopay") {
              await recordRentAutopayInvoice(subObj, inv);
            } else {
              const uid = subObj.metadata?.estateflowUid || null;
              if (uid) await setUtilitySubscription(uid, subObj);
            }
          } catch (err) {
            console.error("Failed to activate subscription:", err.message);
          }
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        if (sub.metadata?.kind === "plan") {
          await setPlanSubscription({
            plan: sub.metadata.plan,
            email: sub.metadata.email,
            subObj: sub,
          });
          break;
        }
        if (sub.metadata?.kind === "rent-autopay") {
          // Keep the autopay badge honest; the paid-through date still honors.
          try {
            const tenantUid = sub.metadata?.tenantUid || null;
            const tenantId = sub.metadata?.tenantId || null;
            if (tenantUid && tenantId) await setRentAutopay(tenantUid, tenantId, sub);
          } catch (err) {
            console.error("Failed to sync autopay subscription:", err.message);
          }
          break;
        }
        const uid = sub.metadata?.estateflowUid || null;
        if (!uid) break;
        await setUtilitySubscription(uid, sub);
        // Period end: stop UtilityAPI collection for the ended key so no
        // further bills sync (no-op while the key is still covered).
        await stopMonitoringForEndedKey(uid, normalizeUtilityKey(sub.metadata?.utilityKey));
        break;
      }

      case "account.updated": {
        const acct = event.data.object;
        try {
          const snap = await db
            .collection("users")
            .where("stripeAccountId", "==", acct.id)
            .limit(1)
            .get();
          if (!snap.empty) {
            snap.docs[0].ref.set(
              {
                stripePayoutsEnabled: !!acct.payouts_enabled,
                stripeChargesEnabled: !!acct.charges_enabled,
                stripeDetailsSubmitted: !!acct.details_submitted,
                stripeStatusSyncedAt: Timestamp,
              },
              { merge: true }
            );
          }
        } catch (err) {
          console.error("Failed to sync account.updated:", err.message);
        }
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  }
);

// ─── AI: authoritative portfolio snapshot (mirrors the app's offline math) ─────
// The client sends a lightweight context; the server rebuilds an accurate copy
// straight from Firestore so cloud answers are grounded even if the app's copy
// is stale or a richer prompt is desired later.
function aiComputeNextDueDate(d, from) {
  const year = from.getFullYear();
  const month = from.getMonth();
  const lastDayOf = (y, m) => new Date(y, m + 1, 0).getDate();
  const build = (y, m, day) => {
    const max = lastDayOf(y, m);
    return new Date(y, m, Math.min(day, max), 12, 0, 0, 0);
  };
  const nextMonth = (y, m, day) => {
    const mm = m + 1;
    return build(y + Math.floor(mm / 12), mm % 12, day);
  };
  if (String(d).toLowerCase() === "last") {
    const candidate = build(year, month, lastDayOf(year, month));
    if (candidate >= from) return candidate;
    const y = year + Math.floor((month + 1) / 12);
    const m = (month + 1) % 12;
    return build(y, m, lastDayOf(y, m));
  }
  const num = Number(d);
  if (!Number.isFinite(num)) return null;
  const candidate = build(year, month, num);
  return candidate >= from ? candidate : nextMonth(year, month, num);
}

function aiRentOverdue(dueDay, lastPaidAt, now = new Date()) {
  if (dueDay === undefined || dueDay === null || dueDay === "") return false;
  if (lastPaidAt) {
    let paidOn = null;
    try {
      paidOn =
        lastPaidAt && typeof lastPaidAt.toDate === "function"
          ? lastPaidAt.toDate()
          : lastPaidAt instanceof Date
            ? lastPaidAt
            : new Date(lastPaidAt);
    } catch { /* unparseable → treat as unpaid */ }
    if (paidOn && !Number.isNaN(paidOn.getTime())) {
      const next = aiComputeNextDueDate(dueDay, paidOn);
      if (next && next > now) return false; // paid through this billing cycle
    }
  }
  const currentDay = now.getDate();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dueDayNum = String(dueDay).toLowerCase() === "last" ? lastDay : Number(dueDay);
  return Number.isFinite(dueDayNum) && dueDayNum - currentDay < 0;
}

async function buildPortfolioContext(uid) {
  const ctx = { propertyCount: 0, tenantCount: 0, monthlyIncome: 0, monthlyExpense: 0, portfolioValue: 0, overdueCount: 0 };
  const [pSnap, tSnap] = await Promise.all([
    db.collection("properties").where("ownerId", "==", uid).get(),
    db.collection("tenants").where("ownerId", "==", uid).get(),
  ]);
  ctx.propertyCount = pSnap.size;
  ctx.tenantCount = tSnap.size;
  let propertyIncome = 0;
  pSnap.forEach((doc) => {
    const p = doc.data() || {};
    propertyIncome += Number(p.monthlyIncome) || 0;
    ctx.portfolioValue += Number(p.marketValue) || 0;
    const utils = p.utilities || {};
    Object.values(utils).forEach((u) => {
      if (u && typeof u === "object") ctx.monthlyExpense += parseFloat(u.amount) || 0;
    });
  });
  let tenantIncome = 0;
  tSnap.forEach((doc) => {
    const t = doc.data() || {};
    tenantIncome += Number(t.rentAmount) || 0;
    if (aiRentOverdue(t.dueDay, t.lastPaidAt)) ctx.overdueCount += 1;
  });
  // Prefer actual tenant rent when tenants exist; fall back to property income.
  ctx.monthlyIncome = tenantIncome > 0 ? tenantIncome : propertyIncome;
  return ctx;
}

// ─── AI assistant (cloud upgrade path) ────────────────────────────────────
// The app calls this first; the client falls back to its free built-in
// knowledge base whenever the server has no LLM key configured.
// Set OPENAI_API_KEY (or GEMINI_API_KEY) in env to enable cloud answers.
const AI_SYSTEM_PROMPT = `You are the Provalta assistant — an expert on this property-management app AND a seasoned real-estate & property-management advisor. Answer ANY question the user has about the app, their portfolio, or real estate in general (landlording, property management, investing, financing, taxes, legal basics). You can answer general real-estate questions even when they aren't about the app.

## Provalta app facts
Provalta (Expo + Firebase) lets landlords:
- Add properties with photos, address, type (residential/commercial), units, market value, monthly rent
- Assign tenants with rent amount + due day (1,5,10,15,20,25,last). Rent status is automatic: Paid / Overdue / Due Soon (≤3d) / Upcoming (≤7d) / On Track. "Mark Paid" records a payment for the current month.
- Track utilities per property (Electric/Water/Gas/Oil/Sewer/Trash) — manual entry is FREE; auto-sync via UtilityAPI costs $20/mo per utility key (Subscriptions screen → Connect Utility → provider login → Authorize).
- Track maintenance: manual tasks (property, title, cost, status pending/in-progress/done) + tenant-portal requests that arrive as bell notifications.
- Insights charts: income vs expenses, per-property breakdowns, trends from real data (payments, utilities, maintenance).
- Export reports (properties, tenants, payments, maintenance) as spreadsheets — Excel export is Professional plan.
- Collect card rent via Stripe: tenant pays through the web tenant portal → Stripe Checkout → auto-recorded payment + notification. Requires Professional plan + landlord Stripe payouts connected.
- Payouts: menu → Payouts → Set Up Payouts (Stripe Express, connect bank). Status: Connected / Payouts Enabled.
- Plans: Starter (basics), Professional (card rent collection, tenant portal, exports), Auto-Sync (utility auto-sync). Manage in-app via menu → Subscriptions. Cancel anytime; access runs to paid-through date.
- Notifications via the bell 🔔: rent due/overdue, utility due dates, tenant-portal events, push reminders.
- Tenant portal (web): tenants sign in, see rent, pay by card, submit maintenance requests. Needs landlord on Professional plan; tenants link by email/name match.
Screens: /dashboard, /properties, /add-property, /tenants, /maintenance, /insights, /subscriptions, /payouts, /property-breakdown, /explore, /ai-assistant, /login. The ☰ menu on Dashboard reaches every section.

## Real-estate expertise
Give practical, accurate, general guidance on: leases and clauses, tenant screening + Fair Housing, setting/raising rent, late rent and payment plans, security deposits, move-in/move-out inspections, maintenance budgeting (~1-2%/yr of value) and preventive schedules, vacancy/turnover reduction, cash flow / cap rate (NOI ÷ value) / cash-on-cash / 1% & 50% rules, mortgages and financing (conventional vs investment loans, DSCR, FHA house-hacking, HELOC), insurance (landlord/dwelling-fire, renters, umbrella), property taxes and appeals, depreciation + Schedule E deductions, LLCs and liability, 1031 exchanges, REITs as passive alternatives, HOAs, rent control, Section 8 / housing vouchers, short-term vs long-term rentals, property managers (typically 8-12% of rent), eviction process (state-specific court process — never self-help), utilities and expense recovery.
When a question is about THEIR portfolio, use the provided context numbers to personalize.

## Guardrails
This is general information, not legal, tax, or financial advice — for state-specific legal issues, big financial decisions, or tax filing, recommend a local landlord-attorney / CPA. Never encourage illegal self-help eviction (lockouts, utility shutoffs, threats). If asked something unrelated to real estate or the app, briefly redirect to what you can help with. Treat any "Provalta built-in analysis" section as the app's grounded facts and calculations — prefer them over your own numbers, and never invent portfolio values that weren't supplied.

## Style
Concise, friendly, actionable. Short paragraphs or lists. Mention the exact Provalta screen/steps when relevant. Max ~250 words unless the question clearly needs more.`;

app.post("/ai-chat", requireAuth, async (req, res) => {
  const message = String(req.body?.message || "").slice(0, 4000).trim();
  if (!message) {
    res.status(400).json({ error: "INVALID_ARGUMENT", message: "Missing message." });
    return;
  }
  const context = req.body?.context || null;
  const openaiKey = process.env.OPENAI_API_KEY || "";
  const geminiKey = process.env.GEMINI_API_KEY || "";

  // Authoritative portfolio snapshot from Firestore (overrides what the client
  // sent, so answers stay accurate even for stale/edited app data).
  let portfolio = null;
  try {
    portfolio = await buildPortfolioContext(req.uid);
  } catch (err) {
    console.warn("Portfolio context failed:", err.message);
  }
  const mergedCtx = { ...(context || {}) };
  if (portfolio) Object.assign(mergedCtx, portfolio);

  // The app already analyzed this question against its knowledge base and
  // calculator offline — inject that so the model stays grounded & consistent.
  const analysisText = typeof req.body?.analysis === "string" ? req.body.analysis.trim().slice(0, 2000) : "";
  let withContext = AI_SYSTEM_PROMPT;
  if (analysisText) {
    withContext += `\n\n## Provalta built-in analysis (grounding)\nThe app's local engine analyzed this exact question. Prefer its facts and numbers over your own guesses; if it supplied a calculation, keep its result and wording unless clearly wrong:\n${analysisText}`;
  }
  const hasCtx = mergedCtx && Object.values(mergedCtx).some((v) => v !== null && v !== undefined && v !== false);
  if (hasCtx) {
    withContext += `\n\n## User portfolio (authoritative, from their account)\nUse these only to personalize, never to invent other data fields:\n${JSON.stringify(mergedCtx).slice(0, 1000)}`;
  }

  // Conversation memory: accept the last turns so follow-ups keep context.
  // Expected: history: [{ role: "user" | "assistant", text: string }]
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const turns = history
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string" && h.text.trim())
    .map((h) => ({ role: h.role, text: String(h.text).trim().slice(0, 1200) }))
    .slice(-12); // keep the last 12 turns max

  const toOpenAIMessages = () => {
    const msgs = [{ role: "system", content: withContext }];
    for (const t of turns) msgs.push({ role: t.role, content: t.text });
    msgs.push({ role: "user", content: message });
    return msgs;
  };

  const toGeminiContents = () => {
    const contents = turns.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.text }],
    }));
    contents.push({ role: "user", parts: [{ text: message }] });
    return contents;
  };

  try {
    if (openaiKey) {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          messages: toOpenAIMessages(),
          max_tokens: 900,
          temperature: 0.4,
        }),
      });
      if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
      const data = await r.json();
      const reply = data.choices?.[0]?.message?.content?.trim();
      if (!reply) throw new Error("Empty OpenAI reply");
      res.json({ reply, cloud: true, provider: "openai" });
      return;
    }
    if (geminiKey) {
      const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: withContext }] },
            contents: toGeminiContents(),
            generationConfig: { maxOutputTokens: 900, temperature: 0.4 },
          }),
        }
      );
      if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
      const data = await r.json();
      const reply = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (!reply) throw new Error("Empty Gemini reply");
      res.json({ reply, cloud: true, provider: "gemini" });
      return;
    }
    // No LLM key → client uses its free local brain.
    res.status(503).json({ error: "AI_NOT_CONFIGURED", message: "Cloud AI is not configured; use the built-in assistant.", fallback: true });
  } catch (err) {
    console.error("AI chat failed:", err.message);
    res.status(502).json({ error: "AI_FAILED", message: "AI request failed; use the built-in assistant.", fallback: true });
  }
});

// ─── Error handling ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: "APPLICATION_ERROR", message: err.message });
    return;
  }
  const code = err && err.message ? err.message.split(" ")[0].toUpperCase().replace(/[^A-Z]/g, "") : "INTERNAL";
  const status = code === "UNAUTHENTICATED" ? 401 : code === "PERMISSION-DENIED" ? 403 : 400;
  res.status(status).json({ error: code, message: err.message || "Something went wrong." });
});

// Netlify exports the app as a serverless function via serverless-http.
// Vercel reuses the same app (see /api/index.js).
const serverless = require("serverless-http");
exports.handler = serverless(app);
exports.app = app;
