import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScreenHeader } from "../components/screen-header";
import { auth } from "../lib/firebase";
import { openExternalUrl } from "../lib/openExternal";
import {
  getArcadiaPricing,
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
  const lockedUtility = params.lockUtility === "1";
  const meterLabel = typeof params.meterLabel === "string" ? params.meterLabel : "";
  const newMeter = params.newMeter === "1";
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
  const [providersCollapsed, setProvidersCollapsed] = useState(false);
  const [region, setRegion] = useState<"ALL" | "NJ" | "NY">("ALL");

  /** True UtilityAPI ID for the paid flow (aliases like NY-NGRID resolve). */
  const effectiveUtilityUid = (p: SupportedUtility | null) => {
    if (!p) return undefined;
    if (p.method && p.method !== "auto" && p.method !== "arcadia") return undefined;
    return p.utilityApiUid || p.uid;
  };

  const isArcadia = (p: SupportedUtility | null) => p?.method === "arcadia";
  const isPortalOnly = (p: SupportedUtility | null) =>
    !!p?.method && p.method !== "auto" && p.method !== "arcadia";

  const methodBadge = (p: SupportedUtility) => {
    if (p.method === "arcadia") return { label: "Auto-sync", color: "#2DD4BF" };
    if (!p.method || p.method === "auto") return { label: "Auto-sync", color: "#34D399" };
    if (p.method === "greenbutton") return { label: "Green Button", color: "#60A5FA" };
    return { label: "Bill import", color: "#FBBF24" };
  };

  // NJ (Arcadia) meter price for row copy — best effort, falls back silently.
  const [arcadiaPrice, setArcadiaPrice] = useState<string | null>(null);
  useEffect(() => {
    getArcadiaPricing()
      .then((pr) => setArcadiaPrice(pr.priceDollars))
      .catch(() => {});
  }, []);

  const pickProvider = (p: SupportedUtility) => {
    if (selectedProvider?.uid === p.uid) {
      // Tapping the selected provider again deselects and restores the list.
      setSelectedProvider(null);
      setProvidersCollapsed(false);
    } else {
      // Picking a provider collapses the list to just it — "Show all"
      // brings every provider back.
      setSelectedProvider(p);
      setProvidersCollapsed(true);
    }
  };

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
  const regionFiltered = (providers || []).filter((p) => {
    if (region === "ALL") return true;
    const states = (p.states || []).map((s) => s.toUpperCase());
    if (states.includes(region)) return true;
    // Fallback: name match so NJ/NY utilities without tags still surface.
    if (region === "NJ") return /pse&g|jcp|jersey|atlantic|rockland|elizabethtown|south jersey/i.test(p.name);
    return /con ed|national grid|pseg.*long|orange|nyseg|rg&e|rochester|central hudson|national fuel|iedr/i.test(p.name);
  });
  const filteredProviders = regionFiltered
    .filter(
      (p) =>
        !query ||
        p.name.toLowerCase().includes(query) ||
        p.uid.toLowerCase().includes(query)
    )
    .slice(0, 60);
  // A picked provider hides the rest so the choice is unmistakable; the
  // toggle below restores the full catalog.
  const visibleProviders =
    selectedProvider && providersCollapsed ? [selectedProvider] : filteredProviders;

  const goNext = async () => {
    // NY Green Button + Download providers are NOT on any auto-sync
    // network — never send them to checkout. Open the utility portal
    // instead, then the user enters the bill manually.
    if (isPortalOnly(selectedProvider)) {
      const p = selectedProvider!;
      const url = p.connectUrl || p.loginUrl;
      if (url) {
        const opened = await openExternalUrl(async () => url);
        if (!opened) {
          Alert.alert(
            p.name,
            `Open this in your browser to share or download usage:\n${url}\n\nThen enter the bill amount manually on the property form.`
          );
          try {
            await Linking.openURL(url);
          } catch {}
          return;
        }
        Alert.alert(
          p.name,
          p.method === "greenbutton"
            ? "Share your usage with Green Button Connect in the tab that opened (statewide NY hub: NYSERDA IEDR covers Con Ed, NYSEG, RG&E, O&R, PSEG-LI, Central Hudson). Then enter the bill amount manually on the property form — no auto-sync charge for this provider."
            : "Sign in to My Account in the tab that opened, download Green Button usage / your latest bill, then enter the amount manually on the property form — no auto-sync charge for this provider."
        );
        return;
      }
      Alert.alert(
        p.name,
        p.note || "This provider syncs via Green Button / manual bill entry — no auto-sync charge."
      );
      return;
    }
    // Paid engines: UtilityAPI ($20/mo) and NJ Arcadia (higher NJ price).
    // The server picks the Stripe price from the engine — the app just
    // forwards it.
    const apiUid = effectiveUtilityUid(selectedProvider);
    const engine = isArcadia(selectedProvider) ? "arcadia" : undefined;
    router.push({
      pathname: "/connect-payment",
      params: {
        ...(selectedProvider
          ? {
              utilityKey,
              providerUid: apiUid || selectedProvider.uid,
              providerName: selectedProvider.name,
              ...(engine ? { engine } : {}),
            }
          : { utilityKey }),
        ...(newMeter ? { newMeter: "1" } : {}),
      },
    });
  };

  const openProviderPortal = async (p: SupportedUtility) => {
    const url = p.connectUrl || p.loginUrl;
    if (!url) return;
    const opened = await openExternalUrl(async () => url);
    if (!opened) {
      try {
        await Linking.openURL(url);
      } catch {}
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <Image source={require("../assets/login-bg.png")} style={styles.backgroundImage} resizeMode="cover" />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(5,10,20,0.78)" }]} />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title="Connect Provider"
          subtitle={lockedUtility ? `Linking ${utilityKey}${meterLabel ? ` · ${meterLabel}` : ""} — pick the provider.` : "Pick what to connect and who provides it."}
        />

        {lockedUtility ? null : (
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
        )}

        <View style={styles.cardSection}>
          <Text style={styles.sectionTitle}>Choose your provider</Text>
          <Text style={styles.sectionSubtitle}>The sign-in page opens straight on this provider.</Text>
          <View style={styles.chipRow}>
            {(["ALL", "NJ", "NY"] as const).map((r) => {
              const active = region === r;
              return (
                <TouchableOpacity
                  key={r}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => {
                    setRegion(r);
                    setProvidersCollapsed(false);
                  }}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {r === "ALL" ? "All" : r === "NJ" ? "New Jersey" : "New York"}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {region !== "ALL" ? (
            <Text style={styles.finePrint}>
              {region === "NY"
                ? "NY: National Grid auto-syncs via UtilityAPI ($20/mo). Con Ed, PSEG-LI, O&R, NYSEG, RG&E, Central Hudson + National Fuel share via the free statewide Green Button hub (NYSERDA IEDR) — then enter the bill manually."
                : `NJ: PSE&G, JCP&L, Atlantic City Electric, Rockland Electric + NJ gas utilities auto-sync via Arcadia${arcadiaPrice ? ` ($${arcadiaPrice}/mo per meter)` : ""} — monthly bills pull automatically, no manual entry.`}
            </Text>
          ) : null}
          {providersLoading ? (
            <ActivityIndicator size="small" color="#3B82F6" style={{ marginTop: 12 }} />
          ) : providers && providers.length > 0 ? (
            <>
              <View style={styles.searchRow}>
                <Feather name="search" size={14} color="#64748B" />
                <TextInput
                  style={styles.searchInput}
                      placeholder="Search providers (e.g. Con Edison, PSE&G)"
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
                {selectedProvider && providersCollapsed
                  ? `Selected: ${selectedProvider.name}`
                  : `${filteredProviders.length} of ${providers.length} providers${selectedProvider ? ` · selected: ${selectedProvider.name}` : ""}`}
              </Text>
              {selectedProvider && providersCollapsed ? (
                <TouchableOpacity style={styles.retryButton} onPress={() => setProvidersCollapsed(false)}>
                  <Feather name="list" size={13} color="#60A5FA" style={{ marginRight: 6 }} />
                  <Text style={styles.retryText}>Show all {providers.length} providers</Text>
                </TouchableOpacity>
              ) : null}
              {visibleProviders.map((p) => {
                const selected = selectedProvider?.uid === p.uid;
                const badge = methodBadge(p);
                return (
                  <TouchableOpacity
                    key={p.uid}
                    style={[styles.providerRow, selected && styles.providerRowActive]}
                    onPress={() => pickProvider(p)}
                  >
                    <View style={[styles.radio, selected && styles.radioActive]}>
                      {selected ? <Feather name="check" size={12} color="#FFFFFF" /> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.providerName, selected && styles.providerNameActive]} numberOfLines={1}>
                        {p.name}
                      </Text>
                      {(p.states?.length || p.method) ? (
                        <Text style={styles.providerSub} numberOfLines={1}>
                          {(p.states || []).join(" · ")}
                          {(p.states?.length ? "  •  " : "") + badge.label}
                        </Text>
                      ) : null}
                    </View>
                    <View style={[styles.badge, { borderColor: `${badge.color}55`, backgroundColor: `${badge.color}14` }]}>
                      <Text style={[styles.badgeText, { color: badge.color }]}>{badge.label}</Text>
                    </View>
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

        {selectedProvider && isArcadia(selectedProvider) ? (
          <View style={styles.cardSection}>
            <Text style={styles.sectionTitle}>NJ auto-sync (Arcadia)</Text>
            <Text style={styles.sectionSubtitle}>
              {selectedProvider.note || "Monthly bills pull automatically."}
              {arcadiaPrice ? ` Bills at $${arcadiaPrice}/mo per meter — priced above Arcadia cost so every NJ meter profits.` : ""}
            </Text>
          </View>
        ) : null}

        {selectedProvider && isPortalOnly(selectedProvider) ? (
          <View style={styles.cardSection}>
            <Text style={styles.sectionTitle}>
              {selectedProvider.method === "greenbutton" ? "Green Button path (free)" : "Bill import path (free)"}
            </Text>
            <Text style={styles.sectionSubtitle}>
              {selectedProvider.note || "This provider is not on UtilityAPI auto-sync — no $20 charge."}
            </Text>
            <TouchableOpacity style={styles.retryButton} onPress={() => openProviderPortal(selectedProvider)}>
              <Feather name="external-link" size={13} color="#60A5FA" style={{ marginRight: 6 }} />
              <Text style={styles.retryText}>
                Open {selectedProvider.method === "greenbutton" ? "Green Button portal" : "My Account"} for {selectedProvider.name}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.continueButton, !selectedProvider && providers && providers.length > 0 && { opacity: 0.6 }]}
          onPress={goNext}
          disabled={!selectedProvider && !!providers && providers.length > 0}
        >
          <Text style={styles.continueText}>
            {selectedProvider
              ? isPortalOnly(selectedProvider)
                ? `Open portal for ${selectedProvider.name}`
                : `Continue with ${selectedProvider.name}${isArcadia(selectedProvider) && arcadiaPrice ? ` · $${arcadiaPrice}/mo` : ""}`
              : "Choose a provider to continue"}
          </Text>
          <Feather
            name={isPortalOnly(selectedProvider) ? "external-link" : "arrow-right"}
            size={16}
            color="#FFFFFF"
            style={{ marginLeft: 8 }}
          />
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
  scrollContent: { width: "100%", maxWidth: 720, alignSelf: "center", padding: SCREEN_WIDTH < 400 ? 16 : 20, gap: 14 },
  headerContainer: { marginBottom: 4 },
  backBtn: { backgroundColor: "#1E293B", padding: SCREEN_WIDTH < 400 ? 8 : 10, borderRadius: SCREEN_WIDTH < 400 ? 8 : 10, marginRight: 12 },
  headerTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 24 : 28, fontWeight: "900", letterSpacing: 0.5 },
  headerSubtitle: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, marginTop: 8, lineHeight: 18 },
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
  providerSub: { color: "#64748B", fontSize: 11, fontWeight: "600", marginTop: 2 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "800" },
  finePrint: { color: "#64748B", fontSize: 12, lineHeight: 17, marginVertical: 8 },
  retryButton: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  retryText: { color: "#60A5FA", fontSize: 13, fontWeight: "700" },
  continueButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#10B981", padding: 15, borderRadius: 16 },
  continueText: { color: "#FFFFFF", fontSize: 15, fontWeight: "900" },
  skipButton: { alignItems: "center", padding: 10 },
  skipText: { color: "#60A5FA", fontSize: 13, fontWeight: "700" },
});
