/**
 * EstateFlow API — Netlify serverless version.
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

async function getUtilityEntitlement(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const ua = snap.exists ? snap.data()?.utilityAuto || {} : {};
  const active = !!ua.active;
  const currentPeriodEnd = ua.currentPeriodEnd?.toDate?.() || ua.currentPeriodEnd || null;
  const lapsed = active && currentPeriodEnd && currentPeriodEnd.getTime() < Date.now();
  return { active: active && !lapsed, ua, stripeCustomerId: ua.stripeCustomerId || null };
}

function assertUtilityEntitlement(ent) {
  if (!ent.active) {
    throw new ApiError(
      403,
      "Auto utility sync requires an active subscription. Sign up for the auto-sync plan to continue, or enter utilities manually for free."
    );
  }
}

function meterLimit() {
  const n = Number.parseInt(process.env.UTILITY_AUTO_METER_LIMIT || "10", 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

async function countLinkedMeters(uid) {
  const snap = await db.collection("properties").where("ownerId", "==", uid).get();
  const seen = new Set();
  snap.docs.forEach((doc) => {
    const utilities = doc.data()?.utilities || {};
    Object.values(utilities).forEach((u) => {
      if (u && u.meterUid) seen.add(String(u.meterUid));
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

async function setUtilitySubscription(uid, stripeSub) {
  if (!uid) return;
  const status = stripeSub.status;
  const active = status === "active" || status === "trialing";
  const periodEnd = stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000) : null;
  await db.collection("users").doc(uid).set(
    {
      utilityAuto: {
        active,
        plan: "utility-auto",
        stripeSubId: stripeSub.id,
        stripeCustomerId: stripeSub.customer || null,
        stripePriceId: stripeSub.items?.data?.[0]?.price?.id || null,
        status: status || "unknown",
        currentPeriodEnd: periodEnd ? admin.firestore.Timestamp.fromDate(periodEnd) : null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    },
    { merge: true }
  );
}

// ─── Plan subscription helpers (Starter / Professional / Auto-Sync) ───────────
// Marketing-site checkout writes entitlements to users/{uid}.planStatus and
// mirrors them to planSubscriptions/{email} so a visitor can subscribe before
// they ever create an EstateFlow account (merged on first /plan-status call).
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
    return null; // no EstateFlow account (yet) — planSubscriptions keeps the plan
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

/**
 * Sync the subscription quantity to the linked-meter count ($20/meter).
 * UTILITY_METER_PRICE_ID must be a FLAT recurring price (standard pricing,
 * NOT metered/usage-based) so each meter bills $20/mo upfront — due today at
 * checkout and prorated when meters are added mid-cycle.
 */
async function syncMeterQuantity(uid) {
  const meterPriceId = (process.env.UTILITY_METER_PRICE_ID || "").trim();
  if (!meterPriceId || !stripeConfigured()) return;
  try {
    const ent = await getUtilityEntitlement(uid);
    const subId = ent.ua?.stripeSubId;
    if (!ent.active || !subId) return;
    const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
    const sub = await stripe.subscriptions.retrieve(subId);
    const item = (sub.items?.data || []).find((i) => i.price?.id === meterPriceId);
    if (!item) return; // meter price not on this subscription — nothing to sync
    const { count } = await countLinkedMeters(uid);
    if (item.quantity === count) return; // already correct
    await stripe.subscriptionItems.update(item.id, { quantity: count });
  } catch (err) {
    console.error("Meter quantity sync failed:", err.message);
  }
}

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
        "Card rent collection is part of the Professional plan. Ask your landlord or property manager to upgrade on the EstateFlow website.",
    });
    return;
  }

  const connect = await getLandlordConnect(tenant.ownerId);
  if (!connect.exists || !connect.stripeAccountId) {
    res.status(409).json({ error: "FAILED_PRECONDITION", message: "Your landlord hasn't connected their payout account yet. Ask them to set up payouts in the EstateFlow app." });
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
  const applicationFee = feePercent > 0 ? Math.min(Math.round((unitAmount * feePercent) / 100), unitAmount - 1) : undefined;
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const amountLabel = `$${Number(tenant.rentAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  const description = `Rent for ${tenant.propertyName} (${tenant.tenantName}) — ${monthKey}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
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
        metadata: { ownerId: tenant.ownerId, tenantId, monthKey },
      },
      transfer_data: { destination: connect.stripeAccountId },
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
    res.status(500).json({ error: "INTERNAL", message: "Stripe checkout could not be created." });
  }
});

