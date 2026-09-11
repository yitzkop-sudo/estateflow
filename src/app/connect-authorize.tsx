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
import { setPendingUtilityLink } from "../lib/pendingUtilityLink";
import {
  getAuthFormStatus,
  getUtilitySubscriptionStatus,
  linkUtilityToProperty,
  openAuthForm,
  type UtilitySubStatus,
} from "../lib/utilityapi";

/**
 * CONNECT FLOW — Step 3 of 3: authorize with the provider and finish.
 * The sign-in happens in a browser tab; this screen watches for completion
 * and then pulls the bill itself, stashes it in the handoff store, and
 * dismisses straight back to the property form — which shows the data.
 */

const { width: SCREEN_WIDTH } = Dimensions.get("window");

export default function ConnectAuthorize() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const utilityKey = typeof params.utilityKey === "string" ? params.utilityKey : "Electric";
  const providerUid = typeof params.providerUid === "string" ? params.providerUid : null;
  const providerName = typeof params.providerName === "string" ? params.providerName : null;

  const [subStatus, setSubStatus] = useState<UtilitySubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const linkingRef = useRef(false);
  const formUidRef = useRef<string | null>(null);
  const autoTriesRef = useRef(0);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPoll(), [stopPoll]);

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

  const atMeterCap =
    (subStatus?.meterLimit ?? 0) > 0 &&
    (subStatus?.linkedMeters ?? 0) >= (subStatus?.meterLimit ?? 0);

  // Returning from the provider tab re-checks immediately instead of waiting
  // for the next poll tick — coming back lands on finished data when ready.
  useFocusEffect(
    useCallback(() => {
      const uid = formUidRef.current;
      if (!uid || linkingRef.current) return;
      getAuthFormStatus(uid)
        .then((st) => {
          if (st?.completed) runFinishLinking(uid);
        })
        .catch(() => {});
    }, [authPending]) // eslint-disable-line react-hooks/exhaustive-deps
  );

  const runFinishLinking = useCallback(
    async (uid: string | null) => {
      if (!uid || linkingRef.current) return;
      linkingRef.current = true;
      setConnecting(true);
      setStatusMsg("Pulling your latest bill from the provider...");
      try {
        const data = await linkUtilityToProperty(uid, utilityKey);
        stopPoll();
        // Hand the bill to the property form, then go straight back to it —
        // dismissTo focuses the already-open form, so nothing typed is lost.
        setPendingUtilityLink({
          key: utilityKey,
          amount: data.amount,
          provider: data.provider,
          dueDay: data.dueDay,
          meterUid: data.meterUid,
        });
        router.dismissTo("/add-property");
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
    },
    [router, stopPoll, utilityKey]
  );

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
            // Cap automatic link attempts so a permanently-failing link
            // can't retry forever — the manual button below always works.
            if (autoTriesRef.current >= 3) {
              stopPoll();
              setError("Automatic linking gave up after 3 tries — tap below to retry manually.");
              return;
            }
            autoTriesRef.current += 1;
            await runFinishLinking(uid);
            return;
          }
        } catch {
          // keep polling through transient failures
        }
        if (tries >= 60) stopPoll();
      }, 5000);
    },
    [runFinishLinking, stopPoll]
  );

  const keySubs = subStatus?.subscriptions;
  const keyCovered = keySubs ? !!keySubs[utilityKey]?.active : !!subStatus?.active;

  const handleConnect = async () => {
    if (!keyCovered) {
      router.replace({
        pathname: "/connect-payment",
        params: providerUid ? { utilityKey, providerUid, providerName: providerName || "" } : { utilityKey },
      });
      return;
    }
    if (atMeterCap) {
      Alert.alert("Meter limit reached", "Remove a linked utility or manage your plan to add capacity.");
      return;
    }
    setConnecting(true);
    setError(null);
    setStatusMsg(
      providerName ? `Opening ${providerName} to authorize access...` : "Opening your utility provider to authorize access..."
    );
    let waitingForSignIn = false;
    try {
      const opened = await openExternalUrl(async () => {
        const form = await openAuthForm(providerUid || undefined, utilityKey);
        formUidRef.current = form.formUid;
        return form.url;
      });
      if (!opened) {
        setError("The provider tab was blocked. Allow popups for this site and try again.");
        return;
      }
      waitingForSignIn = true;
      setStatusMsg("Complete the sign-in in the tab that just opened — this screen finishes itself when you're done.");
      setAuthPending(true);
      autoTriesRef.current = 0;
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
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.headerContainer}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <Feather name="arrow-left" size={SCREEN_WIDTH < 400 ? 20 : 24} color="white" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Authorize</Text>
          </View>
          <Text style={styles.headerSubtitle}>Sign in, then you're done.</Text>
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
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Connecting</Text>
              <Text style={styles.summaryValue} numberOfLines={1}>
                {utilityKey}
                {providerName ? ` · ${providerName}` : ""} · $20/mo
              </Text>
            </View>
            {!keyCovered ? (
              <View style={[styles.noticeBanner, { borderColor: "rgba(251,191,36,0.3)", backgroundColor: "rgba(251,191,36,0.08)" }]}>
                <Feather name="lock" size={16} color="#FBBF24" />
                <Text style={[styles.noticeText, { color: "#FCD34D" }]}>
                  Payment first — tap below to go back to checkout.
                </Text>
              </View>
            ) : atMeterCap ? (
              <View style={[styles.noticeBanner, { borderColor: "rgba(251,191,36,0.3)", backgroundColor: "rgba(251,191,36,0.08)" }]}>
                <Feather name="alert-triangle" size={16} color="#FBBF24" />
                <Text style={[styles.noticeText, { color: "#FCD34D" }]}>
                  Meter limit reached ({subStatus?.linkedMeters ?? 0}/{subStatus?.meterLimit ?? 0}).
                </Text>
              </View>
            ) : null}
            {connecting && statusMsg ? (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color="#34D399" />
                <Text style={styles.statusText}>{statusMsg}</Text>
              </View>
            ) : null}
            {!authPending ? (
              <TouchableOpacity
                style={[styles.authorizeButton, (connecting || atMeterCap) && { opacity: 0.6 }]}
                onPress={handleConnect}
                disabled={connecting || atMeterCap}
              >
                {connecting ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <>
                    <Feather name="link" size={16} color="#FFFFFF" style={{ marginRight: 8 }} />
                    <Text style={styles.authorizeText} numberOfLines={1}>
                      {providerName ? `Sign in to ${providerName}` : `Connect ${utilityKey} Provider`}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.finishButton, connecting && { opacity: 0.6 }]}
                onPress={() => {
                  autoTriesRef.current = 0;
                  runFinishLinking(formUidRef.current);
                }}
                disabled={connecting}
              >
                {connecting ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <>
                    <Feather name="check" size={16} color="#FFFFFF" style={{ marginRight: 8 }} />
                    <Text style={styles.authorizeText}>I've signed in — Finish linking</Text>
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
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(59,130,246,0.10)", padding: 14, borderRadius: 16, marginBottom: 8, borderWidth: 1, borderColor: "rgba(59,130,246,0.20)" },
  summaryLabel: { color: "#94A3B8", fontSize: 13, fontWeight: "600" },
  summaryValue: { color: "#FFFFFF", fontSize: 14, fontWeight: "900", flex: 1, textAlign: "right", marginLeft: 12 },
  noticeBanner: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1 },
  noticeText: { flex: 1, color: "#6EE7B7", fontSize: 12, fontWeight: "600", lineHeight: 17 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(59,130,246,0.08)", borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: "rgba(59,130,246,0.2)" },
  statusText: { flex: 1, color: "#93C5FD", fontSize: 12, fontWeight: "600" },
  authorizeButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#10B981", padding: 14, borderRadius: 16, marginTop: 8 },
  authorizeText: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  finishButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#3B82F6", padding: 14, borderRadius: 16, marginTop: 8 },
  manageButton: { alignItems: "center", padding: 12, marginTop: 4 },
  manageButtonText: { color: "#60A5FA", fontSize: 13, fontWeight: "700" },
});
