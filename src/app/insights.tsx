import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from "firebase/firestore";

import React, { useCallback, useEffect, useMemo, useState } from "react";

import {
  ActivityIndicator,
  Dimensions,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { BarChart, LineChart, PieChart } from "react-native-gifted-charts";
import Svg, { Circle, Path, Polyline } from "react-native-svg";

import { auth, db } from "../lib/firebase";
import { exportInsights } from "../lib/export";
import { requirePlanFeature } from "../lib/plans";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UtilityItem = {
  amount: string;
  provider: string;
  dueDay: number | "last";
  notify?: boolean;
};

type Property = {
  id: string;
  propertyName: string;
  address: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  propertyType: string;
  numUnits: number;
  ownerName: string;
  tenantName: string | null;
  tenants?: string[];
  utilities: Record<string, UtilityItem>;
  photoUrl?: string | null;
  notes?: string | null;
  value?: number;
  downPayment?: number;
  monthlyIncome?: number;
  createdAt: any;
};

type MonthSnapshot = {
  totalCost: number;
  monthlyIncome: number;
  portfolioValue: number;
  recordedAt: string;
};

type InsightTenant = {
  id: string;
  tenantName: string;
  propertyName: string;
  rentAmount: number;
};

type Maintenance = {
  id: string;
  propertyId: string;
  propertyName: string;
  title: string;
  cost: number;
  date: any;
  status: "pending" | "done";
  createdAt: any;
};

type ChartCardProps = {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const monthKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

const previousMonthKey = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return monthKey(d);
};

const percentChange = (current: number, previous: number) => {
  if (!previous || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
};

const currency = (value: number) =>
  `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const getUtilityTotal = (utilities?: Record<string, UtilityItem>) => {
  if (!utilities) return 0;
  return Object.values(utilities).reduce(
    (sum, utility) => sum + (parseFloat(utility.amount) || 0),
    0
  );
};

const buildUtilityTotals = (properties: Property[]) => {
  const totals: Record<string, number> = { Electric: 0, Water: 0, Gas: 0, Oil: 0, Sewer: 0, Trash: 0, Other: 0 };
  properties.forEach((property) => {
    if (!property.utilities) return;
    Object.entries(property.utilities).forEach(([key, utility]) => {
      const value = parseFloat(utility.amount) || 0;
      switch (key.toLowerCase()) {
        case "electric": totals.Electric += value; break;
        case "water": totals.Water += value; break;
        case "gas": totals.Gas += value; break;
        case "oil": totals.Oil += value; break;
        case "sewer": totals.Sewer += value; break;
        case "trash": totals.Trash += value; break;
        default: totals.Other += value; break;
      }
    });
  });
  return totals;
};

const marginFor = (income: number, expense: number) => {
  if (income <= 0) return 0;
  return ((income - expense) / income) * 100;
};

// Due-soon utilities across the whole portfolio (next 7 days)
const dueSoonUtilities = (properties: Property[]) => {
  const today = new Date().getDate();
  const results: { propertyName: string; provider: string; amount: number; dueDay: number | "last" }[] = [];
  properties.forEach((p) => {
    if (!p.utilities) return;
    Object.values(p.utilities).forEach((u) => {
      if (u.notify === false) return;
      if (u.dueDay === "last") return;
      const diff = u.dueDay - today;
      if (diff >= 0 && diff <= 7) {
        results.push({
          propertyName: p.propertyName,
          provider: u.provider,
          amount: parseFloat(u.amount) || 0,
          dueDay: u.dueDay,
        });
      }
    });
  });
  return results.sort((a, b) => (a.dueDay as number) - (b.dueDay as number)).slice(0, 3);
};

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function ChartCard({ title, right, children }: ChartCardProps) {
  return (
    <View style={styles.chartCard}>
      <View style={styles.chartCardHeader}>
        <Text style={styles.chartTitle}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function TrendBadge({ trend, positiveIsGood = true }: { trend: number | null; positiveIsGood?: boolean }) {
  if (trend === null) return null;
  const up = trend >= 0;
  const color = (positiveIsGood ? up : !up) ? "#22C55E" : "#EF4444";
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Feather name={up ? "trending-up" : "trending-down"} size={13} color={color} />
      <Text style={{ color, marginLeft: 4, fontWeight: "700", fontSize: 12 }}>
        {Math.abs(trend).toFixed(1)}% vs last mo
      </Text>
    </View>
  );
}

function SummaryCard({
  icon,
  iconBg,
  iconColor,
  label,
  value,
  trend,
  positiveIsGood = true,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  iconBg: string;
  iconColor: string;
  label: string;
  value: string;
  trend: number | null;
  positiveIsGood?: boolean;
}) {
  return (
    <View style={styles.summaryCard}>
      <View style={[styles.iconCircle, { backgroundColor: iconBg }]}>
        <Feather name={icon} size={18} color={iconColor} />
      </View>
      <Text style={styles.cardLabel}>{label}</Text>
      <Text style={styles.cardValue}>{value}</Text>
      <TrendBadge trend={trend} positiveIsGood={positiveIsGood} />
    </View>
  );
}

// Simple sparkline built from an array of numbers (no external chart needed)
function Sparkline({ points, color, width = 120, height = 34 }: { points: number[]; color: string; width?: number; height?: number }) {
  if (!points || points.length < 2) return <View style={{ height }} />;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = height - ((p - min) / range) * height;
    return `${x},${y}`;
  });
  const path = coords.join(" ");
  return (
    <Svg width={width} height={height}>
      <Polyline
        points={path}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// Semi-circle gauge for net profit margin
function MarginGauge({ percent, size = 170 }: { percent: number; size?: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const strokeWidth = 16;
  const radius = (size - strokeWidth) / 2;
  const arcLength = Math.PI * radius;
  const filled = (clamped / 100) * arcLength;
  const cx = size / 2;
  const cy = size / 2;
  const left = strokeWidth / 2;
  const right = size - strokeWidth / 2;

  const arcPath = `M ${left} ${cy} A ${radius} ${radius} 0 0 1 ${right} ${cy}`;

  return (
    <View style={{ alignItems: "center" }}>
      <Svg width={size} height={cy + 4}>
        <Path
          d={arcPath}
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
        />
        <Path
          d={arcPath}
          stroke="#22C55E"
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={filled > 0 ? `${filled} ${arcLength}` : `0 ${arcLength}`}
        />
      </Svg>
      <View style={{ position: "absolute", top: size * 0.32, alignItems: "center" }}>
        <Text style={[styles.gaugeValue, { fontSize: size > 150 ? 28 : 24 }]}>{clamped.toFixed(1)}%</Text>
        <Text style={styles.gaugeSub}>Net Margin</Text>
      </View>
      <View style={[styles.gaugeRange, { width: size - 16 }]}>
        <Text style={styles.gaugeRangeText}>0%</Text>
        <Text style={styles.gaugeRangeText}>100%</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function Insights() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [properties, setProperties] = useState<Property[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, MonthSnapshot>>({});
  const [paidByMonth, setPaidByMonth] = useState<Record<string, number>>({});
  const [tenants, setTenants] = useState<InsightTenant[]>([]);
  const [maintenance, setMaintenance] = useState<Maintenance[]>([]);
  const [rangeMonths, setRangeMonths] = useState<3 | 6>(6);

  const loadDashboard = useCallback(async (uid: string) => {
    try {
      setLoading(true);
      const q = query(collection(db, "properties"), where("ownerId", "==", uid));
      const propertySnap = await getDocs(q);
      const propertyList: Property[] = propertySnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Property, "id">),
      }));
      setProperties(propertyList);

      // Load tenants — their configured rent is the expected income
      const tenantSnap = await getDocs(query(collection(db, "tenants"), where("ownerId", "==", uid)));
      const tenantList: InsightTenant[] = tenantSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<InsightTenant, "id">),
      }));
      setTenants(tenantList);

      // Load maintenance records — their costs feed the expense charts
      const maintSnap = await getDocs(query(collection(db, "maintenance"), where("ownerId", "==", uid)));
      const maintList: Maintenance[] = maintSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Maintenance, "id">),
      }));
      setMaintenance(maintList);

      const keys = Array.from({ length: 6 }, (_, i) => {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        return monthKey(d);
      });

      const monthData: Record<string, MonthSnapshot> = {};
      await Promise.all(
        keys.map(async (key) => {
          const ref = doc(db, "snapshots", uid, "months", key);
          const snap = await getDoc(ref);
          if (snap.exists()) monthData[key] = snap.data() as MonthSnapshot;
        })
      );
      setSnapshots(monthData);

      // Sum rent marked as paid for each of the same months
      const payments: Record<string, number> = {};
      await Promise.all(
        keys.map(async (key) => {
          const snap = await getDocs(collection(db, "payments", uid, "months", key, "payments"));
          let sum = 0;
          snap.forEach((p) => {
            sum += (p.data().rentAmount as number) || 0;
          });
          payments[key] = sum;
        })
      );
      setPaidByMonth(payments);
    } catch (e) {
      console.log(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        setProperties([]);
        setSnapshots({});
        setPaidByMonth({});
        setTenants([]);
        setMaintenance([]);
        setLoading(false);
        return;
      }
      loadDashboard(user.uid);
    });
    return unsubscribe;
  }, [loadDashboard]);

  // Reload data whenever the screen regains focus (e.g. after marking rent paid
  // on the Tenant Assignment screen) so charts stay fresh.
  useFocusEffect(
    useCallback(() => {
      if (auth.currentUser) loadDashboard(auth.currentUser.uid);
    }, [loadDashboard])
  );

  // --- Portfolio-wide current numbers -----------------------------------

  const portfolioValue = useMemo(
    () => properties.reduce((sum, p) => sum + (p.value || 0), 0),
    [properties]
  );
  const totalIncome = useMemo(
    () => properties.reduce((sum, p) => sum + (p.monthlyIncome || 0), 0),
    [properties]
  );

  // --- Maintenance aggregates ---------------------------------------------

  const monthOf = (v: any) => {
    const d = v?.toDate ? v.toDate() : v ? new Date(v) : null;
    if (!d || isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  const maintenanceTotal = useMemo(() => {
    const cur = monthKey();
    return maintenance
      .filter((m) => monthOf(m.date) === cur)
      .reduce((s, m) => s + (m.cost || 0), 0);
  }, [maintenance]);

  const maintenanceByMonth = useMemo(() => {
    const map: Record<string, number> = {};
    maintenance.forEach((m) => {
      const k = monthOf(m.date);
      if (!k) return;
      map[k] = (map[k] || 0) + (m.cost || 0);
    });
    return map;
  }, [maintenance]);

  const maintenanceByProperty = useMemo(() => {
    const cur = monthKey();
    const map: Record<string, number> = {};
    maintenance
      .filter((m) => monthOf(m.date) === cur)
      .forEach((m) => {
        map[m.propertyName] = (map[m.propertyName] || 0) + (m.cost || 0);
      });
    return map;
  }, [maintenance]);

  const maintenanceByPropertyYear = useMemo(() => {
    const year = new Date().getFullYear();
    const map: Record<string, number> = {};
    maintenance
      .filter((m) => monthOf(m.date)?.startsWith(String(year)))
      .forEach((m) => {
        map[m.propertyName] = (map[m.propertyName] || 0) + (m.cost || 0);
      });
    return map;
  }, [maintenance]);

  const totalExpense = useMemo(
    () => properties.reduce((sum, p) => sum + getUtilityTotal(p.utilities), 0) + maintenanceTotal,
    [properties, maintenanceTotal]
  );
  const utilityTotals = useMemo(() => buildUtilityTotals(properties), [properties]);
  const potentialRent = useMemo(() => tenants.reduce((s, t) => s + (t.rentAmount || 0), 0), [tenants]);

  // Income = total rent marked as paid for a month. Uses the same data source
  // for all months so that month-over-month trends are apples-to-apples.
  // Priority: actual payments → snapshot (expected rent) → 0
  const incomeFrom = (key: string, snap?: MonthSnapshot) => {
    if (paidByMonth[key]) return paidByMonth[key];
    if (snap) return snap.monthlyIncome;
    return 0;
  };

  const previousSnap = snapshots[previousMonthKey()] || null;
  const currentIncome = incomeFrom(monthKey(), snapshots[monthKey()]);
  const previousIncome = incomeFrom(previousMonthKey(), previousSnap || undefined);

  // Use the same formula for current and previous expenses:
  //   utility costs (from properties / snapshot) + maintenance
  const currentExpense =
    properties.reduce((sum, p) => sum + getUtilityTotal(p.utilities), 0) +
    (maintenanceByMonth[monthKey()] || 0);
  const previousExpense = previousSnap
    ? previousSnap.totalCost + (maintenanceByMonth[previousMonthKey()] || 0)
    : 0;

  const netProfit = currentIncome - currentExpense;
  const previousNetProfit = previousIncome - previousExpense;
  const netMargin = currentIncome > 0 ? (netProfit / currentIncome) * 100 : 0;

  const hasPrevData = !!(previousSnap || paidByMonth[previousMonthKey()]);
  const incomeTrend = hasPrevData ? percentChange(currentIncome, previousIncome) : null;
  const expenseTrend = previousSnap
    ? percentChange(currentExpense, previousExpense)
    : null;
  const netProfitTrend = previousSnap
    ? percentChange(netProfit, previousNetProfit)
    : null;
  const portfolioTrend = previousSnap ? percentChange(portfolioValue, previousSnap.portfolioValue) : null;

  // --- Monthly history series ---------------------------------------------

  const monthlySeries = useMemo(() => {
    const now = new Date();
    const count = rangeMonths;
    const curKey = monthKey();
    const curLiveExpense =
      properties.reduce((sum, p) => sum + getUtilityTotal(p.utilities), 0) +
      (maintenanceByMonth[curKey] || 0);
    const raw = Array.from({ length: count }, (_, i) => {
      const d = new Date(now);
      d.setMonth(d.getMonth() - (count - 1 - i));
      const key = monthKey(d);
      const snap = snapshots[key];
      const income = incomeFrom(key, snap);
      // Current month uses live property data (matches summary cards);
      // past months use their saved snapshots.
      const expense =
        key === curKey
          ? curLiveExpense
          : (snap ? snap.totalCost : 0) + (maintenanceByMonth[key] || 0);
      return {
        label: MONTH_LABELS[d.getMonth()],
        income,
        expense,
        net: income - expense,
      };
    });
    const firstNonZero = raw.findIndex((m) => m.income !== 0 || m.expense !== 0);
    return firstNonZero === -1 ? raw.slice(-1) : raw.slice(firstNonZero);
  }, [snapshots, rangeMonths, paidByMonth, maintenanceByMonth, properties]);

  const incomeLineData = monthlySeries.map((m) => ({ value: m.income, label: m.label, dataPointText: currency(m.income) }));
  const expenseLineData = monthlySeries.map((m) => ({ value: m.expense, label: m.label }));
  const netLineData = monthlySeries.map((m) => ({ value: m.net, label: m.label }));

  const incomeExpenseBarData = useMemo(() => {
    const result: any[] = [];
    monthlySeries.forEach((m) => {
      result.push({ value: m.income, label: m.label, frontColor: "#3B82F6", barWidth: 12 });
      result.push({ value: m.expense, label: "", frontColor: "#EF4444", barWidth: 12, spacing: 18 });
    });
    return result;
  }, [monthlySeries]);

  // --- Expense breakdown ---------------------------------------------------

  const expenseCategories = [
    { key: "Electric", color: "#3B82F6", icon: "zap" as const },
    { key: "Water", color: "#06B6D4", icon: "droplet" as const },
    { key: "Gas", color: "#22C55E", icon: "wind" as const },
    { key: "Oil", color: "#F59E0B", icon: "tool" as const },
    { key: "Sewer", color: "#2DD4BF", icon: "layers" as const },
    { key: "Trash", color: "#78716C", icon: "trash-2" as const },
    { key: "Other", color: "#A855F7", icon: "more-horizontal" as const },
  ];

  const MAINTENANCE_COLOR = "#EC4899";

  const pieData = [
    ...expenseCategories.map((cat) => ({
      value: (utilityTotals as any)[cat.key] || 0,
      color: cat.color,
      text:
        totalExpense > 0
          ? `${((((utilityTotals as any)[cat.key] || 0) / totalExpense) * 100).toFixed(0)}%`
          : "0%",
    })),
    {
      value: maintenanceTotal,
      color: MAINTENANCE_COLOR,
      text: totalExpense > 0 ? `${((maintenanceTotal / totalExpense) * 100).toFixed(0)}%` : "0%",
    },
  ];

  // --- Expense by property (horizontal bars) --------------------------------

  const expenseByProperty = useMemo(
    () =>
      [...properties]
        .map((p) => ({
          ...p,
          expense: getUtilityTotal(p.utilities) + (maintenanceByProperty[p.propertyName] || 0),
        }))
        .sort((a, b) => b.expense - a.expense)
        .slice(0, 5),
    [properties, maintenanceByProperty]
  );
  const maxPropertyExpense = expenseByProperty[0]?.expense || 1;

  // --- Top performing / needs attention -------------------------------------

  const incomeForProperty = (p: Property) =>
    tenants
      .filter((t) => t.propertyName?.toLowerCase() === p.propertyName.toLowerCase())
      .reduce((s, t) => s + (t.rentAmount || 0), 0);

  // ROI metrics per property:
  // Cap Rate = annual NOI / property value
  // Cash-on-Cash = annual NOI / cash invested (down payment)
  const roiForProperty = (p: Property) => {
    const income = incomeForProperty(p) || p.monthlyIncome || 0;
    const utility = getUtilityTotal(p.utilities);
    const annualNOI =
      (income - utility) * 12 - (maintenanceByPropertyYear[p.propertyName] || 0);
    const value = p.value || 0;
    const capRate = value > 0 ? (annualNOI / value) * 100 : null;
    const cashInvested = p.downPayment || 0;
    const cashOnCash = cashInvested > 0 ? (annualNOI / cashInvested) * 100 : null;
    return { income, utility, annualNOI, value, capRate, cashOnCash };
  };

  const roiRows = properties
    .map((p) => ({ property: p, ...roiForProperty(p) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => (b.capRate ?? -Infinity) - (a.capRate ?? -Infinity))
    .slice(0, 5);
  const maxCap = Math.max(...roiRows.map((r) => r.capRate ?? 0), 1);
  const capRateColor = (capRate: number | null) => {
    if (capRate === null) return "#64748B";
    if (capRate < 0) return "#EF4444";
    if (capRate >= 5) return "#22C55E";
    if (capRate >= 3) return "#60A5FA";
    return "#F59E0B";
  };

  // --- Per-property income / expense breakdown -------------------------------
  // Every property gets its own income, expense (utilities + maintenance),
  // net profit, margin, and mini charts — not just the top 5.

  const perPropertyBreakdown = useMemo(
    () =>
      [...properties]
        .map((p) => {
          const income = incomeForProperty(p) || p.monthlyIncome || 0;
          const utility = getUtilityTotal(p.utilities);
          const maint = maintenanceByProperty[p.propertyName] || 0;
          const expense = utility + maint;
          const net = income - expense;
          const margin = marginFor(income, expense);
          const capRate = roiForProperty(p).capRate;
          return { property: p, income, utility, maint, expense, net, margin, capRate };
        })
        .sort((a, b) => b.net - a.net),
    [properties, tenants, maintenanceByProperty, maintenanceByPropertyYear]
  );

  const propertyHasTenant = (p: Property) =>
    !!p.tenantName ||
    (Array.isArray(p.tenants) && p.tenants.length > 0) ||
    tenants.some((t) => t.propertyName?.toLowerCase() === p.propertyName.toLowerCase());

  const topProps = useMemo(
    () =>
      [...properties]
        .sort((a, b) => incomeForProperty(b) - incomeForProperty(a))
        .slice(0, 3),
    [properties, tenants]
  );
  const vacantProperties = properties.filter((p) => !propertyHasTenant(p));
  const upcomingDue = dueSoonUtilities(properties);

  // Tenants that need the owner's attention:
  // 1) tenant records whose property doesn't exist (or wasn't matched)
  const unassignedTenants = tenants.filter(
    (t) => !properties.some((p) => p.propertyName.toLowerCase() === (t.propertyName || "").toLowerCase())
  );
  // 2) tenant names on properties that were never set up with rent details
  const configuredNames = new Set(tenants.map((t) => t.tenantName.toLowerCase()));
  const unconfiguredTenants = properties.flatMap((p) => {
    const names =
      Array.isArray(p.tenants) && p.tenants.length > 0
        ? p.tenants
        : p.tenantName
          ? [p.tenantName]
          : [];
    return names
      .filter((n) => !configuredNames.has(n.toLowerCase()))
      .map((n) => ({ propertyName: p.propertyName, tenantName: n }));
  });

  // Rough per-utility sparkline built by scaling the portfolio expense trend
  const trendSeries = monthlySeries.map((m) => m.expense);
  const utilitySparkline = (share: number) =>
    trendSeries.map((v) => Math.round(v * share));

  return (
    <View style={styles.root}>
      <Image source={require("../assets/login-bg.png")} style={styles.bgImage} resizeMode="cover" />
      <View style={styles.bgOverlay} />

      <SafeAreaView style={{ flex: 1 }}>
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#4F8DFF" />
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
            {/* HEADER */}
            <View style={styles.header}>
              <TouchableOpacity onPress={() => router.replace("/dashboard")} style={styles.backBtn}>
                <Feather name="chevron-left" size={22} color="#fff" />
              </TouchableOpacity>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.headerTitle}>Insights</Text>
              </View>
              <TouchableOpacity
                style={styles.filterBtn}
                onPress={async () => {
                  if (!(await requirePlanFeature("exports", "Excel exports"))) return;
                  exportInsights({
                    snapshots,
                    paidByMonth,
                    maintenance: maintenance.map(m => ({ title: m.title || "", propertyName: m.propertyName || "", cost: m.cost || 0, date: m.date })),
                  });
                }}
              >
                <Feather name="download" size={18} color="#4F8DFF" />
              </TouchableOpacity>
            </View>

            {/* SUMMARY CARDS (2x2) */}
            <View style={styles.summaryGrid}>
              <SummaryCard
                icon="dollar-sign"
                iconBg="rgba(59,130,246,.15)"
                iconColor="#3B82F6"
                label="Total Income"
                value={currency(currentIncome)}
                trend={incomeTrend}
              />
              <SummaryCard
                icon="arrow-down-circle"
                iconBg="rgba(168,85,247,.15)"
                iconColor="#A855F7"
                label="Total Expense"
                value={currency(totalExpense)}
                trend={expenseTrend}
                positiveIsGood={false}
              />
            </View>
            <View style={styles.summaryGrid}>
              <SummaryCard
                icon="trending-up"
                iconBg="rgba(34,197,94,.15)"
                iconColor="#22C55E"
                label="Net Profit"
                value={currency(netProfit)}
                trend={netProfitTrend}
              />
              <SummaryCard
                icon="home"
                iconBg="rgba(245,158,11,.15)"
                iconColor="#F59E0B"
                label="Portfolio Value"
                value={currency(portfolioValue)}
                trend={portfolioTrend}
              />
            </View>

            {/* MONTHLY OVERVIEW */}
            <ChartCard
              title="Monthly Overview"
              right={
                <TouchableOpacity
                  style={styles.rangeToggle}
                  onPress={() => setRangeMonths(rangeMonths === 6 ? 3 : 6)}
                >
                  <Text style={styles.rangeToggleText}>{rangeMonths} Months</Text>
                  <Feather name="chevron-down" size={14} color="#94A3B8" />
                </TouchableOpacity>
              }
            >
              <View style={styles.legendRow}>
                <LegendDot color="#3B82F6" label="Income" />
                <LegendDot color="#EF4444" label="Expense" />
                <LegendDot color="#22C55E" label="Net Profit" />
              </View>
              <LineChart
                data={incomeLineData}
                data2={expenseLineData}
                data3={netLineData}
                height={190}
                curved
                color="#3B82F6"
                color2="#EF4444"
                color3="#22C55E"
                thickness={3}
                thickness2={2}
                thickness3={2}
                dataPointsColor="#3B82F6"
                dataPointsColor2="#EF4444"
                dataPointsColor3="#22C55E"
                dataPointsRadius={3}
                textColor="#CBD5E1"
                xAxisLabelTextStyle={{ color: "#94A3B8", fontSize: 11 }}
                yAxisTextStyle={{ color: "#94A3B8", fontSize: 11 }}
                xAxisColor="rgba(59,130,246,0.15)"
                yAxisColor="rgba(59,130,246,0.15)"
                showVerticalLines={false}
                showHorizontalLines={false}
                spacing={rangeMonths === 6 ? 50 : 80}
                initialSpacing={12}
                endSpacing={12}
                isAnimated
                rulesColor="rgba(59,130,246,0.08)"
                noOfSections={4}
              />
            </ChartCard>

            {/* EXPENSE BREAKDOWN */}
            <ChartCard title="Expense Breakdown">
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <PieChart
                  data={pieData}
                  radius={70}
                  donut
                  showText
                  textColor="#fff"
                  textSize={11}
                  isAnimated
                  showTextBackground
                  textBackgroundColor="rgba(0,0,0,0.5)"
                  textBackgroundRadius={6}
                  strokeColor="rgba(255,255,255,0.08)"
                  strokeWidth={2}
                  innerRadius={30}
                  centerLabelComponent={() => (
                    <View style={{ alignItems: "center" }}>
                      <Text style={styles.pieCenterValue}>{currency(totalExpense)}</Text>
                      <Text style={styles.pieCenterLabel}>Total</Text>
                    </View>
                  )}
                />
                <View style={{ flex: 1, marginLeft: 16 }}>
                  {expenseCategories.map((cat, i) => (
                    <View key={cat.key} style={styles.pieLegendItem}>
                      <View style={[styles.legendColor, { backgroundColor: cat.color }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.legendTitle}>{cat.key}</Text>
                        <Text style={styles.legendValue}>{currency(pieData[i].value)}</Text>
                      </View>
                      <Text style={styles.legendPercent}>{pieData[i].text}</Text>
                    </View>
                  ))}
                  <View key="maintenance" style={styles.pieLegendItem}>
                    <View style={[styles.legendColor, { backgroundColor: MAINTENANCE_COLOR }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.legendTitle}>Maintenance</Text>
                      <Text style={styles.legendValue}>{currency(maintenanceTotal)}</Text>
                    </View>
                    <Text style={styles.legendPercent}>{pieData[pieData.length - 1].text}</Text>
                  </View>
                </View>
              </View>
            </ChartCard>

            {/* EXPENSE BY PROPERTY */}
            <ChartCard title="Expense by Property">
              <BarChart
                data={expenseByProperty.map((p) => ({
                  value: p.expense,
                  label: p.propertyName,
                  frontColor: "#3B82F6",
                }))}
                horizontal
                height={180}
                barWidth={16}
                barBorderRadius={4}
                spacing={22}
                yAxisTextStyle={{ color: "#94A3B8", fontSize: 11 }}
                xAxisLabelTextStyle={{ color: "#94A3B8", fontSize: 11 }}
                xAxisColor="rgba(59,130,246,0.15)"
                yAxisColor="rgba(59,130,246,0.15)"
                showVerticalLines={false}
                rulesColor="rgba(59,130,246,0.08)"
                isAnimated
              />
            </ChartCard>

            {/* INCOME VS EXPENSE */}
            <ChartCard title="Income vs Expense">
              <View style={styles.legendRow}>
                <LegendDot color="#3B82F6" label="Income" />
                <LegendDot color="#EF4444" label="Expense" />
              </View>
              <BarChart
                data={incomeExpenseBarData}
                height={190}
                barBorderRadius={4}
                isAnimated
                noOfSections={4}
                yAxisTextStyle={{ color: "#94A3B8", fontSize: 11 }}
                xAxisLabelTextStyle={{ color: "#94A3B8", fontSize: 11 }}
                xAxisColor="rgba(59,130,246,0.15)"
                yAxisColor="rgba(59,130,246,0.15)"
                showVerticalLines={false}
                showHorizontalLines={false}
                rulesColor="rgba(59,130,246,0.08)"
                spacing={4}
                initialSpacing={20}
                endSpacing={20}
              />
            </ChartCard>

            {/* NET PROFIT MARGIN */}
            <ChartCard title="Net Profit Margin">
              <View style={{ alignItems: "center", paddingBottom: 8 }}>
                <MarginGauge percent={netMargin} size={150} />
                <View style={{ marginTop: 16 }}>
                  <TrendBadge trend={netProfitTrend} />
                </View>
              </View>
            </ChartCard>

            {/* UTILITIES OVERVIEW */}
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Utilities Overview</Text>
            </View>

            <View style={styles.utilityGrid}>
              {expenseCategories.map((cat) => {
                const value = (utilityTotals as any)[cat.key] || 0;
                const share = totalExpense > 0 ? value / totalExpense : 0;
                return (
                  <View key={cat.key} style={styles.utilityCard}>
                    <View style={[styles.utilityIconSm, { backgroundColor: `${cat.color}26` }]}>
                      <Feather name={cat.icon} size={18} color={cat.color} />
                    </View>
                    <Text style={styles.utilityName}>{cat.key}</Text>
                    <Text style={styles.utilityPrice}>{currency(value)}</Text>
                    <Text style={styles.utilityShare}>{(share * 100).toFixed(0)}% of total</Text>
                    <Sparkline points={utilitySparkline(share)} color={cat.color} />
                  </View>
                );
              })}
            </View>

            {/* TOP PERFORMING PROPERTIES */}
            <ChartCard title="Top Performing Properties">
              {topProps.length === 0 && <Text style={styles.emptyText}>No properties yet.</Text>}
              {topProps.map((property) => {
                const income = incomeForProperty(property);
                const expense = getUtilityTotal(property.utilities);
                const margin = marginFor(income, expense);
                const capRate = roiForProperty(property).capRate;
                return (
                  <TouchableOpacity
                    key={property.id}
                    style={styles.attentionRow}
                    onPress={() => router.push(`/property-breakdown?propertyId=${property.id}`)}
                  >
                    <View style={styles.rowIcon}>
                      <Feather name="trending-up" size={16} color="#22C55E" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.propertyName}>{property.propertyName}</Text>
                      <Text style={styles.propertyAddress}>
                        Net Profit: {currency(income - expense)}
                      </Text>
                    </View>
                    <View style={[styles.marginPill, { flexDirection: "column", gap: 2 }]}>
                      <Text style={styles.marginPillText}>{margin.toFixed(0)}% Margin</Text>
                      <Text style={styles.roiCoC}>{capRate !== null ? `${capRate.toFixed(1)}% Cap` : "—"}</Text>
                    </View>
                    <Feather name="chevron-right" size={18} color="#475569" style={{ marginLeft: 8 }} />
                  </TouchableOpacity>
                );
              })}
            </ChartCard>

            {/* ROI BY PROPERTY */}
            <ChartCard title="ROI by Property">
              <View style={styles.roiHint}>
                <Feather name="info" size={14} color="#60A5FA" />
                <Text style={styles.roiHintText}>
                  Cap Rate = annual net income ÷ property value. Cash-on-Cash = annual cash flow ÷ cash invested.
                </Text>
              </View>
              {roiRows.length === 0 ? (
                <Text style={styles.emptyText}>Add a property value to see returns.</Text>
              ) : (
                roiRows.map((r) => {
                  const color = capRateColor(r.capRate);
                  const barWidth = Math.min(100, Math.max(4, ((r.capRate ?? 0) / maxCap) * 100));
                  return (
                    <TouchableOpacity
                      key={r.property.id}
                      style={styles.attentionRow}
                      onPress={() => router.push(`/property-breakdown?propertyId=${r.property.id}`)}
                    >
                      <View style={[styles.rowIcon, { backgroundColor: `${color}1A` }]}>
                        <Feather name="trending-up" size={16} color={color} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.propertyName} numberOfLines={1}>{r.property.propertyName}</Text>
                        <Text style={styles.propertyAddress}>Annual NOI: {currency(r.annualNOI)}</Text>
                        <View style={styles.roiBarTrack}>
                          <View style={[styles.roiBarFill, { width: `${barWidth}%`, backgroundColor: color }]} />
                        </View>
                      </View>
                      <View style={{ alignItems: "flex-end", gap: 6 }}>
                        <View style={[styles.marginPill, { backgroundColor: `${color}1A` }]}>
                          <Text style={[styles.marginPillText, { color }]}>
                            {r.capRate !== null ? `${r.capRate.toFixed(1)}% Cap` : "—"}
                          </Text>
                        </View>
                        {r.cashOnCash !== null && (
                          <Text style={styles.roiCoC}>CoC {r.cashOnCash.toFixed(1)}%</Text>
                        )}
                      </View>
                      <Feather name="chevron-right" size={18} color="#475569" style={{ marginLeft: 8 }} />
                    </TouchableOpacity>
                  );
                })
              )}
            </ChartCard>

            {/* PER-PROPERTY BREAKDOWN */}
            <ChartCard title="Per-Property Breakdown">
              <Text style={styles.propBreakHint}>
                Tap a property for its full income, expense & charts breakdown.
              </Text>
              {perPropertyBreakdown.length === 0 && (
                <Text style={styles.emptyText}>No properties yet.</Text>
              )}
              {perPropertyBreakdown.map(({ property, income, expense, net, margin }) => {
                const netColor = net >= 0 ? "#22C55E" : "#EF4444";
                return (
                  <TouchableOpacity
                    key={property.id}
                    style={styles.attentionRow}
                    onPress={() => router.push(`/property-breakdown?propertyId=${property.id}`)}
                  >
                    <View style={styles.rowIcon}>
                      <Feather name="home" size={16} color="#60A5FA" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.propertyName} numberOfLines={1}>
                        {property.propertyName}
                      </Text>
                      <Text style={styles.propertyAddress} numberOfLines={1}>
                        {currency(income)} in · {currency(expense)} out · Net {currency(net)}
                      </Text>
                    </View>
                    <View style={[styles.marginPill, { backgroundColor: `${netColor}1A` }]}>
                      <Text style={[styles.marginPillText, { color: netColor }]}>
                        {margin.toFixed(0)}%
                      </Text>
                    </View>
                    <Feather name="chevron-right" size={18} color="#475569" style={{ marginLeft: 8 }} />
                  </TouchableOpacity>
                );
              })}
            </ChartCard>

            {/* NEEDS ATTENTION */}
            <ChartCard title="Needs Attention">
              {vacantProperties.map((property) => (
                <View key={`vacant-${property.id}`} style={styles.attentionRow}>
                  <View style={[styles.rowIcon, { backgroundColor: "rgba(239,68,68,.15)" }]}>
                    <Feather name="alert-triangle" size={16} color="#EF4444" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.propertyName}>{property.propertyName}</Text>
                    <Text style={styles.propertyAddress}>No tenant assigned</Text>
                  </View>
                </View>
              ))}
              {unassignedTenants.map((tenant) => (
                <View key={`unassigned-${tenant.id}`} style={styles.attentionRow}>
                  <View style={[styles.rowIcon, { backgroundColor: "rgba(239,68,68,.15)" }]}>
                    <Feather name="user-x" size={16} color="#EF4444" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.propertyName}>{tenant.tenantName}</Text>
                    <Text style={styles.propertyAddress}>
                      No property assigned · {currency(tenant.rentAmount || 0)}/mo
                    </Text>
                  </View>
                </View>
              ))}
              {unconfiguredTenants.map((tenant) => (
                <View key={`unconf-${tenant.propertyName}-${tenant.tenantName}`} style={styles.attentionRow}>
                  <View style={[styles.rowIcon, { backgroundColor: "rgba(245,158,11,.15)" }]}>
                    <Feather name="alert-circle" size={16} color="#F59E0B" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.propertyName}>{tenant.tenantName}</Text>
                    <Text style={styles.propertyAddress}>
                      Set up rent details · {tenant.propertyName}
                    </Text>
                  </View>
                </View>
              ))}
              {upcomingDue.map((item, idx) => (
                <View key={`due-${idx}`} style={styles.attentionRow}>
                  <View style={[styles.rowIcon, { backgroundColor: "rgba(245,158,11,.15)" }]}>
                    <Feather name="clock" size={16} color="#F59E0B" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.propertyName}>{item.propertyName}</Text>
                    <Text style={styles.propertyAddress}>
                      {item.provider} due day {item.dueDay}
                    </Text>
                  </View>
                  <Text style={styles.duePillText}>{currency(item.amount)}</Text>
                </View>
              ))}
              {vacantProperties.length === 0 && upcomingDue.length === 0 && unassignedTenants.length === 0 && unconfiguredTenants.length === 0 && (
                <Text style={styles.emptyText}>Nothing needs attention right now.</Text>
              )}
            </ChartCard>

            {/* PORTFOLIO INSIGHTS */}
            <ChartCard title="Portfolio Insights">
              <View style={styles.aiCard}>
                <View style={styles.aiIcon}>
                  <Feather name="cpu" size={26} color="#4F8DFF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.aiTitle}>Portfolio Health</Text>
                  <Text style={styles.aiText}>
                    Your portfolio generated{" "}
                    <Text style={{ color: "#22C55E", fontWeight: "700" }}>{currency(netProfit)}</Text>{" "}
                    in net profit this month.
                  </Text>
                  <Text style={styles.aiText}>
                    Your highest earning property is{" "}
                    <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>
                      {topProps[0]?.propertyName || "-"}
                    </Text>.
                  </Text>
                  <Text style={styles.aiText}>
                    Utility expenses account for{" "}
                    <Text style={{ color: "#F59E0B", fontWeight: "700" }}>
                      {potentialRent > 0 ? ((totalExpense / potentialRent) * 100).toFixed(1) : 0}%
                    </Text>{" "}
                    of your monthly income.
                  </Text>
                  {totalExpense > 0 && (
                    <View style={styles.tipBox}>
                      <Feather name="zap" size={16} color="#22C55E" />
                      <Text style={styles.tipText}>
                        Reducing utility costs by 10% could increase monthly profit by {currency(totalExpense * 0.1)}.
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </ChartCard>
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginRight: 18 }}>
      <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: color, marginRight: 6 }} />
      <Text style={{ color: "#94A3B8", fontSize: 12 }}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#060D1C" },
  bgImage: { position: "absolute", width: "100%", height: "100%" },
  bgOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(5,10,20,0.78)" },
  scrollContent: { padding: 16, paddingBottom: 60, gap: 14 },
  loadingContainer: { flex: 1, justifyContent: "center", alignItems: "center" },

  header: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  backBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },
  headerTitle: { color: "#FFF", fontSize: 26, fontWeight: "900" },
  filterBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(59,130,246,.15)", justifyContent: "center", alignItems: "center" },

  summaryGrid: { flexDirection: "row", gap: 14 },
  summaryCard: { flex: 1, backgroundColor: "rgba(12,24,46,.96)", borderRadius: 22, padding: 16, borderWidth: 1, borderColor: "rgba(59,130,246,.15)" },
  iconCircle: { width: 40, height: 40, borderRadius: 14, justifyContent: "center", alignItems: "center", marginBottom: 12 },
  cardLabel: { color: "#9FB2D6", fontSize: 12 },
  cardValue: { color: "#FFF", fontSize: 22, fontWeight: "900", marginTop: 4, marginBottom: 8 },

  chartCard: { backgroundColor: "rgba(12,24,46,.96)", borderRadius: 24, padding: 20, borderWidth: 1, borderColor: "rgba(59,130,246,.15)", shadowColor: "#2563EB", shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 10 } },
  chartCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  chartTitle: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
  legendRow: { flexDirection: "row", marginBottom: 14 },

  rangeToggle: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(255,255,255,0.06)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  rangeToggleText: { color: "#CBD5E1", fontSize: 12, marginRight: 4 },

  pieCenterValue: { color: "#FFFFFF", fontWeight: "900", fontSize: 15 },
  pieCenterLabel: { color: "#94A3B8", fontSize: 11 },
  pieLegendItem: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  legendColor: { width: 12, height: 12, borderRadius: 6, marginRight: 10 },
  legendTitle: { color: "#FFFFFF", fontWeight: "700", fontSize: 13 },
  legendValue: { color: "#94A3B8", marginTop: 1, fontSize: 12 },
  legendPercent: { color: "#FFFFFF", fontWeight: "800", fontSize: 13 },

  gaugeLabelWrap: { position: "absolute", top: "38%", alignItems: "center" },
  gaugeValue: { color: "#FFFFFF", fontSize: 28, fontWeight: "900" },
  gaugeSub: { color: "#94A3B8", fontSize: 12, marginTop: 2 },
  gaugeRange: { flexDirection: "row", justifyContent: "space-between", width: "100%", paddingHorizontal: 8, marginTop: -8 },
  gaugeRangeText: { color: "#64748B", fontSize: 11 },

  sectionHeaderRow: { marginTop: 2 },
  sectionTitle: { color: "#FFFFFF", fontSize: 20, fontWeight: "800" },

  utilityGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 14 },
  utilityCard: { width: "48%", backgroundColor: "rgba(12,24,46,.96)", borderRadius: 22, padding: 16, borderWidth: 1, borderColor: "rgba(59,130,246,.12)" },
  utilityIconSm: { width: 40, height: 40, borderRadius: 14, justifyContent: "center", alignItems: "center", marginBottom: 12 },
  utilityName: { color: "#94A3B8", fontSize: 13 },
  utilityPrice: { color: "#FFFFFF", fontWeight: "900", fontSize: 20, marginTop: 4 },
  utilityShare: { color: "#64748B", fontSize: 11, marginTop: 2, marginBottom: 8 },

  attentionRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,.05)" },
  rowIcon: { width: 34, height: 34, borderRadius: 12, backgroundColor: "rgba(34,197,94,.15)", justifyContent: "center", alignItems: "center", marginRight: 12 },
  propertyName: { color: "#FFFFFF", fontWeight: "700", fontSize: 14 },
  propertyAddress: { color: "#94A3B8", marginTop: 2, fontSize: 12 },
  marginPill: { backgroundColor: "rgba(34,197,94,.15)", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10 },
  marginPillText: { color: "#22C55E", fontWeight: "700", fontSize: 12 },
  duePillText: { color: "#F59E0B", fontWeight: "800", fontSize: 13 },
  emptyText: { color: "#64748B", fontSize: 13, paddingVertical: 8 },

  roiHint: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: "rgba(59,130,246,0.08)", borderRadius: 14, padding: 12, marginBottom: 6, borderWidth: 1, borderColor: "rgba(59,130,246,0.15)" },
  roiHintText: { flex: 1, color: "#93C5FD", fontSize: 12, fontWeight: "600", lineHeight: 17 },
  roiBarTrack: { height: 6, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 3, marginTop: 8, overflow: "hidden" },
  roiBarFill: { height: "100%", borderRadius: 3 },
  roiCoC: { color: "#94A3B8", fontSize: 12, fontWeight: "700" },

  propBreakHint: { color: "#64748B", fontSize: 12, fontWeight: "600", marginBottom: 6 },

  aiCard: { flexDirection: "row" },
  aiIcon: { width: 64, height: 64, borderRadius: 20, backgroundColor: "rgba(59,130,246,.15)", justifyContent: "center", alignItems: "center", marginRight: 18 },
  aiTitle: { color: "#FFFFFF", fontWeight: "900", fontSize: 20, marginBottom: 14 },
  aiText: { color: "#CBD5E1", fontSize: 15, lineHeight: 24, marginBottom: 10 },
  tipBox: { marginTop: 18, backgroundColor: "rgba(34,197,94,.12)", borderRadius: 16, padding: 14, flexDirection: "row", alignItems: "center" },
  tipText: { color: "#22C55E", marginLeft: 10, flex: 1, fontWeight: "600" },
});