// ─── Landlord: one-time Stripe Express onboarding ─────────────────────────────
app.post("/create-connect-onboarding", requireAuth, async (req, res) => {
  const uid = req.uid;
  const base = webBaseUrl();
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);

  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  let accountId = snap.exists ? snap.data()?.stripeAccountId || null : null;

  try {
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: req.token.email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: { product_description: "Collecting rent for rental properties" },
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
    });
    res.json({ url: link.url });
  } catch (err) {
    console.error("Connect onboarding failed:", err.message);
    res.status(500).json({ error: "INTERNAL", message: "Could not start payout onboarding." });
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

// ─── Paid: subscribe to auto utility bill sync ────────────────────────────────
app.post("/create-utility-subscription", requireAuth, async (req, res) => {
  const uid = req.uid;
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);

  const ent = await getUtilityEntitlement(uid);

  if (ent.active && ent.ua.stripeCustomerId) {
    const url = await createBillingPortal(stripe, ent.ua.stripeCustomerId);
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

  // Meter-only billing: no base plan — the user pays $20 per connected meter.
  // Metered/usage prices take no quantity — Stripe bills actual usage.
  const meterPriceId = (process.env.UTILITY_METER_PRICE_ID || "").trim();
  if (!/^price_[A-Za-z0-9]+$/.test(meterPriceId)) {
    throw new ApiError(
      500,
      "Per-meter billing is misconfigured. UTILITY_METER_PRICE_ID must be a Stripe price ID like price_... . Fix it in env vars and redeploy."
    );
  }
  const base = webBaseUrl(); // throws a clear error before hitting Stripe

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    // Flat $20/mo per meter, first meter included → $20.00 due today.
    line_items: [{ price: meterPriceId, quantity: 1 }],
    subscription_data: {
      metadata: { estateflowUid: uid },
    },
    metadata: { estateflowUid: uid },
    success_url: `${base}/utility-return.html?utility=subscribed&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/utility-return.html?utility=canceled`,
  });

  res.json({ url: session.url, alreadyActive: false });
});

// ─── Paid: confirm a just-completed checkout without waiting for webhooks ────
// Webhooks can lag (or be misconfigured); the app calls this when the user
// returns from Stripe so payment flows straight into authorization. It finds
// the user's subscription via the estateflowUid metadata Stripe was given at
// checkout (or a specific session id), activates the entitlement exactly like
// the webhook would, and reports whether it's live yet.
async function findActiveUtilitySub(stripe, uid) {
  const found = await stripe.subscriptions.search({
    query: `metadata['estateflowUid']:'${uid}'`,
    limit: 10,
  });
  return (found.data || []).find((s) => s.status === "active" || s.status === "trialing") || null;
}

app.post("/confirm-utility-subscription", requireAuth, async (req, res) => {
  const uid = req.uid;
  const before = await getUtilityEntitlement(uid);
  if (before.active) {
    res.json({ active: true, alreadyActive: true });
    return;
  }
  if (!stripeConfigured()) throw new ApiError(500, "Stripe is not configured.");
  const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
  const sessionId = String(req.body?.sessionId || "").trim();
  let sub = null;
  if (sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
      const candidate = session.subscription && typeof session.subscription === "object" ? session.subscription : null;
      if (
        candidate &&
        candidate.metadata?.estateflowUid === uid &&
        (candidate.status === "active" || candidate.status === "trialing")
      ) {
        sub = candidate;
      }
    } catch (err) {
      console.warn("Checkout session lookup failed:", err.message);
    }
  }
  if (!sub) {
    try {
      sub = await findActiveUtilitySub(stripe, uid);
    } catch (err) {
      console.warn("Subscription search failed:", err.message);
    }
  }
  if (!sub) {
    res.json({ active: false });
    return;
  }
  await setUtilitySubscription(uid, sub);
  await syncMeterQuantity(uid);
  res.json({ active: true });
});

// ─── Paid: current auto-sync subscription status + portal link ────────────────
app.get("/utility-subscription-status", requireAuth, async (req, res) => {
  const uid = req.uid;
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

  res.json({
    active: ent.active,
    plan: ent.active ? ent.ua.plan || "utility-auto" : null,
    currentPeriodEnd: ent.currentPeriodEnd ? ent.currentPeriodEnd.toISOString() : null,
    portalUrl,
    meterLimit: limit,
    linkedMeters: linked.count,
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

  const { count, meterUids } = await countLinkedMeters(uid);
  assertUnderMeterLimit(count, meterLimit());

  const data = await utilityApi.linkForProperty({ formUid });
  if (data.meterUid && !meterUids.has(String(data.meterUid))) {
    assertUnderMeterLimit(count + 1, meterLimit());
  }
  // Keep the $20/meter quantity in step with actually-linked meters.
  await syncMeterQuantity(uid);
  res.json(data);
});

// ─── Paid: refresh one already-linked meter's bill ────────────────────────────
app.post("/refresh-utility-auto", requireAuth, async (req, res) => {
  const uid = req.uid;
  const ent = await getUtilityEntitlement(uid);
  assertUtilityEntitlement(ent);

  const meterUid = String(req.body?.meterUid || "").trim();
  if (!meterUid) throw new ApiError(400, "Missing meterUid.");

  const data = await utilityApi.refreshMeter({ meterUid });
  // Re-sync quantity here too so removed meters stop billing on next refresh.
  await syncMeterQuantity(uid);
  res.json(data);
});

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

// ─── Stripe webhook ───────────────────────────────────────────────────────────
app.post("/stripe-webhook", async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
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
          console.warn("checkout.session.completed without EstateFlow metadata", session.id);
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
        const uid = sub.metadata?.estateflowUid || null;
        if (!uid) break;
        await setUtilitySubscription(uid, sub);
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
