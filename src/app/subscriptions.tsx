import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { auth } from "../lib/firebase";
import { openExternalUrl } from "../lib/openExternal";
import {
  cancelUtilitySubscription,
  confirmUtilitySubscription,
  getUtilitySubscriptionStatus,
  reconcileUtilitySubscriptions,
  startUtilitySubscription,
  type UtilitySubStatus,
} from "../lib/utilityapi";

/**
 * MANAGE SUBSCRIPTIONS — reachable from the navigation drawer.
 * One $20/mo subscription per utility key: shows each key's status,
 * lets users subscribe uncovered keys (Stripe checkout), and opens the
 * Stripe billing portal to manage/cancel existing ones.
 */

const { width: SCREEN_WIDTH } = Dimensions.get("window");

const UTILITY_KEYS = ["Electric", "Water", "Gas", "Oil", "Sewer", "Trash"] as const;
type UtilityKey = (typeof UTILITY_KEYS)[number];

const UTILITY_META: Record<UtilityKey, { icon: React.ComponentProps<typeof Feather>["name"]; color: string }> = {
  Electric: { icon: "zap", color: "#A78BFA" },
  Water: { icon: "droplet", color: "#60A5FA" },
  Gas: { icon: "wind", color: "#34D399" },
  Oil: { icon: "droplet", color: "#FB923C" },
  Sewer: { icon: "layers", color: "#2DD4BF" },
  Trash: { icon: "trash-2", color: "#78716C" },
};

