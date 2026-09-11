/**
 * Server-side UtilityAPI client.
 *
 * The UtilityAPI token lives here in functions/.env (UTILITYAPI_TOKEN) so it is
 * never exposed to the mobile client. Only active auto-bill subscribers may call
 * these through the Cloud Functions in index.js.
 */
const { HttpsError } = require("firebase-functions/v2/https");

const BASE_URL = "https://utilityapi.com/api/v2";

function token() {
  const t = process.env.UTILITYAPI_TOKEN;
  if (!t) {
    throw new HttpsError(
      "failed-precondition",
      "UtilityAPI is not configured. Add UTILITYAPI_TOKEN to functions/.env and redeploy."
    );
  }
  return t;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, options = {}, { noToken = false } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(noToken ? {} : { Authorization: `Bearer ${token()}` }),
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let message = `UtilityAPI error (${res.status})`;
    try {
      const body = await res.json();
      message = body?.error || body?.description || message;
    } catch {
      // ignore response parse errors
    }
    throw new HttpsError("internal", message);
  }
  return res.json();
}

/** Create an authorization form for the user to complete in their browser. */
async function createAuthForm(body) {
  const form = await api("/forms", {
    method: "POST",
    body: JSON.stringify(body && typeof body === "object" ? body : {}),
  });
  return form;
}

/** Poll until an authorization linked to a form shows up, then return it. */
async function waitForAuthorization(formUid, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    await delay(3000);
    const data = await api(`/authorizations?forms=${formUid}&include=meters`);
    const auth = data.authorizations?.[0];
    if (auth) return auth;
  }
  return null;
}

/** Activate meters so historical bill data starts collecting. */
async function activateMeters(meterUids) {
  await api("/meters/historical-collection", {
    method: "POST",
    body: JSON.stringify({ meters: meterUids, collection_duration: 6 }),
  });
}

async function waitForBills(meterUids, attempts = 25) {
  let states = [];
  for (let i = 0; i < attempts; i++) {
    await delay(3000);
    const data = await api(`/meters?uids=${meterUids.join(",")}`);
    const raw = data.meters || [];
    const meters = Array.isArray(raw) ? raw : Object.values(raw);
    states = meters.map((m) => String(m?.status || "unknown"));
    if (meters.some((m) => (m.bill_count || 0) > 0)) return { ready: true, states };
    if (meters.length > 0 && meters.every((m) => m.status === "errored")) return { ready: false, states };
  }
  return { ready: false, states };
}

/** Display name for a UtilityAPI utility id (falls back to the raw id). */
function nameForUtility(utilityId) {
  const id = String(utilityId || "").trim();
  if (!id) return "Unknown provider";
  const hit = SUPPORTED_UTILITIES.find((u) => u.uid.toLowerCase() === id.toLowerCase());
  return hit ? hit.name : id;
}

async function fetchLatestBill(meterUids) {
  const data = await api(`/bills?meters=${meterUids.join(",")}&limit=1&order=latest_first`);
  return data.bills?.[0] || null;
}

function billAmount(bill) {
  const total = bill.base?.bill_total_cost;
  if (typeof total === "number" && total > 0) return total;
  const items = bill.line_items || [];
  return items.reduce((sum, item) => sum + (item.cost || 0), 0);
}

function billDueDay(bill, fallback = 15) {
  const end = bill.base?.bill_end_date ? new Date(bill.base.bill_end_date).getDate() : NaN;
  if (!Number.isNaN(end) && end >= 1 && end <= 31) return end;
  return fallback;
}

/**
 * Create an authorization form. Returns { formUid, url } the client opens in a
 * browser so the user can grant access to their utility provider.
 * An optional provider uid opens the hosted page straight on that provider.
 */
exports.createAuthForm = async (utilityUid) => {
  const body = utilityUid ? { utility: utilityUid } : {};
  try {
    const form = await createAuthForm(body);
    return { formUid: form.uid, url: form.url };
  } catch (e) {
    if (utilityUid) {
      const form = await createAuthForm({});
      return { formUid: form.uid, url: form.url };
    }
    throw e;
  }
};

/**
 * Provider catalog for the in-app picker (UtilityID + display name, sorted).
 * UtilityAPI v2 has no utilities-list endpoint, so this is curated from
 * https://utilityapi.com/docs/utilities (see api/_shared/utilityapi.js).
 */
