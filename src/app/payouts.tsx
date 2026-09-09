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
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { auth } from "../lib/firebase";
import { fetchConnectStatus, startConnectOnboarding, type ConnectStatus } from "../lib/stripe";

export default function Payouts() {
  const router = useRouter();
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      const s = await fetchConnectStatus();
      setStatus(s);
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
      await WebBrowser.openAuthSessionAsync(url, "propertymanager://payouts");
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

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const url = await startConnectOnboarding();
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
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.iconBtn}>
          <Feather name="arrow-left" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={s.topTitle}>Rent Payouts</Text>
        <View style={{ width: 44 }} />
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
            <TouchableOpacity style={[s.cta, s.ctaSecondary]} onPress={() => openInBrowser("https://dashboard.stripe.com/")}>
              <Feather name="external-link" size={16} color="#fff" />
              <Text style={s.ctaText}>Open Stripe Dashboard</Text>
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
            <TouchableOpacity style={s.cta} onPress={handleConnect} disabled={connecting}>
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
            <TouchableOpacity style={s.cta} onPress={handleConnect} disabled={connecting}>
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
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#060D1C" },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  iconBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },
  topTitle: { color: "#fff", fontSize: 18, fontWeight: "800" },
  content: { padding: 20, gap: 14 },
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
  ctaText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  sectionTitle: { color: "#fff", fontSize: 16, fontWeight: "800", marginBottom: 2 },
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
