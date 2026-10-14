// Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyB-wA_Mj3Idf-CBs2a2zOWkWFOYAAhK9UM",
  authDomain: "estateflow-827fc.firebaseapp.com",
  projectId: "estateflow-827fc",
  storageBucket: "estateflow-827fc.firebasestorage.app",
  messagingSenderId: "651335250513",
  appId: "1:651335250513:web:57ae5c0be381946c707e70",
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Base URL of the Provalta API (moved to Vercel — see /api/index.js).
// Replace with your Vercel URL after the first deploy.
const API_BASE = 'https://estateflow-neon.vercel.app/api';
const PORTAL_BUILD = '2026-10-12-autosync';
console.log('[portal] build ' + PORTAL_BUILD + ' api=' + API_BASE);

const INVITE_ERROR = 'No rental found for this email. Ask your landlord to add your email in Tenant Assignment, then try again.';

async function findInviteByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const snap = await db.collection('tenants')
    .where('tenantEmail', '==', normalized).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}
// State
let currentUser = null;
let tenantData = null;
let allPayments = [];
let allRequests = [];
let portalAccess = null; // null = unknown, true/false (Professional-plan gate)
let propertyUtilities = {};
let editingUtilityKey = null;
let editingUtilityMeter = null;

// ─── HELPERS ────────────────────────────────────────────────────────────────────
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');

  if (page === 'dashboard') loadDashboard();
  if (page === 'maintenance') loadAllRequests();
  if (page === 'payments') loadAllPayments();
  if (page === 'utilities') loadAllUtilities();
  if (page === 'autosync') renderAutosyncScreen();
  if (page === 'billing') loadBillingPage();
}

function showLoading() { document.getElementById('loading').style.display = 'flex'; }
function hideLoading() { document.getElementById('loading').style.display = 'none'; }

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function getGreeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning,' : h < 18 ? 'Good afternoon,' : 'Good evening,';
}

const monthKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

const ordinalSuffix = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const formatDueDay = (d) => {
  if (d === 'last') return 'Last day of month';
  return `${ordinalSuffix(d)} of month`;
};

function getRentStatus(dueDay, lastPaidAt) {
  const now = new Date();

  if (lastPaidAt) {
    const paidOn = lastPaidAt?.toDate ? lastPaidAt.toDate() : new Date(lastPaidAt);
    if (!isNaN(paidOn.getTime())) {
      const nextDue = computeNextDueDate(dueDay, paidOn);
      if (nextDue > now) return { label: 'Paid', color: '#22C55E', icon: 'fa-check-circle' };
    }
  }

  const currentDay = now.getDate();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dueDayNum = dueDay === 'last' ? lastDay : dueDay;
  const daysUntilDue = dueDayNum - currentDay;

  if (daysUntilDue < 0) return { label: 'Overdue', color: '#EF4444', icon: 'fa-exclamation-triangle' };
  if (daysUntilDue <= 3) return { label: 'Due Soon', color: '#FACC15', icon: 'fa-clock' };
  if (daysUntilDue <= 7) return { label: 'Upcoming', color: '#60A5FA', icon: 'fa-calendar' };
  return { label: 'On Track', color: '#22C55E', icon: 'fa-check-circle' };
}

function computeNextDueDate(dueDay, lastPaid) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const dueDayNum = dueDay === 'last' ? lastDay : dueDay;
  const d = new Date(year, month, dueDayNum, 9, 0, 0, 0);
  if (d <= lastPaid) d.setMonth(d.getMonth() + 1);
  return d;
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────
function switchAuthTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  document.querySelector(`.tab:${tab === 'login' ? 'first-child' : 'last-child'}`).classList.add('active');
  document.getElementById(`auth-${tab}`).classList.add('active');
  document.getElementById('login-error').textContent = '';
  document.getElementById('signup-error').textContent = '';
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  const icon = btn.querySelector('i');
  if (input.type === 'password') {
    input.type = 'text';
    icon.classList.replace('fa-eye', 'fa-eye-slash');
  } else {
    input.type = 'password';
    icon.classList.replace('fa-eye-slash', 'fa-eye');
  }
}

function friendlyError(err) {
  const msg = String(err?.message || '');
  if (msg.includes('user-not-found')) return 'No account with this email yet — tap Sign Up to create one first.';
  if (msg.includes('wrong-password') || msg.includes('invalid-credential')) return 'Invalid email or password.';
  if (msg.includes('email-already-in-use')) return 'An account with this email already exists. Try signing in instead.';
  if (msg.includes('weak-password')) return 'Password is too weak (min 6 characters).';
  if (msg.includes('too-many-requests')) return 'Too many attempts. Try again later.';
  return msg || 'Authentication failed.';
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  errorEl.textContent = '';
  if (!email || !password) { errorEl.textContent = 'Please enter both email and password.'; return; }

  btn.disabled = true;
  btn.querySelector('span').textContent = 'Signing in...';

  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    // Check if user is a tenant
    const userDoc = await db.collection('users').doc(cred.user.uid).get();
    if (userDoc.exists && userDoc.data().role === 'landlord') {
      errorEl.textContent = 'This account is a landlord. Please use the mobile app.';
      await auth.signOut();
      return;
    }
    // Invite-only: landlord must have added this email in Tenant Assignment
    const invite = await findInviteByEmail(cred.user.email);
    if (!invite) {
      errorEl.textContent = INVITE_ERROR;
      await auth.signOut();
      return;
    }
    // Find tenant record
    await findTenantRecord(cred.user.uid);
    showPage('dashboard');
  } catch (err) {
    errorEl.textContent = friendlyError(err);
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Sign In';
  }
}

async function handleSignup() {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const confirm = document.getElementById('signup-confirm').value;
  const errorEl = document.getElementById('signup-error');
  const btn = document.getElementById('signup-btn');

  errorEl.textContent = '';
  if (!name || !email || !password) { errorEl.textContent = 'Please fill in all fields.'; return; }
  if (password !== confirm) { errorEl.textContent = 'Passwords do not match.'; return; }

  btn.disabled = true;
  btn.querySelector('span').textContent = 'Creating account...';

  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });

    // Invite check runs AFTER account creation: Firestore rules only let
    // signed-in users read tenant records. No invite → remove the just
    // created login so strangers can't keep accounts.
    try {
      const invite = await findInviteByEmail(cred.user.email);
      if (!invite) {
        try { await cred.user.delete(); } catch {}
        try { await auth.signOut(); } catch {}
        errorEl.textContent = INVITE_ERROR;
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Create Account';
        return;
      }
    } catch (e) {
      try { await cred.user.delete(); } catch {}
      try { await auth.signOut(); } catch {}
      errorEl.textContent = 'Could not verify your invitation. Try again.';
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Create Account';
      return;
    }

    // Save as tenant in Firestore
    await db.collection('users').doc(cred.user.uid).set({
      role: 'tenant',
      email: email,
      displayName: name,
      createdAt: new Date().toISOString(),
    });

    await findTenantRecord(cred.user.uid);
    showPage('dashboard');
  } catch (err) {
    errorEl.textContent = friendlyError(err);
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Create Account';
  }
}

async function handleGoogleSignIn() {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const cred = await auth.signInWithPopup(provider);

    const userDoc = await db.collection('users').doc(cred.user.uid).get();
    if (userDoc.exists && userDoc.data().role === 'landlord') {
      showToast('This account is a landlord. Please use the mobile app.', 'error');
      await auth.signOut();
      return;
    }

    if (!userDoc.exists) {
      // Invite-only for Google sign-ups too
      const invite = await findInviteByEmail(cred.user.email);
      if (!invite) {
        showToast(INVITE_ERROR, 'error');
        await auth.signOut();
        return;
      }
      await db.collection('users').doc(cred.user.uid).set({
        role: 'tenant',
        email: cred.user.email,
        displayName: cred.user.displayName,
        createdAt: new Date().toISOString(),
      });
    }

    // Returning Google user: still require an invite (email may have changed)
    const inviteCheck = await findInviteByEmail(cred.user.email);
    if (!inviteCheck) {
      showToast(INVITE_ERROR, 'error');
      await auth.signOut();
      return;
    }

    await findTenantRecord(cred.user.uid);
    showPage('dashboard');
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('operation-not-supported-in-this-environment') || !window.isSecureContext) {
      showToast('Google sign-in requires a local server. Run: npx serve web', 'error');
      return;
    }
    showToast(friendlyError(err), 'error');
  }
}

async function resetPassword() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) { document.getElementById('login-error').textContent = 'Enter your email to reset password.'; return; }
  try {
    await auth.sendPasswordResetEmail(email);
    showToast('Password reset email sent. Check your inbox.');
  } catch (err) {
    document.getElementById('login-error').textContent = friendlyError(err);
  }
}

async function handleLogout() {
  await auth.signOut();
  currentUser = null;
  tenantData = null;
  portalAccess = null;
  propertyUtilities = {};
  tenantAuto = null;
  autopayStatus = null;
  billingInvoicesCache = [];
  billingInvoicesExpanded = false;
  billingInvoicesQuery = '';
  billingInvoiceSearchOpen = false;
  if (autosyncPollTimer) { clearTimeout(autosyncPollTimer); autosyncPollTimer = null; }
  showPage('login');
}

// ─── TENANT DATA ──────────────────────────────────────────────────────────────
// Invite-only: the ONLY match is tenants.tenantEmail == auth email (lowercased).
// No name fallback, no self-link — the landlord must add the email in the app.
async function findTenantRecord(uid) {
  currentUser = auth.currentUser;
  if (!currentUser) return;

  const normalized = String(currentUser.email || '').trim().toLowerCase();
  const emailSnap = await db.collection('tenants')
    .where('tenantEmail', '==', normalized).limit(1).get();
  if (!emailSnap.empty) {
    tenantData = { id: emailSnap.docs[0].id, ...emailSnap.docs[0].data() };
    return;
  }

  // No invite — sign out, there is nothing to link anymore
  tenantData = null;
  showToast(INVITE_ERROR, 'error');
  await auth.signOut();
}

// Self-linking removed: invite-only, landlord adds the email in Tenant Assignment.

