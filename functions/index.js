/**
 * EstateFlow rent payments — Stripe Connect destination charges.
 *
 * Money flow when a tenant pays rent:
 *   tenant card → Stripe Checkout → charge on the platform account
 *   → automatic transfer to the landlord's connected account
 *   → Stripe pays out to the landlord's bank account.
 *
 * Config comes from functions/.env (see .env.example):
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 *   WEB_BASE_URL (public URL hosting the web/ portal), PLATFORM_FEE_PERCENT
 */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const stripeFactory = require("stripe");
const utilityApi = require("./utilityapi");

admin.initializeApp();
const db = admin.firestore();

const REGION = "us-central1";

// ─── Utility auto-sync subscription (paid tier) ───────────────────────────────
const UTILITY_PLAN_PRICE_ID = () => {
  const id = process.env.UTILITY_PLAN_PRICE_ID || "";
  if (!id) {
    throw new HttpsError(
      "failed-precondition",
      "Utility auto-sync plan is not configured. Add UTILITY_PLAN_PRICE_ID to functions/.env (a monthly Stripe price) and redeploy."
    );
  }
  return id;
};

// ─── Configuration helpers ─────────────────────────────────────────────────────
function stripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getStripe() {
  if (!stripeConfigured()) {
    throw new HttpsError(
      "failed-precondition",
      "Stripe is not configured yet. Add STRIPE_SECRET_KEY to functions/.env and redeploy."
    );
  }
  return stripeFactory(process.env.STRIPE_SECRET_KEY);
}

function webBaseUrl() {
  const base = (process.env.WEB_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    throw new HttpsError(
      "failed-precondition",
      "WEB_BASE_URL is not configured. Set it to the public URL hosting the tenant portal."
    );
  }
  return base;
}

const platformFeePercent = () => {
  const n = Number.parseFloat(process.env.PLATFORM_FEE_PERCENT || "0");
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 0;
};

const dollarsToCents = (v) => Math.round(Number(v || 0) * 100);

const normalizeName = (s) =>
  String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/** Verify that the signed-in tenant user is allowed to pay for this tenant record. */
function assertTenantOwnership(tenant, authCtx) {
  const email = String(authCtx.token.email || "").trim().toLowerCase();
  const storedEmail = String(tenant.tenantEmail || "").trim().toLowerCase();
  const displayName = normalizeName(authCtx.token.name);
  const emailPrefix = email.split("@")[0] ? normalizeName(email.split("@")[0]) : "";
  const tenantName = normalizeName(tenant.tenantName);

  // Record was linked by e-mail — strictest match.
  if (storedEmail) {
    if (email && storedEmail === email) return;
    throw new HttpsError("permission-denied", "This rental is linked to a different tenant account.");
  }
  // Not linked yet — allow the same loose name matching the portal itself uses.
  if ((displayName && displayName === tenantName) || (emailPrefix && emailPrefix === tenantName)) return;

  throw new HttpsError(
    "permission-denied",
    "Could not verify that you are the tenant for this rental. Link your account first."
  );
}

/** Load the landlord's Connect state stored on users/{ownerId}. */
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

// ─── Tenant: create a Checkout session for one month's rent ───────────────────
exports.createRentCheckoutSession = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in to pay rent.");

  const tenantId = String(req.data?.tenantId || "").trim();
  const monthKey = String(req.data?.monthKey || "").trim();
  if (!tenantId || !/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new HttpsError("invalid-argument", "Missing tenantId or monthKey.");
  }

  const base = webBaseUrl(); // fail fast before hitting Stripe

  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) throw new HttpsError("not-found", "Rental record not found.");
  const tenant = tenantSnap.data() || {};
  if (!tenant.ownerId) throw new HttpsError("failed-precondition", "Rental has no landlord assigned.");
  assertTenantOwnership(tenant, req.auth);

  const connect = await getLandlordConnect(tenant.ownerId);
  if (!connect.exists || !connect.stripeAccountId) {
    throw new HttpsError(
      "failed-precondition",
      "Your landlord hasn't connected their payout account yet. Ask them to set up payouts in the EstateFlow app."
    );
  }
  if (!connect.payoutsEnabled) {
    throw new HttpsError(
      "failed-precondition",
      "Your landlord's payout setup isn't finished yet, so payments can't be accepted right now."
    );
  }
    const unitAmount = dollarsToCents(tenant.rentAmount);
  if (!unitAmount || unitAmount < 100) {
    throw new HttpsError("invalid-argument", "Rent amount must be at least $1.00.");
  }

  const feePercent = platformFeePercent();
  const applicationFee =
    feePercent > 0 ? Math.min(Math.round((unitAmount * feePercent) / 100), unitAmount - 1) : undefined;

  const stripe = getStripe();
  const amountLabel = `$${Number(tenant.rentAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  const description = `Rent for ${tenant.propertyName} (${tenant.tenantName}) — ${monthKey}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: req.auth.token.email || undefined,
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
      // Destination charge: money is transferred straight into the landlord's account.
      transfer_data: { destination: connect.stripeAccountId },
      metadata: {
        ownerId: tenant.ownerId,
        tenantId,
        monthKey,
        tenantUid: req.auth.uid,
        tenantName: String(tenant.tenantName || ""),
        propertyName: String(tenant.propertyName || ""),
        rentAmountDollars: String(tenant.rentAmount),
      },
      success_url: `${base}/portal.html?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/portal.html?canceled=1`,
    });

    return { url: session.url };
  } catch (err) {
    console.error("Checkout session failed:", err);
    throw new HttpsError("internal", err.message || "Stripe checkout could not be created.");
  }
});
// ─── Landlord: one-time Stripe Express onboarding ─────────────────────────────
exports.createConnectOnboarding = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = req.auth.uid;
  const base = webBaseUrl();

  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  let accountId = snap.exists ? snap.data()?.stripeAccountId || null : null;

  const stripe = getStripe();
  try {
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: req.auth.token.email || undefined,
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
    return { url: link.url };
  } catch (err) {
    console.error("Connect onboarding failed:", err);
    throw new HttpsError("internal", err.message || "Could not start payout onboarding.");
  }
});

