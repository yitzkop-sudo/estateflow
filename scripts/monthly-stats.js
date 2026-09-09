// Adds a monthly stats document into Firestore.
// Usage:
//   node scripts/monthly-stats.js
// Requires:
//   - FIREBASE_* environment variables already present in your Expo build
//   - firebase-admin installed
//   - service account credentials via GOOGLE_APPLICATION_CREDENTIALS
//
// This script is a starting point only. You MUST adapt the collection/doc path
// to match how you want to store month history.

const admin = require('firebase-admin');

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function prevMonthKey(d = new Date()) {
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return monthKey(p);
}

async function main() {
  // init
  if (!admin.apps.length) {
    admin.initializeApp();
  }

  const db = admin.firestore();

  // TODO: determine how to compute monthly totals.
  // For now we only compute from properties.utilities similar to dashboard.
  const allUsersSnap = await db.collection('users').get().catch(() => null);

  // Fallback: if you don't have a 'users' collection, you'll need to specify a uid.
  const uids = [];
  if (allUsersSnap) {
    allUsersSnap.forEach(doc => uids.push(doc.id));
  } else {
    console.error('No users collection found. Edit script to provide a uid.');
    process.exit(1);
  }

  const mk = monthKey();
  const pmk = prevMonthKey();

  for (const uid of uids) {
    const propertiesSnap = await db.collection('properties').where('ownerId', '==', uid).get();

    let currentExpense = 0;
    propertiesSnap.forEach(doc => {
      const data = doc.data() || {};
      const utilities = data.utilities || {};
      for (const u of Object.values(utilities)) {
        const raw = (u && u.amount) != null ? String(u.amount) : '0';
        const cleaned = raw.trim().replace(/[^0-9.,-]/g, '').replace(/,/g, '');
        const n = Number(cleaned);
        if (Number.isFinite(n)) currentExpense += n;
      }
    });

    // portfolioValue/expense for previous month: try to read from monthlyStats
    // TODO: ensure you store these docs under the path below.
    const prevDocRef = db.doc(`users/${uid}/monthlyStats/${pmk}`);
    const prevSnap = await prevDocRef.get();
    const prevExpense = prevSnap.exists ? (prevSnap.data().expense || 0) : 0;

    const docRef = db.doc(`users/${uid}/monthlyStats/${mk}`);
    const update = {
      expense: currentExpense,
      portfolioValue: currentExpense, // replace with real portfolio value if you have it
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await docRef.set(update, { merge: true });

    console.log(`Updated ${uid} for ${mk}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

