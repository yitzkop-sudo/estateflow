import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { auth } from "../lib/firebase";
import {
  getSupportedUtilities,
  type SupportedUtility,
} from "../lib/utilityapi";

/**
 * CONNECT FLOW — Step 1 of 3: choose the utility + provider.
 * Continue → /connect-payment → /connect-authorize → back to the property
 * form with the bill data. Form state is never lost: results travel through
 * the pending-link handoff store, and we always return with dismissTo.
 */

const { width: SCREEN_WIDTH } = Dimensions.get("window");

const UTILITY_KEYS = ["Electric", "Water", "Gas", "Oil", "Sewer", "Trash"] as const;
type UtilityKey = (typeof UTILITY_KEYS)[number];

const cleanError = (e: any, fallback: string) => {
  const raw = String(e?.message || e || fallback);
  const noHtml = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const short = noHtml.length > 140 ? `${noHtml.slice(0, 140)}…` : noHtml;
  return short || fallback;
};

export default function ConnectUtility() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const [utilityKey, setUtilityKey] = useState<UtilityKey>(
    typeof params.utilityKey === "string" && (UTILITY_KEYS as readonly string[]).includes(params.utilityKey)
      ? (params.utilityKey as UtilityKey)
      : "Electric"
  );
  const [providers, setProviders] = useState<SupportedUtility[] | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [providerQuery, setProviderQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<SupportedUtility | null>(null);

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

  useEffect(() => {
    if (!auth.currentUser) {
      router.replace("/login");
      return;
    }
    loadProviders();
  }, [loadProviders, router]);

  const query = providerQuery.trim().toLowerCase();
  const filteredProviders = (providers || [])
    .filter(
      (p) =>
        !query ||
        p.name.toLowerCase().includes(query) ||
        p.uid.toLowerCase().includes(query)
    )
    .slice(0, 60);

  const goNext = () => {
    router.push({
      pathname: "/connect-payment",
      params: selectedProvider
        ? { utilityKey, providerUid: selectedProvider.uid, providerName: selectedProvider.name }
        : { utilityKey },
    });
  };

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
          <Text style={styles.headerSubtitle}>Step 1 of 3 — pick what to connect and who provides it.</Text>
        </View>

        <View style={styles.stepper}>
          {["Provider", "Payment", "Authorize"].map((label, i) => (
            <View key={label} style={styles.stepItem}>
              <View style={[styles.stepDot, i === 0 && styles.stepDotNow]}>
                <Text style={[styles.stepNum, i === 0 && styles.stepNumNow]}>{i + 1}</Text>
              </View>
              <Text style={[styles.stepLabel, i === 0 && styles.stepLabelOn]}>{label}</Text>
            </View>
          ))}
        </View>

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

        <View style={styles.cardSection}>
          <Text style={styles.sectionTitle}>Choose your provider</Text>
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
            </>
          ) : (
            <>
              <Text style={styles.finePrint}>
                {providersError ||
                  "Provider list unavailable — continue and you'll pick your provider on the sign-in page."}
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

        <TouchableOpacity
          style={[styles.continueButton, !selectedProvider && providers && providers.length > 0 && { opacity: 0.6 }]}
          onPress={goNext}
          disabled={!selectedProvider && !!providers && providers.length > 0}
        >
          <Text style={styles.continueText}>
            {selectedProvider ? `Continue with ${selectedProvider.name}` : "Choose a provider to continue"}
          </Text>
          <Feather name="arrow-right" size={16} color="#FFFFFF" style={{ marginLeft: 8 }} />
        </TouchableOpacity>
        {!selectedProvider && (!providers || providers.length === 0) ? (
          <TouchableOpacity style={styles.skipButton} onPress={goNext}>
            <Text style={styles.skipText}>Continue without choosing (pick in the browser)</Text>
          </TouchableOpacity>
        ) : null}
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
  stepDotNow: { backgroundColor: "#3B82F6", borderColor: "#3B82F6" },
  stepNum: { color: "#64748B", fontSize: 11, fontWeight: "800" },
  stepNumNow: { color: "#FFFFFF" },
  stepLabel: { color: "#64748B", fontSize: 10, fontWeight: "700" },
  stepLabelOn: { color: "#E2E8F0" },
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
  finePrint: { color: "#64748B", fontSize: 12, lineHeight: 17, marginVertical: 8 },
  retryButton: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  retryText: { color: "#60A5FA", fontSize: 13, fontWeight: "700" },
  continueButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#10B981", padding: 15, borderRadius: 16 },
  continueText: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  skipButton: { alignItems: "center", padding: 10 },
  skipText: { color: "#60A5FA", fontSize: 13, fontWeight: "700" },
});
