# Stripe Rent Payments Setup

> **Hosting note (card-free):** All server-side logic has moved off Firebase
> Cloud Functions to a **Netlify Function** so Firebase stays on the free Spark
> plan (no Blaze, no card). The API lives in
> `netlify/functions/api.js` (Express + `serverless-http`). See
> **[NETLIFY_SETUP.md](./NETLIFY_SETUP.md)** for the full deploy+env guide;
> this file documents the Stripe products/webhooks/behaviour.

Rent payments are real money now: tenants pay with **Stripe Checkout** (card) from the
tenant portal, and every payment is a **Connect destination charge** that transfers
directly into the landlord's connected bank account.

```
Tenant card → Stripe Checkout → charge (platform account)
  → automatic transfer to landlord's connected acct_xxx balance
  → Stripe deposits into the landlord's bank account
```

## Components

| Piece | Location | What it does |
|---|---|---|
| `netlify/functions/api.js` | Netlify Function (Express) | `createRentCheckoutSession`, `createConnectOnboarding`, `getConnectStatus`, all utility-sync routes + `stripeWebhook` HTTP endpoint |
| Tenant portal pay flow | `web/app.js`, `web/index.html` | Redirects tenant to Stripe-hosted checkout, handles success/cancel return |
| Landlord payouts screen | `src/app/payouts.tsx`, `src/lib/stripe.ts` | One-time Stripe Express onboarding (bank details), live status sync |
| Payment records | Firestore via webhook | Written **only by the webhook** after Stripe confirms the charge |

## One-time setup

1. **No Blaze needed** — the API runs on a **Netlify Function** (free tier, no card).
   Firebase stays on the free Spark plan for Auth + Firestore. See NETLIFY_SETUP.md.

2. **Stripe keys** — create an account at https://dashboard.stripe.com (use Test mode first)
   and copy your secret key from Developers → API keys.

3. **Configure the API** — all secrets are Netlify **environment variables**
   (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `WEB_BASE_URL`, `PLATFORM_FEE_PERCENT`,
   plus the utility vars). Full walkthrough in NETLIFY_SETUP.md.

4. **Deploy** to Netlify (see NETLIFY_SETUP.md):
   ```bash
   npx netlify deploy --build --prod
   ```

5. **Webhook endpoint** — Stripe Dashboard → Developers → Webhooks → Add endpoint:
   - URL: `<your-netlify-site>.netlify.app/.netlify/functions/api/stripe-webhook` (see
     NETLIFY_SETUP.md for the exact URL after deploy)
   - Events: `checkout.session.completed`, `account.updated`, `invoice.paid`,
     `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the signing secret (`whsec_...`) into the Netlify env var `STRIPE_WEBHOOK_SECRET`
     (see NETLIFY_SETUP.md) so the webhook can verify signatures.
   
   For local testing instead: `stripe listen --forward-to localhost:<port>/stripe-webhook`.

6. **Update rules**: `firebase deploy --only firestore:rules` (tenants can no longer
   self-record payments; only the webhook writes them).

## Testing the full loop (Stripe test mode)

1. In the landlord app: **Tenants → card icon → "Connect Stripe Payouts"**.
   Use test data from https://docs.stripe.com/connect/testing (name, DOB, and the
   test bank `000123456789`).
2. Finish onboarding — status flips to *"Payouts are active"*.
3. In the tenant portal, tap **Pay Rent → Pay $X with Card**, use test card
   `4242 4242 4242 4242`, any future expiry / CVC.
4. After redirect back, the payment record appears in both apps within a few seconds,
   and the landlord receives the rent notification.

## Paid "utility auto-sync" subscription

Beyond rent, users can either **enter utilities manually for free** or subscribe to a
monthly paid plan that **pulls their real utility bills automatically** from their
providers (via UtilityAPI, called server-side so the token stays secret).

- Free users: manually enter each utility in add/edit property step 4.
- Subscribers: the same step shows an auto-sync button per utility; bill data is
  fetched by the Netlify API and written into `properties.utilities` with a `meterUid`.

### Setup
1. Create a **recurring Stripe product/price** (Dashboard → Products → Create product →
   Recurring monthly price) then note its **Price ID** (`price_...`).
2. Get a **UtilityAPI token** (https://utilityapi.com) — note it is a paid, per-meter
   data service, not free at scale.
3. Add these **Netlify env vars**: `UTILITYAPI_TOKEN`, `UTILITY_PLAN_PRICE_ID`,
   `UTILITY_AUTO_METER_LIMIT` (see NETLIFY_SETUP.md), then redeploy Netlify.
4. Make sure the webhook includes `invoice.paid`, `customer.subscription.updated`,
   `customer.subscription.deleted` (see webhook setup above).

### Meter cap (keeps the flat plan profitable)
Each subscriber's auto-sync is limited to `UTILITY_AUTO_METER_LIMIT` meters (default
10). The server counts unique linked `meterUid`s across that user's properties and
rejects linking a new meter once the cap is hit — so a single flat-price subscriber
can't run up an unbounded UtilityAPI bill. The app shows remaining capacity
(`X/Y meters`) and disables linking at the cap. A meter already linked to an existing
utility can still be refreshed (refresh adds no cost/no new meter).

Set the cap so `UTILITY_AUTO_METER_LIMIT × $3` stays below your monthly plan price
(e.g. price $29/mo → keep the cap between 5–9 meters).

### How entitlements work
- Subscription state lives at `users/{uid}.utilityAuto` (`active`, `currentPeriodEnd`, `stripeSubId`).
- The webhook grants/revokes `active` on subscribe, renew (`invoice.paid`), and cancel/delete.
- Every utility route checks entitlement and rejects expired/absent subscriptions,
  so free users simply use the manual entry flow.
- The meter-cap check runs at link time (`createUtilityAuthForm` early + `linkUtilityAuto`
  backstop), so a user is blocked before and after the provider login.

### Cost note
UtilityAPI itself is **not free** (~$3/meter/month to keep bills refreshed, plus
~$12 one-time per meter to backfill history). Build the auto-sync plan's monthly price
to cover that data cost, otherwise you pay it out of pocket per meter.

## Notes & limitations
- Currency is USD.
- The optional platform fee is charged as a Stripe `application_fee_amount`.
- Stripe's standard processing fee (≈2.9% + 30¢) comes out of the transferred amount;
  the landlord's payout equals rent minus processing fees minus any platform fee.
- Production hardening (recommended before going live): store `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `UTILITYAPI_TOKEN` as **encrypted secret env vars** in
  Netlify (Dashboard → Site → Environment variables → Encrypted) rather than plaintext, so
  the values aren't readable in the deploy logs.
