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

// Base URL of the EstateFlow API (moved to Vercel — see /api/index.js).
// Replace with your Vercel URL after the first deploy.
const API_BASE = 'https://estateflow-api.vercel.app/api';

// State
let currentUser = null;
let tenantData = null;
let allPayments = [];
let allRequests = [];
let portalAccess = null; // null = unknown, true/false (Professional-plan gate)

// ─── HELPERS ────────────────────────────────────────────────────────────────────
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');

  if (page === 'dashboard') loadDashboard();
  if (page === 'maintenance') loadAllRequests();
  if (page === 'payments') loadAllPayments();
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
  if (msg.includes('user-not-found')) return 'No account found with this email.';
  if (msg.includes('wrong-password') || msg.includes('invalid-credential')) return 'Invalid email or password.';
  if (msg.includes('email-already-in-use')) return 'An account with this email already exists.';
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
      await db.collection('users').doc(cred.user.uid).set({
        role: 'tenant',
        email: cred.user.email,
        displayName: cred.user.displayName,
        createdAt: new Date().toISOString(),
      });
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
  showPage('login');
}

// ─── TENANT DATA ──────────────────────────────────────────────────────────────
async function findTenantRecord(uid) {
  currentUser = auth.currentUser;
  if (!currentUser) return;

  // 1. Try matching by stored tenantEmail (most reliable)
  const emailSnap = await db.collection('tenants')
    .where('tenantEmail', '==', currentUser.email).get();
  if (!emailSnap.empty) {
    tenantData = { id: emailSnap.docs[0].id, ...emailSnap.docs[0].data() };
    return;
  }

  // 2. Try matching by tenantName == displayName or email prefix
  const name = (currentUser.displayName || currentUser.email?.split('@')[0] || '').trim();
  if (name) {
    const nameSnap = await db.collection('tenants')
      .where('tenantName', '==', name).get();
    if (!nameSnap.empty) {
      // If multiple matches, pick the first; user can re-link if wrong
      tenantData = { id: nameSnap.docs[0].id, ...nameSnap.docs[0].data() };
      return;
    }
  }

  // 3. No auto-match — show linking UI
  showLinkingUI();
}

function showLinkingUI() {
  document.getElementById('rent-card').style.display = 'none';
  document.getElementById('no-tenant-card').style.display = 'none';
  document.getElementById('link-card').style.display = 'block';
  document.getElementById('link-error').textContent = '';
}

async function linkTenantAccount() {
  const nameInput = document.getElementById('link-name').value.trim();
  const errorEl = document.getElementById('link-error');
  const btn = document.getElementById('link-btn');

  errorEl.textContent = '';
  if (!nameInput) { errorEl.textContent = 'Please enter your name as your landlord entered it.'; return; }

  btn.disabled = true;
  btn.querySelector('span').textContent = 'Searching...';

  try {
    const snap = await db.collection('tenants')
      .where('tenantName', '==', nameInput).get();

    if (snap.empty) {
      errorEl.textContent = 'No tenant found with that name. Check spelling or contact your landlord.';
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Link Account';
      return;
    }

    // Link: save email to the tenant record and update local state
    const doc = snap.docs[0];
    tenantData = { id: doc.id, ...doc.data() };

    // Save email for future auto-matching
    await db.collection('tenants').doc(doc.id).update({
      tenantEmail: currentUser.email,
    });

    document.getElementById('link-card').style.display = 'none';
    loadDashboard();
    showToast('Account linked successfully!');
  } catch (err) {
    errorEl.textContent = err.message || 'Failed to find tenant.';
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Link Account';
  }
}

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
  document.getElementById('locked-card').style.display = 'block';
  document.getElementById('quick-actions').style.display = 'none';
  document.getElementById('payments-header').style.display = 'none';
  document.getElementById('requests-header').style.display = 'none';
  document.getElementById('payments-list').innerHTML = '';
  document.getElementById('requests-list').innerHTML = '';
  document.getElementById('maintenance-badge').style.display = 'none';
}

function renderPortalUnlocked() {
  document.getElementById('locked-card').style.display = 'none';
  document.getElementById('quick-actions').style.display = '';
  document.getElementById('payments-header').style.display = '';
  document.getElementById('requests-header').style.display = '';
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
    document.getElementById('rent-card').style.display = 'none';
    document.getElementById('no-tenant-card').style.display = 'none';
    // Only show linking UI if not already showing it
    if (document.getElementById('link-card').style.display !== 'block') {
      showLinkingUI();
    }
    return;
  }

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

  params.delete('paid');
  params.delete('canceled');
  params.delete('session_id');
  const qs = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${qs ? '?' + qs : ''}`);
  return paid ? 'paid' : 'canceled';
}
let checkoutReturn = readCheckoutReturn();

function handleCheckoutReturn() {
  if (!checkoutReturn) return;
  const result = checkoutReturn;
  checkoutReturn = null;

  if (result === 'paid') {
    // The webhook records the payment a second or two later — refresh twice.
    showToast('Payment complete! Updating your receipt…');
    setTimeout(() => loadDashboard(), 1500);
    setTimeout(() => { loadDashboard(); showToast('Rent recorded — thank you!'); }, 3500);
  } else if (result === 'canceled') {
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

// ─── AUTH STATE LISTENER ──────────────────────────────────────────────────────
auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    await findTenantRecord(user.uid);
    showPage('dashboard');
    handleCheckoutReturn();
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