const SUPPORTED_UTILITIES = [
  { uid: "AEPIM", name: "Indiana Michigan Power (AEP)" },
  { uid: "BLUEWATER", name: "Bluewater Power" },
  { uid: "CONSUMERSENERGY", name: "Consumers Energy" },
  { uid: "DEMO", name: "Demonstration Utility (for testing)" },
  { uid: "EPE", name: "El Paso Electric" },
  { uid: "ESSEX", name: "Essex Powerlines" },
  { uid: "EVRSRCMA", name: "Eversource Massachusetts" },
  { uid: "LAKEFRONT", name: "Lakefront Utilities" },
  { uid: "NATIONALGRID", name: "National Grid" },
  { uid: "PCE", name: "WestLight Energy (PCE)" },
  { uid: "PG&E", name: "Pacific Gas and Electric (PG&E)" },
  { uid: "SCE", name: "Southern California Edison (SCE)" },
  { uid: "SDG&E", name: "San Diego Gas & Electric (SDG&E)" },
  { uid: "SoCalGas", name: "Southern California Gas (SoCalGas)" },
  { uid: "SSMPUC", name: "PUC Distribution (SSMPUC)" },
  { uid: "SWEPCO", name: "Southwestern Electric Power (SWEPCO)" },
  { uid: "WELLAND", name: "Welland Hydro-Electric" },
];

/** Provider catalog for the in-app picker (uid + name, sorted). */
exports.listUtilities = async () => SUPPORTED_UTILITIES.map((u) => ({ ...u }));

/**
 * Link a completed authorization to utility data for a property. Runs the full
 * UtilityAPI flow server-side and returns normalized bill data.
 */
/** Authorizations may carry meters as an array OR a uid-keyed object. */
function normalizeMeters(meters) {
  const arr = Array.isArray(meters) ? meters : Object.values(meters || {});
  return arr.map((m) => (m && m.uid ? String(m.uid) : null)).filter(Boolean);
}

exports.linkForProperty = async ({ formUid }) => {
  const auth = await waitForAuthorization(formUid);
  if (!auth) throw new HttpsError("aborted", "Authorization was not completed. Please try again.");
  const meterUids = normalizeMeters(auth.meters);
  if (meterUids.length === 0) {
    throw new HttpsError("not-found", "No utility meters were found for this account.");
  }
  await activateMeters(meterUids);
  const { ready, states } = await waitForBills(meterUids);
  if (!ready) {
    // Bills not collected yet — link anyway with what we have; the bill
    // fills in on refresh instead of failing the whole connect flow.
    console.warn(`Linking without bills (meter states: ${states.join(", ") || "unknown"}).`);
    return {
      amount: "0.00",
      provider: nameForUtility(auth.utility),
      dueDay: 15,
      meterUid: meterUids[0],
    };
  }
  const bill = await fetchLatestBill(meterUids);
  if (!bill) throw new HttpsError("not-found", "No bills are available yet.");
  const amount = billAmount(bill);
  if (!Number.isFinite(amount) || amount < 0) throw new HttpsError("not-found", "Could not determine the bill amount.");
  return {
    amount: amount.toFixed(2),
    provider: nameForUtility(bill.utility),
    dueDay: billDueDay(bill),
    meterUid: meterUids[0],
  };
};

/** Refresh bills for a single already-linked meter. */
exports.refreshMeter = async ({ meterUid }) => {
  await activateMeters([meterUid]);
  const { ready, states } = await waitForBills([meterUid], 20);
  if (!ready) {
    throw new HttpsError(
      "not-found",
      `No bills collected yet (meter status: ${states.join(", ") || "unknown"}). Try again in a bit.`
    );
  }
  const bill = await fetchLatestBill([meterUid]);
  if (!bill) throw new HttpsError("not-found", "No bills are available yet.");
  const amount = billAmount(bill);
  if (!Number.isFinite(amount) || amount < 0) throw new HttpsError("not-found", "Could not determine the bill amount.");
  return {
    amount: amount.toFixed(2),
    provider: nameForUtility(bill.utility),
    dueDay: billDueDay(bill),
  };
};