export default function Subscriptions() {
  const router = useRouter();
  const [subStatus, setSubStatus] = useState<UtilitySubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payingKey, setPayingKey] = useState<UtilityKey | null>(null);
  const [paidPendingKey, setPaidPendingKey] = useState<UtilityKey | null>(null);
  const [cancellingKey, setCancellingKey] = useState<UtilityKey | null>(null);

  const handleCancel = async (key: UtilityKey, resume: boolean) => {
    setCancellingKey(key);
    setError(null);
    try {
      await cancelUtilitySubscription(key, resume || undefined);
      await load(false);
      Alert.alert(
        resume ? "Subscription kept" : "Subscription canceled",
        resume
          ? `${key} stays covered at $20/mo.`
          : `${key} stays covered until the paid-through date, then stops. Linked meters keep working until then.`
      );
    } catch (e: any) {
      const msg = e?.message || "Could not update the subscription.";
      setError(msg);
      Alert.alert("Billing", msg);
    } finally {
      setCancellingKey(null);
    }
  };

  const confirmCancel = (key: UtilityKey) => {
    Alert.alert(
      `Cancel ${key}?`,
      "Access runs to the paid-through date, then this utility stops syncing. You can resubscribe anytime.",
      [
        { text: "Keep it", style: "cancel" },
        { text: "Cancel subscription", style: "destructive", onPress: () => handleCancel(key, false) },
      ]
    );
  };
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPaidPendingKey(null);
  }, []);

  useEffect(() => () => stopPoll(), [stopPoll]);

  // Reconcile (verify against Stripe) on open/refresh so ghost "active"
  // records from missed webhooks can't linger; fall back to plain status.
  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      setSubStatus(await reconcileUtilitySubscriptions());
    } catch (e: any) {
      try {
        setSubStatus(await getUtilitySubscriptionStatus());
      } catch (e2: any) {
        setError(e2?.message || e?.message || "Could not load subscriptions.");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!auth.currentUser) {
      router.replace("/login");
      return;
    }
    load();
  }, [load, router]);

  // Strict: without the per-key map we know nothing per key, so nothing
  // shows covered (the server is the source of truth on every action).
  const covered = useCallback(
    (key: string) => !!subStatus?.subscriptions?.[key]?.active,
    [subStatus]
  );

  const coveredCount = UTILITY_KEYS.filter((k) => covered(k)).length;

  // Watch a just-paid key until Stripe confirms it, then reload the list.
  const startPayPoll = useCallback(
    (key: UtilityKey) => {
      stopPoll();
      let tries = 0;
      let consecutiveErrors = 0;
      pollRef.current = setInterval(async () => {
        tries += 1;
        try {
          const c = await confirmUtilitySubscription(undefined, key);
          consecutiveErrors = 0;
          if (c?.active) {
            stopPoll();
            await load(false);
            Alert.alert("Subscribed", `${key} is now covered at $20/mo.`);
            return;
          }
        } catch {
          consecutiveErrors += 1;
          if (consecutiveErrors >= 3) {
            stopPoll();
            setError("Could not confirm the payment. Pull to refresh or try again.");
            return;
          }
        }
        if (tries >= 60) stopPoll();
      }, 5000);
    },
    [load, stopPoll]
  );

  const handleSubscribe = async (key: UtilityKey) => {
    setPayingKey(key);
    setError(null);
    try {
      let alreadyActive = false;
      const opened = await openExternalUrl(async () => {
        const res = await startUtilitySubscription(key);
        alreadyActive = res.alreadyActive;
        if (alreadyActive) return "";
        return res.url;
      });
      if (alreadyActive) {
        await load(false);
        return;
      }
      if (!opened) {
        setError("The checkout tab was blocked. Allow popups for this site and try again.");
        return;
      }
      setPaidPendingKey(key);
      startPayPoll(key);
    } catch (e: any) {
      const msg = `${e?.name || "Error"}: ${e?.message || e || "Could not start the checkout."}`;
      setError(msg);
      Alert.alert("Checkout failed", msg);
    } finally {
      setPayingKey(null);
    }
  };

  const handleManage = async () => {
    setError(null);
    try {
      const opened = await openExternalUrl(async () => {
        if (subStatus?.portalUrl) return subStatus.portalUrl;
        const s = await getUtilitySubscriptionStatus();
        setSubStatus(s);
        if (!s?.portalUrl) throw new Error("No billing portal link available yet.");
        return s.portalUrl;
      });
      if (!opened) setError("The tab was blocked. Allow popups for this site and try again.");
    } catch (e: any) {
      const msg = e?.message || "Could not open the billing portal.";
      setError(msg);
      Alert.alert("Billing portal", msg);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <Image source={require("../assets/login-bg.png")} style={styles.backgroundImage} resizeMode="cover" />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(5,10,20,0.78)" }]} />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(false); }} tintColor="#3B82F6" />}
      >
        <View style={styles.headerContainer}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <TouchableOpacity
              onPress={() => (router.canGoBack() ? router.back() : router.replace("/dashboard"))}
              style={styles.backBtn}
            >
              <Feather name="arrow-left" size={SCREEN_WIDTH < 400 ? 20 : 24} color="white" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Subscriptions</Text>
          </View>
          <Text style={styles.headerSubtitle}>One $20/mo subscription per utility — manage each below.</Text>
        </View>

        {error ? (
          <TouchableOpacity style={styles.errorBanner} onPress={() => setError(null)}>
            <Feather name="alert-circle" size={14} color="#F87171" />
            <Text style={styles.errorText}>{error}</Text>
          </TouchableOpacity>
        ) : null}

        {loading ? (
          <View style={styles.cardSection}>
            <ActivityIndicator size="large" color="#3B82F6" />
          </View>
        ) : (
          <>
            <View style={styles.cardSection}>
              <View style={styles.summaryRow}>
                <View style={styles.summaryIcon}>
                  <Feather name="credit-card" size={20} color="#60A5FA" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.summaryTitle}>
                    {coveredCount} of {UTILITY_KEYS.length} utilities covered
                  </Text>
                  <Text style={styles.summarySubtitle}>
                    ${(coveredCount * 20).toLocaleString()}/mo total
                    {subStatus ? ` · ${subStatus.linkedMeters}/${subStatus.meterLimit} meters linked` : ""}
                  </Text>
                </View>
              </View>
              {subStatus?.active ? (
                <TouchableOpacity style={styles.portalButton} onPress={handleManage}>
                  <Feather name="settings" size={15} color="#60A5FA" style={{ marginRight: 8 }} />
                  <Text style={styles.portalButtonText}>Manage billing (cancel, invoices)</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {UTILITY_KEYS.map((key) => {
              const meta = UTILITY_META[key];
              const isCovered = covered(key);
              const paying = payingKey === key;
              const waiting = paidPendingKey === key;
              const periodEnd = subStatus?.subscriptions?.[key]?.currentPeriodEnd;
              const cancelAtEnd = !!subStatus?.subscriptions?.[key]?.cancelAtPeriodEnd;
              const cancelling = cancellingKey === key;
              return (
                <View key={key} style={styles.cardSection}>
                  <View style={styles.utilityRow}>
                    <View style={[styles.utilityIconChip, { backgroundColor: `${meta.color}22` }]}>
                      <Feather name={meta.icon} size={18} color={meta.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.utilityLabel}>{key}</Text>
                      <Text style={[styles.statusText, isCovered && styles.statusActive]}>
                        {!isCovered
                          ? "Not subscribed"
                          : cancelAtEnd
                            ? `Cancels ${periodEnd ? new Date(periodEnd).toLocaleDateString() : "soon"} · $20/mo until then`
                            : "Active · $20/mo"}
                        {isCovered && !cancelAtEnd && periodEnd
                          ? ` · renews ${new Date(periodEnd).toLocaleDateString()}`
                          : ""}
                      </Text>
                    </View>
                    <View style={[styles.statusPill, isCovered && !cancelAtEnd ? styles.pillOn : styles.pillOff]}>
                      <Text style={[styles.pillText, isCovered && !cancelAtEnd ? styles.pillTextOn : styles.pillTextOff]}>
                        {isCovered && !cancelAtEnd ? "ON" : isCovered ? "ENDS" : "OFF"}
                      </Text>
                    </View>
                  </View>
                  {isCovered ? (
                    <TouchableOpacity
                      style={[styles.cancelButton, cancelling && { opacity: 0.6 }]}
                      onPress={() => (cancelAtEnd ? handleCancel(key, true) : confirmCancel(key))}
                      disabled={cancelling}
                    >
                      {cancelling ? (
                        <ActivityIndicator size="small" color="#F87171" />
                      ) : (
                        <Text style={styles.cancelText}>
                          {cancelAtEnd ? "Keep subscription" : "Cancel subscription"}
                        </Text>
                      )}
                    </TouchableOpacity>
                  ) : null}
                  {waiting ? (
                    <View style={styles.waitingRow}>
                      <ActivityIndicator size="small" color="#34D399" />
                      <Text style={styles.waitingText}>Confirming payment…</Text>
                    </View>
                  ) : !isCovered ? (
                    <TouchableOpacity
                      style={[styles.subscribeButton, paying && { opacity: 0.7 }]}
                      onPress={() => handleSubscribe(key)}
                      disabled={paying}
                    >
                      {paying ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <>
                          <Feather name="lock" size={15} color="#FFFFFF" style={{ marginRight: 8 }} />
                          <Text style={styles.subscribeText}>Subscribe · $20/mo</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })}

            <Text style={styles.finePrint}>
              Cancel anytime from billing management — already-linked meters keep their last synced data, and you can always enter bills manually for free.
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#060D1C", position: "relative" },
  backgroundImage: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, width: "100%", height: "100%" },
  scrollContent: { padding: SCREEN_WIDTH < 400 ? 16 : 20, gap: 14, paddingBottom: 40 },
  headerContainer: { marginBottom: 4 },
  backBtn: { backgroundColor: "#1E293B", padding: SCREEN_WIDTH < 400 ? 8 : 10, borderRadius: SCREEN_WIDTH < 400 ? 8 : 10, marginRight: 12 },
  headerTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 24 : 28, fontWeight: "900", letterSpacing: 0.5 },
  headerSubtitle: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, marginTop: 8, lineHeight: 18 },
  errorBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(239,68,68,0.10)", borderRadius: 14, padding: 12, borderWidth: 1, borderColor: "rgba(239,68,68,0.30)" },
  errorText: { flex: 1, color: "#FCA5A5", fontSize: 12, fontWeight: "600", lineHeight: 17 },
  cardSection: { backgroundColor: "rgba(15,23,42,0.9)", borderRadius: 22, padding: SCREEN_WIDTH < 400 ? 14 : 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  summaryIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(59,130,246,0.14)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(59,130,246,0.22)" },
  summaryTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 15 : 17, fontWeight: "900" },
  summarySubtitle: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, fontWeight: "600", marginTop: 2 },
  portalButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", marginTop: 12, padding: 12, borderRadius: 14, backgroundColor: "rgba(59,130,246,0.10)", borderWidth: 1, borderColor: "rgba(59,130,246,0.25)" },
  portalButtonText: { color: "#60A5FA", fontSize: 13, fontWeight: "800" },
  utilityRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  utilityIconChip: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  utilityLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  statusText: { color: "#64748B", fontSize: 12, fontWeight: "600", marginTop: 2 },
  statusActive: { color: "#6EE7B7" },
  statusPill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
  pillOn: { backgroundColor: "rgba(16,185,129,0.15)", borderColor: "rgba(16,185,129,0.4)" },
  pillOff: { backgroundColor: "rgba(71,85,105,0.25)", borderColor: "rgba(71,85,105,0.5)" },
  pillText: { fontSize: 11, fontWeight: "900" },
  pillTextOn: { color: "#34D399" },
  pillTextOff: { color: "#94A3B8" },
  cancelButton: { alignItems: "center", justifyContent: "center", padding: 11, borderRadius: 14, marginTop: 12, backgroundColor: "rgba(239,68,68,0.08)", borderWidth: 1, borderColor: "rgba(239,68,68,0.30)" },
  cancelText: { color: "#F87171", fontSize: 13, fontWeight: "800" },
  subscribeButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#10B981", padding: 13, borderRadius: 14, marginTop: 12 },
  subscribeText: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
  waitingRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(52,211,153,0.08)", borderRadius: 14, padding: 12, marginTop: 12, borderWidth: 1, borderColor: "rgba(52,211,153,0.25)" },
  waitingText: { flex: 1, color: "#6EE7B7", fontSize: 12, fontWeight: "600" },
  finePrint: { color: "#64748B", fontSize: 12, lineHeight: 17, textAlign: "center", paddingHorizontal: 8 },
});