// ─── Landlord: current Connect status (syncs live state from Stripe) ──────────
exports.getConnectStatus = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = req.auth.uid;

  const snap = await db.collection("users").doc(uid).get();
  const data = snap.exists ? snap.data() || {} : {};
  let connected = !!data.stripeAccountId;
  let payoutsEnabled = !!data.stripePayoutsEnabled;
  let chargesEnabled = !!data.stripeChargesEnabled;

  // If configured, refresh from Stripe so the flag is never stale.
  if (connected && stripeConfigured()) {
    try {
      const stripe = getStripe();
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

  return {
    connected,
    payoutsEnabled: connected && payoutsEnabled && chargesEnabled,
    accountId: data.stripeAccountId || null,
  };
});
// ─── Utility auto-sync entitlement helpers ────────────────────────────────────
async function getUtilityEntitlement(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const ua = snap.exists ? snap.data()?.utilityAuto || {} : {};
  const active = !!ua.active;
  const currentPeriodEnd = ua.currentPeriodEnd?.toDate?.() || ua.currentPeriodEnd || null;
  // If the subscription's paid period has lapsed, treat it as inactive.
  const lapsed = active && currentPeriodEnd && currentPeriodEnd.getTime() < Date.now();
  return { active: active && !lapsed, ua, stripeCustomerId: ua.stripeCustomerId || null };
}

function assertUtilityEntitlement(ent) {
  if (!ent.active) {
    throw new HttpsError(
      "permission-denied",
      "Auto utility sync requires an active subscription. Sign up for the auto-sync plan to continue, or enter utilities manually for free."
    );
  }
}

