/**
 * Server-side UtilityAPI client (Netlify version).
 *
 * The UtilityAPI token lives in Netlify environment variables (UTILITYAPI_TOKEN)
 * so it is never exposed to the mobile client. Only active auto-bill subscribers
 * may call these, enforced by the Express routes in api.js.
 */

const BASE_URL = "https://utilityapi.com/api/v2";

/** A typed error the Express layer converts into an HTTP response. */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function token() {
  const t = process.env.UTILITYAPI_TOKEN;
  if (!t) {
    throw new ApiError(500, "UtilityAPI is not configured. Add UTILITYAPI_TOKEN to Netlify env and redeploy.");
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
    throw new ApiError(502, message);
  }
  return res.json();
}

/**
 * Provider catalog for the in-app picker (UtilityID + display name, sorted).
 *
 * UtilityAPI v2 has NO utilities-list endpoint (endpoints are templates,
 * forms, authorizations, meters, bills, intervals, files, events), so this
 * is a curated list of current UtilityIDs (see
 * https://utilityapi.com/docs/utilities — UtilityIDs are case-sensitive
 * strings like "PG&E", which is also what POST /forms accepts as `utility`).
 * If coverage changes, update this list and redeploy; unknown or retired IDs
 * safely fall back to a generic auth form in createAuthForm().
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

async function listUtilities() {
  return SUPPORTED_UTILITIES.map((u) => ({ ...u }));
}

/**
 * Create an authorization form for the user to complete in their browser.
 * When a provider uid is given, the hosted page opens straight on that
 * provider's login; falls back to a generic form if the API rejects it so a
 * bad uid can never block connecting.
 */
async function createAuthForm(utilityUid) {
  if (utilityUid) {
    try {
      return await api("/forms", {
        method: "POST",
        body: JSON.stringify({ utility: utilityUid }),
      });
    } catch (e) {
      console.warn("Preselected-utility form failed, falling back to generic form:", e.message);
    }
  }
  return api("/forms", {
    method: "POST",
    body: JSON.stringify({}),
  });
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
 */
exports.createAuthForm = async (utilityUid) => {
  const form = await createAuthForm(utilityUid);
  return { formUid: form.uid, url: form.url };
};

/** Provider catalog for the in-app picker (uid + name, sorted). */
exports.listUtilities = async () => listUtilities();

/**
 * Non-destructive status check: has the user finished the provider sign-in
 * for this form yet? Powers the Connect screen's auto-advance polling.
 */
async function checkAuthFormStatus(formUid) {
  const data = await api(`/authorizations?forms=${encodeURIComponent(formUid)}&include=meters`);
  const auth = data.authorizations?.[0];
  return { completed: !!auth, meterCount: normalizeMeters(auth?.meters).length };
}
exports.checkAuthFormStatus = async ({ formUid }) => checkAuthFormStatus(formUid);

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
  if (!auth) throw new ApiError(408, "Authorization was not completed. Please try again.");
  const meterUids = normalizeMeters(auth.meters);
  if (meterUids.length === 0) {
    throw new ApiError(404, "No utility meters were found for this account.");
  }
  await activateMeters(meterUids);
  const { ready, states } = await waitForBills(meterUids);
  if (!ready) {
    // Bills not collected yet (e.g. "Not activated" on a fresh meter).
    // Link anyway with what we have — the bill fills in on refresh — instead
    // of failing the whole connect flow.
    console.warn(`Linking without bills (meter states: ${states.join(", ") || "unknown"}).`);
    return {
      amount: "0.00",
      provider: nameForUtility(auth.utility),
      dueDay: 15,
      meterUid: meterUids[0],
    };
  }
  const bill = await fetchLatestBill(meterUids);
  if (!bill) throw new ApiError(404, "No bills are available yet.");
  const amount = billAmount(bill);
  // $0 bills are real (credits, net metering, demo data) — only reject
  // unreadable amounts so linking never fails on valid data.
  if (!Number.isFinite(amount) || amount < 0) throw new ApiError(404, "Could not determine the bill amount.");
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
    throw new ApiError(
      404,
      `No bills collected yet (meter status: ${states.join(", ") || "unknown"}). Try again in a bit.`
    );
  }
  const bill = await fetchLatestBill([meterUid]);
  if (!bill) throw new ApiError(404, "No bills are available yet.");
  const amount = billAmount(bill);
  if (!Number.isFinite(amount) || amount < 0) throw new ApiError(404, "Could not determine the bill amount.");
  return {
    amount: amount.toFixed(2),
    provider: nameForUtility(bill.utility),
    dueDay: billDueDay(bill),
  };
};

exports.ApiError = ApiError;
exports.utilityApi = exports;
