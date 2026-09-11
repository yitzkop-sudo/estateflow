import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { auth } from "../lib/firebase";
import { openExternalUrl } from "../lib/openExternal";
import { setPendingUtilityLink } from "../lib/pendingUtilityLink";
import {
  getAuthFormStatus,
  getSupportedUtilities,
  getUtilitySubscriptionStatus,
  linkUtilityToProperty,
  openAuthForm,
  startUtilitySubscription,
  type SupportedUtility,
  type UtilitySubStatus,
} from "../lib/utilityapi";

/** Strip HTML error pages down to a short readable line (stale backends return HTML). */
const cleanError = (e: any, fallback: string) => {
  const raw = String(e?.message || e || fallback);
  const noHtml = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const short = noHtml.length > 140 ? `${noHtml.slice(0, 140)}…` : noHtml;
  return short || fallback;
};

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
  const [providers, setProviders] = useState<SupportedUtility[] | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [providerQuery, setProviderQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<SupportedUtility | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const linkingRef = useRef(false);
  const formUidRef = useRef<string | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Never leave a poll running after leaving the screen.
  useEffect(() => () => stopPoll(), [stopPoll]);

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProvidersError(null);
    try {
      setProviders(await getSupportedUtilities());
    } catch (e: any) {
      console.warn("Provider catalog failed:", e);
      setProvidersError(cleanError(e, "Could not load the provider list."));
    } finally {
      setProvidersLoading(false);
    }
  }, []);

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
    // Provider catalog loads independently — no subscription needed to browse.
    loadProviders();
  }, [loadStatus, loadProviders, router]);

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
      // One continuous flow: watch for the payment in the background and
      // auto-advance to step 4. The manual button below is just a fallback.
      setPaidPending(true);
      startPayPoll();
    } catch (e: any) {
      const msg = `${e?.name || "Error"}: ${e?.message || e || "Could not start the checkout."} (platform: ${Platform.OS})`;
      console.warn("Checkout failed:", JSON.stringify({ name: e?.name, message: e?.message, stack: e?.stack?.split("\n").slice(0, 4) }));
      setError(msg);
      Alert.alert("Checkout failed", msg);
    } finally {
      setPaying(false);
    }
  };

  // Poll for the new subscription so paying flows straight into step 4
  // with no manual "I've paid" tap (leaves after ~5 min or on unmount).
  const startPayPoll = useCallback(() => {
    stopPoll();
    let tries = 0;
    pollRef.current = setInterval(async () => {
      tries += 1;
      try {
        const s = await getUtilitySubscriptionStatus();
        setSubStatus(s);
        if (s?.active) {
          stopPoll();
          setPaidPending(false);
          Alert.alert("Payment confirmed", "Auto-sync is on. Continue to step 4 to authorize.");
          return;
        }
      } catch {
        // keep polling through transient failures
      }
      if (tries >= 60) stopPoll();
    }, 5000);
  }, [stopPoll]);

  const handlePaidDone = async () => {
    setPaying(true);
    try {
      const s = await loadStatus();
      if (s?.active) {
        stopPoll();
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
    if (!subStatus?.active) {
      Alert.alert("Pay first", "Complete the $20/meter payment in step 3, then come back here to authorize.");
      return;
    }
    if ((subStatus.meterLimit ?? 0) > 0 && (subStatus.linkedMeters ?? 0) >= (subStatus.meterLimit ?? 0)) {
      Alert.alert("Meter limit reached", "Remove a linked utility or manage your plan to add capacity.");
      return;
    }
    setConnecting(true);
    setError(null);
    setStatusMsg(
      selectedProvider
        ? `Opening ${selectedProvider.name} to authorize access...`
        : "Opening your utility provider to authorize access..."
    );
    let waitingForSignIn = false;
    try {
      const opened = await openExternalUrl(async () => {
        const form = await openAuthForm(selectedProvider?.uid);
        formUidRef.current = form.formUid;
        setFormUid(form.formUid);
        return form.url;
      });
      if (!opened) {
        setError("The provider tab was blocked. Allow popups for this site and try again.");
        return;
      }
      waitingForSignIn = true;
      setStatusMsg("Complete the sign-in in the tab that just opened — this screen finishes itself when you're done.");
      setAuthPending(true);
      startAuthPoll(formUidRef.current);
    } catch (e: any) {
      const msg = e?.message || "Could not connect to the provider.";
      setError(msg);
      Alert.alert("Connection failed", msg);
    } finally {
      setConnecting(false);
      if (!waitingForSignIn) setStatusMsg("");
    }
  };

  // Poll for the finished sign-in so linking completes itself — the manual
  // "Finish linking" button below is just a fallback (leaves after ~5 min).
  const startAuthPoll = useCallback(
    (uid: string | null) => {
      if (!uid) return;
      stopPoll();
      let tries = 0;
      pollRef.current = setInterval(async () => {
        tries += 1;
        try {
          const st = await getAuthFormStatus(uid);
          if (st?.completed) {
            stopPoll();
            await runFinishLinking(uid);
            return;
          }
        } catch {
          // keep polling through transient failures (e.g. slow webhook)
        }
        if (tries >= 60) stopPoll();
      }, 5000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stopPoll]
  );

  const runFinishLinking = async (uid: string | null) => {
    if (!uid || linkingRef.current) return;
    linkingRef.current = true;
    setConnecting(true);
    setStatusMsg("Pulling your latest bill from the provider...");
    try {
      const data = await linkUtilityToProperty(uid);
      stopPoll();
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
      linkingRef.current = false;
    }
  };

  const handleFinishLinking = async () => {
    await runFinishLinking(formUidRef.current ?? formUid);
  };

  const atMeterCap =
    (subStatus?.meterLimit ?? 0) > 0 &&
    (subStatus?.linkedMeters ?? 0) >= (subStatus?.meterLimit ?? 0);

  const stepLabels = ["Utility", "Provider", "Pay", "Authorize"];
  const stepIndex = !selectedProvider ? 1 : !subStatus?.active ? 2 : 3;

  const providerQueryNorm = providerQuery.trim().toLowerCase();
  const filteredProviders = (providers || [])
    .filter(
      (p) =>
        !providerQueryNorm ||
        p.name.toLowerCase().includes(providerQueryNorm) ||
        p.uid.toLowerCase().includes(providerQueryNorm)
    )
    .slice(0, 60);

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
          <Text style={styles.headerSubtitle}>Pick your provider, pay per meter, then sign in — the bill lands in the app.</Text>
        </View>

        <View style={styles.stepper}>
          {stepLabels.map((label, i) => {
            const done = i < stepIndex;
            const now = i === stepIndex;
            return (
              <View key={label} style={styles.stepItem}>
                <View style={[styles.stepDot, done && styles.stepDotDone, now && styles.stepDotNow]}>
                  {done ? (
                    <Feather name="check" size={10} color="#FFFFFF" />
                  ) : (
                    <Text style={[styles.stepNum, now && styles.stepNumNow]}>{i + 1}</Text>
                  )}
                </View>
                <Text style={[styles.stepLabel, (done || now) && styles.stepLabelOn]}>{label}</Text>
              </View>
            );
          })}
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
            {/* ── Step 1: utility ── */}
            <View style={styles.cardSection}>
              <Text style={styles.sectionTitle}>1 · Which utility?</Text>
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

            {/* ── Step 2: provider ── */}
            <View style={styles.cardSection}>
              <Text style={styles.sectionTitle}>2 · Choose your provider</Text>
              <Text style={styles.sectionSubtitle}>The sign-in page opens straight on this provider.</Text>
              {providersLoading ? (
                <ActivityIndicator size="small" color="#3B82F6" style={{ marginTop: 12 }} />
              ) : providers && providers.length > 0 ? (
                <>
                  <View style={styles.searchRow}>
                    <Feather name="search" size={14} color="#64748B" />
                    <TextInput
                      style={styles.searchInput}
                      placeholder="Search providers (e.g. JCP&L)"
                      placeholderTextColor="#64748B"
                      value={providerQuery}
                      onChangeText={setProviderQuery}
                      autoCorrect={false}
                    />
                    {providerQuery ? (
                      <TouchableOpacity onPress={() => setProviderQuery("")}>
                        <Feather name="x" size={14} color="#64748B" />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <Text style={styles.resultCount}>
                    {filteredProviders.length} of {providers.length} providers
                    {selectedProvider ? ` · selected: ${selectedProvider.name}` : ""}
                  </Text>
                  {filteredProviders.map((p) => {
                    const selected = selectedProvider?.uid === p.uid;
                    return (
                      <TouchableOpacity
                        key={p.uid}
                        style={[styles.providerRow, selected && styles.providerRowActive]}
                        onPress={() => setSelectedProvider(selected ? null : p)}
                      >
                        <View style={[styles.radio, selected && styles.radioActive]}>
                          {selected ? <Feather name="check" size={12} color="#FFFFFF" /> : null}
                        </View>
                        <Text style={[styles.providerName, selected && styles.providerNameActive]} numberOfLines={1}>
                          {p.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                  {filteredProviders.length === 0 ? (
                    <Text style={styles.finePrint}>No providers match — clear the search or continue without choosing.</Text>
                  ) : null}
                  {selectedProvider ? (
                    <TouchableOpacity onPress={() => setSelectedProvider(null)}>
                      <Text style={styles.clearChoice}>Clear choice (pick in the browser instead)</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.finePrint}>Nothing chosen — you'll pick your provider on the sign-in page instead.</Text>
                  )}
                </>
              ) : (
                <>
                  <Text style={styles.finePrint}>
                    {providersError ||
                      "Provider list unavailable — you'll pick your provider on the sign-in page instead."}
                  </Text>
                  {providersError ? (
                    <TouchableOpacity style={styles.retryButton} onPress={loadProviders}>
                      <Feather name="refresh-cw" size={13} color="#60A5FA" style={{ marginRight: 6 }} />
                      <Text style={styles.retryText}>Retry loading providers</Text>
                    </TouchableOpacity>
                  ) : null}
                </>
              )}
            </View>

            {/* ── Step 3: paywall ── */}
            {!subStatus?.active ? (
              <View style={styles.cardSection}>
                <View style={styles.priceHeaderRow}>
                  <View style={styles.priceIcon}>
                    <Feather name="zap" size={20} color="#34D399" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sectionTitle}>3 · Pay $20/meter</Text>
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
                <View style={[styles.activeBanner, { marginBottom: 0 }]}>
                  <Feather name="check-circle" size={16} color="#34D399" />
                  <Text style={styles.activeBannerText}>
                    3 · Paid — auto-sync is on ({subStatus.linkedMeters}/{subStatus.meterLimit} meters).
                  </Text>
                </View>
              </View>
            )}

            {/* ── Step 4: authorize & finish ── */}
            <View style={styles.cardSection}>
              <Text style={styles.sectionTitle}>4 · Authorize & finish</Text>
              <Text style={styles.sectionSubtitle}>
                {selectedProvider
                  ? `Sign in to ${selectedProvider.name}, then finish linking — the bill lands in the app.`
                  : "Sign in to your provider, then finish linking — the bill lands in the app."}
              </Text>
              {subStatus?.active ? (
                <View style={[styles.activeBanner, atMeterCap && styles.capBanner, { marginTop: 12 }]}>
                  <Feather name={atMeterCap ? "alert-triangle" : "check-circle"} size={16} color={atMeterCap ? "#FBBF24" : "#34D399"} />
                  <Text style={[styles.activeBannerText, atMeterCap && { color: "#FCD34D" }]}>
                    {atMeterCap
                      ? `Meter limit reached (${subStatus.linkedMeters}/${subStatus.meterLimit}).`
                      : `Each new connection bills $20/mo.`}
                  </Text>
                </View>
              ) : (
                <View style={[styles.activeBanner, { marginTop: 12, borderColor: "rgba(251,191,36,0.3)", backgroundColor: "rgba(251,191,36,0.08)" }]}>
                  <Feather name="lock" size={16} color="#FBBF24" />
                  <Text style={[styles.activeBannerText, { color: "#FCD34D" }]}>
                    Payment first — complete step 3, then authorize here.
                  </Text>
                </View>
              )}
              {connecting && statusMsg ? (
                <View style={styles.statusRow}>
                  <ActivityIndicator size="small" color="#34D399" />
                  <Text style={styles.statusText}>{statusMsg}</Text>
                </View>
              ) : null}
              {!authPending ? (
                <TouchableOpacity
                  style={[styles.payButton, (!subStatus?.active || connecting || atMeterCap) && { opacity: 0.6 }]}
                  onPress={handleConnect}
                  disabled={!subStatus?.active || connecting || atMeterCap}
                >
                  {connecting ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Feather name="link" size={16} color="#FFFFFF" style={{ marginRight: 8 }} />
                      <Text style={styles.payButtonText} numberOfLines={1}>
                        {selectedProvider ? `Sign in to ${selectedProvider.name}` : `Connect ${utilityKey} Provider`}
                      </Text>
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
              {subStatus?.active ? (
                <TouchableOpacity style={styles.manageButton} onPress={handleManage}>
                  <Text style={styles.manageButtonText}>Manage subscription</Text>
                </TouchableOpacity>
              ) : null}
            </View>
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
  stepper: { flexDirection: "row", justifyContent: "space-between", backgroundColor: "rgba(15,23,42,0.9)", borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },
  stepItem: { alignItems: "center", gap: 4, flex: 1 },
  stepDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(30,41,59,0.9)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(71,85,105,0.5)" },
  stepDotDone: { backgroundColor: "#10B981", borderColor: "#10B981" },
  stepDotNow: { backgroundColor: "#3B82F6", borderColor: "#3B82F6" },
  stepNum: { color: "#64748B", fontSize: 11, fontWeight: "800" },
  stepNumNow: { color: "#FFFFFF" },
  stepLabel: { color: "#64748B", fontSize: 10, fontWeight: "700" },
  stepLabelOn: { color: "#E2E8F0" },
  retryButton: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  retryText: { color: "#60A5FA", fontSize: 13, fontWeight: "700" },
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
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(11,17,32,0.9)", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14, marginTop: 12, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  searchInput: { flex: 1, color: "#FFFFFF", fontSize: 14, fontWeight: "600", padding: 0 },
  resultCount: { color: "#64748B", fontSize: 11, fontWeight: "600", marginTop: 8, marginBottom: 4 },
  providerRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(30,41,59,0.65)", paddingHorizontal: 12, paddingVertical: 11, borderRadius: 14, marginBottom: 6, borderWidth: 1, borderColor: "rgba(59,130,246,0.10)" },
  providerRowActive: { backgroundColor: "rgba(59,130,246,0.18)", borderColor: "#3B82F6" },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: "#475569", alignItems: "center", justifyContent: "center" },
  radioActive: { backgroundColor: "#3B82F6", borderColor: "#3B82F6" },
  providerName: { flex: 1, color: "#CBD5E1", fontSize: 13, fontWeight: "600" },
  providerNameActive: { color: "#FFFFFF", fontWeight: "800" },
  clearChoice: { color: "#60A5FA", fontSize: 12, fontWeight: "700", marginTop: 4 },
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
