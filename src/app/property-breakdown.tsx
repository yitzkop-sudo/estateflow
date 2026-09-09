import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { BarChart, PieChart } from "react-native-gifted-charts";
import { auth, db } from "../lib/firebase";

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
  propertyType: string;
  numUnits: number;
  ownerName: string;
  utilities: Record<string, UtilityItem>;
  photoUrl?: string | null;
  value?: number;
  downPayment?: number;
  monthlyIncome?: number;
};

type Tenant = {
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
};

const EXPENSE_CATEGORIES = [
  { key: "Electric", color: "#3B82F6", icon: "zap" as const },
  { key: "Water", color: "#06B6D4", icon: "droplet" as const },
  { key: "Gas", color: "#22C55E", icon: "wind" as const },
  { key: "Oil", color: "#F59E0B", icon: "tool" as const },
  { key: "Sewer", color: "#2DD4BF", icon: "layers" as const },
  { key: "Trash", color: "#78716C", icon: "trash-2" as const },
  { key: "Other", color: "#A855F7", icon: "more-horizontal" as const },
];
const MAINTENANCE_COLOR = "#EC4899";

const currency = (value: number) =>
  `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const ordinalSuffix = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const formatDueDay = (d: number | "last") =>
  d === "last" ? "Last day of month" : `${ordinalSuffix(d)} of month`;

const formatDate = (v: any) => {
  if (!v) return "";
  const d = v?.toDate ? v.toDate() : new Date(v);
  if (!d || isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export default function PropertyBreakdown() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const propertyId = typeof params.propertyId === "string" ? params.propertyId : null;

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [property, setProperty] = useState<Property | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [maintenance, setMaintenance] = useState<Maintenance[]>([]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setLoading(false);
        setNotFound(true);
        return;
      }
      if (!propertyId) {
        setLoading(false);
        setNotFound(true);
        return;
      }
      try {
        setLoading(true);
        const snap = await getDoc(doc(db, "properties", propertyId));
        if (!snap.exists() || (snap.data() as any).ownerId !== user.uid) {
          setNotFound(true);
          return;
        }
        const data = snap.data() as Omit<Property, "id">;
        const prop: Property = { id: snap.id, ...data };
        setProperty(prop);

        const tenantSnap = await getDocs(
          query(collection(db, "tenants"), where("ownerId", "==", user.uid))
        );
        setTenants(
          tenantSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Tenant, "id">) }))
        );

        const maintSnap = await getDocs(
          query(collection(db, "maintenance"), where("ownerId", "==", user.uid))
        );
        const allMaint: Maintenance[] = maintSnap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Maintenance, "id">),
        }));
        setMaintenance(
          allMaint.filter(
            (m) =>
              m.propertyId === prop.id ||
              (m.propertyName || "").toLowerCase() === (prop.propertyName || "").toLowerCase()
          )
        );
      } catch (e) {
        console.log(e);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    });
    return unsubscribe;
  }, [propertyId]);

  const income = useMemo(() => {
    if (!property) return 0;
    const rent = tenants
      .filter(
        (t) => (t.propertyName || "").toLowerCase() === (property.propertyName || "").toLowerCase()
      )
      .reduce((s, t) => s + (t.rentAmount || 0), 0);
    return rent || property.monthlyIncome || 0;
  }, [property, tenants]);

  const utilityTotal = useMemo(() => {
    if (!property?.utilities) return 0;
    return Object.values(property.utilities).reduce(
      (s, u) => s + (parseFloat(u.amount) || 0),
      0
    );
  }, [property]);

  const maintTotal = useMemo(
    () => maintenance.reduce((s, m) => s + (m.cost || 0), 0),
    [maintenance]
  );

  const expense = utilityTotal + maintTotal;
  const net = income - expense;
  const margin = income > 0 ? ((income - expense) / income) * 100 : 0;
  const netColor = net >= 0 ? "#22C55E" : "#EF4444";

  const utilitySlices = useMemo<Record<string, number>>(() => {
    if (!property?.utilities) return {};
    const totals: Record<string, number> = {};
    Object.entries(property.utilities).forEach(([key, u]) => {
      const known = EXPENSE_CATEGORIES.some(
        (c) => c.key.toLowerCase() === key.toLowerCase()
      );
      const bucket = known
        ? EXPENSE_CATEGORIES.find((c) => c.key.toLowerCase() === key.toLowerCase())!.key
        : "Other";
      totals[bucket] = (totals[bucket] || 0) + (parseFloat(u.amount) || 0);
    });
    return totals;
  }, [property]);

  const pieData = useMemo(() => {
    const slices = [
      ...EXPENSE_CATEGORIES.map((cat) => ({
        value: utilitySlices[cat.key] || 0,
        color: cat.color,
        text:
          expense > 0
            ? `${(((utilitySlices[cat.key] || 0) / expense) * 100).toFixed(0)}%`
            : "0%",
      })),
      {
        value: maintTotal,
        color: MAINTENANCE_COLOR,
        text: expense > 0 ? `${((maintTotal / expense) * 100).toFixed(0)}%` : "0%",
      },
    ];
    return slices.filter((s) => s.value > 0);
  }, [utilitySlices, maintTotal, expense]);

  const annualNOI = (income - utilityTotal) * 12 - maintTotal;
  const capRate =
    property?.value && property.value > 0 ? (annualNOI / property.value) * 100 : null;
  const cashOnCash =
    property?.downPayment && property.downPayment > 0
      ? (annualNOI / property.downPayment) * 100
      : null;

  return (
    <View style={styles.root}>
      <Image source={require("../assets/login-bg.png")} style={styles.bgImage} resizeMode="cover" />
      <View style={styles.bgOverlay} />

      <SafeAreaView style={{ flex: 1 }}>
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#4F8DFF" />
          </View>
        ) : notFound || !property ? (
          <View style={styles.loadingContainer}>
            <Text style={styles.notFound}>Property not found.</Text>
            <TouchableOpacity
              style={styles.backToInsights}
              onPress={() => router.replace("/insights")}
            >
              <Text style={styles.backToInsightsText}>Back to Insights</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
            {/* HEADER */}
            <View style={styles.header}>
              <TouchableOpacity
                onPress={() => (router.canGoBack() ? router.back() : router.replace("/insights"))}
                style={styles.backBtn}
              >
                <Feather name="chevron-left" size={22} color="#fff" />
              </TouchableOpacity>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {property.propertyName}
                </Text>
                <Text style={styles.headerSub} numberOfLines={1}>
                  {property.address || property.propertyType || ""}
                </Text>
              </View>
              <View style={[styles.marginPill, { backgroundColor: `${netColor}1A` }]}>
                <Text style={[styles.marginPillText, { color: netColor }]}>
                  {margin.toFixed(0)}%
                </Text>
              </View>
            </View>

            {/* SUMMARY STATS */}
            <View style={styles.statRow}>
              <View style={styles.statCard}>
                <Text style={styles.statLabel}>Income</Text>
                <Text style={[styles.statValue, { color: "#3B82F6" }]}>{currency(income)}</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statLabel}>Expense</Text>
                <Text style={[styles.statValue, { color: "#EF4444" }]}>{currency(expense)}</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statLabel}>Net</Text>
                <Text style={[styles.statValue, { color: netColor }]}>{currency(net)}</Text>
              </View>
            </View>

            {/* INCOME VS EXPENSE */}
            <View style={styles.chartCard}>
              <Text style={styles.chartTitle}>Income vs Expense</Text>
              <View style={styles.legendRow}>
                <View style={{ flexDirection: "row", alignItems: "center", marginRight: 18 }}>
                  <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: "#3B82F6", marginRight: 6 }} />
                  <Text style={{ color: "#94A3B8", fontSize: 12 }}>Income</Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: "#EF4444", marginRight: 6 }} />
                  <Text style={{ color: "#94A3B8", fontSize: 12 }}>Expense</Text>
                </View>
              </View>
              <BarChart
                data={[
                  { value: income, label: "Income", frontColor: "#3B82F6" },
                  { value: expense, label: "Expense", frontColor: "#EF4444" },
                ]}
                height={180}
                barWidth={44}
                barBorderRadius={6}
                spacing={40}
                initialSpacing={30}
                yAxisTextStyle={{ color: "#94A3B8", fontSize: 11 }}
                xAxisLabelTextStyle={{ color: "#94A3B8", fontSize: 11 }}
                xAxisColor="rgba(59,130,246,0.15)"
                yAxisColor="rgba(59,130,246,0.15)"
                noOfSections={4}
                isAnimated
              />
              <View style={styles.roiRow}>
                <Text style={styles.roiText}>
                  Cap Rate: {capRate !== null ? `${capRate.toFixed(1)}%` : "—"}
                </Text>
                <Text style={styles.roiText}>
                  Cash-on-Cash: {cashOnCash !== null ? `${cashOnCash.toFixed(1)}%` : "—"}
                </Text>
              </View>
            </View>

            {/* EXPENSE BREAKDOWN */}
            <View style={styles.chartCard}>
              <Text style={styles.chartTitle}>Expense Breakdown</Text>
              {pieData.length === 0 ? (
                <Text style={styles.emptyText}>No expenses recorded.</Text>
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <PieChart
                    data={pieData}
                    radius={70}
                    donut
                    showText
                    textColor="#fff"
                    textSize={11}
                    showTextBackground
                    textBackgroundColor="rgba(0,0,0,0.5)"
                    textBackgroundRadius={6}
                    strokeColor="rgba(255,255,255,0.08)"
                    strokeWidth={2}
                    innerRadius={30}
                    isAnimated
                    centerLabelComponent={() => (
                      <View style={{ alignItems: "center" }}>
                        <Text style={styles.pieCenterValue}>{currency(expense)}</Text>
                        <Text style={styles.pieCenterLabel}>Total</Text>
                      </View>
                    )}
                  />
                  <View style={{ flex: 1, marginLeft: 16 }}>
                    {EXPENSE_CATEGORIES.map((cat) =>
                      utilitySlices[cat.key] > 0 ? (
                        <View key={cat.key} style={styles.pieLegendItem}>
                          <View style={[styles.legendColor, { backgroundColor: cat.color }]} />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.legendTitle}>{cat.key}</Text>
                            <Text style={styles.legendValue}>{currency(utilitySlices[cat.key])}</Text>
                          </View>
                        </View>
                      ) : null
                    )}
                    {maintTotal > 0 && (
                      <View style={styles.pieLegendItem}>
                        <View style={[styles.legendColor, { backgroundColor: MAINTENANCE_COLOR }]} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.legendTitle}>Maintenance</Text>
                          <Text style={styles.legendValue}>{currency(maintTotal)}</Text>
                        </View>
                      </View>
                    )}
                  </View>
                </View>
              )}
            </View>

            {/* UTILITIES */}
            <View style={styles.chartCard}>
              <Text style={styles.chartTitle}>Utilities · {currency(utilityTotal)}/mo</Text>
              {!property.utilities || Object.keys(property.utilities).length === 0 ? (
                <Text style={styles.emptyText}>No utilities added.</Text>
              ) : (
                Object.entries(property.utilities).map(([key, u]) => {
                  const meta =
                    EXPENSE_CATEGORIES.find((c) => c.key.toLowerCase() === key.toLowerCase()) || {
                      color: "#94A3B8",
                      icon: "zap" as const,
                    };
                  return (
                    <View key={key} style={styles.utilRow}>
                      <View style={[styles.rowIcon, { backgroundColor: `${meta.color}1A` }]}>
                        <Feather name={meta.icon} size={16} color={meta.color} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.propertyName}>{key}</Text>
                        <Text style={styles.propertyAddress}>
                          {(u.provider || "No provider") + " · " + formatDueDay(u.dueDay)}
                        </Text>
                      </View>
                      <Text style={styles.utilAmount}>${u.amount}</Text>
                    </View>
                  );
                })
              )}
            </View>

            {/* MAINTENANCE */}
            <View style={styles.chartCard}>
              <Text style={styles.chartTitle}>Maintenance · {currency(maintTotal)}</Text>
              {maintenance.length === 0 ? (
                <Text style={styles.emptyText}>No maintenance records.</Text>
              ) : (
                maintenance.map((m) => (
                  <View key={m.id} style={styles.utilRow}>
                    <View
                      style={[
                        styles.rowIcon,
                        {
                          backgroundColor:
                            m.status === "done"
                              ? "rgba(34,197,94,.15)"
                              : "rgba(245,158,11,.15)",
                        },
                      ]}
                    >
                      <Feather
                        name={m.status === "done" ? "check-circle" : "tool"}
                        size={16}
                        color={m.status === "done" ? "#22C55E" : "#F59E0B"}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.propertyName} numberOfLines={1}>
                        {m.title || "Maintenance"}
                      </Text>
                      <Text style={styles.propertyAddress}>
                        {[formatDate(m.date), m.status === "done" ? "Done" : "Pending"]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                    <Text style={styles.utilAmount}>{currency(m.cost || 0)}</Text>
                  </View>
                ))
              )}
            </View>
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#060D1C" },
  bgImage: { position: "absolute", width: "100%", height: "100%" },
  bgOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(5,10,20,0.78)" },
  scrollContent: { padding: 16, paddingBottom: 60, gap: 14 },
  loadingContainer: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  notFound: { color: "#94A3B8", fontSize: 15, fontWeight: "700" },
  backToInsights: { backgroundColor: "rgba(59,130,246,.15)", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  backToInsightsText: { color: "#60A5FA", fontWeight: "800" },

  header: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  backBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },
  headerTitle: { color: "#FFF", fontSize: 22, fontWeight: "900" },
  headerSub: { color: "#94A3B8", fontSize: 12, marginTop: 2 },
  marginPill: { backgroundColor: "rgba(34,197,94,.15)", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10 },
  marginPillText: { color: "#22C55E", fontWeight: "700", fontSize: 12 },

  statRow: { flexDirection: "row", gap: 12 },
  statCard: { flex: 1, backgroundColor: "rgba(12,24,46,.96)", borderRadius: 18, padding: 14, borderWidth: 1, borderColor: "rgba(59,130,246,.15)" },
  statLabel: { color: "#64748B", fontSize: 11, fontWeight: "700" },
  statValue: { fontSize: 18, fontWeight: "900", marginTop: 4 },

  chartCard: { backgroundColor: "rgba(12,24,46,.96)", borderRadius: 24, padding: 20, borderWidth: 1, borderColor: "rgba(59,130,246,.15)" },
  chartTitle: { color: "#FFFFFF", fontSize: 18, fontWeight: "800", marginBottom: 14 },
  legendRow: { flexDirection: "row", marginBottom: 14 },
  roiRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 14 },
  roiText: { color: "#94A3B8", fontSize: 13, fontWeight: "700" },

  pieCenterValue: { color: "#FFFFFF", fontWeight: "900", fontSize: 15 },
  pieCenterLabel: { color: "#94A3B8", fontSize: 11 },
  pieLegendItem: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  legendColor: { width: 12, height: 12, borderRadius: 6, marginRight: 10 },
  legendTitle: { color: "#FFFFFF", fontWeight: "700", fontSize: 13 },
  legendValue: { color: "#94A3B8", marginTop: 1, fontSize: 12 },

  utilRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,.05)" },
  rowIcon: { width: 34, height: 34, borderRadius: 12, backgroundColor: "rgba(34,197,94,.15)", justifyContent: "center", alignItems: "center", marginRight: 12 },
  propertyName: { color: "#FFFFFF", fontWeight: "700", fontSize: 14 },
  propertyAddress: { color: "#94A3B8", marginTop: 2, fontSize: 12 },
  utilAmount: { color: "#FFFFFF", fontWeight: "800", fontSize: 14 },
  emptyText: { color: "#64748B", fontSize: 13, paddingVertical: 8 },
});
