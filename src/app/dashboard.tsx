import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged, signOut } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Dimensions,
  Image,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { computeNextDueDate } from "../lib/date";
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { auth, db } from "../lib/firebase";
import { scheduleRentReminders, scheduleUtilityReminders } from "../lib/notifications";
import { exportFullReport } from "../lib/export";

const { width: SW, height: SH } = Dimensions.get("window");
const DRAWER_WIDTH = Math.min(280, Math.round(SW * 0.8));

// ─── types ────────────────────────────────────────────────────────────────────
type UtilityItem = { amount: string; provider: string; dueDay: number | "last"; notify?: boolean };
type Property = {
  id: string;
  propertyName: string;
  address: string;
  street: string; city: string; state: string; zip: string;
  propertyType: string;
  numUnits: number;
  ownerName: string;
  tenantName: string | null;
  utilities: Record<string, UtilityItem>;
  photoUrl?: string | null;
  notes: string | null;
  createdAt: any;
  value?: number;         // market value — set in add-property form
  monthlyIncome?: number; // monthly rent — set in add-property form
};

type Tenant = {
  id: string;
  tenantName: string;
  propertyName: string;
  rentAmount: number;
  dueDay: number | "last";
  notes: string;
  lastPaidAt?: any;
  createdAt: any;
};

// Monthly snapshot stored in Firestore: snapshots/{uid}/months/{YYYY-MM}
type MonthSnap = {
  totalCost: number;      // sum of all utility amounts that month
  monthlyIncome: number;  // sum of monthlyIncome across properties
  portfolioValue: number; // sum of value across properties
  recordedAt: string;     // ISO date string
};

// Unified item shown in the notification bell/dropdown
type DueItem = {
  kind: "utility" | "rent";
  propertyName: string;
  subName: string; // tenant name (rent) or utility name (utility)
  amount: number;
  dueDate: Date;
  overdue: boolean;
};

// Unified item shown in "Recent Activity"
type ActivityItem = {
  id: string;
  label: string;
  sub: string;
  amount: string;
  amountColor: string;
  icon: keyof typeof Feather.glyphMap;
  iconBg: string;
  iconColor: string;
  date: string;
  ts: number;
};

// Notification from tenant web portal (payments, maintenance requests)
type TenantNotification = {
  id: string;
  type: string;
  message: string;
  tenantName: string;
  propertyName: string;
  amount?: number;
  title?: string;
  read: boolean;
  createdAt: any;
};

// ─── helpers ─────────────────────────────────────────────────────────────────
const monthKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const prevMonthKey = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return monthKey(d);
};

const fmtShortDate = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

const pctChange = (current: number, previous: number) => {
  if (!previous || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
};

const fmtPct = (n: number | null) =>
  n === null ? null : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

// ─── rent status helpers (mirror of the Tenant Assignment screen) ─────────────
type RentStatus = {
  label: string;
  color: string;
  icon: keyof typeof Feather.glyphMap;
};

function getRentStatus(dueDay: number | "last", lastPaidAt?: any): RentStatus {
  const now = new Date();

  if (lastPaidAt) {
    const paidOn = lastPaidAt.toDate ? lastPaidAt.toDate() : new Date(lastPaidAt);
    if (!isNaN(paidOn.getTime()) && computeNextDueDate(dueDay, paidOn) > now) {
      return { label: "Paid", color: "#22C55E", icon: "check-circle" };
    }
  }

  const currentDay = now.getDate();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dueDayNum = dueDay === "last" ? lastDay : dueDay;
  const daysUntilDue = dueDayNum - currentDay;

  if (daysUntilDue < 0) {
    return { label: "Overdue", color: "#EF4444", icon: "alert-triangle" };
  } else if (daysUntilDue <= 3) {
    return { label: "Due Soon", color: "#FACC15", icon: "clock" };
  } else if (daysUntilDue <= 7) {
    return { label: "Upcoming", color: "#60A5FA", icon: "calendar" };
  } else {
    return { label: "On Track", color: "#22C55E", icon: "check-circle" };
  }
}

const isTenantPaid = (t: Tenant) =>
  !!t.lastPaidAt && getRentStatus(t.dueDay, t.lastPaidAt).label === "Paid";

// ─── Smooth glowing sparkline ─────────────────────────────────────────────────
function GlowSparkline({
  width,
  height,
  dataPoints,
}: {
  width: number;
  height: number;
  dataPoints: number[]; // normalised 0-1 values, left→right
}) {
  // Need at least 2 points to draw anything
  if (dataPoints.length < 2) {
    return (
      <Svg width={width} height={height}>
        {/* Empty — first month, no history yet */}
      </Svg>
    );
  }

  const pad = { l: 8, r: 16, t: 14, b: 14 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;

  const min = Math.min(...dataPoints);
  const max = Math.max(...dataPoints);
  const range = max - min || 1;

  const pts = dataPoints.map((v, i) => ({
    x: pad.l + (i / (dataPoints.length - 1)) * W,
    y: pad.t + (1 - (v - min) / range) * H,
  }));

  const buildPath = (pts: { x: number; y: number }[]) => {
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const cpx = (prev.x + curr.x) / 2;
      d += ` C ${cpx} ${prev.y} ${cpx} ${curr.y} ${curr.x} ${curr.y}`;
    }
    return d;
  };

  const linePath = buildPath(pts);
  const endPt = pts[pts.length - 1];
  const fillPath =
    linePath + ` L ${endPt.x} ${height} L ${pad.l} ${height} Z`;

  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#3B82F6" stopOpacity="0.28" />
          <Stop offset="1" stopColor="#3B82F6" stopOpacity="0" />
        </LinearGradient>
        <LinearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#1D4ED8" stopOpacity="0.7" />
          <Stop offset="1" stopColor="#60A5FA" stopOpacity="1" />
        </LinearGradient>
      </Defs>
      <Path d={fillPath} fill="url(#fillGrad)" />
      <Path d={linePath} fill="none" stroke="#3B82F6" strokeWidth={8} strokeOpacity={0.18} strokeLinecap="round" strokeLinejoin="round" />
      <Path d={linePath} fill="none" stroke="#60A5FA" strokeWidth={4} strokeOpacity={0.35} strokeLinecap="round" strokeLinejoin="round" />
      <Path d={linePath} fill="none" stroke="url(#lineGrad)" strokeWidth={2.5} strokeOpacity={1} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={endPt.x} cy={endPt.y} r={10} fill="#3B82F6" fillOpacity={0.22} />
      <Circle cx={endPt.x} cy={endPt.y} r={6}  fill="#3B82F6" fillOpacity={0.45} />
      <Circle cx={endPt.x} cy={endPt.y} r={4}  fill="#FFFFFF" />
      <Circle cx={endPt.x} cy={endPt.y} r={3}  fill="#93C5FD" />
    </Svg>
  );
}