/** Number of meters included in the flat auto-sync plan (env-tunable). */
function meterLimit() {
  const n = Number.parseInt(process.env.UTILITY_AUTO_METER_LIMIT || "10", 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/** Count the user's currently linked (unique) utility meter uids. */
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

/** Fail fast if the subscriber is already at the meter cap. */
function assertUnderMeterLimit(current, limit) {
  if (current >= limit) {
    throw new HttpsError(
      "failed-precondition",
      `Your plan includes ${limit} linked meters and you've reached that limit. Remove a linked utility or contact support to add meter capacity. You can still enter utilities manually for free.`
    );
  }
}

/** Create a Stripe billing portal session so the user can manage/cancel. */
async function createBillingPortal(stripe, customerId) {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${webBaseUrl()}/portal.html?portal=1`,
  });
  return session.url;
}

// ─── Paid: subscribe to auto utility bill sync ────────────────────────────────

/** Persist the state of a user's utility auto-sync subscription. */
async function setUtilitySubscription(uid, stripeSub) {
  if (!uid) return;
  const status = stripeSub.status; // active, trialing, past_due, canceled, etc.
  const active = status === "active" || status === "trialing";
  const periodEnd = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000)
    : null;
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

exports.createUtilitySubscription = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = req.auth.uid;
  const stripe = getStripe();

  const ent = await getUtilityEntitlement(uid);

  // If the user already has an active subscription, hand them straight to the portal.
  if (ent.active && ent.ua.stripeCustomerId) {
    const url = await createBillingPortal(stripe, ent.ua.stripeCustomerId);
    return { url, alreadyActive: true };
  }

  let customerId = ent.stripeCustomerId;
  if (!customerId) {
    // Reuse the Stripe customer if the user ever paid rent via the portal.
    const snap = await db.collection("users").doc(uid).get();
    customerId = snap.exists ? snap.data()?.stripeCustomerId || null : null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.auth.token.email || undefined,
        metadata: { estateflowUid: uid },
      });
      customerId = customer.id;
      await db.collection("users").doc(uid).set({ stripeCustomerId: customerId }, { merge: true });
    }
  }

  // Meter-only billing: no base plan — the user pays $20 per connected meter.
  // Metered/usage prices take no quantity — Stripe bills actual usage.
  const meterPriceId = process.env.UTILITY_METER_PRICE_ID || "";
  if (!meterPriceId) {
    throw new HttpsError(
      "failed-precondition",
      "Per-meter billing is not configured. Add UTILITY_METER_PRICE_ID to functions/.env and redeploy."
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: meterPriceId }],
    subscription_data: {
      metadata: { estateflowUid: uid },
    },
    metadata: { estateflowUid: uid },
    success_url: `${webBaseUrl()}/portal.html?utility=subscribed&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${webBaseUrl()}/portal.html?utility=canceled`,
  });

  return { url: session.url, alreadyActive: false };
});

// ─── Paid: current auto-sync subscription status + portal link ────────────────
exports.getUtilitySubscriptionStatus = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = req.auth.uid;
  const ent = await getUtilityEntitlement(uid);

  let portalUrl = null;
  if (ent.active && ent.stripeCustomerId && stripeConfigured()) {
    try {
      portalUrl = await createBillingPortal(getStripe(), ent.stripeCustomerId);
    } catch (err) {
      console.warn("Billing portal session failed:", err.message);
    }
  }

  const limit = meterLimit();
  const linked = await countLinkedMeters(uid);

  return {
    active: ent.active,
    plan: ent.active ? ent.ua.plan || "utility-auto" : null,
    currentPeriodEnd: ent.currentPeriodEnd ? ent.currentPeriodEnd.toISOString() : null,
    portalUrl,
    meterLimit: limit,
    linkedMeters: linked.count,
  };
});

// ─── Paid: start the UtilityAPI authorization (returns a browser URL) ─────────
exports.createUtilityAuthForm = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = req.auth.uid;
  const ent = await getUtilityEntitlement(uid);
  assertUtilityEntitlement(ent);

  // Block before the user goes through the whole provider login if they're full.
  const linked = await countLinkedMeters(uid);
  assertUnderMeterLimit(linked.count, meterLimit());

  return utilityApi.createAuthForm();
});

// ─── Paid: finish linking an authorization and return bill data ───────────────
exports.linkUtilityAuto = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = req.auth.uid;
  const ent = await getUtilityEntitlement(uid);
  assertUtilityEntitlement(ent);

  const formUid = String(req.data?.formUid || "").trim();
  if (!formUid) throw new HttpsError("invalid-argument", "Missing formUid.");

  // Backstop after the provider returns the meter: don't exceed the plan's cap.
  const { count, meterUids } = await countLinkedMeters(uid);
  assertUnderMeterLimit(count, meterLimit());

  const data = await utilityApi.linkForProperty({ formUid });
  if (data.meterUid && !meterUids.has(String(data.meterUid))) {
    // This is a brand-new meter; re-check so one authorization can't add multiples.
    assertUnderMeterLimit(count + 1, meterLimit());
  }
  return data;
});

// ─── Paid: refresh one already-linked meter's bill ────────────────────────────
exports.refreshUtilityAuto = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const ent = await getUtilityEntitlement(req.auth.uid);
  assertUtilityEntitlement(ent);

  const meterUid = String(req.data?.meterUid || "").trim();
  if (!meterUid) throw new HttpsError("invalid-argument", "Missing meterUid.");

  return utilityApi.refreshMeter({ meterUid });
});

// ─── Stripe webhook: the only writer of "paid" records after a real charge ────
exports.stripeWebhook = onRequest({ region: REGION }, async (req, res) => {
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

  const stripe = getStripe();
  const signature = req.get("stripe-signature");
  let event;
  try {
    // req.rawBody preserves the exact bytes Stripe signed.
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

      // Subscription mode → utility auto-sync. The rent case below is payment mode.
      if (session.mode === "subscription") {
        const sub = session.subscription;
        const subUid = session.metadata?.estateflowUid || null;
        if (typeof sub === "string" && subUid) {
          try {
            const subObj = await getStripe().subscriptions.retrieve(sub);
            await setUtilitySubscription(subUid, subObj);
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

      await admin.firestore().runTransaction(async (tx) => {
        const existing = await tx.get(paymentRef);
        // Idempotency guard — webhook retries must not double-record.
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

      // Notify the landlord — same shape the app already displays.
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

    // ─── Subscription lifecycle continued ────────────────────────────────
    case "invoice.paid": {
      const inv = event.data.object;
      if (inv.billing_reason === "subscription_create" || inv.billing_reason === "subscription_cycle") {
        const subId = inv.subscription;
        if (!subId || typeof subId !== "string") break;
        try {
          const subObj = await getStripe().subscriptions.retrieve(subId);
          const uid = subObj.metadata?.estateflowUid || null;
          if (uid) await setUtilitySubscription(uid, subObj);
        } catch (err) {
          console.error("Failed to activate utility subscription:", err.message);
        }
      }
      break;
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
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
      // Unhandled event types are acknowledged so Stripe stops retrying.
      break;
  }

  res.json({ received: true });
});