// ─── PORTAL ACCESS (Professional-plan gate) ───────────────────────────────────
// The tenant portal is included in the Professional plan (and grandfathered
// Auto-Sync subscriptions). This
// checks the landlord's / property manager's plan via the API. If the API can't
// be reached (e.g. not configured yet) we fail open rather than locking out.
async function checkPortalAccess() {
  if (portalAccess !== null) return portalAccess;
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/portal-entitlement`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json().catch(() => ({}));
    portalAccess = !!body.portalAccess;
  } catch (e) {
    console.warn('Portal entitlement check failed:', e.message);
    portalAccess = null;
  }
  return portalAccess;
}

function renderPortalLocked() {
  document.getElementById('rent-card').style.display = 'none';
  document.getElementById('no-tenant-card').style.display = 'none';
  document.getElementById('link-card').style.display = 'none';
  document.getElementById('autopay-card').style.display = 'none';
  document.getElementById('locked-card').style.display = 'block';
  document.getElementById('quick-actions').style.display = 'none';
  document.getElementById('payments-header').style.display = 'none';
  document.getElementById('requests-header').style.display = 'none';
  document.getElementById('utilities-header').style.display = 'none';
  document.getElementById('payments-list').innerHTML = '';
  document.getElementById('requests-list').innerHTML = '';
  document.getElementById('utilities-list').innerHTML = '';
  document.getElementById('maintenance-badge').style.display = 'none';
}

function renderPortalUnlocked() {
  document.getElementById('locked-card').style.display = 'none';
  document.getElementById('quick-actions').style.display = '';
  document.getElementById('payments-header').style.display = '';
  document.getElementById('requests-header').style.display = '';
  document.getElementById('utilities-header').style.display = '';
}

// ─── DASHBOARD ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  if (!currentUser) return;

  // Greeting
  document.getElementById('greeting-text').textContent = getGreeting();
  document.getElementById('user-name').textContent =
    currentUser.displayName || currentUser.email?.split('@')[0] || 'Tenant';

  // The tenant portal is a Professional-plan feature: gate it on the
  // landlord's / property manager's plan.
  if ((await checkPortalAccess()) === false) {
    renderPortalLocked();
    return;
  }
  renderPortalUnlocked();

  if (!tenantData) {
    // Invite-only: no record means no access — point back to the landlord
    document.getElementById('rent-card').style.display = 'none';
    document.getElementById('link-card').style.display = 'none';
    document.getElementById('autopay-card').style.display = 'none';
    document.getElementById('no-tenant-card').style.display = 'block';
    return;
  }

  // Re-read the tenant record (lastPaidAt goes stale after paying).
  await refreshTenantData();

  document.getElementById('rent-card').style.display = 'block';
  document.getElementById('no-tenant-card').style.display = 'none';
  document.getElementById('link-card').style.display = 'none';

  const status = getRentStatus(tenantData.dueDay, tenantData.lastPaidAt);

  // Status
  document.getElementById('rent-status-dot').style.background = status.color;
  document.getElementById('rent-status-text').textContent = status.label;
  document.getElementById('rent-status-text').style.color = status.color;

  // Amount & details
  document.getElementById('rent-amount').textContent = `$${(tenantData.rentAmount || 0).toLocaleString()}`;
  document.getElementById('rent-property').textContent = tenantData.propertyName || '--';
  document.getElementById('rent-due-day').textContent = `Due ${formatDueDay(tenantData.dueDay)}`;

  // Pay button or paid banner
  if (status.label === 'Paid') {
    document.getElementById('pay-btn').style.display = 'none';
    document.getElementById('paid-banner').style.display = 'flex';
  } else {
    document.getElementById('pay-btn').style.display = 'flex';
    document.getElementById('paid-banner').style.display = 'none';
  }

  // Load recent payments
  await loadRecentPayments();

  // Load recent maintenance requests
  await loadRecentRequests();

  // Load utilities preview
  await loadUtilitiesPreview();

  // Load autopay status
  await loadAutopay();
}

// Tenant doc goes stale after paying (status reads lastPaidAt) — re-read it.
async function refreshTenantData() {
  if (!tenantData) return;
  try {
    const snap = await db.collection('tenants').doc(tenantData.id).get();
    if (snap.exists) tenantData = { id: snap.id, ...snap.data() };
  } catch (e) { console.warn('Tenant refresh failed:', e.message); }
}

async function loadRecentPayments() {
  const container = document.getElementById('payments-list');
  if (!tenantData) return;
  const ownerId = tenantData.ownerId;

  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    return monthKey(d);
  });

  allPayments = [];
  for (const mk of months) {
    try {
      // Landlord stores at: payments/{ownerId}/months/{mk}/payments/{tenantDocId}
      const docSnap = await db.collection('payments').doc(ownerId)
        .collection('months').doc(mk).collection('payments').doc(tenantData.id).get();
      if (docSnap.exists) {
        allPayments.push({ month: mk, ...docSnap.data() });
      }
    } catch (e) { console.warn('Payment read failed:', mk, e.message); }
  }

  if (allPayments.length === 0) {
    container.innerHTML = '<p class="empty-text">No payment history yet</p>';
    return;
  }

  container.innerHTML = allPayments.slice(0, 4).map(p => {
    const paidAt = p.paidAt?.toDate ? p.paidAt.toDate() : p.paidAt ? new Date(p.paidAt) : null;
    const dateStr = paidAt ? paidAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : p.month;
    return `
      <div class="list-item">
        <div class="list-icon" style="background:rgba(34,197,94,0.15);color:#22C55E;">
          <i class="fas fa-check-circle"></i>
        </div>
        <div class="list-info">
          <div class="list-title">Rent Payment</div>
          <div class="list-sub">${dateStr}</div>
        </div>
        <span class="list-amount">$${(p.rentAmount || 0).toLocaleString()}</span>
      </div>`;
  }).join('');
}

async function loadRecentRequests() {
  const container = document.getElementById('requests-list');
  try {
    const snap = await db.collection('maintenance_requests')
      .where('tenantId', '==', currentUser.uid).get();

    allRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const da = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
        const db = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
        return db - da;
      });

  // Update badge
  const pending = allRequests.filter(r => r.status === 'pending').length;
  const badge = document.getElementById('maintenance-badge');
  if (pending > 0) {
    badge.textContent = pending;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }

  if (allRequests.length === 0) {
    container.innerHTML = '<p class="empty-text">No maintenance requests yet</p>';
    return;
  }

  container.innerHTML = allRequests.slice(0, 3).map(r => {
    const statusColor = r.status === 'done' ? '#22C55E' : r.status === 'in-progress' ? '#60A5FA' : '#FACC15';
    const statusLabel = r.status === 'done' ? 'Completed' : r.status === 'in-progress' ? 'In Progress' : 'Pending';
    return `
      <div class="list-item">
        <div class="list-icon" style="background:${statusColor}15;color:${statusColor};">
          <i class="fas fa-tools"></i>
        </div>
        <div class="list-info">
          <div class="list-title">${r.title}</div>
          <div class="list-sub">${r.propertyName}</div>
        </div>
        <span class="list-badge" style="color:${statusColor};background:${statusColor}22;border-color:${statusColor}44;">
          ${statusLabel}
        </span>
      </div>`;
  }).join('');
  } catch (e) {
    console.warn('Maintenance requests load failed:', e.message);
    container.innerHTML = '<p class="empty-text">No maintenance requests yet</p>';
  }
}

// ─── STRIPE CHECKOUT RETURN HANDLING ──────────────────────────────────────────
// Stripe redirects back here after checkout (?paid=1 / ?canceled=1).
function readCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const paid = params.get('paid') === '1';
  const canceled = params.get('canceled') === '1';
  if (!paid && !canceled) return null;

  const out = { result: paid ? 'paid' : 'canceled', sessionId: params.get('session_id') };
  params.delete('paid');
  params.delete('canceled');
  params.delete('session_id');
  const qs = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${qs ? '?' + qs : ''}`);
  return out;
}
let checkoutReturn = readCheckoutReturn();

async function handleCheckoutReturn() {
  if (!checkoutReturn || !currentUser) return;
  const ret = checkoutReturn;
  checkoutReturn = null;

  if (ret.result === 'paid') {
    // Back to the dashboard first, then record + refresh.
    showPage('dashboard');
    showToast('Payment complete! Updating your receipt…');
    // Confirm directly with Stripe (heals a missed webhook), then refresh.
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_BASE}/confirm-rent-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...(ret.sessionId ? { sessionId: ret.sessionId } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
      await loadDashboard();
      showToast(data.recorded === false ? 'Rent already recorded — thank you!' : 'Rent recorded — thank you!');
    } catch (e) {
      console.warn('Rent confirm failed, falling back to refresh:', e.message);
      setTimeout(() => loadDashboard(), 1500);
      setTimeout(() => loadDashboard(), 3500);
      setTimeout(() => loadDashboard(), 8000);
    }
  } else if (ret.result === 'canceled') {
    showToast('Payment canceled. No money was charged.', 'error');
  }
}

// ─── PAY RENT (via Stripe Checkout) ───────────────────────────────────────────
function openPayModal() {
  if (!tenantData) return;
  document.getElementById('modal-property').textContent = tenantData.propertyName;
  document.getElementById('modal-amount').textContent = `$${(tenantData.rentAmount || 0).toLocaleString()}`;
  document.getElementById('modal-due-day').textContent = formatDueDay(tenantData.dueDay);
  const label = document.getElementById('confirm-pay-label');
  label.textContent = `Pay $${(tenantData.rentAmount || 0).toLocaleString()} with Card`;
  document.getElementById('confirm-pay-btn').disabled = false;
  document.getElementById('pay-modal').classList.add('active');
}

function closePayModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('pay-modal').classList.remove('active');
}

// Creates a Checkout session through the Cloud Function and redirects to
// Stripe's hosted payment page. The stripeWebhook function then confirms the
// charge server-side and writes the payment record the landlord app reads.
async function confirmPayment() {
  if (!tenantData || !currentUser) return;
  const btn = document.getElementById('confirm-pay-btn');
  const label = document.getElementById('confirm-pay-label');

  btn.disabled = true;
  label.textContent = 'Opening Stripe…';

  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/create-rent-checkout-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({ tenantId: tenantData.id, monthKey: monthKey() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
    if (!data?.url) throw new Error('No checkout URL returned.');
    window.location.href = data.url;
  } catch (err) {
    console.error('Checkout failed:', err);
    showToast(friendlyFunctionError(err), 'error');
    btn.disabled = false;
    label.textContent = 'Try Again';
  }
}

function friendlyFunctionError(err) {
  let msg = err?.message || String(err || 'Something went wrong.');
  msg = msg.replace(/^(INTERNAL|INVALID_ARGUMENT|FAILED_PRECONDITION|PERMISSION_DENIED|UNAUTHENTICATED|NOT_FOUND)\s*:\s*/i, '');
  if (/landlord|payout/i.test(msg)) return msg;
  if (/internal/i.test(msg)) return 'Payment service error. Please try again in a moment.';
  return msg;
}

// ─── MAINTENANCE ──────────────────────────────────────────────────────────────
async function loadAllRequests() {
  const container = document.getElementById('all-requests-list');
  if (!currentUser) return;

  if ((await checkPortalAccess()) === false) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px;">
        <i class="fas fa-lock" style="font-size:40px;color:#334155;"></i>
        <p class="empty-text" style="margin-top:12px;">Portal not included</p>
        <p style="color:#475569;font-size:13px;">Ask your landlord or property manager to upgrade to the Professional plan.</p>
      </div>`;
    return;
  }

  try {
    const snap = await db.collection('maintenance_requests')
      .where('tenantId', '==', currentUser.uid).get();

    allRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const da = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
        const db = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
        return db - da;
      });

  if (allRequests.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px;">
        <i class="fas fa-tools" style="font-size:48px;color:#334155;"></i>
        <p class="empty-text" style="margin-top:12px;">No maintenance requests yet</p>
        <p style="color:#475569;font-size:13px;">Submit a request when something needs repair</p>
      </div>`;
    return;
  }

  container.innerHTML = allRequests.map(r => {
    const statusColor = r.status === 'done' ? '#22C55E' : r.status === 'in-progress' ? '#60A5FA' : '#FACC15';
    const statusLabel = r.status === 'done' ? 'Completed' : r.status === 'in-progress' ? 'In Progress' : 'Pending';
    const createdAt = r.createdAt?.toDate ? r.createdAt.toDate() : new Date(r.createdAt);
    return `
      <div class="card">
        <div class="list-item" style="padding:0;border:none;">
          <div class="list-icon" style="background:${statusColor}15;color:${statusColor};border:1px solid ${statusColor}30;">
            <i class="fas fa-tools"></i>
          </div>
          <div class="list-info">
            <div class="list-title">${r.title}</div>
            <div class="list-sub">${r.propertyName}</div>
          </div>
          <span class="list-badge" style="color:${statusColor};background:${statusColor}22;border-color:${statusColor}44;">
            ${statusLabel}
          </span>
        </div>
        ${r.description ? `<p style="color:#94A3B8;font-size:13px;margin:12px 0;line-height:1.5;">${r.description}</p>` : ''}
        <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:10px;margin-top:8px;">
          <span style="color:#64748B;font-size:12px;">
            Submitted ${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </div>
      </div>`;
  }).join('');
  } catch (e) {
    console.warn('Maintenance load failed:', e.message);
    container.innerHTML = `
      <div style="text-align:center;padding:40px;">
        <i class="fas fa-tools" style="font-size:48px;color:#334155;"></i>
        <p class="empty-text" style="margin-top:12px;">No maintenance requests yet</p>
        <p style="color:#475569;font-size:13px;">Submit a request when something needs repair</p>
      </div>`;
  }
}