// ─── Change badge (shown only when previous month data exists) ────────────────
function ChangeBadge({
  current,
  previous,
  positiveIsGood = true,
}: {
  current: number;
  previous: number | null;
  positiveIsGood?: boolean;
}) {
  if (previous === null) return null;
  const pct = pctChange(current, previous);
  if (pct === null) return null;
  const up = pct >= 0;
  const good = positiveIsGood ? up : !up;
  const color = good ? "#22C55E" : "#EF4444";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      <Feather name={up ? "trending-up" : "trending-down"} size={13} color={color} />
      <Text style={{ color, fontWeight: "700", fontSize: 13 }}>
        {Math.abs(pct).toFixed(1)}%
      </Text>
    </View>
  );
}

// ─── main component ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("");
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [imageToShow, setImageToShow] = useState<string | null>(null);
  const [notifCount, setNotifCount] = useState(0);
  const [notifRead, setNotifRead] = useState(false);
  const lastReadCount = useRef(0);
  const [clearedNotifIds, setClearedNotifIds] = useState<Set<string>>(new Set());
  const [upcomingDues, setUpcomingDues] = useState<DueItem[]>([]);
  const [duesModalOpen, setDuesModalOpen] = useState(false);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [tenantNotifs, setTenantNotifs] = useState<TenantNotification[]>([]);

  // Historical monthly snapshots keyed by "YYYY-MM"
  const [monthSnaps, setMonthSnaps] = useState<Record<string, MonthSnap>>({});
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [rawPayments, setRawPayments] = useState<{ tenantName: string; propertyName: string; rentAmount: number; paidAt: any }[]>([]);
  const [rawMaintenance, setRawMaintenance] = useState<{ title: string; propertyName: string; cost: number; date: any; notes?: string }[]>([]);

  const anim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;

  useEffect(() => {
    Animated.timing(anim, { toValue: menuOpen ? 0 : -DRAWER_WIDTH, duration: 220, useNativeDriver: true }).start();
  }, [menuOpen]);

  useEffect(() => {
    let unsubSnapshot: (() => void) | null = null;
    let unsubNotifs: (() => void) | null = null;
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (!user) { setProperties([]); setUserName(""); setLoading(false); return; }
      setUserName(user.displayName || user.email?.split("@")[0] || "");
      loadAll(user);

      // Real-time listener for tenant web portal notifications
      unsubNotifs?.();
      const nq = query(
        collection(db, "notifications", user.uid, "items"),
        orderBy("createdAt", "desc")
      );
      unsubNotifs = onSnapshot(nq, (snap) => {
        const list: TenantNotification[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<TenantNotification, "id">),
        }));
        setTenantNotifs(list);
      }, () => {});
    });
    return () => { unsubAuth(); unsubNotifs?.(); };
  }, []);

  const loadAll = async (user = auth.currentUser) => {
    if (!user) return;
    setLoading(true);
    try {
      // 0. Restore the persisted "last read" notification count so the red dot
      //    stays cleared across sign-out / sign-in.
      try {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        const stored = userDoc.exists()
          ? (userDoc.data().lastNotifReadCount as number) ?? 0
          : 0;
        lastReadCount.current = stored;
      } catch {}

      // 1. Load properties
      const snap = await getDocs(
        query(collection(db, "properties"), where("ownerId", "==", user.uid))
      );
      const props: Property[] = snap.docs.map(d => ({
        id: d.id,
        ...(d.data() as Omit<Property, "id">),
      }));
      setProperties(props);

      // 2. Load up to 6 months of snapshots for the sparkline
      const keys = Array.from({ length: 6 }, (_, i) => {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        return monthKey(d);
      });
      const snaps: Record<string, MonthSnap> = {};
      await Promise.all(
        keys.map(async (k) => {
          const ref = doc(db, "snapshots", user.uid, "months", k);
          const s = await getDoc(ref);
          if (s.exists()) snaps[k] = s.data() as MonthSnap;
        })
      );
      setMonthSnaps(snaps);

      // 3. Load tenants — rent amounts drive monthly income
      const tenantSnap = await getDocs(
        query(collection(db, "tenants"), where("ownerId", "==", user.uid))
      );
      const tenantList: Tenant[] = tenantSnap.docs.map(d => ({
        id: d.id,
        ...(d.data() as Omit<Tenant, "id">),
      }));
      setTenants(tenantList);

      // 3b. Build "Recent Activity" from real records (payments, maintenance, properties)
      const activityItems: ActivityItem[] = [];
      const allPayments: { tenantName: string; propertyName: string; rentAmount: number; paidAt: any }[] = [];

      // Rent received — current + previous month
      for (const mk of [monthKey(), prevMonthKey()]) {
        const pSnap = await getDocs(collection(db, "payments", user.uid, "months", mk, "payments"));
        pSnap.forEach((d) => {
          const p = d.data();
          const paidAt = p.paidAt?.toDate ? p.paidAt.toDate() : new Date(p.paidAt);
          if (isNaN(paidAt.getTime())) return;
          allPayments.push({ tenantName: p.tenantName, propertyName: p.propertyName, rentAmount: p.rentAmount, paidAt: p.paidAt });
          activityItems.push({
            id: `rent-${mk}-${d.id}`,
            label: "Rent Received",
            sub: `${p.tenantName || "Tenant"} · ${p.propertyName || ""}`,
            amount: `+$${(p.rentAmount || 0).toLocaleString()}`,
            amountColor: "#22C55E",
            icon: "arrow-down",
            iconBg: "#16321E",
            iconColor: "#22C55E",
            date: fmtShortDate(paidAt),
            ts: paidAt.getTime(),
          });
        });
      }

      // Maintenance records
      const mSnap = await getDocs(query(collection(db, "maintenance"), where("ownerId", "==", user.uid)));
      const allMaint: { title: string; propertyName: string; cost: number; date: any; notes?: string }[] = [];
      mSnap.docs.forEach((d) => {
        const m = d.data();
        const ts = m.date?.toDate
          ? m.date.toDate()
          : m.date
            ? new Date(m.date)
            : m.createdAt?.toDate
              ? m.createdAt.toDate()
              : new Date();
        allMaint.push({ title: m.title || "", propertyName: m.propertyName || "", cost: m.cost || 0, date: m.date, notes: m.notes });
        activityItems.push({
          id: `maint-${d.id}`,
          label: "Maintenance",
          sub: `${m.title || "Task"} · ${m.propertyName || ""}`,
          amount: `-$${(m.cost || 0).toLocaleString()}`,
          amountColor: "#EF4444",
          icon: "tool",
          iconBg: "#321616",
          iconColor: "#EF4444",
          date: fmtShortDate(ts),
          ts: ts.getTime(),
        });
      });

      // Properties added
      props.forEach((p) => {
        const ts = p.createdAt?.toDate ? p.createdAt.toDate() : p.createdAt ? new Date(p.createdAt) : null;
        if (!ts || isNaN(ts.getTime())) return;
        activityItems.push({
          id: `prop-${p.id}`,
          label: "Property Added",
          sub: p.propertyName,
          amount: "",
          amountColor: "#94A3B8",
          icon: "home",
          iconBg: "rgba(59,130,246,0.15)",
          iconColor: "#3B82F6",
          date: fmtShortDate(ts),
          ts: ts.getTime(),
        });
      });

      activityItems.sort((a, b) => b.ts - a.ts);
      setActivities(activityItems.slice(0, 6));
      setRawPayments(allPayments);
      setRawMaintenance(allMaint);

      // 4. Save today's snapshot (overwrites same month — idempotent)
      const totalCost = props.reduce((t, p) => {
        if (!p.utilities) return t;
        return t + Object.values(p.utilities).reduce((s, u) => s + (parseFloat(u.amount) || 0), 0);
      }, 0);
      const monthlyIncome =
        tenantList.reduce((t, tn) => t + (tn.rentAmount || 0), 0) ||
        props.reduce((t, p) => t + (p.monthlyIncome || 0), 0);
      const portfolioValue = props.reduce((t, p) => t + (p.value || 0), 0);

      await setDoc(
        doc(db, "snapshots", user.uid, "months", monthKey()),
        {
          totalCost,
          monthlyIncome,
          portfolioValue,
          recordedAt: new Date().toISOString(),
        } satisfies MonthSnap
      );
      // Refresh snaps with just-written value
      snaps[monthKey()] = { totalCost, monthlyIncome, portfolioValue, recordedAt: new Date().toISOString() };
      setMonthSnaps({ ...snaps });

      // 5. Schedule utility due reminders
      const util = await scheduleUtilityReminders(props);

      // 6. Schedule rent due reminders (incl. overdue rent) from tenant records
      const rent = await scheduleRentReminders(tenantList);

      const dues: DueItem[] = [
        ...rent.upcoming.map((r) => ({
          kind: "rent" as const,
          propertyName: r.propertyName,
          subName: r.tenantName,
          amount: r.amount,
          dueDate: r.dueDate,
          overdue: r.overdue,
        })),
        ...util.upcoming.map((u) => ({
          kind: "utility" as const,
          propertyName: u.propertyName,
          subName: u.utilityName,
          amount: Number(u.amount) || 0,
          dueDate: u.dueDate,
          overdue: false,
        })),
      ];
      setUpcomingDues(dues);
      const dueCount = rent.count + util.count;
      setNotifCount(dueCount);
      setNotifRead(dueCount <= lastReadCount.current);

    } catch (e) {
      console.error(e);
      setProperties([]);
    } finally {
      setLoading(false);
    }
  };

  const getGreeting = () => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning," : h < 18 ? "Good afternoon," : "Good evening,";
  };
  const firstName = userName?.split(" ")[0] || auth.currentUser?.email?.split("@")[0] || "Owner";

  // ── Current-month real numbers ──────────────────────────────────────────────
  const totalMonthlyCost = () => {
    let t = 0;
    properties.forEach(p => p.utilities && Object.values(p.utilities).forEach(u => { t += parseFloat(u.amount) || 0; }));
    return t;
  };
  const totalUtilityCount = () => {
    let c = 0;
    properties.forEach(p => p.utilities && (c += Object.keys(p.utilities).length));
    return c;
  };
  const propMonthlyCost = (p: Property) => {
    let t = 0;
    if (p.utilities) Object.values(p.utilities).forEach(u => { t += parseFloat(u.amount) || 0; });
    return t;
  };
  const totalPortfolioValue = () => properties.reduce((t, p) => t + (p.value || 0), 0);
  const totalMonthlyIncome = () => properties.reduce((t, p) => t + (p.monthlyIncome || 0), 0);

  const cost = totalMonthlyCost();
  const portfolioValue = totalPortfolioValue();
  const monthlyIncome = tenants.reduce((t, tn) => t + (tn.rentAmount || 0), 0) || totalMonthlyIncome();
  const monthlyExpense = cost; // utility bills ARE the tracked expense

  // ── Rent due list (mirror of Tenant Assignment logic) ──────────────────────
  const markRentPaid = async (tenant: Tenant) => {
    try {
      await updateDoc(doc(db, "tenants", tenant.id), { lastPaidAt: serverTimestamp() });
      await setDoc(
        doc(db, "payments", auth.currentUser!.uid, "months", monthKey(), "payments", tenant.id),
        {
          rentAmount: tenant.rentAmount,
          tenantName: tenant.tenantName,
          propertyName: tenant.propertyName,
          paidAt: serverTimestamp(),
        }
      );
      await loadAll();
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to mark as paid.");
    }
  };

  const dueRents = tenants
    .filter((t) => !isTenantPaid(t))
    .map((t) => ({ tenant: t, status: getRentStatus(t.dueDay, t.lastPaidAt) }))
    .filter(
      ({ status }) =>
        status.label === "Overdue" || status.label === "Due Soon" || status.label === "Upcoming"
    )
    .sort((a, b) => {
      const rank: Record<string, number> = { Overdue: 0, "Due Soon": 1, Upcoming: 2 };
      return (rank[a.status.label] ?? 3) - (rank[b.status.label] ?? 3);
    });

  // ── Previous month numbers (from Firestore snapshot) ───────────────────────
  const prevSnap = monthSnaps[prevMonthKey()] ?? null;
  const hasPrevMonth = prevSnap !== null;

  // ── Sparkline: last 6 months of totalCost, oldest → newest ─────────────────
  const sparkData = Array.from({ length: 6 }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - (5 - i)); // oldest first
    return monthSnaps[monthKey(d)]?.totalCost ?? null;
  });
  // Only keep trailing non-null values; if < 2 real points → show empty chart
  const filledSpark = sparkData.filter((v): v is number => v !== null);

  const handleLogout = async () => { try { await signOut(auth); router.replace("/login"); } catch { } };
  const openDuesModal = () => {
    lastReadCount.current = notifCount;
    setNotifRead(true);
    setDuesModalOpen(true);
    const uid = auth.currentUser?.uid;
    if (uid) {
      setDoc(doc(db, "users", uid), { lastNotifReadCount: notifCount }, { merge: true }).catch(() => {});
      // Mark every tenant notification as read so the red dot clears, but keep
      // them visible in the list (they only leave when individually tapped).
      tenantNotifs.forEach((n) => {
        if (!n.read) {
          updateDoc(doc(db, "notifications", uid, "items", n.id), { read: true }).catch(() => {});
        }
      });
    }
  };
  const openNotificationTarget = (n: TenantNotification) => {
    setDuesModalOpen(false);
    const uid = auth.currentUser?.uid;
    if (uid) {
      // Mark it gone locally right away, then delete it from Firestore so it
      // never comes back after signing out and back in.
      setClearedNotifIds((prev) => new Set(prev).add(n.id));
      deleteDoc(doc(db, "notifications", uid, "items", n.id)).catch(() => {});
    }
    if (n.type === "rent_paid") {
      router.push("/tenants");
    } else {
      router.push("/maintenance");
    }
  };
  const openAddProperty = () => { setMenuOpen(false); router.push("/add-property"); };
  const openViewProperties = () => { setMenuOpen(false); router.push("/properties"); };
  const badgeColor = (type: string) => type?.toLowerCase().includes("commercial") ? "#A855F7" : "#3B82F6";

  const CARD_H = 168;
  const CHART_W = SW * 0.52;
  const CHART_H = CARD_H - 24;

  return (
    <View style={s.root}>
     <Image
  source={require("../assets/login-bg.png")}
  style={{
    position: "absolute",
    width: "100%",
    height: "100%",
  }}
  resizeMode="cover"
/>


      <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(5,10,20,0.78)" }]} />

      <SafeAreaView style={{ flex: 1 }}>
        {/* TOP BAR */}
        <View style={s.topBar}>
          <TouchableOpacity onPress={() => setMenuOpen(true)} style={s.iconBtn}>
            <Feather name="menu" size={22} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={s.iconBtn} onPress={openDuesModal}>
            <Feather name="bell" size={22} color="#fff" />
            {(notifCount > 0 && !notifRead) || tenantNotifs.some(n => !n.read && !clearedNotifIds.has(n.id)) ? <View style={s.notifDot} /> : null}
          </TouchableOpacity>
        </View>

        {/* GREETING */}
        <View style={s.greetWrap}>
          <Text style={s.greetLine}>{getGreeting()}</Text>
          <Text style={s.greetName}>{firstName}</Text>
          <Text style={s.greetSub}>Here's your portfolio overview</Text>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scroll}>

          {/* ── PORTFOLIO VALUE CARD ── */}
          <View style={[s.portfolioCard, { height: CARD_H }]}>
            {/* Sparkline — empty on first month, real curve from month 2+ */}
            <View style={[s.chartOverlay, { width: CHART_W, height: CHART_H }]} pointerEvents="none">
              <GlowSparkline width={CHART_W} height={CHART_H} dataPoints={filledSpark} />
            </View>

            <View style={{ flex: 1 }}>
              {/* Label + badge */}
              <View style={s.portfolioTopRow}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={s.portfolioLabel}>Total Portfolio Value</Text>
                  <Feather name="eye" size={15} color="#94A3B8" />
                </View>
                <View style={s.portfolioBadge}>
                  <Text style={s.portfolioBadgeText}>
                    {properties.length} {properties.length === 1 ? "property" : "properties"}
                  </Text>
                </View>
              </View>

              <Text style={s.portfolioValue} numberOfLines={1} adjustsFontSizeToFit>
                ${(portfolioValue > 0 ? portfolioValue : cost).toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </Text>

              {hasPrevMonth ? (() => {
                const portfolioPct = pctChange(
                  portfolioValue > 0 ? portfolioValue : cost,
                  prevSnap!.portfolioValue > 0 ? prevSnap!.portfolioValue : prevSnap!.totalCost
                );
                const portfolioUp = (portfolioPct ?? 0) >= 0;
                return (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
                    <Feather name={portfolioUp ? "trending-up" : "trending-down"} size={16} color={portfolioUp ? "#22C55E" : "#EF4444"} />
                    <Text style={[s.portfolioGrowth, { color: portfolioUp ? "#22C55E" : "#EF4444" }]}>
                      {Math.abs(portfolioPct ?? 0).toFixed(1)}%
                    </Text>
                    <Text style={s.portfolioGrowthSub}>vs last month</Text>
                  </View>
                );
              })() : (
                <Text style={{ color: "#475569", fontSize: 12, marginTop: 10 }}>
                  Month-over-month data available next month
                </Text>
              )}
            </View>
          </View>

          {/* ── MONTHLY SUMMARY ── */}
          <View style={s.summaryRow}>
            {/* Monthly Income */}
            <View style={s.summaryCard}>
              <View style={s.summaryIcon}>
                <Feather name="dollar-sign" size={18} color="#4F8DFF" />
              </View>
              <Text style={s.summaryLabel}>Income</Text>
              <Text style={s.summaryAmount}>
                ${monthlyIncome.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </Text>
              <View style={s.summaryTrend}>
                {hasPrevMonth ? (
                  <ChangeBadge
                    current={monthlyIncome}
                    previous={prevSnap!.monthlyIncome}
                  />
                ) : null}
              </View>
            </View>

            {/* Monthly Expense */}
            <View style={s.summaryCard}>
              <View style={s.summaryIcon}>
                <Feather name="bar-chart-2" size={18} color="#4F8DFF" />
              </View>
              <Text style={s.summaryLabel}>Expense</Text>
              <Text style={s.summaryAmount}>
                ${monthlyExpense.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </Text>
              <View style={s.summaryTrend}>
                {hasPrevMonth ? (
                  <ChangeBadge
                    current={monthlyExpense}
                    previous={prevSnap!.totalCost}
                    positiveIsGood={false}
                  />
                ) : null}
              </View>
            </View>
          </View>

          <View style={s.tilesRow}>
            <View style={s.tile}>
              <View style={[s.tileIcon, { backgroundColor: "rgba(59,130,246,0.18)" }]}>
                <Feather name="grid" size={16} color="#3B82F6" />
              </View>
              <Text style={s.tileLabel}>Properties</Text>
              <Text style={s.tileValue}>{properties.length}</Text>
              <Text style={s.tileGreen}>Active</Text>
            </View>
            <View style={s.tile}>
              <View style={[s.tileIcon, { backgroundColor: "rgba(250,204,21,0.15)" }]}>
                <Feather name="zap" size={16} color="#FACC15" />
              </View>
              <Text style={s.tileLabel}>Utilities</Text>
              <Text style={s.tileValue}>{totalUtilityCount()}</Text>
              <Text style={s.tileGreen}>Tracked</Text>
            </View>
          </View>

          {/* ── RENT DUE ── */}
          {dueRents.length > 0 && (
            <>
              <View style={[s.sectionHeader, { marginBottom: 10 }]}>
                <Text style={s.sectionTitle}>Rent Due</Text>
                <TouchableOpacity onPress={() => router.push("/tenants")}>
                  <Text style={s.viewAll}>Manage</Text>
                </TouchableOpacity>
              </View>
              <View style={s.dueRentCard}>
                {dueRents.map(({ tenant, status }, idx) => (
                  <View key={tenant.id} style={[s.dueRentRow, idx < dueRents.length - 1 && s.dueRentDivider]}>
                    <View style={[s.dueRentIcon, { backgroundColor: status.color + "1A" }]}>
                      <Feather name={status.icon} size={16} color={status.color} />
                    </View>
                    <View style={s.dueRentInfo}>
                      <Text style={s.dueRentName} numberOfLines={1}>{tenant.tenantName}</Text>
                      <Text style={s.dueRentProp} numberOfLines={1}>{tenant.propertyName}</Text>
                      <View style={[s.dueRentBadge, { backgroundColor: status.color + "22", borderColor: status.color + "44" }]}>
                        <Text style={[s.dueRentBadgeText, { color: status.color }]}>{status.label}</Text>
                      </View>
                    </View>
                    <View style={s.dueRentRight}>
                      <Text style={s.dueRentAmount}>${(tenant.rentAmount || 0).toLocaleString()}</Text>
                      <TouchableOpacity style={s.dueRentPaidBtn} onPress={() => markRentPaid(tenant)}>
                        <Feather name="check" size={13} color="#22C55E" />
                        <Text style={s.dueRentPaidText}>Mark Paid</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </View>
            </>
          )}

          <View style={[s.sectionHeader, { marginBottom: 10 }]}>
            <Text style={s.sectionTitle}>Your Properties</Text>
            <TouchableOpacity onPress={openViewProperties}>
              <Text style={s.viewAll}>View all</Text>
            </TouchableOpacity>
          </View>
          <View style={s.propListCard}>
            {loading ? (
              <Text style={s.emptyText}>Loading…</Text>
            ) : properties.length === 0 ? (
              <Text style={s.emptyText}>No properties yet — add your first one!</Text>
            ) : (
              properties.slice(0, 3).map((p, idx) => (
                <TouchableOpacity
                  key={p.id}
                  style={[s.propRow, idx < Math.min(properties.length, 3) - 1 && s.propRowBorder]}
                  onPress={() => router.push("/properties")}
                >
                  <TouchableOpacity onPress={() => { if (p.photoUrl) { setImageToShow(p.photoUrl); setImageModalOpen(true); } }}>
                    <Image
                      source={p.photoUrl ? { uri: p.photoUrl } : require("../assets/placeholder-building.png")}
                      style={s.propThumb}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={s.propName} numberOfLines={1}>{p.propertyName}</Text>
                    <Text style={s.propAddr} numberOfLines={1}>{p.address}</Text>
                    <View style={[s.badge, { borderColor: badgeColor(p.propertyType), backgroundColor: badgeColor(p.propertyType) + "22" }]}>
                      <Text style={[s.badgeText, { color: badgeColor(p.propertyType) }]}>
                        {p.propertyType?.charAt(0).toUpperCase() + p.propertyType?.slice(1)}
                      </Text>
                    </View>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={s.propValue}>${propMonthlyCost(p).toLocaleString("en-US", { maximumFractionDigits: 0 })}/mo</Text>
                    <Text style={s.propSub}>{Object.keys(p.utilities || {}).length} utilities</Text>
                  </View>
                  <Feather name="chevron-right" size={18} color="#4B5563" style={{ marginLeft: 6 }} />
                </TouchableOpacity>
              ))
            )}
          </View>

          <View style={[s.sectionHeader, { marginBottom: 10 }]}>
            <Text style={s.sectionTitle}>Recent Activity</Text>
            <TouchableOpacity
              style={s.exportSmallBtn}
              onPress={() => exportFullReport({
                properties,
                tenants: tenants.map(t => ({ ...t, notes: "", createdAt: null })),
                payments: rawPayments,
                maintenance: rawMaintenance,
              })}
            >
              <Feather name="download" size={15} color="#3B82F6" />
              <Text style={s.exportSmallBtnText}>Export</Text>
            </TouchableOpacity>
          </View>
          <View style={s.actCard}>
            {loading ? (
              <Text style={s.emptyText}>Loading…</Text>
            ) : activities.length === 0 ? (
              <Text style={s.emptyText}>No activity yet</Text>
            ) : (
              activities.map((a, i) => (
                <Fragment key={a.id}>
                  {i > 0 && <View style={s.actDivider} />}
                  <ActivityRow
                    icon={a.icon}
                    iconBg={a.iconBg}
                    iconColor={a.iconColor}
                    label={a.label}
                    sub={a.sub}
                    amount={a.amount}
                    amountColor={a.amountColor}
                    date={a.date}
                  />
                </Fragment>
              ))
            )}
          </View>

        </ScrollView>
      </SafeAreaView>

      {/* DRAWER */}
      <Animated.View pointerEvents={menuOpen ? "auto" : "none"} style={[s.drawer, { width: DRAWER_WIDTH, transform: [{ translateX: anim }] }]}>
        <SafeAreaView style={{ flex: 1 }}>
          <View style={{ padding: 20 }}>
            <Text style={{ color: "#fff", fontSize: 20, fontWeight: "800", marginBottom: 4 }}>EstateFlow</Text>
            <Text style={{ color: "#64748B", marginBottom: 24 }}>Navigation</Text>
            <DrawerItem icon="plus-circle" label="Add Property" onPress={openAddProperty} />
            <DrawerItem icon="user-plus" label="Tenant Assignment" onPress={() => { setMenuOpen(false); router.push("/tenants"); }} />
            <DrawerItem icon="bar-chart-2" label="Insights" onPress={() => { setMenuOpen(false); router.push("/insights"); }} />
            <DrawerItem icon="list" label="View Properties" onPress={openViewProperties} />
            <DrawerItem icon="tool" label="Maintenance" onPress={() => { setMenuOpen(false); router.push("/maintenance"); }} />
            <DrawerItem icon="log-out" label="Sign Out" onPress={handleLogout} />
          </View>
        </SafeAreaView>
      </Animated.View>

      {menuOpen && <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setMenuOpen(false)} />}

      {/* IMAGE MODAL */}
      <Modal visible={imageModalOpen} transparent animationType="fade" onRequestClose={() => setImageModalOpen(false)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "center", alignItems: "center", padding: 24 }} onPress={() => setImageModalOpen(false)} activeOpacity={1}>
          {imageToShow && <Image source={{ uri: imageToShow }} style={{ width: SW - 48, height: (SW - 48) * 0.66, borderRadius: 16 }} resizeMode="cover" />}
        </TouchableOpacity>
      </Modal>

      {/* DUES DROPDOWN */}
      <Modal visible={duesModalOpen} transparent animationType="fade" onRequestClose={() => setDuesModalOpen(false)}>
        <TouchableOpacity style={{ flex: 1 }} onPress={() => setDuesModalOpen(false)} activeOpacity={1}>
          <View style={s.duesDropdown}>
            <View style={s.duesArrow} />
            <Text style={s.duesTitle}>Notifications</Text>
            {upcomingDues.length === 0 && tenantNotifs.filter(n => !clearedNotifIds.has(n.id)).length === 0 ? (
              <Text style={{ color: "#64748B", textAlign: "center", padding: 20 }}>No alerts right now</Text>
            ) : (
              <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
            {/* Tenant-initiated notifications (from web portal) — read ones are greyed */}
            {tenantNotifs.filter(n => !clearedNotifIds.has(n.id)).length > 0 && (
              <>
                {tenantNotifs
                  .filter(n => !clearedNotifIds.has(n.id))
                  .slice(0, 5)
                  .map((n) => {
                      const ts = n.createdAt?.toDate ? n.createdAt.toDate() : n.createdAt ? new Date(n.createdAt) : null;
                      const isPay = n.type === "rent_paid";
                      const isRead = n.read || clearedNotifIds.has(n.id);
                      const iconBg = isPay ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.15)";
                      const iconColor = isPay ? "#22C55E" : "#F59E0B";
                      const icon = isPay ? ("check-circle" as const) : ("tool" as const);
                      return (
                        <TouchableOpacity key={n.id} style={[s.duesItem, isRead && s.duesItemRead]} onPress={() => openNotificationTarget(n)} activeOpacity={0.7}>
                          <View style={[s.duesItemIcon, { backgroundColor: iconBg }]}>
                            <Feather name={icon} size={15} color={iconColor} />
                          </View>
                          <View style={s.duesItemLeft}>
                            <Text style={[s.duesProperty, isRead && { color: "#64748B" }]}>{n.propertyName}</Text>
                            <Text style={[s.duesUtility, isRead && { color: "#475569" }]}>{n.message}</Text>
                          </View>
                          <View style={{ alignItems: "flex-end" }}>
                            {n.amount ? <Text style={s.duesAmount}>${(n.amount || 0).toLocaleString()}</Text> : null}
                            <Text style={[s.duesLabel, { color: "#64748B" }]}>
                              {ts ? fmtShortDate(ts) : ""}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}
                {/* Due items (rent + utility) */}
                {upcomingDues
                  .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
                  .map((item, i) => {
                    const diff = Math.ceil((item.dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                    const label = item.overdue
                      ? "Overdue"
                      : diff <= 1
                        ? "Tomorrow"
                        : diff <= 0
                          ? "Today"
                          : `In ${diff} days`;
                    const labelColor = item.overdue
                      ? "#EF4444"
                      : item.kind === "rent"
                        ? "#FACC15"
                        : "#94A3B8";
                    const iconColor = item.overdue ? "#EF4444" : item.kind === "rent" ? "#FACC15" : "#3B82F6";
                    const iconBg = item.overdue
                      ? "rgba(239,68,68,0.15)"
                      : item.kind === "rent"
                        ? "rgba(250,204,21,0.12)"
                        : "rgba(59,130,246,0.12)";
                    return (
                      <View key={i} style={s.duesItem}>
                        <View style={[s.duesItemIcon, { backgroundColor: iconBg }]}>
                          <Feather
                            name={item.kind === "rent" ? (item.overdue ? "alert-triangle" : "user") : "activity"}
                            size={15}
                            color={iconColor}
                          />
                        </View>
                        <View style={s.duesItemLeft}>
                          <Text style={s.duesProperty}>{item.propertyName}</Text>
                          <Text style={s.duesUtility}>
                            {item.kind === "rent" ? "Rent · " : ""}{item.subName}
                          </Text>
                        </View>
                        <View style={{ alignItems: "flex-end" }}>
                          <Text style={s.duesAmount}>${item.amount.toLocaleString()}</Text>
                          <Text style={[s.duesLabel, { color: labelColor }]}>{label}</Text>
                        </View>
                      </View>
                    );
                  })}
              </ScrollView>
            )}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ─── sub-components ───────────────────────────────────────────────────────────
function ActivityRow({ icon, iconBg, iconColor, label, sub, amount, amountColor, date }: any) {
  return (
    <View style={s.actRow}>
      <View style={[s.actIcon, { backgroundColor: iconBg }]}><Feather name={icon} size={18} color={iconColor} /></View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={s.actLabel}>{label}</Text>
        <Text style={s.actSub}>{sub}</Text>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={[s.actAmount, { color: amountColor }]}>{amount}</Text>
        <Text style={s.actDate}>{date}</Text>
      </View>
    </View>
  );
}
function DrawerItem({ icon, label, onPress }: any) {
  return (
    <TouchableOpacity style={s.drawerItem} onPress={onPress}>
      <Feather name={icon} size={20} color="#3B82F6" />
      <Text style={s.drawerLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#060D1C" },
  topBar: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  iconBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },
  notifDot: { position: "absolute", top: 6, right: 6, width: 10, height: 10, borderRadius: 5, backgroundColor: "#EF4444", borderWidth: 2, borderColor: "#060D1C" },
  greetWrap: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 20 },
  greetLine: { color: "#CBD5E1", fontSize: 16, fontWeight: "500" },
  greetName: { color: "#fff", fontSize: 32, fontWeight: "900", marginTop: 2 },
  greetSub: { color: "#64748B", fontSize: 14, marginTop: 4 },
  scroll: { paddingHorizontal: 16, paddingBottom: 60, gap: 14 },
  portfolioCard: { backgroundColor: "rgba(11,20,42,0.97)", borderRadius: 22, borderWidth: 1, borderColor: "rgba(59,130,246,0.25)", padding: 20, overflow: "hidden", shadowColor: "#1D4ED8", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 20, elevation: 12 },
  chartOverlay: { position: "absolute", right: 0, bottom: 0 },
  portfolioTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  portfolioLabel: { color: "#94A3B8", fontSize: 13, fontWeight: "500" },
  portfolioBadge: { backgroundColor: "rgba(37,99,235,0.22)", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: "rgba(96,165,250,0.35)" },
  portfolioBadgeText: { color: "#93C5FD", fontWeight: "700", fontSize: 13 },
  portfolioValue: { color: "#fff", fontSize: 38, fontWeight: "900", letterSpacing: -1.5, marginTop: 2, maxWidth: "60%" },
  portfolioGrowth: { color: "#22C55E", fontSize: 15, fontWeight: "800" },
  portfolioGrowthSub: { color: "#94A3B8", fontSize: 15, fontWeight: "500" },
  summaryRow: { flexDirection: "row", gap: 12 },
  summaryCard: { flex: 1, backgroundColor: "rgba(13,25,50,0.95)", borderRadius: 22, padding: 18, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)", shadowColor: "#2563EB", shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
  summaryIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: "rgba(37,99,235,0.15)", justifyContent: "center", alignItems: "center", marginBottom: 14 },
  summaryLabel: { color: "#B8C3D9", fontSize: 13, lineHeight: 20, marginBottom: 8 },
  summaryAmount: { color: "#FFFFFF", fontSize: 24, fontWeight: "800", marginBottom: 8 },
  summaryTrend: { flexDirection: "row", alignItems: "center" },
  summaryPositive: { color: "#22C55E", fontWeight: "700", marginLeft: 4, fontSize: 13 },
  firstMonthPlaceholder: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  firstMonthText: { color: "#334155", fontSize: 12, fontWeight: "500" },
  tilesRow: { flexDirection: "row", gap: 8 },
  tile: { flex: 1, backgroundColor: "rgba(14,22,42,0.92)", borderRadius: 16, padding: 12, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)", gap: 3 },
  tileIcon: { width: 34, height: 34, borderRadius: 10, justifyContent: "center", alignItems: "center", marginBottom: 4 },
  tileLabel: { color: "#64748B", fontSize: 10, fontWeight: "500" },
  tileValue: { color: "#fff", fontSize: 17, fontWeight: "800" },
  tileGreen: { color: "#22C55E", fontSize: 11, fontWeight: "600" },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: { color: "#fff", fontSize: 17, fontWeight: "800" },
  viewAll: { color: "#3B82F6", fontSize: 14, fontWeight: "600" },
  exportSmallBtn: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(59,130,246,0.12)", borderWidth: 1, borderColor: "rgba(59,130,246,0.3)", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  exportSmallBtnText: { color: "#3B82F6", fontSize: 12, fontWeight: "700" },
  propListCard: { backgroundColor: "rgba(14,22,42,0.92)", borderRadius: 20, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)", overflow: "hidden", paddingVertical: 4 },
  propRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12 },
  propRowBorder: { borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  propThumb: { width: 68, height: 68, borderRadius: 14, backgroundColor: "#1E293B" },
  propName: { color: "#fff", fontSize: 14, fontWeight: "700" },
  propAddr: { color: "#64748B", fontSize: 11, marginTop: 2, marginBottom: 6 },
  badge: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "600" },
  propValue: { color: "#fff", fontSize: 13, fontWeight: "700" },
  propSub: { color: "#64748B", fontSize: 11, marginTop: 2 },
  emptyText: { color: "#64748B", textAlign: "center", padding: 24 },
  dueRentCard: { backgroundColor: "rgba(14,22,42,0.92)", borderRadius: 20, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)", overflow: "hidden", paddingVertical: 4 },
  dueRentRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12 },
  dueRentDivider: { borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  dueRentIcon: { width: 36, height: 36, borderRadius: 11, justifyContent: "center", alignItems: "center", marginRight: 10 },
  dueRentInfo: { flex: 1, marginRight: 10 },
  dueRentName: { color: "#fff", fontSize: 14, fontWeight: "800" },
  dueRentProp: { color: "#64748B", fontSize: 12, marginTop: 2, marginBottom: 6 },
  dueRentBadge: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, borderWidth: 1 },
  dueRentBadgeText: { fontSize: 10, fontWeight: "700" },
  dueRentRight: { alignItems: "flex-end", gap: 8 },
  dueRentAmount: { color: "#fff", fontSize: 14, fontWeight: "800" },
  dueRentPaidBtn: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(34,197,94,0.12)", borderWidth: 1, borderColor: "rgba(34,197,94,0.35)", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  dueRentPaidText: { color: "#22C55E", fontSize: 12, fontWeight: "800" },
  actCard: { backgroundColor: "rgba(14,22,42,0.92)", borderRadius: 20, padding: 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  actDivider: { height: 1, backgroundColor: "rgba(255,255,255,0.06)", marginVertical: 14 },
  actRow: { flexDirection: "row", alignItems: "center" },
  actIcon: { width: 42, height: 42, borderRadius: 12, justifyContent: "center", alignItems: "center" },
  actLabel: { color: "#fff", fontSize: 14, fontWeight: "700" },
  actSub: { color: "#64748B", fontSize: 12, marginTop: 2 },
  actAmount: { fontSize: 14, fontWeight: "800" },
  actDate: { color: "#64748B", fontSize: 12, marginTop: 2 },
  drawer: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: "#080F1E", zIndex: 50, shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 12, elevation: 12, borderRightWidth: 1, borderRightColor: "rgba(59,130,246,0.15)" },
  drawerItem: { flexDirection: "row", alignItems: "center", paddingVertical: 14, gap: 14, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.05)" },
  drawerLabel: { color: "#fff", fontSize: 16, fontWeight: "600" },

  duesDropdown: { position: "absolute", top: 68, right: 16, width: Math.min(340, SW - 32), backgroundColor: "rgba(15,23,42,0.98)", borderRadius: 20, padding: 18, borderWidth: 1, borderColor: "rgba(59,130,246,0.2)", shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.5, shadowRadius: 20, elevation: 24 },
  duesArrow: { position: "absolute", top: -7, right: 24, width: 14, height: 14, backgroundColor: "rgba(15,23,42,0.98)", borderTopWidth: 1, borderLeftWidth: 1, borderColor: "rgba(59,130,246,0.2)", transform: [{ rotate: "45deg" }] },
  duesTitle: { color: "#fff", fontSize: 17, fontWeight: "900", marginBottom: 12 },
  duesItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  duesItemRead: { opacity: 0.55 },
  duesItemIcon: { width: 30, height: 30, borderRadius: 9, justifyContent: "center", alignItems: "center", marginRight: 10 },
  duesItemLeft: { flex: 1 },
  duesProperty: { color: "#fff", fontSize: 15, fontWeight: "800" },
  duesUtility: { color: "#94A3B8", fontSize: 13, marginTop: 2 },
  duesAmount: { color: "#fff", fontSize: 15, fontWeight: "800" },
  duesLabel: { color: "#FACC15", fontSize: 12, fontWeight: "700", marginTop: 2 },
});

