# EstateFlow API on Netlify (card-free)

EstateFlow's server-side logic **no longer runs on Firebase Cloud Functions** (which
require the paid Blaze plan). Instead it runs as a **Netlify Function** powered by a
plain Express app, while **Firebase Auth + Firestore stay on the free Spark plan —
no Blaze, no credit card.**

This mirrors the proven setup in the `SYNC` project.

## Why this works

- Firebase **Auth** and **Firestore** are free on the Spark plan with no card.
- Only **Cloud Functions** require Blaze. So we host the backend elsewhere.
- A Netlify Function (`netlify/functions/api.js`) wraps the same logic the Cloud
  Functions had, using the **Firebase Admin SDK** to read/write Firestore directly.
- The app still authenticates the same way: it sends the user's **Firebase ID token**
  in an `Authorization: Bearer <token>` header, and the server verifies it with
  `admin.auth().verifyIdToken()` before each call — identical security to the old
  `req.auth` callables.

## Files

| File | Purpose |
|---|---|
| `netlify/functions/api.js` | The Express app (all routes + Stripe webhook) |
| `netlify/functions/shared/utilityapi.js` | UtilityAPI client (token stays server-side) |
| `netlify/functions/package.json` | Server deps (`express`, `serverless-http`, `firebase-admin`, `stripe`) |
| `netlify.toml` | Netlify function dir + optional `/api/*` redirect |
| `src/lib/api.ts` | App-side HTTP client (sends ID token, parses errors) |
| `src/lib/utilityapi.ts`, `src/lib/stripe.ts` | Thin wrappers over the HTTP client |
| `web/app.js` | Tenant portal — rent checkout calls the Netlify API too |

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/connect-status` | ✔ | Landlord payout status |
| POST | `/create-connect-onboarding` | ✔ | Landlord Stripe Express onboarding |
| POST | `/create-rent-checkout-session` | ✔ | Tenant rent Checkout URL |
| POST | `/create-utility-auth-form` | ✔ sub | Start UtilityAPI login |
| POST | `/link-utility-auto` | ✔ sub | Finish linking, get bill |
| POST | `/refresh-utility-auto` | ✔ sub | Refresh one meter's bill |
| GET | `/utility-subscription-status` | ✔ | Subscription + meter capacity |
| POST | `/create-utility-subscription` | ✔ | Stripe Checkout/portal URL |
| POST | `/create-plan-checkout` | (public) | Start a plan subscription from the marketing site (Starter/Professional/Auto-Sync) |
| GET | `/plan-status` | ✔ | Plan entitlements for the signed-in user (features: exports, portal, autosync) |
| GET | `/portal-entitlement` | ✔ | Tenant portal access based on the landlord's plan |
| POST | `/stripe-webhook` | (signed) | Stripe webhook (rent + subscriptions) |

(`✔ sub` = also requires an active auto-sync subscription.)

## Step 1 — Firebase service account (one-time)

The server uses a **service account** to talk to Firestore with full admin rights.

1. Firebase Console → ⚙️ Project settings → **Service accounts** tab.
2. **Generate new private key** → downloads `estateflow-827fc-firebase-adminsdk-xxxxx.json`.
3. Open it, copy the **entire JSON** (it's a single-line-able object), and paste it into
   a Netlify **environment variable** named `FIREBASE_SERVICE_ACCOUNT` (scan type:
   **Encrypted**).
   - Because it's one big string, paste it and let Netlify store it as-is; the server
     parses it with `JSON.parse`. Do **not** commit it to git (`.gitignore` covers
     `serviceAccount.json`).

## Step 2 — Netlify site + environment

1. Create an account at https://app.netlify.com (free, no card).
2. **Add new site → Import an existing project** and connect this repo (or drag-and-drop
   later). The site gets a name like `estateflow-api`.
3. In **Site settings → Environment variables**, add (Encrypted for secrets):

   | Variable | Value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | the whole service-account JSON (from step 1) |
   | `STRIPE_SECRET_KEY` | `sk_test_...` |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_...` (after step 4 hookup) |
   | `UTILITYAPI_TOKEN` | your utilityapi.com token |
   | `UTILITY_PLAN_PRICE_ID` | `price_...` (recurring monthly Stripe price — **Auto-Sync plan base**) |
   | `STARTER_PLAN_PRICE_ID` | `price_...` (Starter plan, $19.99/mo recurring) |
   | `PROFESSIONAL_PLAN_PRICE_ID` | `price_...` (Professional plan, $49.99/mo recurring) |
   | `UTILITY_METER_PRICE_ID` | `price_...` (optional metered price, $20/meter/mo — Auto-Sync per-meter add-on; create it attached to a Billing Meter, see the note below) |
   | `UTILITY_METER_EVENT_NAME` | `utility_meters` (the Billing Meter's event name — only used for meter-attached prices) |
   | `UTILITY_AUTO_METER_LIMIT` | `10` (set so `limit × $3` < monthly price; raise it, e.g. `999`, when `UTILITY_METER_PRICE_ID` is on) |
   | `WEB_BASE_URL` | public URL hosting `web/` (e.g. your Firebase Hosting URL) |
   | `PLATFORM_FEE_PERCENT` | `0` (landlord keeps all) |

   **Per-meter billing ($20/meter) in Stripe:** the API supports both Stripe Billing-Meter
   prices (newer accounts: Dashboard → **Product catalog → Billing meters → + Create meter**,
   name "Linked utility meters", event name `utility_meters`, aggregation **Last**; then add a
   Usage-based price to the Auto-Sync product at **$20/unit/month**) **and** classic
   usage-record metered prices — it auto-detects which one it's talking to. If your Dashboard
   has no Billing meters tab, create the price with one API call (see the Stripe Dashboard
   note below) and copy the resulting `price_...` into `UTILITY_METER_PRICE_ID`.

4. Set build settings so Netlify compiles the function:
   - **Build command:** `echo Building Functions`
   - **Functions directory:** `netlify/functions`
5. **Deploy** the site. The API becomes:
   ```
   https://<your-site>.netlify.app/.netlify/functions/api
   ```
   e.g. route `/create-rent-checkout-session` →
   `https://estateflow-api.netlify.app/.netlify/functions/api/create-rent-checkout-session`

## Step 3 — Point the app + portal at the API

1. **Mobile app** — add to root `.env` (also update when you build):
   ```
   EXPO_PUBLIC_API_URL=https://<your-site>.netlify.app/.netlify/functions/api
   ```
   Then restart Expo so the new env var is picked up.

2. **Tenant portal** — in `web/app.js`, replace the placeholder:
   ```js
   const API_BASE = 'https://YOUR-SITE.netlify.app/.netlify/functions/api';
   ```

## Step 4 — Point Stripe's webhook at the API

Stripe Dashboard → Developers → Webhooks → **Add endpoint**:

- URL: `https://<your-site>.netlify.app/.netlify/functions/api/stripe-webhook`
- Events:
  - `checkout.session.completed`
  - `account.updated`
  - `invoice.paid`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- **Reveal** the signing secret → set Netlify env `STRIPE_WEBHOOK_SECRET` → redeploy.

## Local testing

Install and run with Netlify CLI (uses your Netlify env for local `FIREBASE_SERVICE_ACCOUNT`
if you set `netlify env:import`, otherwise create `.env` with the same vars):

```bash
cd C:\Users\Ez\EstateFlow
npm i -g netlify-cli
netlify dev
```

The API is available at `http://localhost:8888/.netlify/functions/api`. For Stripe, run
`stripe listen --forward-to localhost:8888/.netlify/functions/api/stripe-webhook` and put
the returned `whsec_...` in your local env.

## Deploying updates

```bash
cd C:\Users\Ez\EstateFlow
npx netlify deploy --build --prod
```

(Or just push — Netlify auto-deploys from the connected repo.)

## Notes

- `netlify/functions/node_modules` is created locally and gitignored; Netlify installs
  deps from `netlify/functions/package.json` on build.
- Function runtime limits (free tier) apply, but this API is low-traffic and well inside
  them.
- The old `functions/` Cloud Functions can stay in the repo or be deleted; nothing in the
  app calls them anymore.
