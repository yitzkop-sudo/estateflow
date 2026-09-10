import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { auth } from "../lib/firebase";
import { openExternalUrl } from "../lib/openExternal";
import { setPendingUtilityLink } from "../lib/pendingUtilityLink";
import {
  getUtilitySubscriptionStatus,
  linkUtilityToProperty,
  openAuthForm,
  startUtilitySubscription,
  type UtilitySubStatus,
} from "../lib/utilityapi";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

const UTILITY_KEYS = ["Electric", "Water", "Gas", "Oil", "Sewer", "Trash"] as const;
type UtilityKey = (typeof UTILITY_KEYS)[number];

export default function ConnectUtility() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const [utilityKey, setUtilityKey] = useState<UtilityKey>(
    typeof params.utilityKey === "string" && (UTILITY_KEYS as readonly string[]).includes(params.utilityKey)
      ? (params.utilityKey as UtilityKey)
      : "Electric"
  );
  const [subStatus, setSubStatus] = useState<UtilitySubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [paidPending, setPaidPending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [formUid, setFormUid] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await getUtilitySubscriptionStatus();
      setSubStatus(s);
      return s;
    } catch (e: any) {
      Alert.alert("Couldn't load subscription", e?.message || "Check your connection and try again.");
      return null;
    }
  }, []);

  useEffect(() => {
    const user = auth.currentUser;
    if (!user) {
      router.replace("/login");
      return;
    }
    loadStatus().finally(() => setLoading(false));
  }, [loadStatus, router]);

  const handlePay = async () => {
    setPaying(true);
    setError(null);
    try {
      let alreadyActive = false;
      const opened = await openExternalUrl(async () => {
        const res = await startUtilitySubscription();
        alreadyActive = res.alreadyActive;
        // Already subscribed → nothing to open, just refresh status.
        if (alreadyActive) return "";
        return res.url;
      });
      if (alreadyActive) {
        await loadStatus();
        return;
      }
      if (!opened) {
        setError("The checkout tab was blocked. Allow popups for this site and try again.");
        return;
      }
      // User paid (or cancelled) in the browser — they confirm, we re-check.
      setPaidPending(true);
    } catch (e: any) {
      const msg = `${e?.name || "Error"}: ${e?.message || e || "Could not start the checkout."} (platform: ${Platform.OS})`;
      console.warn("Checkout failed:", JSON.stringify({ name: e?.name, message: e?.message, stack: e?.stack?.split("\n").slice(0, 4) }));
      setError(msg);
      Alert.alert("Checkout failed", msg);
    } finally {
      setPaying(false);
    }
  };

  const handlePaidDone = async () => {
    setPaying(true);
    try {
      const s = await loadStatus();
      if (s?.active) {
        setPaidPending(false);
        Alert.alert("Subscribed", "Auto-sync is on. Now connect your provider below.");
      } else {
        Alert.alert("Not active yet", "We couldn't see an active subscription. If you just paid, wait a moment and try again.");
      }
    } finally {
      setPaying(false);
    }
  };

  const handleManage = async () => {
    setError(null);
    try {
      const opened = await openExternalUrl(async () => {
        if (subStatus?.portalUrl) return subStatus.portalUrl;
        const s = await loadStatus();
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

  const handleConnect = async () => {
    if (!subStatus?.active) return;
    if ((subStatus.meterLimit ?? 0) > 0 && (subStatus.linkedMeters ?? 0) >= (subStatus.meterLimit ?? 0)) {
      Alert.alert("Meter limit reached", "Remove a linked utility or manage your plan to add capacity.");
      return;
    }
    setConnecting(true);
    setError(null);
    setStatusMsg("Opening your utility provider to authorize access...");
    let waitingForSignIn = false;
    try {
      const opened = await openExternalUrl(async () => {
        const form = await openAuthForm();
        setFormUid(form.formUid);
        return form.url;
      });
      if (!opened) {
        setError("The provider tab was blocked. Allow popups for this site and try again.");
        return;
      }
      waitingForSignIn = true;
      setStatusMsg("Complete the sign-in in your browser, then come back here...");
      setAuthPending(true);
    } catch (e: any) {
      const msg = e?.message || "Could not connect to the provider.";
      setError(msg);
      Alert.alert("Connection failed", msg);
    } finally {
      setConnecting(false);
      if (!waitingForSignIn) setStatusMsg("");
    }
  };

  const handleFinishLinking = async () => {
    if (!formUid) return;
    setConnecting(true);
    setStatusMsg("Pulling your latest bill from the provider...");
    try {
      const data = await linkUtilityToProperty(formUid);
      setPendingUtilityLink({
        key: utilityKey,
        amount: data.amount,
        provider: data.provider,
        dueDay: data.dueDay,
        meterUid: data.meterUid,
      });
      router.back();
      Alert.alert("Connected", `${utilityKey} bill auto-filled from ${data.provider}: $${data.amount}.`);
    } catch (e: any) {
      const msg = e?.message || "Could not pull the bill. Try again.";
      setError(msg);
      Alert.alert("Linking failed", msg);
    } finally {
      setConnecting(false);
      setStatusMsg("");
      setAuthPending(false);
    }
  };

  const atMeterCap =
    (subStatus?.meterLimit ?? 0) > 0 &&
    (subStatus?.linkedMeters ?? 0) >= (subStatus?.meterLimit ?? 0);

  return (
    <SafeAreaView style={styles.container}>
      <Image source={require("../assets/login-bg.png")} style={styles.backgroundImage} resizeMode="cover" />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(5,10,20,0.78)" }]} />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.headerContainer}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <TouchableOpacity
              onPress={() => (router.canGoBack() ? router.back() : router.replace("/add-property"))}
              style={styles.backBtn}
            >
              <Feather name="arrow-left" size={SCREEN_WIDTH < 400 ? 20 : 24} color="white" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Connect Provider</Text>
          </View>
          <Text style={styles.headerSubtitle}>Link your utility account so bills sync automatically.</Text>
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
            {/* ── Pick utility ── */}
            <View style={styles.cardSection}>
              <Text style={styles.sectionTitle}>Which utility?</Text>
              <View style={styles.chipRow}>
                {UTILITY_KEYS.map((key) => {
                  const selected = utilityKey === key;
                  return (
                    <TouchableOpacity
                      key={key}
                      style={[styles.chip, selected && styles.chipActive]}
                      onPress={() => setUtilityKey(key)}
                    >
                      <Text style={[styles.chipText, selected && styles.chipTextActive]}>{key}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* ── Pricing / paywall ── */}
            {!subStatus?.active ? (
              <View style={styles.cardSection}>
                <View style={styles.priceHeaderRow}>
                  <View style={styles.priceIcon}>
                    <Feather name="zap" size={20} color="#34D399" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sectionTitle}>Auto-sync billing</Text>
                    <Text style={styles.sectionSubtitle}>Pay per meter. No base plan.</Text>
                  </View>
                </View>
                <View style={styles.priceRow}>
                  <Text style={styles.priceLabel}>Each connected meter</Text>
                  <Text style={styles.priceValue}>$20.00/mo</Text>
                </View>
                <Text style={styles.finePrint}>
                  Connecting {utilityKey} adds one meter at $20/mo — that's all you pay. Bills pull straight from your provider each month. Prefer free? Enter bills manually from the previous screen instead.
                </Text>
                <TouchableOpacity
                  style={[styles.payButton, paying && { opacity: 0.7 }]}
                  onPress={handlePay}
                  disabled={paying}
                >
                  {paying ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Feather name="lock" size={16} color="#FFFFFF" style={{ marginRight: 8 }} />
                      <Text style={styles.payButtonText}>Pay $20/meter & Continue</Text>
                    </>
                  )}
                </TouchableOpacity>
                {paidPending ? (
                  <TouchableOpacity
                    style={[styles.checkButton, paying && { opacity: 0.7 }]}
                    onPress={handlePaidDone}
                    disabled={paying}
                  >
                    <Feather name="check-circle" size={16} color="#FFFFFF" style={{ marginRight: 8 }} />
                    <Text style={styles.payButtonText}>I've completed payment</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : (
              <View style={styles.cardSection}>
                <View style={[styles.activeBanner, atMeterCap && styles.capBanner]}>
                  <Feather name={atMeterCap ? "alert-triangle" : "check-circle"} size={16} color={atMeterCap ? "#FBBF24" : "#34D399"} />
                  <Text style={[styles.activeBannerText, atMeterCap && { color: "#FCD34D" }]}>
                    {atMeterCap
                      ? `Meter limit reached (${subStatus.linkedMeters}/${subStatus.meterLimit}).`
                      : `Auto-sync is on (${subStatus.linkedMeters}/${subStatus.meterLimit} meters). Each new connection bills $20/mo.`}
                  </Text>
                </View>
                {connecting && statusMsg ? (
                  <View style={styles.statusRow}>
                    <ActivityIndicator size="small" color="#34D399" />
                    <Text style={styles.statusText}>{statusMsg}</Text>
                  </View>
                ) : null}
                {!authPending ? (
                  <TouchableOpacity
                    style={[styles.payButton, (connecting || atMeterCap) && { opacity: 0.6 }]}
                    onPress={handleConnect}
                    disabled={connecting || atMeterCap}
                  >
                    {connecting ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <>
                        <Feather name="link" size={16} color="#FFFFFF" style={{ marginRight: 8 }} />
                        <Text style={styles.payButtonText}>Connect {utilityKey} Provider</Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[styles.checkButton, connecting && { opacity: 0.6 }]}
                    onPress={handleFinishLinking}
                    disabled={connecting}
                  >
                    {connecting ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <>
                        <Feather name="check" size={16} color="#FFFFFF" style={{ marginRight: 8 }} />
                        <Text style={styles.payButtonText}>I've signed in — Finish linking</Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.manageButton} onPress={handleManage}>
                  <Text style={styles.manageButtonText}>Manage subscription</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#060D1C", position: "relative" },
  backgroundImage: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, width: "100%", height: "100%" },
  scrollContent: { padding: SCREEN_WIDTH < 400 ? 16 : 20, gap: 14 },
  headerContainer: { marginBottom: 4 },
  backBtn: { backgroundColor: "#1E293B", padding: SCREEN_WIDTH < 400 ? 8 : 10, borderRadius: SCREEN_WIDTH < 400 ? 8 : 10, marginRight: 12 },
  headerTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 24 : 28, fontWeight: "900", letterSpacing: 0.5 },
  headerSubtitle: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, marginTop: 8, lineHeight: 18 },
  errorBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(239,68,68,0.10)", borderRadius: 14, padding: 12, borderWidth: 1, borderColor: "rgba(239,68,68,0.30)" },
  errorText: { flex: 1, color: "#FCA5A5", fontSize: 12, fontWeight: "600", lineHeight: 17 },
  cardSection: { backgroundColor: "rgba(15,23,42,0.9)", borderRadius: 28, padding: SCREEN_WIDTH < 400 ? 16 : 20, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },
  sectionTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 16 : 18, fontWeight: "900", marginBottom: 4 },
  sectionSubtitle: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 13 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  chip: { backgroundColor: "rgba(30,41,59,0.65)", borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  chipActive: { backgroundColor: "rgba(37,99,235,0.95)", borderColor: "rgba(59,130,246,0.35)" },
  chipText: { color: "#94A3B8", fontSize: 13, fontWeight: "700" },
  chipTextActive: { color: "#FFFFFF" },
  priceHeaderRow: { flexDirection: "row", alignItems: "center", marginBottom: 16 },
  priceIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(52,211,153,0.14)", alignItems: "center", justifyContent: "center", marginRight: 12, borderWidth: 1, borderColor: "rgba(52,211,153,0.22)" },
  priceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(30,41,59,0.65)", padding: 14, borderRadius: 16, marginBottom: 8, borderWidth: 1, borderColor: "rgba(59,130,246,0.10)" },
  priceLabel: { color: "#CBD5E1", fontSize: 14, fontWeight: "600" },
  priceValue: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  finePrint: { color: "#64748B", fontSize: 12, lineHeight: 17, marginVertical: 8 },
  payButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#10B981", padding: 14, borderRadius: 16, marginTop: 8 },
  payButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  checkButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#3B82F6", padding: 14, borderRadius: 16, marginTop: 8 },
  manageButton: { alignItems: "center", padding: 12, marginTop: 4 },
  manageButtonText: { color: "#60A5FA", fontSize: 13, fontWeight: "700" },
  activeBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(52,211,153,0.08)", borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: "rgba(52,211,153,0.25)" },
  capBanner: { borderColor: "rgba(251,191,36,0.3)", backgroundColor: "rgba(251,191,36,0.08)" },
  activeBannerText: { flex: 1, color: "#6EE7B7", fontSize: 12, fontWeight: "600", lineHeight: 17 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(59,130,246,0.08)", borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: "rgba(59,130,246,0.2)" },
  statusText: { flex: 1, color: "#93C5FD", fontSize: 12, fontWeight: "600" },
});
