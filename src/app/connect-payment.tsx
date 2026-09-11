import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
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
  confirmUtilitySubscription,
  getUtilitySubscriptionStatus,
  startUtilitySubscription,
  type UtilitySubStatus,
} from "../lib/utilityapi";

/**
 * CONNECT FLOW — Step 2 of 3: Stripe checkout ($20/meter).
 * On payment (auto-detected by polling, or the manual button) this screen
 * replaces itself with /connect-authorize so Back never lands here again.
 */

const { width: SCREEN_WIDTH } = Dimensions.get("window");

export default function ConnectPayment() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const utilityKey = typeof params.utilityKey === "string" ? params.utilityKey : "Electric";
  const providerUid = typeof params.providerUid === "string" ? params.providerUid : null;
  const providerName = typeof params.providerName === "string" ? params.providerName : null;

  const [subStatus, setSubStatus] = useState<UtilitySubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [paidPending, setPaidPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPoll(), [stopPoll]);

  const goAuthorize = useCallback(() => {
    stopPoll();
    router.replace({
      pathname: "/connect-authorize",
      params: providerUid
        ? { utilityKey, providerUid, providerName: providerName || "" }
        : { utilityKey },
    });
  }, [router, stopPoll, utilityKey, providerUid, providerName]);

  // This screen always renders — no silent skipping. Subscribed users get an
  // explicit Continue button instead of the pay button.
  useEffect(() => {
    if (!auth.currentUser) {
      router.replace("/login");
      return;
    }
    getUtilitySubscriptionStatus()
      .then(setSubStatus)
      .catch((e: any) => setError(e?.message || "Could not load subscription status."))
      .finally(() => setLoading(false));
  }, [router]);

  // Watch for the new subscription so paying flows straight into step 3.
  // Uses the confirm endpoint (verifies with Stripe directly) so a slow or
  // missing webhook can never stall the flow. Persistent backend errors stop
  // the poll and surface themselves instead of spinning forever.
  const startPayPoll = useCallback(() => {
    stopPoll();
    let tries = 0;
    let consecutiveErrors = 0;
    let lastDetail = "";
    pollRef.current = setInterval(async () => {
      tries += 1;
      try {
        const c = await confirmUtilitySubscription();
        consecutiveErrors = 0;
        if (c?.active) {
          const s = await getUtilitySubscriptionStatus().catch(() => null);
          if (s) setSubStatus(s);
          goAuthorize();
          return;
        }
        lastDetail = c?.detail || "";
      } catch (e: any) {
        consecutiveErrors += 1;
        lastDetail = e?.message || "request failed";
        // Broken backend (stale deploy, missing env) → say so fast.
        if (consecutiveErrors >= 3) {
          stopPoll();
          setError(`${lastDetail} — fix the API, then tap "I've completed payment" to retry.`);
          return;
        }
      }
      if (tries >= 60) {
        stopPoll();
        setError(
          `Payment not detected${lastDetail ? `: ${lastDetail}` : ""}. ` +
            `If you paid, tap "I've completed payment" to retry.`
        );
      }
    }, 5000);
  }, [goAuthorize, stopPoll]);

  // Returning from the Stripe tab (it opens outside the app) re-checks
  // immediately instead of waiting for the next poll tick.
  useFocusEffect(
    useCallback(() => {
      if (!paidPending) return;
      confirmUtilitySubscription()
        .then(async (c) => {
          if (c?.active) {
            const s = await getUtilitySubscriptionStatus().catch(() => null);
            if (s) setSubStatus(s);
            goAuthorize();
          }
        })
        .catch(() => {});
    }, [paidPending, goAuthorize])
  );

  const handlePay = async () => {
    setPaying(true);
    setError(null);
    try {
      let alreadyActive = false;
      const opened = await openExternalUrl(async () => {
        const res = await startUtilitySubscription();
        alreadyActive = res.alreadyActive;
        if (alreadyActive) return "";
        return res.url;
      });
      if (alreadyActive) {
        goAuthorize();
        return;
      }
      if (!opened) {
        setError("The checkout tab was blocked. Allow popups for this site and try again.");
        return;
      }
      setPaidPending(true);
      startPayPoll();
    } catch (e: any) {
      const msg = `${e?.name || "Error"}: ${e?.message || e || "Could not start the checkout."}`;
      console.warn("Checkout failed:", e);
      setError(msg);
      Alert.alert("Checkout failed", msg);
    } finally {
      setPaying(false);
    }
  };

  const handlePaidDone = async () => {
    setPaying(true);
    try {
      const c = await confirmUtilitySubscription();
      if (c?.active) {
        const s = await getUtilitySubscriptionStatus().catch(() => null);
        if (s) setSubStatus(s);
        goAuthorize();
      } else if (c?.detail) {
        setError(`Not active yet: ${c.detail}`);
        Alert.alert("Not active yet", c.detail);
      } else {
        Alert.alert("Not active yet", "We couldn't see an active subscription. If you just paid, wait a moment and try again.");
      }
    } catch (e: any) {
      Alert.alert("Check failed", e?.message || "Could not verify the payment. Try again.");
    } finally {
      setPaying(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <Image source={require("../assets/login-bg.png")} style={styles.backgroundImage} resizeMode="cover" />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(5,10,20,0.78)" }]} />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.headerContainer}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <Feather name="arrow-left" size={SCREEN_WIDTH < 400 ? 20 : 24} color="white" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Payment</Text>
          </View>
          <Text style={styles.headerSubtitle}>Pay per meter, then authorize.</Text>
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
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Connecting</Text>
              <Text style={styles.summaryValue}>
                {utilityKey}
                {providerName ? ` · ${providerName}` : ""}
              </Text>
            </View>
            <View style={styles.priceRow}>
              <Text style={styles.priceLabel}>Each connected meter</Text>
              <Text style={styles.priceValue}>$20.00/mo</Text>
            </View>
            <Text style={styles.finePrint}>
              One meter at $20/mo — that's all you pay. Stay on this screen after paying; it moves on by itself.
            </Text>
            {subStatus?.active ? (
              <>
                <View style={styles.subscribedRow}>
                  <Feather name="check-circle" size={16} color="#34D399" />
                  <Text style={styles.subscribedText}>
                    You're subscribed ({subStatus.linkedMeters}/{subStatus.meterLimit} meters) — this meter will bill $20/mo on link.
                  </Text>
                </View>
                <TouchableOpacity style={styles.payButton} onPress={goAuthorize}>
                  <Text style={styles.payButtonText}>Continue to authorize</Text>
                  <Feather name="arrow-right" size={16} color="#FFFFFF" style={{ marginLeft: 8 }} />
                </TouchableOpacity>
              </>
            ) : (
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
            )}
            {paidPending ? (
              <>
                <View style={styles.confirmingRow}>
                  <ActivityIndicator size="small" color="#34D399" />
                  <Text style={styles.confirmingText}>
                    Confirming your payment — moving on automatically.
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.checkButton, paying && { opacity: 0.7 }]}
                  onPress={handlePaidDone}
                  disabled={paying}
                >
                  <Feather name="check-circle" size={16} color="#FFFFFF" style={{ marginRight: 8 }} />
                  <Text style={styles.payButtonText}>I've completed payment</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>
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
  priceHeaderRow: { flexDirection: "row", alignItems: "center", marginBottom: 16 },
  priceIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(52,211,153,0.14)", alignItems: "center", justifyContent: "center", marginRight: 12, borderWidth: 1, borderColor: "rgba(52,211,153,0.22)" },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(59,130,246,0.10)", padding: 14, borderRadius: 16, marginBottom: 8, borderWidth: 1, borderColor: "rgba(59,130,246,0.20)" },
  summaryLabel: { color: "#94A3B8", fontSize: 13, fontWeight: "600" },
  summaryValue: { color: "#FFFFFF", fontSize: 14, fontWeight: "900", flex: 1, textAlign: "right", marginLeft: 12 },
  priceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(30,41,59,0.65)", padding: 14, borderRadius: 16, marginBottom: 8, borderWidth: 1, borderColor: "rgba(59,130,246,0.10)" },
  priceLabel: { color: "#CBD5E1", fontSize: 14, fontWeight: "600" },
  priceValue: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  finePrint: { color: "#64748B", fontSize: 12, lineHeight: 17, marginVertical: 8 },
  subscribedRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(52,211,153,0.08)", borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: "rgba(52,211,153,0.25)" },
  subscribedText: { flex: 1, color: "#6EE7B7", fontSize: 12, fontWeight: "600", lineHeight: 17 },
  confirmingRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(52,211,153,0.08)", borderRadius: 14, padding: 12, marginTop: 8, borderWidth: 1, borderColor: "rgba(52,211,153,0.25)" },
  confirmingText: { flex: 1, color: "#6EE7B7", fontSize: 12, fontWeight: "600", lineHeight: 17 },
  payButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#10B981", padding: 14, borderRadius: 16, marginTop: 8 },
  payButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  checkButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#3B82F6", padding: 14, borderRadius: 16, marginTop: 8 },
});