function openMaintenanceModal() {
  if (tenantData) {
    document.getElementById('modal-maint-property').querySelector('span').textContent = tenantData.propertyName;
  }
  document.getElementById('maint-title').value = '';
  document.getElementById('maint-description').value = '';
  document.getElementById('maintenance-modal').classList.add('active');
}

function closeMaintenanceModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('maintenance-modal').classList.remove('active');
}

async function submitMaintenanceRequest() {
  const title = document.getElementById('maint-title').value.trim();
  const description = document.getElementById('maint-description').value.trim();
  const btn = document.getElementById('submit-maint-btn');

  if (!title) { showToast('Please enter a title for your request.', 'error'); return; }
  if (!tenantData) { showToast('No property assigned.', 'error'); return; }
  if (!tenantData.ownerId) { showToast('Your landlord is not linked yet — ask them to re-add you so this request reaches them.', 'error'); return; }

  btn.disabled = true;

  try {
    await db.collection('maintenance_requests').add({
      tenantId: currentUser.uid,
      tenantName: tenantData.tenantName,
      propertyName: tenantData.propertyName,
      ownerId: tenantData.ownerId,
      title,
      description,
      status: 'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Notify landlord
    await db.collection('notifications').doc(tenantData.ownerId)
      .collection('items').doc(`maintenance-${currentUser.uid}-${Date.now()}`).set({
        type: 'maintenance_request',
        tenantName: tenantData.tenantName,
        propertyName: tenantData.propertyName,
        title,
        message: `${tenantData.tenantName} submitted a maintenance request for ${tenantData.propertyName}: "${title}"`,
        read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

    closeMaintenanceModal();
    loadAllRequests();
    showToast('Your maintenance request has been submitted!');
  } catch (err) {
    showToast(err.message || 'Failed to submit request.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ─── PAYMENT HISTORY ──────────────────────────────────────────────────────────
async function loadAllPayments() {
  const container = document.getElementById('all-payments-list');
  if (!currentUser || !tenantData) return;

  if ((await checkPortalAccess()) === false) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px;">
        <i class="fas fa-lock" style="font-size:40px;color:#334155;"></i>
        <p class="empty-text" style="margin-top:12px;">Portal not included</p>
        <p style="color:#475569;font-size:13px;">Ask your landlord or property manager to upgrade to the Professional plan.</p>
      </div>`;
    return;
  }

  const ownerId = tenantData.ownerId;

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    return monthKey(d);
  });

  const payments = [];
  let total = 0;

  for (const mk of months) {
    try {
      // Read from landlord's path: payments/{ownerId}/months/{mk}/payments/{tenantDocId}
      const docSnap = await db.collection('payments').doc(ownerId)
        .collection('months').doc(mk).collection('payments').doc(tenantData.id).get();
      if (docSnap.exists) {
        const p = docSnap.data();
        const amount = p.rentAmount || 0;
        payments.push({ month: mk, ...p });
        total += amount;
      }
    } catch {}
  }

  document.getElementById('total-paid').textContent = `$${total.toLocaleString()}`;
  document.getElementById('total-count').textContent = `${payments.length} payment${payments.length !== 1 ? 's' : ''}`;

  if (payments.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px;">
        <i class="fas fa-credit-card" style="font-size:48px;color:#334155;"></i>
        <p class="empty-text" style="margin-top:12px;">No payment history yet</p>
        <p style="color:#475569;font-size:13px;">Your rent payments will appear here</p>
      </div>`;
    return;
  }

  // Group by year
  const grouped = {};
  payments.forEach(p => {
    const year = p.month.split('-')[0];
    if (!grouped[year]) grouped[year] = [];
    grouped[year].push(p);
  });

  let html = '';
  for (const [year, yearPayments] of Object.entries(grouped).sort((a, b) => b[0] - a[0])) {
    html += `<h3 style="color:#fff;font-size:18px;font-weight:800;margin:16px 0 10px;">${year}</h3>`;
    yearPayments.forEach(p => {
      const paidAt = p.paidAt?.toDate ? p.paidAt.toDate() : p.paidAt ? new Date(p.paidAt) : null;
      const monthLabel = new Date(parseInt(p.month.split('-')[0]), parseInt(p.month.split('-')[1]) - 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      html += `
        <div class="card">
          <div class="list-item" style="padding:0;border:none;">
            <div class="list-icon" style="background:rgba(34,197,94,0.15);color:#22C55E;">
              <i class="fas fa-check-circle"></i>
            </div>
            <div class="list-info">
              <div class="list-title">${monthLabel}</div>
              <div class="list-sub">${paidAt ? 'Paid ' + paidAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : p.month}</div>
            </div>
            <span class="list-amount">$${(p.rentAmount || 0).toLocaleString()}</span>
          </div>
        </div>`;
    });
  }

  container.innerHTML = html;
}

// ─── UTILITIES (same fields as the app) ───────────────────────────────────────
const UTILITY_TYPES = ['Electric', 'Water', 'Gas', 'Oil', 'Sewer', 'Trash'];
const UTILITY_ICONS = { Electric: 'fa-bolt', Water: 'fa-droplet', Gas: 'fa-wind', Oil: 'fa-oil-can', Sewer: 'fa-layer-group', Trash: 'fa-trash' };
const UTILITY_COLORS = { Electric: '#A78BFA', Water: '#60A5FA', Gas: '#34D399', Oil: '#FB923C', Sewer: '#2DD4BF', Trash: '#78716C' };

function formatUtilDueDay(d) {
  if (d === 'last') return 'Last day of month';
  return `${ordinalSuffix(Number(d))} of month`;
}

async function fetchUtilities() {
  if (!tenantData || !currentUser) return {};
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}/tenant-property-utilities?tenantId=${encodeURIComponent(tenantData.id)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  propertyUtilities = data.utilities || {};
  return propertyUtilities;
}

async function persistUtilities(next, meterKey, meterIndex) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}/tenant-property-utilities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      tenantId: tenantData.id,
      utilities: next,
      ...(meterKey ? { meterKey } : {}),
      ...(meterIndex === null || meterIndex === undefined ? {} : { meterIndex }),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  propertyUtilities = data.utilities || next;
  return propertyUtilities;
}

function utilityRow(key, u, showDelete) {
  const icon = UTILITY_ICONS[key] || 'fa-bolt';
  const color = UTILITY_COLORS[key] || '#60A5FA';
  const extras = Array.isArray(u.meters) ? u.meters : [];
  const total = (Number(u.amount) || 0) + extras.reduce((s, m) => s + (Number(m && m.amount) || 0), 0);
  return `
    <div class="list-item" onclick="openUtilityModal('${key}')" style="cursor:pointer;">
      <div class="list-icon" style="background:${color}22;color:${color};">
        <i class="fas ${icon}"></i>
      </div>
      <div class="list-info">
        <div class="list-title">${key}${u.provider ? ` · ${u.provider}` : ''}${extras.length ? ` · ${1 + extras.length} meters` : ''}</div>
        <div class="list-sub">Due ${formatUtilDueDay(u.dueDay)}${u.notify === false ? ' · no reminders' : ''}${u.auto ? ' · auto-sync' : ''}</div>
      </div>
      <span class="list-amount">$${total.toLocaleString()}</span>
    </div>`;
}

// Assigned slots for one utility: landlord-flagged meters only (legacy: primary).
function slotsFor(key) {
  const u = propertyUtilities[key];
  if (!u) return [];
  const extras = Array.isArray(u.meters) ? u.meters : [];
  const anyFlagged = !!u.tenantPays || extras.some((m) => m && m.tenantPays);
  const prim = { amount: u.amount || '', provider: u.provider || '', dueDay: u.dueDay ?? 15, notify: u.notify, meterUid: u.meterUid, auto: u.auto, label: '' };
  if (!anyFlagged) return [{ index: null, m: prim }];
  const out = [];
  if (u.tenantPays) out.push({ index: null, m: prim });
  extras.forEach((m, i) => {
    if (m && m.tenantPays) out.push({ index: i, m: { amount: m.amount || '', provider: m.provider || '', dueDay: m.dueDay ?? 15, notify: m.notify, meterUid: m.meterUid, auto: m.auto, label: m.label || '' } });
  });
  return out;
}

function slotRow(key, slot) {
  const icon = UTILITY_ICONS[key] || 'fa-bolt';
  const color = UTILITY_COLORS[key] || '#60A5FA';
  const m = slot.m;
  const idx = slot.index === null ? 'null' : slot.index;
  const name = m.label ? `${key} · ${m.label}` : key;
  return `
    <div class="list-item" onclick="openUtilityModal('${key}', ${idx})" style="cursor:pointer;">
      <div class="list-icon" style="background:${color}22;color:${color};">
        <i class="fas ${icon}"></i>
      </div>
      <div class="list-info">
        <div class="list-title">${name}${m.provider ? ` · ${m.provider}` : ''}</div>
        <div class="list-sub">Due ${formatUtilDueDay(m.dueDay)}${m.notify === false ? ' · no reminders' : ''}${m.auto ? ' · auto-sync' : ''}</div>
      </div>
      <span class="list-amount">$${Number(m.amount || 0).toLocaleString()}</span>
    </div>
    ${autosyncRow(key, slot)}`;
}

async function loadUtilitiesPreview() {
  const container = document.getElementById('utilities-list');
  if (!container || !tenantData) return;
  try {
    await fetchUtilities();
    const rows = [];
    for (const k of UTILITY_TYPES) {
      for (const slot of slotsFor(k)) rows.push({ k, slot });
      if (rows.length >= 3) break;
    }
    if (rows.length === 0) {
      container.innerHTML = '<p class="empty-text">No utilities yet — tap Manage to add one</p>';
      return;
    }
    container.innerHTML = rows.slice(0, 3).map(({ k, slot }) => slotRowPreview(k, slot)).join('');
  } catch (e) {
    console.warn('Utilities load failed:', e.message);
    container.innerHTML = '<p class="empty-text">Utilities unavailable right now</p>';
  }
}

function slotRowPreview(k, slot) {
  const icon = UTILITY_ICONS[k] || 'fa-bolt';
  const color = UTILITY_COLORS[k] || '#60A5FA';
  const m = slot.m;
  const name = m.label ? `${k} · ${m.label}` : k;
  return `
    <div class="list-item">
      <div class="list-icon" style="background:${color}22;color:${color};">
        <i class="fas ${icon}"></i>
      </div>
      <div class="list-info">
        <div class="list-title">${name}${m.provider ? ` · ${m.provider}` : ''}</div>
        <div class="list-sub">Due ${formatUtilDueDay(m.dueDay)}${m.auto ? ' · auto-sync' : ''}</div>
      </div>
      <span class="list-amount">$${Number(m.amount || 0).toLocaleString()}</span>
    </div>`;
}

async function loadAllUtilities() {
  const container = document.getElementById('all-utilities-list');
  if (!currentUser || !tenantData) return;

  if ((await checkPortalAccess()) === false) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px;">
        <i class="fas fa-lock" style="font-size:40px;color:#334155;"></i>
        <p class="empty-text" style="margin-top:12px;">Portal not included</p>
        <p style="color:#475569;font-size:13px;">Ask your landlord or property manager to upgrade to the Professional plan.</p>
      </div>`;
    return;
  }

  try {
    await fetchUtilities();
    try { await fetchTenantAuto(); } catch (e) { console.warn('Auto-sync status unavailable:', e.message); tenantAuto = null; }
    const cards = [];
    let assignedCount = 0;
    let assignedTotal = 0;
    for (const k of UTILITY_TYPES) {
      const u = propertyUtilities[k];
      if (!u) {
        const icon = UTILITY_ICONS[k] || 'fa-bolt';
        const color = UTILITY_COLORS[k] || '#60A5FA';
        cards.push(`<div class="card">
          <div class="list-item">
            <div class="list-icon" style="background:${color}22;color:${color};opacity:0.55;">
              <i class="fas ${icon}"></i>
            </div>
            <div class="list-info">
              <div class="list-title">${k}</div>
              <div class="list-sub">Not set up yet</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button class="btn secondary" style="padding:10px;" onclick="openUtilityModal('${k}', null)">Enter manually</button>
            <button class="btn secondary" style="padding:10px;" onclick="openAutosyncScreen('${k}')">Auto-sync · $20/mo</button>
          </div>
        </div>`);
        continue;
      }
      const slots = slotsFor(k);
      for (const slot of slots) {
        assignedCount++;
        assignedTotal += Number(slot.m.amount) || 0;
        cards.push(`<div class="card">${slotRow(k, slot)}</div>`);
      }
    }
    const header = assignedCount === 0
      ? `<div class="card" style="margin-top: 4px;"><p class="empty-text">Set up each bill below — enter it manually or auto-sync it. These are your own bills on your own account.</p></div>`
      : `
      <div class="card total-card" style="margin-top: 4px;">
        <div class="total-icon"><i class="fas fa-bolt"></i></div>
        <p class="total-label">My Utilities · ${tenantData.propertyName || ''}</p>
        <h2 class="total-amount">$${assignedTotal.toLocaleString()}</h2>
        <p class="total-sub">${assignedCount} ${assignedCount === 1 ? 'meter' : 'meters'}${tenantAuto ? ` · ${tenantAuto.linkedMeters}/${tenantAuto.meterLimit} auto meters` : ''}</p>
      </div>`;
    container.innerHTML = header + cards.join('');
  } catch (e) {
    console.warn('Utilities load failed:', e.message);
    container.innerHTML = '<p class="empty-text">Utilities unavailable right now</p>';
  }
}

function openUtilityModal(key, meterIndex) {
  if (!tenantData) return;
  editingUtilityKey = key || null;
  editingUtilityMeter = (meterIndex === null || meterIndex === undefined) ? null : meterIndex;
  const slot = key ? slotsFor(key).find((s) => s.index === editingUtilityMeter) : null;
  const existing = slot ? slot.m : null;
  const title = key ? (existing ? `Edit ${existing.label ? `${key} · ${existing.label}` : key}` : `Add ${key}`) : 'Add Utility';
  document.getElementById('utility-modal-title').textContent = title;
  document.getElementById('modal-util-property').querySelector('span').textContent = tenantData.propertyName || '';
  document.getElementById('util-type').value = key || 'Electric';
  document.getElementById('util-type').disabled = !!key;
  document.getElementById('util-provider').value = existing?.provider || '';
  document.getElementById('util-amount').value = existing?.amount || '';
  document.getElementById('util-due-day').value = String(existing?.dueDay ?? '15');
  document.getElementById('util-notify').checked = existing?.notify !== false;
  document.getElementById('util-error').textContent = '';
  // Whole-key remove only for the primary slot of a meter-less utility.
  const u = key ? propertyUtilities[key] : null;
  const canDelete = !!existing && editingUtilityMeter === null && !(Array.isArray(u?.meters) && u.meters.length > 0);
  document.getElementById('delete-util-btn').style.display = canDelete ? 'flex' : 'none';
  document.getElementById('utility-modal').classList.add('active');
}

function closeUtilityModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('utility-modal').classList.remove('active');
  editingUtilityKey = null;
  editingUtilityMeter = null;
}

async function saveUtility() {
  const errorEl = document.getElementById('util-error');
  const btn = document.getElementById('save-util-btn');
  errorEl.textContent = '';

  const key = editingUtilityKey || document.getElementById('util-type').value;
  const provider = document.getElementById('util-provider').value.trim();
  const amount = document.getElementById('util-amount').value.trim();
  const dueRaw = document.getElementById('util-due-day').value;
  const notify = document.getElementById('util-notify').checked;

  if (!UTILITY_TYPES.includes(key)) { errorEl.textContent = 'Pick a utility type.'; return; }
  if (amount === '' || isNaN(Number(amount)) || Number(amount) < 0) { errorEl.textContent = 'Enter a valid amount.'; return; }
  const dueDay = dueRaw === 'last' ? 'last' : Number(dueRaw);
  if (dueDay !== 'last' && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) { errorEl.textContent = 'Pick a valid due day.'; return; }

  btn.disabled = true;
  try {
    // Send the full map (server routes the edit into our assigned slot and
    // freezes everything else); deletions are keys we omit.
    const next = { ...propertyUtilities };
    if (editingUtilityKey && editingUtilityMeter !== null && editingUtilityMeter !== undefined) {
      const cur = next[editingUtilityKey] || {};
      const extras = Array.isArray(cur.meters) ? [...cur.meters] : [];
      extras[editingUtilityMeter] = { ...(extras[editingUtilityMeter] || {}), amount, provider, dueDay, notify };
      next[editingUtilityKey] = { ...cur, meters: extras };
    } else {
      next[key] = { ...((next[key] && typeof next[key] === 'object') ? next[key] : {}), amount, provider, dueDay, notify };
    }
    await persistUtilities(next, key, editingUtilityMeter);
    closeUtilityModal();
    await loadAllUtilities();
    await loadUtilitiesPreview();
    showToast(`${key} saved — your landlord sees it in the app.`);
  } catch (err) {
    errorEl.textContent = err.message || 'Could not save utility.';
  } finally {
    btn.disabled = false;
  }
}

async function deleteUtility() {
  if (!editingUtilityKey) return;
  const key = editingUtilityKey;
  const btn = document.getElementById('delete-util-btn');
  btn.disabled = true;
  try {
    const next = { ...propertyUtilities };
    delete next[key];
    await persistUtilities(next);
    closeUtilityModal();
    await loadAllUtilities();
    await loadUtilitiesPreview();
    showToast(`${key} removed.`);
  } catch (err) {
    document.getElementById('util-error').textContent = err.message || 'Could not remove utility.';
  } finally {
    btn.disabled = false;
  }
}

// ─── TENANT AUTO-SYNC ($20/mo per meter on the tenant's own card) ───────────
// Subscription lives on users/{tenantUid}.utilityAuto — the landlord is never
// charged. Meters land on the rental's property doc so both sides see bills.
let tenantAuto = null;
let autosyncPollTimer = null;

async function tenantApi(path, options) {
  const token = await currentUser.getIdToken();
  const isGet = !options || !options.method || options.method === 'GET';
  const res = await fetch(`${API_BASE}${path}`, {
    ...(options || {}),
    headers: { ...(options && options.headers), ...(isGet ? {} : { 'Content-Type': 'application/json' }), 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.message || `Request failed (${res.status})`).replace(/^(INTERNAL|INVALID_ARGUMENT|FAILED_PRECONDITION|PERMISSION_DENIED|UNAUTHENTICATED|NOT_FOUND)\s*:\s*/i, ''));
  return data;
}

async function fetchTenantAuto() {
  tenantAuto = await tenantApi(`/tenant-utility-status?tenantId=${encodeURIComponent(tenantData.id)}`);
  return tenantAuto;
}

function autosyncRow(key, slot) {
  const m = slot.m;
  const idx = slot.index === null ? 'null' : slot.index;
  // Show the button even when status couldn't load — the modal will surface
  // the real error instead of hiding the feature silently.
  if (!tenantAuto) {
    return `<button class="btn secondary" style="margin-top:10px;padding:12px;" onclick="openAutosyncModal('${key}', ${idx})">Auto-sync bills · $20/mo</button>`;
  }
  const sub = tenantAuto.subscriptions && tenantAuto.subscriptions[key];
  const active = !!(sub && sub.active);
  if (m.auto) {
    return `<div style="display:flex;gap:8px;margin-top:10px;">
      <button class="btn secondary" style="padding:10px;" onclick="refreshLinkedUtility('${key}', ${idx})">Refresh bill</button>
      <button class="btn secondary" style="padding:10px;" onclick="openAutosyncModal('${key}', ${idx})">Manage auto-sync</button>
    </div>`;
  }
  if (active) {
    return `<button class="btn primary" style="margin-top:10px;padding:12px;" onclick="openAutosyncModal('${key}', ${idx})">Connect provider (subscribed)</button>`;
  }
  return `<button class="btn secondary" style="margin-top:10px;padding:12px;" onclick="openAutosyncScreen('${key}', undefined, ${idx})">Auto-sync bills · $20/mo</button>`;
}

function openAutosyncModal(key, meterIndex) {
  editingUtilityKey = key;
  editingUtilityMeter = (meterIndex === null || meterIndex === undefined) ? null : meterIndex;
  const slot = key ? slotsFor(key).find((s) => s.index === editingUtilityMeter) : null;
  const name = slot && slot.m.label ? `${key} · ${slot.m.label}` : key;
  document.getElementById('autosync-title').textContent = `Auto-sync · ${name}`;
  document.getElementById('autosync-body').innerHTML = '<p class="empty-text">Loading...</p>';
  document.getElementById('autosync-modal').classList.add('active');
  renderAutosyncBody(key).catch((e) => {
    document.getElementById('autosync-body').innerHTML = `<p class="empty-text">${e.message || 'Unavailable right now.'}</p>`;
  });
}

function closeAutosyncModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('autosync-modal').classList.remove('active');
  if (autosyncPollTimer) { clearTimeout(autosyncPollTimer); autosyncPollTimer = null; }
}

async function renderAutosyncBody(key) {
  await fetchTenantAuto();
  const body = document.getElementById('autosync-body');
  const sub = tenantAuto.subscriptions[key];
  const slot = slotsFor(key).find((s) => s.index === editingUtilityMeter);
  const u = slot ? slot.m : {};
  const idx = editingUtilityMeter === null || editingUtilityMeter === undefined ? 'null' : editingUtilityMeter;
  if (!sub || !sub.active) {
    const cancelNote = sub && sub.cancelAtPeriodEnd ? `<p style="color:#FBBF24;font-size:13px;">Canceled — runs to ${sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : 'period end'}.</p>` : '';
    body.innerHTML = `
      <p style="color:#94A3B8;font-size:14px;line-height:1.6;margin-bottom:12px;">
        Link your <b style="color:#E2E8F0;">${key}${u.label ? ` · ${u.label}` : ''}</b> provider and bills sync automatically.
        <b style="color:#E2E8F0;">$20/month per meter</b> on your own card — your landlord is not charged.
      </p>
      ${cancelNote}
      <button class="btn primary" onclick="openAutosyncScreen('${key}', undefined, ${idx})">
        <i class="fas fa-bolt"></i><span>Start auto-sync setup</span>
      </button>
      ${tenantAuto.portalUrl ? `<button class="btn secondary" style="margin-top:10px;" onclick="window.open('${tenantAuto.portalUrl}', '_blank')">Manage billing</button>` : ''}`;
    return;
  }
  if (!u.auto) {
    body.innerHTML = `
      <p style="color:#22C55E;font-size:14px;font-weight:700;margin-bottom:12px;">Subscribed — now connect your provider.</p>
      <div id="autosync-error" class="error-text"></div>
      <button class="btn primary" onclick="openAutosyncScreen('${key}', 'provider', ${idx})">
        <i class="fas fa-link"></i><span>Choose provider & connect</span>
      </button>
      <button class="btn danger" style="margin-top:10px;" onclick="cancelTenantSub('${key}', false)">Cancel subscription</button>`;
    return;
  }
  body.innerHTML = `
    <p style="color:#22C55E;font-size:14px;font-weight:700;margin-bottom:6px;">Auto-sync is on${u.provider ? ` · ${u.provider}` : ''}.</p>
    <p style="color:#94A3B8;font-size:13px;margin-bottom:12px;">Latest bill: $${Number(u.amount || 0).toLocaleString()}${sub.cancelAtPeriodEnd ? ' · subscription canceled, runs to period end' : ''}</p>
    <div id="autosync-error" class="error-text"></div>
    <button class="btn primary" onclick="refreshLinkedUtility('${key}', ${idx});closeAutosyncModal();">
      <i class="fas fa-refresh"></i><span>Refresh bill now</span>
    </button>
    ${sub.cancelAtPeriodEnd
      ? `<button class="btn secondary" style="margin-top:10px;" onclick="cancelTenantSub('${key}', true)">Resume subscription</button>`
      : `<button class="btn danger" style="margin-top:10px;" onclick="cancelTenantSub('${key}', false)">Cancel subscription</button>`}
    ${tenantAuto.portalUrl ? `<button class="btn secondary" style="margin-top:10px;" onclick="window.open('${tenantAuto.portalUrl}', '_blank')">Manage billing</button>` : ''}`;
}

// ─── AUTO-SYNC SETUP SCREEN (same order as the app) ─────────────────────────
// Utility → provider (searchable) → checkout ($20/mo on the tenant's card) →
// authorize provider + connect. One dedicated screen, no popups.
let autosyncWizard = null;
let providerCatalog = null;

function openAutosyncScreen(key, step, meterIndex) {
  if (!tenantData) return;
  if (autosyncPollTimer) { clearTimeout(autosyncPollTimer); autosyncPollTimer = null; }
  autosyncWizard = { key: key || null, providerUid: null, providerName: null, step: step || (key ? 'provider' : 'utility'), meterIndex: (meterIndex === null || meterIndex === undefined) ? null : meterIndex };
  try {
    const saved = window.localStorage.getItem('estateflow-autosync-provider-' + (key || ''));
    if (saved) autosyncWizard.providerUid = saved;
    const savedName = window.localStorage.getItem('estateflow-autosync-provider-name-' + (key || ''));
    if (savedName) autosyncWizard.providerName = savedName;
  } catch {}
  document.getElementById('autosync-modal').classList.remove('active');
  showPage('autosync');
}

function closeAutosyncScreen() {
  if (autosyncPollTimer) { clearTimeout(autosyncPollTimer); autosyncPollTimer = null; }
  showPage('utilities');
}

function screenBack() {
  if (!autosyncWizard) { closeAutosyncScreen(); return; }
  const s = autosyncWizard.step;
  if (s === 'utility') { closeAutosyncScreen(); return; }
  autosyncWizard.step = s === 'provider' ? 'utility' : s === 'checkout' ? 'provider' : 'checkout';
  renderAutosyncScreen();
}

function stepDots(activeIdx) {
  const labels = ['Utility', 'Provider', 'Checkout', 'Authorize'];
  document.getElementById('autosync-steps').innerHTML = labels.map((l, i) => `
    <div style="flex:1;text-align:center;">
      <div style="height:6px;border-radius:3px;background:${i <= activeIdx ? '#3B82F6' : 'rgba(255,255,255,0.1)'};"></div>
      <div style="font-size:10.5px;margin-top:4px;color:${i <= activeIdx ? '#93C5FD' : '#475569'};font-weight:700;">${l}</div>
    </div>`).join('');
}

async function renderAutosyncScreen() {
  const w = autosyncWizard;
  const body = document.getElementById('autosync-screen-body');
  if (!w || !tenantData) { showPage('utilities'); return; }
  const idx = { utility: 0, provider: 1, checkout: 2, authorize: 3 }[w.step] ?? 0;
  stepDots(idx);

  if (w.step === 'utility') {
    try { if (!tenantAuto) await fetchTenantAuto(); } catch {}
    const subs = (tenantAuto && tenantAuto.subscriptions) || {};
    body.innerHTML = `
      <p style="color:#94A3B8;font-size:14px;margin-bottom:12px;">Which bill should sync automatically?</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        ${UTILITY_TYPES.map((k) => {
          const linked = propertyUtilities[k] && propertyUtilities[k].auto;
          const subbed = subs[k] && subs[k].active;
          const tag = linked ? ' · linked ✓' : subbed ? ' · subscribed' : '';
          return `<button class="btn secondary" style="padding:14px;" onclick="screenPickUtility('${k}')">${k}${tag}</button>`;
        }).join('')}
      </div>`;
    return;
  }

  if (w.step === 'provider') {
    body.innerHTML = `
      <p style="color:#94A3B8;font-size:14px;margin-bottom:12px;">Who provides your <b style="color:#E2E8F0;">${w.key}</b>?</p>
      <div class="input-group">
        <input type="text" id="autosync-screen-search" placeholder="Search providers…" autocomplete="off">
        <i class="fas fa-search input-icon"></i>
      </div>
      <div id="autosync-screen-providers"><p class="empty-text">Loading...</p></div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn secondary" style="padding:12px;" onclick="screenBack()">Back</button>
        <button class="btn primary" style="padding:12px;" onclick="screenSkipProvider()">Skip</button>
      </div>`;
    const search = document.getElementById('autosync-screen-search');
    search.addEventListener('input', renderScreenProviders);
    try {
      if (!providerCatalog) providerCatalog = await tenantApi('/supported-utilities');
      renderScreenProviders();
    } catch (e) {
      document.getElementById('autosync-screen-providers').innerHTML = '<p class="empty-text">Provider list unavailable — tap Skip to continue.</p>';
    }
    return;
  }

  if (w.step === 'checkout') {
    body.innerHTML = `
      <div class="card" style="margin-bottom:12px;">
        <div class="pay-summary">
          <div class="summary-row"><span>Utility</span><span>${w.key}</span></div>
          <div class="summary-divider"></div>
          <div class="summary-row"><span>Provider</span><span>${w.providerName || 'Any (pick at authorize)'}</span></div>
          <div class="summary-divider"></div>
          <div class="summary-row"><span>Plan</span><span class="amount-green">$20/mo per meter</span></div>
        </div>
      </div>
      <p style="color:#94A3B8;font-size:12.5px;margin-bottom:12px;">Charged to your own card — your landlord is not charged.</p>
      <div style="display:flex;gap:8px;">
        <button class="btn secondary" style="padding:12px;" onclick="screenBack()">Back</button>
        <button class="btn primary" style="padding:12px;" onclick="screenCheckout()" id="screen-pay-btn">
          <i class="fas fa-credit-card"></i><span>Pay $20/mo</span>
        </button>
      </div>`;
    return;
  }

  // authorize
  body.innerHTML = `
    <div class="card" style="text-align:center;padding:28px 22px;">
      <div style="width:56px;height:56px;border-radius:16px;background:rgba(59,130,246,0.12);display:flex;align-items:center;justify-content:center;margin:0 auto 12px;">
        <i class="fas fa-link" style="font-size:24px;color:var(--accent);"></i>
      </div>
      <h3 style="margin-bottom:6px;">Sign in with your provider</h3>
      <p style="color:var(--text-secondary);font-size:14px;margin-bottom:16px;">A provider page opens in a new tab. Finish signing in there, then wait here — connecting happens automatically.</p>
      <div id="autosync-error" class="error-text"></div>
      <button class="btn primary" onclick="screenAuthorize()" id="screen-auth-btn">
        <i class="fas fa-external-link-alt"></i><span>Authorize provider</span>
      </button>
      <button class="btn secondary" style="margin-top:10px;" onclick="screenBack()">Back</button>
    </div>`;
}

function screenPickUtility(key) {
  autosyncWizard.key = key;
  autosyncWizard.step = 'provider';
  autosyncWizard.providerUid = null;
  autosyncWizard.providerName = null;
  try {
    autosyncWizard.providerUid = window.localStorage.getItem('estateflow-autosync-provider-' + key) || null;
    autosyncWizard.providerName = window.localStorage.getItem('estateflow-autosync-provider-name-' + key) || null;
  } catch {}
  renderAutosyncScreen();
}

function renderScreenProviders() {
  const container = document.getElementById('autosync-screen-providers');
  if (!container) return;
  const q = (document.getElementById('autosync-screen-search').value || '').trim().toLowerCase();
  const list = (providerCatalog || []).filter((p) => !q || (p.name || '').toLowerCase().includes(q));
  if (list.length === 0) {
    container.innerHTML = '<p class="empty-text">No providers match your search.</p>';
    return;
  }
  container.innerHTML = list.slice(0, 200).map((p) => `
    <div class="card list-card" style="margin-bottom:10px;cursor:pointer;" onclick="screenPickProvider('${String(p.uid).replace(/'/g, "\\'")}', this)" data-name="${String(p.name || '').replace(/"/g, '&quot;')}">
      <div class="list-item">
        <div class="list-icon" style="background:rgba(59,130,246,0.12);color:#60A5FA;">
          <i class="fas fa-bolt"></i>
        </div>
        <div class="list-info"><div class="list-title">${String(p.name || 'Unknown')}</div></div>
        <i class="fas fa-chevron-right" style="color:#475569;"></i>
      </div>
    </div>`).join('');
}

function screenPickProvider(uid, el) {
  const name = el ? el.dataset.name : uid;
  autosyncWizard.providerUid = uid || null;
  autosyncWizard.providerName = name || null;
  try {
    if (uid && autosyncWizard.key) window.localStorage.setItem('estateflow-autosync-provider-' + autosyncWizard.key, uid);
    if (name && autosyncWizard.key) window.localStorage.setItem('estateflow-autosync-provider-name-' + autosyncWizard.key, name);
  } catch {}
  autosyncWizard.step = 'checkout';
  renderAutosyncScreen();
}

function screenSkipProvider() {
  autosyncWizard.providerUid = null;
  autosyncWizard.providerName = null;
  autosyncWizard.step = 'checkout';
  renderAutosyncScreen();
}

async function screenCheckout() {
  const w = autosyncWizard;
  const btn = document.getElementById('screen-pay-btn');
  if (btn) btn.disabled = true;
  try { window.localStorage.setItem('estateflow-autosync-wizard', JSON.stringify({ key: w.key, providerUid: w.providerUid || null, meterIndex: w.meterIndex ?? null })); } catch {}
  try {
    const data = await tenantApi('/create-tenant-utility-subscription', {
      method: 'POST',
      body: JSON.stringify({ tenantId: tenantData.id, utilityKey: w.key }),
    });
    if (!data?.url) throw new Error('No checkout URL returned.');
    window.location.href = data.url;
  } catch (err) {
    showToast(err.message || 'Could not start checkout.', 'error');
    if (btn) btn.disabled = false;
  }
}

async function screenAuthorize() {
  const w = autosyncWizard;
  const errEl = document.getElementById('autosync-error');
  const btn = document.getElementById('screen-auth-btn');
  if (errEl) errEl.textContent = '';
  if (btn) btn.disabled = true;
  try {
    const data = await tenantApi('/tenant-utility-auth-form', {
      method: 'POST',
      body: JSON.stringify({ tenantId: tenantData.id, utilityKey: w.key, utilityUid: w.providerUid || '' }),
    });
    if (!data?.url) throw new Error('No provider page returned.');
    window.open(data.url, '_blank');
    if (errEl) errEl.textContent = 'Finish signing in with your provider, then wait — connecting happens automatically.';
    pollAuthForm(w.key, data.formUid, 0, w.meterIndex ?? null);
  } catch (err) {
    if (errEl) errEl.textContent = err.message || 'Could not open provider login.';
    if (btn) btn.disabled = false;
  }
}

async function pollAuthForm(key, formUid, tries, meterIndex) {
  const screenActive = document.getElementById('page-autosync').classList.contains('active');
  const modalActive = document.getElementById('autosync-modal').classList.contains('active');
  if (!screenActive && !modalActive) return;
  if (tries > 100) {
    const errEl = document.getElementById('autosync-error');
    if (errEl) errEl.textContent = 'Still waiting — keep the provider tab open, or close and try again.';
    return;
  }
  try {
    const s = await tenantApi(`/tenant-utility-auth-form-status?tenantId=${encodeURIComponent(tenantData.id)}&formUid=${encodeURIComponent(formUid)}`);
    if (s && s.completed) {
      const linked = await tenantApi('/tenant-utility-link', {
        method: 'POST',
        body: JSON.stringify({ tenantId: tenantData.id, formUid, utilityKey: key, ...(meterIndex === null || meterIndex === undefined ? {} : { meterIndex }) }),
      });
      // Use the link response directly so the list shows the new bill data
      // without waiting on another fetch round-trip.
      if (linked && linked.utilities) propertyUtilities = linked.utilities;
      else await fetchUtilities();
      try { await fetchTenantAuto(); } catch {}
      await loadAllUtilities();
      await loadUtilitiesPreview();
      showToast(`${key} connected — bills will sync automatically.`);
      try { window.localStorage.removeItem('estateflow-autosync-wizard'); } catch {}
      autosyncWizard = null;
      if (screenActive) {
        // Screen flow: back to the utility page with the fresh list.
        showPage('utilities');
      } else {
        openAutosyncModal(key);
      }
      return;
    }
  } catch (e) { console.warn('Auth-form poll:', e.message); }
  autosyncPollTimer = setTimeout(() => pollAuthForm(key, formUid, tries + 1, meterIndex), 3000);
}

async function refreshLinkedUtility(key, meterIndex) {
  const slot = slotsFor(key).find((s) => s.index === ((meterIndex === null || meterIndex === undefined) ? null : meterIndex));
  const u = slot ? slot.m : null;
  const name = slot && slot.m.label ? `${key} · ${slot.m.label}` : key;
  if (!u || !u.meterUid) { showToast('No linked meter for ' + name + '.', 'error'); return; }
  showToast('Refreshing ' + name + '…');
  try {
    const data = await tenantApi('/tenant-utility-refresh', {
      method: 'POST',
      body: JSON.stringify({ tenantId: tenantData.id, meterUid: u.meterUid }),
    });
    if (data && data.amount !== undefined) {
      const next = { ...propertyUtilities };
      const full = next[key] || {};
      if (slot.index === null) {
        next[key] = { ...full, amount: String(data.amount), provider: data.provider || full.provider };
      } else {
        const extras = Array.isArray(full.meters) ? [...full.meters] : [];
        extras[slot.index] = { ...(extras[slot.index] || {}), amount: String(data.amount), provider: data.provider || extras[slot.index]?.provider };
        next[key] = { ...full, meters: extras };
      }
      await persistUtilities(next, key, slot.index);
      await loadAllUtilities();
      await loadUtilitiesPreview();
      showToast(`${name} updated to $${Number(data.amount || 0).toLocaleString()}.`);
    }
  } catch (err) {
    showToast(err.message || 'Refresh failed.', 'error');
  }
}

async function cancelTenantSub(key, resume) {
  if (!resume && !confirm(`Cancel auto-sync for ${key}?\n\nYour bills stop syncing at the end of the paid period. Synced bill amounts already on the property stay.`)) return;
  try {
    await tenantApi('/tenant-utility-cancel', {
      method: 'POST',
      body: JSON.stringify({ tenantId: tenantData.id, utilityKey: key, ...(resume ? { resume: true } : {}) }),
    });
    showToast(resume ? 'Subscription resumed.' : 'Subscription canceled — runs to period end.');
    renderAutosyncBody(key).catch(() => {});
    loadAllUtilities();
    if (document.getElementById('page-billing').classList.contains('active')) loadBillingPage();
  } catch (err) {
    showToast(err.message || 'Could not update subscription.', 'error');
  }
}

// Stripe redirects back here after a tenant auto-sync checkout.
function readUtilityReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('utility');
  if (status !== 'subscribed' && status !== 'canceled') return null;
  const out = { status, sessionId: params.get('session_id'), key: params.get('key') };
  params.delete('utility');
  params.delete('session_id');
  params.delete('key');
  const qs = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${qs ? '?' + qs : ''}`);
  return out;
}
let utilityReturn = readUtilityReturn();
// Coming back from Stripe: hold the splash loader until auth restores so the
// login page never flashes in between.
if (utilityReturn || checkoutReturn) showLoading();

async function handleUtilityReturn() {
  if (!utilityReturn || !currentUser || !tenantData) return;
  const ret = utilityReturn;
  utilityReturn = null;
  if (ret.status === 'canceled') {
    showToast('Subscription canceled. Nothing was charged.', 'error');
    return;
  }
  showToast('Payment complete! Activating auto-sync…');
  try {
    const res = await fetch(`${API_BASE}/confirm-utility-subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await currentUser.getIdToken()}` },
      body: JSON.stringify({ ...(ret.sessionId ? { sessionId: ret.sessionId } : {}), ...(ret.key ? { utilityKey: ret.key } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.active) {
      showToast('Auto-sync subscribed — authorize your provider to finish.');
      let resumeKey = ret.key || null;
      let resumeMeter = null;
      if (!resumeKey) {
        try {
          const saved = JSON.parse(window.localStorage.getItem('estateflow-autosync-wizard') || 'null');
          resumeKey = saved && saved.key;
          resumeMeter = saved && saved.meterIndex !== undefined ? saved.meterIndex : null;
        } catch {}
      } else {
        try {
          const saved = JSON.parse(window.localStorage.getItem('estateflow-autosync-wizard') || 'null');
          if (saved && saved.key === resumeKey && saved.meterIndex !== undefined) resumeMeter = saved.meterIndex;
        } catch {}
      }
      try { window.localStorage.removeItem('estateflow-autosync-wizard'); } catch {}
      if (resumeKey) {
        try { await fetchUtilities(); } catch {}
        try { await fetchTenantAuto(); } catch {}
        let savedUid = null, savedName = null;
        try {
          savedUid = window.localStorage.getItem('estateflow-autosync-provider-' + resumeKey);
          savedName = window.localStorage.getItem('estateflow-autosync-provider-name-' + resumeKey);
        } catch {}
        autosyncWizard = { key: resumeKey, providerUid: savedUid, providerName: savedName, step: 'authorize', meterIndex: resumeMeter };
        showPage('autosync');
      }
      loadAllUtilities();
    } else {
      showToast('Payment received — subscription activates in a moment. Reopen Utilities shortly.', 'error');
    }
  } catch (e) {
    showToast('Payment received — subscription activates in a moment.', 'error');
  }
}

// ─── TENANT BILLING (own subscriptions only — never the landlord's) ─────────
// Every call below runs on the signed-in tenant's own Stripe customer and
// their own users/{uid}.utilityAuto record. The landlord's app reads only
// users/{landlordUid}, so the two sides can never see or touch each other's
// subscriptions, cards, or invoices.
async function loadBillingPage() {
  if (!currentUser || !tenantData) return;
  if ((await checkPortalAccess()) === false) {
    document.getElementById('billing-subs').innerHTML = `
      <div style="text-align:center;padding:40px;">
        <i class="fas fa-lock" style="font-size:40px;color:#334155;"></i>
        <p class="empty-text" style="margin-top:12px;">Portal not included</p>
        <p style="color:#475569;font-size:13px;">Ask your landlord or property manager to upgrade to the Professional plan.</p>
      </div>`;
    document.getElementById('billing-cards').innerHTML = '';
    document.getElementById('billing-invoices').innerHTML = '';
    return;
  }
  loadBillingSubs();
  loadAutopayCards();
  loadBillingCards();
  loadBillingInvoices();
  loadBillingProfile();
}

async function loadBillingSubs() {
  const container = document.getElementById('billing-subs');
  try {
    await fetchTenantAuto();
    const subs = tenantAuto.subscriptions || {};
    // Only utilities with a live subscription (active or running to period end).
    const keys = UTILITY_TYPES.filter((k) => subs[k] && subs[k].active);
    if (keys.length === 0) {
      container.innerHTML = '<p class="empty-text">No subscriptions yet — auto-sync a utility to start one.</p>';
      return;
    }
    container.innerHTML = keys.map((k) => {
      const s = subs[k] || {};
      const color = '#22C55E';
      const label = s.cancelAtPeriodEnd ? `Cancels ${s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : 'at period end'}` : 'Active · $20/mo';
      const action = s.cancelAtPeriodEnd
        ? `<button class="btn secondary" style="padding:10px;" onclick="cancelTenantSub('${k}', true)">Resume</button>`
        : `<button class="btn danger" style="padding:10px;" onclick="cancelTenantSub('${k}', false)">Cancel</button>`;
      return `<div class="card" style="margin-bottom:10px;">
        <div class="list-item" style="padding:0;border:none;">
          <div class="list-icon" style="background:${color}15;color:${color};"><i class="fas fa-bolt"></i></div>
          <div class="list-info"><div class="list-title">${k}</div><div class="list-sub">${label}</div></div>
        </div>
        <div style="margin-top:10px;">${action}</div>
      </div>`;
    }).join('') + (tenantAuto.portalUrl ? `<button class="btn secondary" onclick="window.open('${tenantAuto.portalUrl}', '_blank')">Open Stripe billing portal</button>` : '');
  } catch (e) {
    container.innerHTML = '<p class="empty-text">Subscriptions unavailable right now.</p>';
  }
}

// Card on the rent-autopay subscription (tenant's own card, own account).
async function loadAutopayCards() {
  const container = document.getElementById('billing-autopay-cards');
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/rent-payment-methods?tenantId=${encodeURIComponent(tenantData.id)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || '');
    const methods = data.methods || [];
    container.innerHTML = (methods.length === 0 ? '<p class="empty-text">No card on file.</p>' : methods.map((m) => `
      <div class="card" style="margin-bottom:10px;">
        <div class="list-item" style="padding:0;border:none;">
          <div class="list-icon" style="background:rgba(59,130,246,0.12);color:#60A5FA;"><i class="fas fa-credit-card"></i></div>
          <div class="list-info">
            <div class="list-title" style="text-transform:capitalize;">${m.brand} ···· ${m.last4}</div>
            <div class="list-sub">Expires ${m.expMonth || '--'}/${m.expYear || '--'}${m.isDefault ? ' · autopay card' : ''}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          ${m.isDefault ? '' : `<button class="btn secondary" style="padding:10px;" onclick="setDefaultAutopayCard('${m.id}')">Use for autopay</button>`}
          <button class="btn danger" style="padding:10px;" onclick="detachAutopayCard('${m.id}')">Remove</button>
        </div>
      </div>`).join('')) + `
      <button class="btn primary" style="margin-top:4px;" onclick="addAutopayCard()" id="add-autopay-card-btn">
        <i class="fas fa-plus"></i><span>${methods.length === 0 ? 'Add Card' : 'Add Another Card'}</span>
      </button>`;
  } catch (e) {
    container.innerHTML = '<p class="empty-text">No autopay card yet — set up autopay first.</p>';
  }
}

async function setDefaultAutopayCard(id) {
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/rent-payment-methods/default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ tenantId: tenantData.id, paymentMethodId: id }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Failed.');
    showToast('Autopay card updated.');
    loadAutopayCards();
  } catch (e) { showToast(e.message || 'Could not update card.', 'error'); }
}

async function detachAutopayCard(id) {
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/rent-payment-methods/detach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ tenantId: tenantData.id, paymentMethodId: id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Failed.');
    showToast('Card removed.');
    loadAutopayCards();
  } catch (e) { showToast(e.message || 'Could not remove card.', 'error'); }
}

async function addAutopayCard() {
  const btn = document.getElementById('add-autopay-card-btn');
  if (btn) btn.disabled = true;
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/rent-payment-methods/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ tenantId: tenantData.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Failed.');
    if (!data?.url) throw new Error('No checkout URL returned.');
    try { window.localStorage.setItem('estateflow-autopay-card-tenant', tenantData.id); } catch {}
    window.location.href = data.url;
  } catch (err) {
    showToast(err.message || 'Could not start card setup.', 'error');
    if (btn) btn.disabled = false;
  }
}

async function loadBillingCards() {
  const container = document.getElementById('billing-cards');
  try {
    const data = await tenantApi('/billing-payment-methods');
    const methods = data.methods || [];
    container.innerHTML = (methods.length === 0 ? '<p class="empty-text">No saved cards yet.</p>' : methods.map((m) => `
      <div class="card" style="margin-bottom:10px;">
        <div class="list-item" style="padding:0;border:none;">
          <div class="list-icon" style="background:rgba(59,130,246,0.12);color:#60A5FA;"><i class="fas fa-credit-card"></i></div>
          <div class="list-info">
            <div class="list-title" style="text-transform:capitalize;">${m.brand} ···· ${m.last4}</div>
            <div class="list-sub">Expires ${m.expMonth || '--'}/${m.expYear || '--'}${m.isDefault ? ' · default' : ''}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          ${m.isDefault ? '' : `<button class="btn secondary" style="padding:10px;" onclick="setDefaultCard('${m.id}')">Set default</button>`}
          <button class="btn danger" style="padding:10px;" onclick="detachCard('${m.id}')">Remove</button>
        </div>
      </div>`).join('')) + `
      <button class="btn primary" style="margin-top:4px;" onclick="addBillingCard()" id="add-card-btn">
        <i class="fas fa-plus"></i><span>Add Card</span>
      </button>`;
  } catch (e) {
    container.innerHTML = '<p class="empty-text">Cards unavailable until your first subscription.</p>';
  }
}

async function setDefaultCard(id) {
  try {
    await tenantApi('/billing-payment-methods/default', { method: 'POST', body: JSON.stringify({ paymentMethodId: id }) });
    showToast('Default card updated.');
    loadBillingCards();
  } catch (e) { showToast(e.message || 'Could not update card.', 'error'); }
}

async function detachCard(id) {
  try {
    await tenantApi('/billing-payment-methods/detach', { method: 'POST', body: JSON.stringify({ paymentMethodId: id }) });
    showToast('Card removed.');
    loadBillingCards();
  } catch (e) { showToast(e.message || 'Could not remove card.', 'error'); }
}

async function addBillingCard() {
  const btn = document.getElementById('add-card-btn');
  if (btn) btn.disabled = true;
  try {
    const data = await tenantApi('/tenant-billing-card-setup', {
      method: 'POST',
      body: JSON.stringify({ tenantId: tenantData.id }),
    });
    if (!data?.url) throw new Error('No checkout URL returned.');
    window.location.href = data.url;
  } catch (err) {
    showToast(err.message || 'Could not start card setup.', 'error');
    if (btn) btn.disabled = false;
  }
}

// Invoices: readable cards, 5 at a time + View all, searchable by text/date.
let billingInvoicesCache = [];
let billingInvoicesExpanded = false;
let billingInvoicesQuery = '';
let billingInvoiceSearchOpen = false;

function invoiceDateStr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function invoiceMatches(inv, q) {
  if (!q) return true;
  const d = inv.created ? new Date(inv.created) : null;
  const hay = [
    inv.description || '',
    inv.number || '',
    inv.status || '',
    invDateStr(inv.created),
    d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '',
    d && !isNaN(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : '',
    inv.amountPaid ? (inv.amountPaid / 100).toFixed(2) : '',
  ].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => w && hay.includes(w));
}

function toggleInvoiceSearch() {
  billingInvoiceSearchOpen = !billingInvoiceSearchOpen;
  renderBillingInvoices();
  const input = document.getElementById('invoice-search');
  if (input && billingInvoiceSearchOpen) input.focus();
}

function renderBillingInvoices() {
  const container = document.getElementById('billing-invoices');
  const list = billingInvoicesCache.filter((inv) => invoiceMatches(inv, billingInvoicesQuery));
  const shown = billingInvoicesExpanded ? list : list.slice(0, 5);
  const searchRow = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
      <button class="btn-icon" onclick="toggleInvoiceSearch()" title="Search invoices" style="flex-shrink:0;">
        <i class="fas fa-search"></i>
      </button>
      ${billingInvoiceSearchOpen ? `<div class="input-group" style="flex:1;margin-bottom:0;">
        <input type="text" id="invoice-search" placeholder="Search by date, amount, status…" value="${String(billingInvoicesQuery).replace(/"/g, '&quot;')}">
      </div>` : `<span style="color:#64748B;font-size:13px;">${billingInvoicesCache.length} invoice${billingInvoicesCache.length === 1 ? '' : 's'}</span>`}
    </div>`;
  if (list.length === 0) {
    container.innerHTML = searchRow + '<p class="empty-text">No invoices match your search.</p>';
  } else {
    container.innerHTML = searchRow + shown.map((inv) => {
      const amount = Number(((inv.amountPaid || inv.amountDue) || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const paid = inv.status === 'paid';
      const color = paid ? '#22C55E' : '#FBBF24';
      return `
      <div class="card" style="margin-bottom:10px;padding:14px 16px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <div class="list-icon" style="background:${color}15;color:${color};flex-shrink:0;"><i class="fas fa-receipt"></i></div>
          <div class="list-info">
            <div class="list-title">$${amount}</div>
            <div class="list-sub">${invoiceDateStr(inv.created)}${inv.description ? ` · ${inv.description}` : ''}</div>
          </div>
          <span class="list-badge" style="color:${color};background:${color}22;border-color:${color}44;flex-shrink:0;">${inv.status || ''}</span>
        </div>
        <button class="btn secondary" style="padding:10px;margin-top:10px;" onclick="openInvoice('${inv.id}')">View invoice</button>
      </div>`;
    }).join('') + (!billingInvoicesExpanded && list.length > 5
      ? `<button class="btn secondary" onclick="billingInvoicesExpanded=true;renderBillingInvoices();">View all (${list.length})</button>`
      : billingInvoicesExpanded && billingInvoicesCache.length > 5
        ? `<button class="btn secondary" onclick="billingInvoicesExpanded=false;renderBillingInvoices();">Show less</button>`
        : '');
  }
  const input = document.getElementById('invoice-search');
  if (input) input.addEventListener('input', () => { billingInvoicesQuery = input.value; renderBillingInvoices(); const el = document.getElementById('invoice-search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
}

async function loadBillingInvoices() {
  const container = document.getElementById('billing-invoices');
  try {
    const data = await tenantApi('/billing-invoices?limit=25');
    billingInvoicesCache = data.invoices || [];
    billingInvoicesExpanded = false;
    renderBillingInvoices();
  } catch (e) {
    container.innerHTML = '<p class="empty-text">Invoices unavailable right now.</p>';
  }
}

async function loadBillingProfile() {
  try {
    const p = await tenantApi('/billing-profile');
    document.getElementById('bill-name').value = p.name || '';
    document.getElementById('bill-email').value = p.email || '';
    document.getElementById('bill-phone').value = p.phone || '';
  } catch (e) { console.warn('Billing profile unavailable:', e.message); }
}

async function saveBillingProfile() {
  const errEl = document.getElementById('bill-profile-error');
  const btn = document.getElementById('bill-profile-btn');
  errEl.textContent = '';
  btn.disabled = true;
  try {
    await tenantApi('/billing-profile', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('bill-name').value.trim(),
        email: document.getElementById('bill-email').value.trim(),
        phone: document.getElementById('bill-phone').value.trim(),
      }),
    });
    showToast('Billing profile saved.');
  } catch (e) {
    errEl.textContent = e.message || 'Could not save profile.';
  } finally {
    btn.disabled = false;
  }
}

function money2(cents) {
  return `$${Number((cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function openInvoice(id) {
  const inv = (billingInvoicesCache || []).find((i) => i.id === id);
  if (!inv) return;
  const paid = inv.status === 'paid';
  const color = paid ? '#22C55E' : '#FBBF24';
  const balance = Math.max(0, (inv.amountDue || 0) - (inv.amountPaid || 0));
  const billedTo = [currentUser && currentUser.displayName, currentUser && currentUser.email].filter(Boolean).join(' · ');
  const row = (label, value) => `
    <div class="summary-row"><span>${label}</span><span style="text-align:right;max-width:60%;">${value || '—'}</span></div>
    <div class="summary-divider"></div>`;
  document.getElementById('invoice-body').innerHTML = `
    <div style="text-align:center;margin-bottom:12px;">
      <div style="font-size:26px;font-weight:900;">${money2(inv.amountPaid || inv.amountDue)}</div>
      <span class="list-badge" style="color:${color};background:${color}22;border-color:${color}44;">${paid ? 'PAID' : (inv.status || '').toUpperCase()}</span>
    </div>
    <div class="pay-summary">
      ${row('Invoice', inv.number || inv.description || '—')}
      ${row('Date', invoiceDateStr(inv.created) || '—')}
      ${inv.description ? row('Description', inv.description) : ''}
      ${row('Amount due', money2(inv.amountDue))}
      ${row('Amount paid', money2(inv.amountPaid))}
      ${balance > 0 ? row('Balance', money2(balance)) : ''}
      ${billedTo ? row('Billed to', billedTo) : ''}
    </div>
    ${inv.hostedUrl ? `<button class="btn secondary" style="margin-top:4px;" onclick="window.open('${inv.hostedUrl}', '_blank')">View in Stripe</button>` : ''}`;
  document.getElementById('invoice-modal').classList.add('active');
}

function closeInvoiceModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('invoice-modal').classList.remove('active');
}

// Card-setup checkout redirects back here.
function readBillingReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('billing');
  if (status !== 'setup' && status !== 'canceled') return null;
  const out = { status, autopayCard: params.get('autopay_card') === '1', sessionId: params.get('session_id') };
  params.delete('billing');
  params.delete('autopay_card');
  params.delete('session_id');
  const qs = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${qs ? '?' + qs : ''}`);
  return out;
}
let billingReturn = readBillingReturn();

async function handleBillingReturn() {
  if (!billingReturn) return;
  const ret = billingReturn;
  billingReturn = null;
  if (ret.status === 'canceled') {
    showToast('Card setup canceled.', 'error');
    return;
  }
  // Autopay card setup: make the new card the autopay default.
  if (ret.autopayCard && ret.sessionId && currentUser && tenantData) {
    showToast('Saving your new card…');
    try {
      const savedTenant = (() => { try { return window.localStorage.getItem('estateflow-autopay-card-tenant'); } catch { return null; } })();
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_BASE}/rent-payment-methods/finish-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ tenantId: savedTenant || tenantData.id, sessionId: ret.sessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'Failed.');
      try { window.localStorage.removeItem('estateflow-autopay-card-tenant'); } catch {}
      showToast('Card saved — autopay will use it.');
    } catch (e) {
      showToast('Card added — open Billing to make it the autopay card.', 'error');
    }
  } else {
    showToast('Card saved — ready to use.');
  }
  if (document.getElementById('page-billing').classList.contains('active')) loadBillingPage();
}

// ─── RENT AUTOPAY (one subscription, charged monthly automatically) ─────────
let autopayStatus = null;

async function fetchAutopay() {
  if (!tenantData || !currentUser) return null;
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}/rent-autopay-status?tenantId=${encodeURIComponent(tenantData.id)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  autopayStatus = data;
  return data;
}

async function renderAutopay() {
  const dot = document.getElementById('autopay-dot');
  const text = document.getElementById('autopay-text');
  const sub = document.getElementById('autopay-sub');
  const btn = document.getElementById('autopay-btn');
  const cancelBtn = document.getElementById('autopay-cancel-btn');
  const cardsBtn = document.getElementById('autopay-cards-btn');
  document.getElementById('autopay-card').style.display = 'block';
  if (!autopayStatus) {
    dot.style.background = '#64748B'; text.style.color = '#64748B';
    text.textContent = 'Autopay unavailable';
    sub.textContent = 'Could not check autopay status.';
    btn.style.display = 'none'; cancelBtn.style.display = 'none'; cardsBtn.style.display = 'none';
    return;
  }
  if (autopayStatus.active) {
    const canceling = !!autopayStatus.cancelAtPeriodEnd;
    dot.style.background = canceling ? '#FBBF24' : '#22C55E';
    text.style.color = canceling ? '#FBBF24' : '#22C55E';
    text.textContent = canceling ? 'Autopay ending' : 'Autopay on';
    let cardNote = '';
    try {
      const token = await currentUser.getIdToken();
      const res = await fetch(`${API_BASE}/rent-payment-methods?tenantId=${encodeURIComponent(tenantData.id)}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      const def = res.ok && data.methods ? data.methods.find((m) => m.isDefault) : null;
      if (def) cardNote = ` Card •••• ${def.last4}.`;
    } catch {}
    sub.textContent = (canceling
      ? 'Runs to the paid-through date, then stops.'
      : 'Your card is charged automatically every month.') + cardNote + ' Manage in Billing.';
    btn.style.display = 'none';
    cancelBtn.style.display = 'flex';
    cardsBtn.style.display = 'flex';
    cancelBtn.querySelector('span').textContent = canceling ? 'Resume autopay' : 'Cancel autopay';
    cancelBtn.onclick = () => cancelAutopay(canceling);
  } else {
    dot.style.background = '#64748B'; text.style.color = '#64748B';
    text.textContent = 'Autopay off';
    sub.textContent = 'Pay rent automatically every month. Cancel anytime.';
    btn.style.display = 'flex'; cancelBtn.style.display = 'none'; cardsBtn.style.display = 'none';
  }
}

async function loadAutopay() {
  try {
    await fetchAutopay();
  } catch (e) {
    console.warn('Autopay status failed:', e.message);
    autopayStatus = null;
  }
  await renderAutopay();
}

async function setupAutopay() {
  if (!tenantData || !currentUser) return;
  const btn = document.getElementById('autopay-btn');
  btn.disabled = true;
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/create-rent-autopay-checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ tenantId: tenantData.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
    if (data.alreadyActive) {
      showToast('Autopay is already on for this rental.');
      await loadAutopay();
      return;
    }
    if (!data?.url) throw new Error('No checkout URL returned.');
    window.location.href = data.url;
  } catch (err) {
    showToast(err.message || 'Could not start autopay signup.', 'error');
    btn.disabled = false;
  }
}

async function cancelAutopay(resume) {
  if (!resume && !confirm('Cancel autopay?\n\nYour card stops being charged at the end of the paid period. Already-synced months stay recorded.')) return;
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/cancel-rent-autopay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ tenantId: tenantData.id, ...(resume ? { resume: true } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
    showToast(resume ? 'Autopay resumed.' : 'Autopay canceled — runs to period end.');
    await loadAutopay();
  } catch (err) {
    showToast(err.message || 'Could not update autopay.', 'error');
  }
}

// Stripe redirects back here after autopay checkout.
function readAutopayReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('autopay');
  if (status !== '1' && status !== 'canceled') return null;
  const out = { status, sessionId: params.get('session_id') };
  params.delete('autopay');
  params.delete('session_id');
  const qs = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${qs ? '?' + qs : ''}`);
  return out;
}
let autopayReturn = readAutopayReturn();

async function handleAutopayReturn() {
  if (!autopayReturn || !currentUser || !tenantData) return;
  const ret = autopayReturn;
  autopayReturn = null;
  if (ret.status === 'canceled') {
    showToast('Autopay signup canceled.', 'error');
    return;
  }
  showToast('Activating autopay…');
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/confirm-rent-autopay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ ...(ret.sessionId ? { sessionId: ret.sessionId } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.active) showToast('Autopay is on — rent is automatic now.');
    else showToast('Autopay activates in a moment — check back shortly.', 'error');
  } catch (e) {
    showToast('Autopay activates in a moment — check back shortly.', 'error');
  }
  await loadDashboard();
}

// ─── AUTH STATE LISTENER ──────────────────────────────────────────────────────
auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    await findTenantRecord(user.uid);
    // findTenantRecord signs out when there is no invite — stop here
    if (!auth.currentUser) return;
    showPage('dashboard');
    handleCheckoutReturn();
    handleUtilityReturn();
    handleBillingReturn();
    handleAutopayReturn();
  } else {
    showPage('login');
  }
  hideLoading();
});

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (document.getElementById('auth-login').classList.contains('active')) {
      handleLogin();
    } else if (document.getElementById('auth-signup').classList.contains('active')) {
      handleSignup();
    }
  }
});
