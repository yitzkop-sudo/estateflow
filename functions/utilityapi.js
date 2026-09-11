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

async function waitForBills(meterUids, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    await delay(3000);
    const data = await api(`/meters?uids=${meterUids.join(",")}`);
    const meters = data.meters || [];
    if (meters.some((m) => (m.bill_count || 0) > 0)) return true;
    if (meters.length > 0 && meters.every((m) => m.status === "errored")) return false;
  }
  return false;
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

/** Provider catalog for the in-app picker (uid + name, sorted). */
exports.listUtilities = async () => {
  const out = [];
  let page = 1;
  for (let i = 0; i < 5; i++) {
    const data = await api(`/utilities?limit=200&page=${page}`);
    const arr = data.utilities || data.data || [];
    for (const u of arr) {
      if (u && u.uid) out.push({ uid: String(u.uid), name: String(u.name || u.display_name || u.uid) });
    }
    const totalPages = data.pagination?.total_pages ?? data.total_pages ?? null;
    if (typeof totalPages === "number" ? page >= totalPages : arr.length === 0) break;
    page += 1;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
};

/**
 * Link a completed authorization to utility data for a property. Runs the full
 * UtilityAPI flow server-side and returns normalized bill data.
 */
exports.linkForProperty = async ({ formUid }) => {
  const auth = await waitForAuthorization(formUid);
  if (!auth) throw new HttpsError("aborted", "Authorization was not completed. Please try again.");
  const meters = auth.meters || [];
  if (meters.length === 0) {
    throw new HttpsError("not-found", "No utility meters were found for this account.");
  }
  const meterUids = meters.map((m) => m.uid);
  await activateMeters(meterUids);
  const ready = await waitForBills(meterUids);
  if (!ready) {
    throw new HttpsError("unavailable", "Could not fetch bill data from the provider. Try again later.");
  }
  const bill = await fetchLatestBill(meterUids);
  if (!bill) throw new HttpsError("not-found", "No bills are available yet.");
  const amount = billAmount(bill);
  if (!(amount > 0)) throw new HttpsError("not-found", "Could not determine the bill amount.");
  return {
    amount: amount.toFixed(2),
    provider: bill.utility,
    dueDay: billDueDay(bill),
    meterUid: meterUids[0],
  };
};

/** Refresh bills for a single already-linked meter. */
exports.refreshMeter = async ({ meterUid }) => {
  await activateMeters([meterUid]);
  await waitForBills([meterUid], 20);
  const bill = await fetchLatestBill([meterUid]);
  if (!bill) throw new HttpsError("not-found", "No bills are available yet.");
  const amount = billAmount(bill);
  if (!(amount > 0)) throw new HttpsError("not-found", "Could not determine the bill amount.");
  return {
    amount: amount.toFixed(2),
    provider: bill.utility,
    dueDay: billDueDay(bill),
  };
};
