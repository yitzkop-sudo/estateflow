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
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { auth } from "../lib/firebase";
import { openExternalUrl } from "../lib/openExternal";
import {
  cancelUtilitySubscription,
  confirmUtilitySubscription,
  detachBillingCard,
  getBillingInvoices,
  getBillingPaymentMethods,
  getBillingProfile,
  getUtilitySubscriptionStatus,
  reconcileUtilitySubscriptions,
  setDefaultBillingCard,
  startCardSetup,
  startUtilitySubscription,
  updateBillingProfile,
  type BillingCard,
  type BillingInvoice,
  type BillingProfile,
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
  const [cards, setCards] = useState<BillingCard[] | null>(null);
  const [profile, setProfile] = useState<BillingProfile | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [draft, setDraft] = useState<BillingProfile | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [invoices, setInvoices] = useState<BillingInvoice[] | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [addingCard, setAddingCard] = useState(false);
  const [cardBusyId, setCardBusyId] = useState<string | null>(null);

  const hasBillingAccount = cards !== null || profile !== null || invoices !== null;

  const isNoAccount = (e: any) => /no billing account/i.test(e?.message || "");

  const loadBilling = useCallback(async () => {
    setBillingLoading(true);
    try {
      const [c, p, inv] = await Promise.all([
        getBillingPaymentMethods().catch((e) => {
          if (!isNoAccount(e)) throw e;
          return null;
        }),
        getBillingProfile().catch((e) => {
          if (!isNoAccount(e)) throw e;
          return null;
        }),
        getBillingInvoices(10).catch((e) => {
          if (!isNoAccount(e)) throw e;
          return null;
        }),
      ]);
      setCards(c?.methods ?? []);
      setProfile(p);
      setInvoices(inv?.invoices ?? []);
    } catch (e: any) {
      setError(e?.message || "Could not load billing info.");
    } finally {
      setBillingLoading(false);
    }
  }, []);

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
    loadBilling();
  }, [load, loadBilling, router]);

  const reloadAll = useCallback(
    (showSpinner = false) => {
      load(showSpinner);
      loadBilling();
    },
    [load, loadBilling]
  );

  const handleAddCard = async () => {
    setAddingCard(true);
    setError(null);
    try {
      const before = cards?.length ?? 0;
      const opened = await openExternalUrl(async () => (await startCardSetup()).url);
      if (!opened) {
        setError("The tab was blocked. Allow popups for this site and try again.");
        return;
      }
      // The new card lands a few seconds after setup completes — poll briefly.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const c = await getBillingPaymentMethods();
          setCards(c.methods);
          if (c.methods.length !== before) break;
        } catch {
          break;
        }
      }
      loadBilling();
    } catch (e: any) {
      const msg = e?.message || "Could not start card setup.";
      setError(msg);
      Alert.alert("Add card", msg);
    } finally {
      setAddingCard(false);
    }
  };

  const handleSetDefault = async (id: string) => {
    setCardBusyId(id);
    try {
      await setDefaultBillingCard(id);
      await loadBilling();
    } catch (e: any) {
      const msg = e?.message || "Could not set default card.";
      setError(msg);
      Alert.alert("Payment methods", msg);
    } finally {
      setCardBusyId(null);
    }
  };

  const handleDetach = (card: BillingCard) => {
    Alert.alert(
      "Remove card?",
      `${card.brand} •••• ${card.last4} will be removed.${card.isDefault ? " It is the default card." : ""}`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setCardBusyId(card.id);
            try {
              await detachBillingCard(card.id);
              await loadBilling();
            } catch (e: any) {
              const msg = e?.message || "Could not remove card.";
              setError(msg);
              Alert.alert("Payment methods", msg);
            } finally {
              setCardBusyId(null);
            }
          },
        },
      ]
    );
  };

  const handleSaveProfile = async () => {
    if (!draft) return;
    setSavingProfile(true);
    try {
      await updateBillingProfile({
        name: draft.name,
        email: draft.email,
        phone: draft.phone,
        address: { ...draft.address },
      });
      setEditingProfile(false);
      await loadBilling();
      Alert.alert("Billing information", "Saved.");
    } catch (e: any) {
      const msg = e?.message || "Could not save billing information.";
      setError(msg);
      Alert.alert("Billing information", msg);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleOpenInvoice = async (inv: BillingInvoice) => {
    const url = inv.hostedUrl || inv.pdfUrl;
    if (!url) {
      Alert.alert("Receipt", "No receipt link available for this invoice yet.");
      return;
    }
    try {
      const opened = await openExternalUrl(async () => url);
      if (!opened) setError("The tab was blocked. Allow popups for this site and try again.");
    } catch (e: any) {
      setError(e?.message || "Could not open the receipt.");
    }
  };

  const money = (cents: number, currency: string) => {
    const v = (cents || 0) / 100;
    return currency && currency.toLowerCase() !== "usd"
      ? `$${v.toFixed(2)} ${currency.toUpperCase()}`
      : `$${v.toFixed(2)}`;
  };

  const brandName = (b: string) => (b ? b.charAt(0).toUpperCase() + b.slice(1) : "Card");

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

            {/* ── Payment methods ── */}
            <View style={styles.cardSection}>
              <View style={styles.sectionHeadRow}>
                <Text style={styles.sectionTitle}>Payment methods</Text>
                {hasBillingAccount ? (
                  <TouchableOpacity
                    style={[styles.addButton, addingCard && { opacity: 0.6 }]}
                    onPress={handleAddCard}
                    disabled={addingCard}
                  >
                    {addingCard ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <>
                        <Feather name="plus" size={14} color="#FFFFFF" style={{ marginRight: 6 }} />
                        <Text style={styles.addButtonText}>Add card</Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : null}
              </View>
              {billingLoading ? (
                <ActivityIndicator size="small" color="#3B82F6" style={{ marginTop: 8 }} />
              ) : !hasBillingAccount ? (
                <Text style={styles.finePrintLeft}>
                  Billing appears here after your first subscription — cards, receipts and billing details included.
                </Text>
              ) : (cards || []).length === 0 ? (
                <Text style={styles.finePrintLeft}>No saved cards yet — add one to speed up future checkouts.</Text>
              ) : (
                (cards || []).map((card) => {
                  const busy = cardBusyId === card.id;
                  return (
                    <View key={card.id} style={styles.methodRow}>
                      <View style={styles.methodIcon}>
                        <Feather name="credit-card" size={16} color="#60A5FA" />
                      </View>
                      <TouchableOpacity
                        style={{ flex: 1 }}
                        onPress={() => {
                          if (!card.isDefault && !busy) handleSetDefault(card.id);
                        }}
                        disabled={busy || card.isDefault}
                      >
                        <Text style={styles.methodTitle}>
                          {brandName(card.brand)} •••• {card.last4}
                        </Text>
                        <Text style={styles.methodSub}>
                          Exp {card.expMonth || "–"}/{card.expYear || "–"}
                          {card.isDefault ? " · Default" : " · Tap to make default"}
                        </Text>
                      </TouchableOpacity>
                      {busy ? (
                        <ActivityIndicator size="small" color="#F87171" />
                      ) : (
                        <TouchableOpacity onPress={() => handleDetach(card)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Feather name="trash-2" size={16} color="#F87171" />
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })
              )}
            </View>

            {/* ── Billing information ── */}
            <View style={styles.cardSection}>
              <View style={styles.sectionHeadRow}>
                <Text style={styles.sectionTitle}>Billing information</Text>
                {profile && !editingProfile ? (
                  <TouchableOpacity
                    onPress={() => {
                      setDraft({ ...profile, address: { ...profile.address } });
                      setEditingProfile(true);
                    }}
                  >
                    <Text style={styles.editLink}>Edit</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {billingLoading ? (
                <ActivityIndicator size="small" color="#3B82F6" style={{ marginTop: 8 }} />
              ) : !profile ? (
                <Text style={styles.finePrintLeft}>
                  {hasBillingAccount ? "Could not load billing details." : "Billing appears here after your first subscription."}
                </Text>
              ) : editingProfile && draft ? (
                <>
                  <Text style={styles.fieldLabel}>Name</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={draft.name}
                    onChangeText={(v) => setDraft({ ...draft, name: v })}
                    placeholder="Full name"
                    placeholderTextColor="#64748B"
                  />
                  <Text style={styles.fieldLabel}>Email</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={draft.email}
                    onChangeText={(v) => setDraft({ ...draft, email: v })}
                    placeholder="billing@email.com"
                    placeholderTextColor="#64748B"
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                  <Text style={styles.fieldLabel}>Phone</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={draft.phone}
                    onChangeText={(v) => setDraft({ ...draft, phone: v })}
                    placeholder="+1 …"
                    placeholderTextColor="#64748B"
                    keyboardType="phone-pad"
                  />
                  <Text style={styles.fieldLabel}>Street</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={draft.address.line1}
                    onChangeText={(v) => setDraft({ ...draft, address: { ...draft.address, line1: v } })}
                    placeholder="Street address"
                    placeholderTextColor="#64748B"
                  />
                  <View style={styles.fieldRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>City</Text>
                      <TextInput
                        style={styles.fieldInput}
                        value={draft.address.city}
                        onChangeText={(v) => setDraft({ ...draft, address: { ...draft.address, city: v } })}
                        placeholder="City"
                        placeholderTextColor="#64748B"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>State</Text>
                      <TextInput
                        style={styles.fieldInput}
                        value={draft.address.state}
                        onChangeText={(v) => setDraft({ ...draft, address: { ...draft.address, state: v } })}
                        placeholder="State"
                        placeholderTextColor="#64748B"
                      />
                    </View>
                  </View>
                  <View style={styles.fieldRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>ZIP</Text>
                      <TextInput
                        style={styles.fieldInput}
                        value={draft.address.postalCode}
                        onChangeText={(v) => setDraft({ ...draft, address: { ...draft.address, postalCode: v } })}
                        placeholder="ZIP"
                        placeholderTextColor="#64748B"
                        keyboardType="numbers-and-punctuation"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>Country</Text>
                      <TextInput
                        style={styles.fieldInput}
                        value={draft.address.country}
                        onChangeText={(v) => setDraft({ ...draft, address: { ...draft.address, country: v } })}
                        placeholder="US"
                        placeholderTextColor="#64748B"
                        autoCapitalize="characters"
                      />
                    </View>
                  </View>
                  <View style={styles.editActions}>
                    <TouchableOpacity
                      style={styles.cancelEditButton}
                      onPress={() => {
                        setEditingProfile(false);
                        setDraft(null);
                      }}
                      disabled={savingProfile}
                    >
                      <Text style={styles.cancelEditText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.saveButton, savingProfile && { opacity: 0.7 }]}
                      onPress={handleSaveProfile}
                      disabled={savingProfile}
                    >
                      {savingProfile ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <Text style={styles.saveText}>Save</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  <ProfileLine label="Name" value={profile.name} />
                  <ProfileLine label="Email" value={profile.email} />
                  <ProfileLine label="Phone" value={profile.phone} />
                  <ProfileLine
                    label="Address"
                    value={[profile.address.line1, profile.address.line2, profile.address.city, profile.address.state, profile.address.postalCode, profile.address.country]
                      .filter(Boolean)
                      .join(", ")}
                  />
                </>
              )}
            </View>

            {/* ── Invoice history ── */}
            <View style={styles.cardSection}>
              <Text style={styles.sectionTitle}>Invoice history</Text>
              {billingLoading ? (
                <ActivityIndicator size="small" color="#3B82F6" style={{ marginTop: 8 }} />
              ) : !hasBillingAccount ? (
                <Text style={styles.finePrintLeft}>Invoices appear here after your first subscription.</Text>
              ) : (invoices || []).length === 0 ? (
                <Text style={styles.finePrintLeft}>No invoices yet.</Text>
              ) : (
                (invoices || []).map((inv) => {
                  const paid = inv.status === "paid";
                  const open = inv.status === "open" || inv.status === "draft";
                  return (
                    <TouchableOpacity key={inv.id} style={styles.invoiceRow} onPress={() => handleOpenInvoice(inv)}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.invoiceTitle} numberOfLines={1}>
                          {inv.description || inv.number || "Invoice"}
                        </Text>
                        <Text style={styles.invoiceSub}>
                          {inv.created ? new Date(inv.created).toLocaleDateString() : ""}
                          {inv.number ? ` · ${inv.number}` : ""}
                        </Text>
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={styles.invoiceAmount}>{money(inv.amountPaid || inv.amountDue, inv.currency)}</Text>
                        <View style={[styles.invPill, paid ? styles.invPaid : open ? styles.invOpen : styles.invOther]}>
                          <Text style={[styles.invPillText, paid ? styles.invPaidText : open ? styles.invOpenText : styles.invOtherText]}>
                            {paid ? "PAID" : inv.status.toUpperCase()}
                          </Text>
                        </View>
                      </View>
                      <Feather name="chevron-right" size={16} color="#64748B" />
                    </TouchableOpacity>
                  );
                })
              )}
            </View>

            <Text style={styles.finePrint}>
              Cancel anytime from billing management — already-linked meters keep their last synced data, and you can always enter bills manually for free.
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ProfileLine({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <View style={styles.profileLine}>
      <Text style={styles.profileLabel}>{label}</Text>
      <Text style={styles.profileValue}>{value}</Text>
    </View>
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
  finePrintLeft: { color: "#64748B", fontSize: 12, lineHeight: 17, marginTop: 8 },
  sectionHeadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  sectionTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 15 : 17, fontWeight: "900" },
  addButton: { flexDirection: "row", alignItems: "center", backgroundColor: "#3B82F6", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
  addButtonText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  editLink: { color: "#60A5FA", fontSize: 13, fontWeight: "800" },
  methodRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "rgba(30,41,59,0.65)", padding: 12, borderRadius: 14, marginTop: 8, borderWidth: 1, borderColor: "rgba(59,130,246,0.10)" },
  methodIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: "rgba(59,130,246,0.12)", alignItems: "center", justifyContent: "center" },
  methodTitle: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  methodSub: { color: "#94A3B8", fontSize: 12, fontWeight: "600", marginTop: 2 },
  profileLine: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: "rgba(51,65,85,0.5)" },
  profileLabel: { color: "#94A3B8", fontSize: 12, fontWeight: "700" },
  profileValue: { color: "#E2E8F0", fontSize: 13, fontWeight: "600", flex: 1, textAlign: "right" },
  fieldLabel: { color: "#94A3B8", fontSize: 12, fontWeight: "700", marginTop: 10, marginBottom: 4 },
  fieldInput: { backgroundColor: "rgba(11,17,32,0.9)", color: "#FFFFFF", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, fontSize: 14, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  fieldRow: { flexDirection: "row", gap: 8 },
  editActions: { flexDirection: "row", gap: 8, marginTop: 14 },
  cancelEditButton: { flex: 1, alignItems: "center", padding: 12, borderRadius: 14, backgroundColor: "rgba(71,85,105,0.4)", borderWidth: 1, borderColor: "rgba(71,85,105,0.5)" },
  cancelEditText: { color: "#CBD5E1", fontSize: 14, fontWeight: "800" },
  saveButton: { flex: 1, alignItems: "center", padding: 12, borderRadius: 14, backgroundColor: "#10B981" },
  saveText: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
  invoiceRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(30,41,59,0.65)", padding: 12, borderRadius: 14, marginTop: 8, borderWidth: 1, borderColor: "rgba(59,130,246,0.10)" },
  invoiceTitle: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
  invoiceSub: { color: "#64748B", fontSize: 11, fontWeight: "600", marginTop: 2 },
  invoiceAmount: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
  invPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginTop: 4, borderWidth: 1, alignSelf: "flex-end" },
  invPaid: { backgroundColor: "rgba(16,185,129,0.15)", borderColor: "rgba(16,185,129,0.4)" },
  invOpen: { backgroundColor: "rgba(251,191,36,0.12)", borderColor: "rgba(251,191,36,0.4)" },
  invOther: { backgroundColor: "rgba(71,85,105,0.25)", borderColor: "rgba(71,85,105,0.5)" },
  invPillText: { fontSize: 10, fontWeight: "900" },
  invPaidText: { color: "#34D399" },
  invOpenText: { color: "#FBBF24" },
  invOtherText: { color: "#94A3B8" },
});
