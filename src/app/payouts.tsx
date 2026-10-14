import { Feather } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { onAuthStateChanged } from "firebase/auth";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "../components/screen-header";
import { auth } from "../lib/firebase";
import { fetchConnectStatus, fetchConnectActivity, startConnectOnboarding, type ConnectStatus, type ConnectActivity } from "../lib/stripe";
import { CheckoutSheet, isCheckoutSheetAvailable, type CheckoutRequest } from "../components/checkout-sheet";

export default function Payouts() {
  const router = useRouter();
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<CheckoutRequest | null>(null);
  const [activity, setActivity] = useState<ConnectActivity | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);

  const load = async () => {
    try {
      setError(null);
      const s = await fetchConnectStatus();
      setStatus(s);
      if (s?.payoutsEnabled) {
        setActivityLoading(true);
        try {
          setActivity(await fetchConnectActivity());
        } catch {
          setActivity(null);
        } finally {
          setActivityLoading(false);
        }
      }
    } catch (e: any) {
      setError(e?.message || "Could not load payout status.");
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) {
        router.replace("/login");
      } else {
        load();
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openInBrowser = async (url: string) => {
    if (Platform.OS === "web") {
      window.open(url, "_blank");
      return;
    }
    try {
      await WebBrowser.openAuthSessionAsync(url, "provalta://payouts");
    } catch {
      try {
        await WebBrowser.openBrowserAsync(url);
      } catch {
        await Linking.openURL(url);
      }
    }
    // Onboarding may have completed while the browser was open — re-sync.
    await load();
  };

  // Full Stripe payout history: same in-app sheet as onboarding (no markers —
  // the user just closes it). Falls back to the browser when no WebView.
  const openPayoutHistory = () => {
    const url = "https://dashboard.stripe.com/payouts";
    if (Platform.OS !== "web" && isCheckoutSheetAvailable()) {
      setCheckout({
        url,
        title: "Payout history",
        subtitle: "Stripe · close with × when done",
        loadingText: "Loading payout history…",
        successMarkers: [],
      });
      return;
    }
    openInBrowser(url);
  };

  const handleConnect = async (title?: string) => {
    setConnecting(true);
    setError(null);
    try {
      const url = await startConnectOnboarding();
      // In-app sheet (same as card checkout) when the binary has a WebView —
      // Stripe onboarding finishes at connect-return.html, which closes it.
      if (Platform.OS !== "web" && isCheckoutSheetAvailable()) {
        setCheckout({
          url,
          title: title || "Connect Payouts",
          subtitle: "Secure Stripe onboarding · bank details stay with Stripe",
          loadingText: "Loading secure onboarding…",
          successTitle: "Setup complete",
          successMarkers: ["connect-return"],
          cancelMarkers: ["connect-refresh"],
        });
        return;
      }
      await openInBrowser(url);
    } catch (e: any) {
      Alert.alert("Couldn't start setup", e?.message || "Please try again.");
    } finally {
      setConnecting(false);
    }
  };

  const steps = [
    { icon: "credit-card" as const, title: "Tenant pays by card", body: "They check out through Stripe's secure hosted page." },
    { icon: "refresh-cw" as const, title: "Money transfers to you", body: "Each payment is routed straight into your Stripe balance." },
    { icon: "briefcase" as const, title: "Auto-deposit to your bank", body: "Stripe pays out your balance automatically." },
  ];

    return (
    <SafeAreaView style={s.root}>
      {/* TOP BAR */}
      <View style={{ width: "100%", maxWidth: 720, alignSelf: "center", paddingHorizontal: 20, paddingTop: 8 }}>
        <ScreenHeader title="Rent Payouts" subtitle="Stripe transfers to your bank" />
      </View>

      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {/* STATUS CARD */}
        {checking ? (
          <View style={[s.card, { alignItems: "center", paddingVertical: 40 }]}>
            <ActivityIndicator color="#4F8DFF" />
            <Text style={s.checkingText}>Checking payout status…</Text>
          </View>
        ) : status?.payoutsEnabled ? (
          <View style={[s.card, s.cardSuccess]}>
            <Feather name="check-circle" size={40} color="#22C55E" />
            <Text style={s.successTitle}>Payouts are active 🎉</Text>
            <Text style={s.successBody}>
              Rent payments your tenants make in the tenant portal go straight to your connected bank
              account through Stripe.
            </Text>
            {activity?.bank && (
              <View style={s.bankRow}>
                <Feather name="credit-card" size={16} color="#60A5FA" />
                <Text style={s.bankText}>
                  {activity.bank.bankName ? `${activity.bank.bankName} ` : ""}•••• {activity.bank.last4}
                </Text>
              </View>
            )}
            <TouchableOpacity style={s.cta} onPress={() => handleConnect("Update bank details")} disabled={connecting}>
              {connecting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Feather name="edit-2" size={16} color="#fff" />
                  <Text style={s.ctaText}>Edit bank / account details</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={[s.cta, s.ctaSecondary]} onPress={openPayoutHistory}>
              <Feather name="external-link" size={16} color="#fff" />
              <Text style={s.ctaText} numberOfLines={2}>Full history in Stripe</Text>
            </TouchableOpacity>
          </View>
        ) : status?.connected ? (
          <View style={[s.card, s.cardPending]}>
            <Feather name="clock" size={40} color="#60A5FA" />
            <Text style={s.pendingTitle}>Finish payout setup</Text>
            <Text style={s.pendingBody}>
              Your Stripe account isn&apos;t complete yet. You&apos;re a few steps away from receiving rent
              straight into your bank account.
            </Text>
            <TouchableOpacity style={s.cta} onPress={() => handleConnect()} disabled={connecting}>
              {connecting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Feather name="arrow-right-circle" size={18} color="#fff" />
                  <Text style={s.ctaText}>Continue Setup</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={[s.card, s.cardEmpty]}>
            <View style={s.heroIcon}>
              <Feather name="credit-card" size={30} color="#4F8DFF" />
            </View>
            <Text style={s.emptyTitle}>Get paid for rent automatically</Text>
            <Text style={s.emptyBody}>
              Connect a Stripe payouts account so tenants can pay rent with a card and the money
              lands directly in your bank.
            </Text>
            <TouchableOpacity style={s.cta} onPress={() => handleConnect()} disabled={connecting}>
              {connecting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Feather name="shield" size={18} color="#fff" />
                  <Text style={s.ctaText}>Connect Stripe Payouts</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        {error && !checking && (
          <View style={s.errorBanner}>
            <Feather name="alert-triangle" size={16} color="#EF4444" />
            <Text style={s.errorText}>{error}</Text>
            <TouchableOpacity onPress={load} style={s.retryBtn}>
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── IN-APP PAYOUT ACTIVITY ── */}
        {status?.payoutsEnabled && !checking && (
          <View style={[s.card]}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={s.sectionTitle}>Rent payouts</Text>
              <TouchableOpacity onPress={load} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Feather name="refresh-cw" size={16} color="#60A5FA" />
              </TouchableOpacity>
            </View>
            {activityLoading ? (
              <ActivityIndicator color="#4F8DFF" style={{ paddingVertical: 16 }} />
            ) : !activity ? (
              <Text style={s.feeNote}>Couldn't load activity right now — pull to retry.</Text>
            ) : (
              <>
                <View style={s.balanceRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.balanceLabel}>Available</Text>
                    <Text style={s.balanceAmount}>${(activity.balance.available / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.balanceLabel}>On the way</Text>
                    <Text style={s.balanceAmount}>${(activity.balance.pending / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text>
                  </View>
                </View>
                <Text style={s.subTitle}>Rent received</Text>
                {activity.transfers.length === 0 ? (
                  <Text style={s.feeNote}>No rent transfers yet.</Text>
                ) : (
                  activity.transfers.slice(0, 8).map((t) => (
                    <View key={t.id} style={s.txRow}>
                      <View style={s.txIcon}>
                        <Feather name="arrow-down-left" size={14} color="#22C55E" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.txTitle} numberOfLines={1}>{t.description || "Rent payment"}</Text>
                        <Text style={s.txSub}>{t.created ? new Date(t.created).toLocaleDateString() : ""}</Text>
                      </View>
                      <Text style={s.txAmount}>+${(t.amount / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text>
                    </View>
                  ))
                )}
                <Text style={[s.subTitle, { marginTop: 12 }]}>Bank deposits</Text>
                {activity.payouts.length === 0 ? (
                  <>
                    <Text style={s.feeNote}>No bank deposits yet.</Text>
                    {activity.balance.pending > 0 && (
                      <Text style={s.feeNote}>
                        Stripe holds new payments before the first deposit
                        {activity.payoutSchedule?.delayDays
                          ? ` (about ${activity.payoutSchedule.delayDays} days)`
                          : ""}
                        . Nothing is wrong — it lands automatically.
                      </Text>
                    )}
                  </>
                ) : (
                  activity.payouts.slice(0, 8).map((p) => (
                    <View key={p.id} style={s.txRow}>
                      <View style={[s.txIcon, { backgroundColor: "rgba(59,130,246,0.15)" }]}>
                        <Feather name="briefcase" size={14} color="#60A5FA" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.txTitle} numberOfLines={1}>
                          {p.arrival ? `Arrives ${new Date(p.arrival).toLocaleDateString()}` : "Bank deposit"}
                        </Text>
                        <Text style={[s.txSub, { textTransform: "capitalize" }]}>{p.status}</Text>
                      </View>
                      <Text style={s.txAmount}>${(p.amount / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text>
                    </View>
                  ))
                )}
              </>
            )}
          </View>
        )}

        {/* HOW IT WORKS */}
        <View style={[s.card]}>
          <Text style={s.sectionTitle}>How rent payments work</Text>
          {steps.map((step, i) => (
            <View key={i} style={s.stepRow}>
              <View style={s.stepIcon}>
                <Feather name={step.icon} size={16} color="#60A5FA" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.stepTitle}>{step.title}</Text>
                <Text style={s.stepBody}>{step.body}</Text>
              </View>
            </View>
          ))}
          <Text style={s.feeNote}>Stripe&apos;s standard card processing fee applies to each payment.</Text>
        </View>

        <View style={{ height: 30 }} />
      </ScrollView>

      {/* ── In-app Stripe onboarding sheet ── */}
      <CheckoutSheet
        request={checkout}
        onSuccess={() => {
          setCheckout(null);
          load();
        }}
        onCancel={() => {
          setCheckout(null);
          load();
        }}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#060D1C" },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  iconBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },
  topTitle: { color: "#fff", fontSize: 18, fontWeight: "800" },
  content: { width: "100%", maxWidth: 720, alignSelf: "center", padding: 20, gap: 14 },
  card: {
    backgroundColor: "#0F1B33",
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    gap: 12,
  },
  cardEmpty: { alignItems: "center", paddingVertical: 28 },
  heroIcon: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: "rgba(59,130,246,0.15)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 4,
  },
  checkingText: { color: "#94A3B8", marginTop: 10 },
  emptyTitle: { color: "#fff", fontSize: 19, fontWeight: "800", textAlign: "center" },
  emptyBody: { color: "#94A3B8", fontSize: 14, lineHeight: 21, textAlign: "center" },
  cardSuccess: { borderColor: "rgba(34,197,94,0.35)", alignItems: "center", paddingVertical: 28 },
  successTitle: { color: "#fff", fontSize: 19, fontWeight: "800" },
  successBody: { color: "#A7F3D0", fontSize: 14, lineHeight: 21, textAlign: "center" },
  bankRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(59,130,246,0.12)", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginTop: 4, alignSelf: "stretch" },
  bankText: { color: "#BFDBFE", fontSize: 14, fontWeight: "700" },
  cardPending: { borderColor: "rgba(96,165,250,0.35)", alignItems: "center", paddingVertical: 28 },
  pendingTitle: { color: "#fff", fontSize: 19, fontWeight: "800" },
  pendingBody: { color: "#BFDBFE", fontSize: 14, lineHeight: 21, textAlign: "center" },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#2563EB",
    borderRadius: 14,
    paddingVertical: 15,
    alignSelf: "stretch",
  },
  ctaSecondary: { backgroundColor: "#1E40AF", borderWidth: 1, borderColor: "rgba(96,165,250,0.35)" },
  ctaText: { color: "#fff", fontSize: 15, fontWeight: "800", flexShrink: 1, textAlign: "center" },
  sectionTitle: { color: "#fff", fontSize: 16, fontWeight: "800", marginBottom: 2 },
  subTitle: { color: "#94A3B8", fontSize: 13, fontWeight: "800", marginTop: 8, marginBottom: 2 },
  balanceRow: { flexDirection: "row", gap: 12, marginVertical: 8 },
  balanceLabel: { color: "#64748B", fontSize: 11, fontWeight: "700" },
  balanceAmount: { color: "#22C55E", fontSize: 20, fontWeight: "900", marginTop: 2 },
  txRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)" },
  txIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: "rgba(34,197,94,0.15)", justifyContent: "center", alignItems: "center" },
  txTitle: { color: "#E2E8F0", fontSize: 13, fontWeight: "700" },
  txSub: { color: "#64748B", fontSize: 11, marginTop: 1 },
  txAmount: { color: "#fff", fontSize: 14, fontWeight: "800" },
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginTop: 6 },
  stepIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: "rgba(59,130,246,0.15)",
    justifyContent: "center",
    alignItems: "center",
  },
  stepTitle: { color: "#E2E8F0", fontSize: 14, fontWeight: "700" },
  stepBody: { color: "#94A3B8", fontSize: 12.5, lineHeight: 18, marginTop: 1 },
  feeNote: { color: "#64748B", fontSize: 11.5, marginTop: 10, fontStyle: "italic" },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(239,68,68,0.12)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.3)",
    borderRadius: 14,
    padding: 12,
  },
  errorText: { color: "#EF4444", flex: 1, fontSize: 13 },
  retryBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: "rgba(239,68,68,0.15)" },
  retryText: { color: "#EF4444", fontWeight: "800", fontSize: 12 },
});
