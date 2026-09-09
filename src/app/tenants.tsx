import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { computeNextDueDate } from "../lib/date";
import { auth, db } from "../lib/firebase";
import { scheduleRentReminders } from "../lib/notifications";
import { exportTenants } from "../lib/export";
import { requirePlanFeature } from "../lib/plans";

const { width: SW } = Dimensions.get("window");

type Tenant = {
  id: string;
  propertyId: string;
  propertyName: string;
  tenantName: string;
  rentAmount: number;
  dueDay: number | "last";
  notes: string;
  lastPaidAt?: any;
  createdAt: any;
};

type Property = {
  id: string;
  propertyName: string;
  address: string;
  propertyType: string;
  photoUrl?: string | null;
  tenants?: string[];
  tenantName?: string | null;
};

const DUE_DAY_OPTIONS: (number | "last")[] = [1, 5, 10, 15, 20, 25, "last"];

const ordinalSuffix = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const formatDueDay = (d: number | "last") => {
  if (d === "last") return "Last day of month";
  return `${ordinalSuffix(d)} of month`;
};

function getRentStatus(
  dueDay: number | "last",
  lastPaidAt?: any
): {
  label: string;
  color: string;
  icon: React.ComponentProps<typeof Feather>["name"];
} {
  const now = new Date();

  if (lastPaidAt) {
    const paidOn = lastPaidAt.toDate ? lastPaidAt.toDate() : new Date(lastPaidAt);
    if (!isNaN(paidOn.getTime()) && computeNextDueDate(dueDay, paidOn) > now) {
      return { label: "Paid", color: "#22C55E", icon: "check-circle" };
    }
  }

  const currentDay = now.getDate();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  let dueDayNum: number;
  if (dueDay === "last") {
    dueDayNum = lastDay;
  } else {
    dueDayNum = dueDay;
  }

  const daysUntilDue = dueDayNum - currentDay;

  if (daysUntilDue < 0) {
    return { label: "Overdue", color: "#EF4444", icon: "alert-triangle" };
  } else if (daysUntilDue <= 3) {
    return { label: "Due Soon", color: "#FACC15", icon: "clock" };
  } else if (daysUntilDue <= 7) {
    return { label: "Upcoming", color: "#60A5FA", icon: "calendar" };
  } else {
    return { label: "On Track", color: "#22C55E", icon: "check-circle" };
  }
}

const isTenantPaid = (t: Tenant) =>
  !!t.lastPaidAt && getRentStatus(t.dueDay, t.lastPaidAt).label === "Paid";

const currentMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const formatPaidAt = (v: any) => {
  if (!v) return "";
  const d = v.toDate ? v.toDate() : new Date(v);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

export default function Tenants() {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [saving, setSaving] = useState(false);
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [actionModalOpen, setActionModalOpen] = useState(false);
  const [actionTenant, setActionTenant] = useState<(Tenant & { unconfigured?: boolean }) | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Tenant | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchInputRef = useRef<TextInput>(null);

  const [formTenantName, setFormTenantName] = useState("");
  const [formTenantEmail, setFormTenantEmail] = useState("");
  const [formPropertyName, setFormPropertyName] = useState("");
  const [formRentAmount, setFormRentAmount] = useState("");
  const [formDueDay, setFormDueDay] = useState<number | "last">(1);
  const [formNotes, setFormNotes] = useState("");
  const [dueDayPickerOpen, setDueDayPickerOpen] = useState(false);

  useEffect(() => {
    let unsubSnapshot: (() => void) | null = null;
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (!user) {
        setTenants([]);
        setProperties([]);
        setLoading(false);
        router.replace("/login");
        return;
      }
      unsubSnapshot = loadTenants(user.uid);
      loadProperties(user.uid);
    });
    return () => {
      unsubAuth();
      unsubSnapshot?.();
    };
  }, []);

  const loadTenants = (uid: string) => {
    const q = query(collection(db, "tenants"), where("ownerId", "==", uid));
    const unsub = onSnapshot(q, (snap) => {
      const list: Tenant[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Tenant, "id">),
      }));
      setTenants(list);
      setLoading(false);
    });
    return unsub;
  };

  const loadProperties = async (uid: string) => {
    try {
      const q = query(collection(db, "properties"), where("ownerId", "==", uid));
      const snap = await getDocs(q);
      const list: Property[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Property, "id">),
      }));
      setProperties(list);
    } catch (err) {
      console.error("Failed to load properties", err);
    }
  };

  const allTenants: (Tenant & { unconfigured?: boolean })[] = useMemo(() => {
    const configured = new Set(tenants.map((t) => t.tenantName.toLowerCase()));
    const merged: (Tenant & { unconfigured?: boolean })[] = [...tenants];
    for (const prop of properties) {
      const names = (prop as any).tenants?.length
        ? (prop as any).tenants
        : (prop as any).tenantName
          ? [(prop as any).tenantName]
          : [];
      for (const name of names) {
        if (!configured.has(name.toLowerCase())) {
          merged.push({
            id: `unconf_${prop.id}_${name}`,
            propertyId: prop.id,
            propertyName: prop.propertyName,
            tenantName: name,
            rentAmount: 0,
            dueDay: 1,
            notes: "",
            createdAt: null,
            unconfigured: true,
          });
        }
      }
    }
    return merged;
  }, [tenants, properties]);

  const filteredTenants = useMemo(() => {
    let list = allTenants;
    if (statusFilter) {
      list = list.filter((t) => {
        if (t.unconfigured) return statusFilter === "unconfigured";
        const status = getRentStatus(t.dueDay, t.lastPaidAt);
        return status.label === statusFilter;
      });
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.tenantName?.toLowerCase().includes(q) ||
          t.propertyName?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [allTenants, searchQuery, statusFilter]);

  const openAddModal = (prefillPropertyName?: string) => {
    setEditingTenant(null);
    setFormTenantName("");
    setFormTenantEmail("");
    setFormPropertyName(prefillPropertyName || "");
    setFormRentAmount("");
    setFormDueDay(1);
    setFormNotes("");
    setAssignModalOpen(false);
    setModalOpen(true);
  };

  const openEditModal = (tenant: Tenant) => {
    setEditingTenant(tenant);
    setFormTenantName(tenant.tenantName);
    setFormTenantEmail((tenant as any).tenantEmail || "");
    setFormPropertyName(tenant.propertyName);
    setFormRentAmount(String(tenant.rentAmount));
    setFormDueDay(tenant.dueDay);
    setFormNotes(tenant.notes || "");
    setModalOpen(true);
  };

  const syncPropertyTenant = async (propertyName: string, tenantName: string, remove = false) => {
    try {
      const q = query(
        collection(db, "properties"),
        where("ownerId", "==", auth.currentUser?.uid),
        where("propertyName", "==", propertyName)
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        await updateDoc(doc(db, "properties", snap.docs[0].id), {
          tenants: remove ? arrayRemove(tenantName) : arrayUnion(tenantName),
        });
      }
    } catch (e) {
      console.error("Failed to sync property tenant", e);
    }
  };

  const handleSave = async () => {
    const user = auth.currentUser;
    if (!user) return;

    if (!formTenantName.trim()) {
      Alert.alert("Required", "Tenant name is required.");
      return;
    }
    if (!formPropertyName.trim()) {
      Alert.alert("Required", "Property name is required.");
      return;
    }
    const amount = parseFloat(formRentAmount);
    if (!formRentAmount.trim() || isNaN(amount) || amount <= 0) {
      Alert.alert("Required", "Please enter a valid rent amount.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ownerId: user.uid,
        tenantName: formTenantName.trim(),
        tenantEmail: formTenantEmail.trim().toLowerCase() || "",
        propertyName: formPropertyName.trim(),
        rentAmount: amount,
        dueDay: formDueDay,
        notes: formNotes.trim() || "",
        createdAt: serverTimestamp(),
      };

      const isUnconfigured = editingTenant?.id?.startsWith("unconf_");
      if (editingTenant && !isUnconfigured) {
        await deleteDoc(doc(db, "tenants", editingTenant.id));
      }
      await addDoc(collection(db, "tenants"), payload);
      if (!editingTenant || isUnconfigured) {
        await syncPropertyTenant(formPropertyName.trim(), formTenantName.trim());
      }

      setModalOpen(false);
      setSaving(false);
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to save tenant.");
      setSaving(false);
    }
  };

  const handleDelete = (tenant: Tenant) => {
    setDeleteTarget(tenant);
    setDeleteConfirmOpen(true);
  };

  const markAsPaid = async (tenant: Tenant & { unconfigured?: boolean }) => {
    if (tenant.unconfigured) {
      Alert.alert("Set Up First", "Add rent details before marking as paid.");
      return;
    }
    try {
      await updateDoc(doc(db, "tenants", tenant.id), { lastPaidAt: serverTimestamp() });
      await setDoc(
        doc(db, "payments", auth.currentUser!.uid, "months", currentMonthKey(), "payments", tenant.id),
        {
          rentAmount: tenant.rentAmount,
          tenantName: tenant.tenantName,
          propertyName: tenant.propertyName,
          paidAt: serverTimestamp(),
        }
      );
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to mark as paid.");
    }
  };

  const markAsUnpaid = async (tenant: Tenant & { unconfigured?: boolean }) => {
    try {
      await updateDoc(doc(db, "tenants", tenant.id), { lastPaidAt: deleteField() });
      await deleteDoc(
        doc(db, "payments", auth.currentUser!.uid, "months", currentMonthKey(), "payments", tenant.id)
      );
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to update payment status.");
    }
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    const isUnconfigured = deleteTarget.id.startsWith("unconf_");
    try {
      if (!isUnconfigured) {
        await deleteDoc(doc(db, "tenants", deleteTarget.id));
      }
      await syncPropertyTenant(deleteTarget.propertyName, deleteTarget.tenantName, true);
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to delete.");
    }
  };

  const totalMonthlyRent = allTenants.reduce((t, tn) => t + tn.rentAmount, 0);
  const overdueCount = allTenants.filter(
    (t) => !t.unconfigured && !isTenantPaid(t) && getRentStatus(t.dueDay, t.lastPaidAt).label === "Overdue"
  ).length;
  const dueSoonCount = allTenants.filter(
    (t) => !t.unconfigured && !isTenantPaid(t) && getRentStatus(t.dueDay, t.lastPaidAt).label === "Due Soon"
  ).length;

  const toggleSearch = () => {
    const toValue = searchOpen ? 0 : 1;
    Animated.spring(searchAnim, { toValue, useNativeDriver: false, tension: 50, friction: 8 }).start();
    if (!searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 300);
    }
    setSearchOpen(!searchOpen);
  };

  const searchMaxHeight = searchAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 200] });
  const searchOpacity = searchAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <View style={s.root}>
      <Image
        source={require("../assets/login-bg.png")}
        style={s.bgImage}
        resizeMode="cover"
      />
      <View style={s.bgOverlay} />

      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scroll}>

          {/* ── HEADER ── */}
          <View style={s.headerRow}>
            <TouchableOpacity
              onPress={() => router.canGoBack() ? router.back() : router.replace("/dashboard")}
              style={s.backBtn}
            >
              <Feather name="arrow-left" size={22} color="#fff" />
            </TouchableOpacity>
            <Text style={s.headerTitle}>Tenant Assignment</Text>
            {(allTenants.length > 0 || searchOpen) && (
              <TouchableOpacity style={s.searchToggleBtn} onPress={toggleSearch}>
                <Feather name={searchOpen ? "x" : "search"} size={20} color="#fff" />
              </TouchableOpacity>
            )}
            {allTenants.length === 0 && !searchOpen && <View style={{ width: 44 }} />}
          </View>

          {/* ── SUMMARY CARDS ── */}
          <View style={s.summaryRow}>
            <View style={s.summaryCard}>
              <View style={[s.summaryIcon, { backgroundColor: "rgba(34,197,94,0.15)" }]}>
                <Feather name="dollar-sign" size={18} color="#22C55E" />
              </View>
              <Text style={s.summaryLabel}>Monthly Rent</Text>
              <Text style={s.summaryAmount}>
                ${totalMonthlyRent.toLocaleString()}
              </Text>
              <Text style={s.summarySub}>{allTenants.length} tenant{allTenants.length !== 1 ? "s" : ""}</Text>
            </View>
            <View style={s.summaryCard}>
              <View style={[s.summaryIcon, { backgroundColor: "rgba(239,68,68,0.15)" }]}>
                <Feather name="alert-triangle" size={18} color="#EF4444" />
              </View>
              <Text style={s.summaryLabel}>Overdue</Text>
              <Text style={[s.summaryAmount, { color: "#EF4444" }]}>{overdueCount}</Text>
              <Text style={s.summarySub}>Need attention</Text>
            </View>
          </View>
          {dueSoonCount > 0 && (
            <View style={s.dueSoonBanner}>
              <Feather name="clock" size={16} color="#FACC15" />
              <Text style={s.dueSoonText}>{dueSoonCount} rent{dueSoonCount > 1 ? "s" : ""} due within 3 days</Text>
            </View>
          )}

          {/* ── ACTION BUTTONS ── */}
          <View style={s.actionBtnRow}>
            <TouchableOpacity style={[s.addButton, { flex: 1 }]} onPress={() => setAssignModalOpen(true)}>
              <Feather name="user-plus" size={20} color="#fff" />
              <Text style={s.addButtonText}>Assign Tenant</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.exportBtn} onPress={() => router.push("/payouts")}>
              <Feather name="credit-card" size={20} color="#fff" />
            </TouchableOpacity>
            {allTenants.length > 0 && (
              <TouchableOpacity
                style={s.exportBtn}
                onPress={async () => {
                  if (await requirePlanFeature("exports", "Excel exports")) exportTenants(allTenants);
                }}
              >
                <Feather name="download" size={20} color="#fff" />
              </TouchableOpacity>
            )}
          </View>

          {/* ── SEARCH BAR (animated) ── */}
          {allTenants.length > 0 && (
            <Animated.View style={{ overflow: "hidden", maxHeight: searchMaxHeight, opacity: searchOpacity }}>
              <View style={s.searchContainer}>
                <Feather name="search" size={18} color="#64748B" style={s.searchIcon} />
                <TextInput
                  ref={searchInputRef}
                  style={s.searchInput}
                  placeholder="Search tenants..."
                  placeholderTextColor="#64748B"
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoCorrect={false}
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchQuery("")} style={s.clearBtn}>
                    <Feather name="x" size={16} color="#64748B" />
                  </TouchableOpacity>
                )}
              </View>

              {/* ── FILTER CHIPS ── */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
                {[
                  { key: null, label: "All", icon: "users" as const },
                  { key: "Overdue", label: "Overdue", icon: "alert-triangle" as const },
                  { key: "Due Soon", label: "Due Soon", icon: "clock" as const },
                  { key: "Paid", label: "Paid", icon: "check-circle" as const },
                  { key: "On Track", label: "On Track", icon: "calendar" as const },
                  { key: "unconfigured", label: "Needs Setup", icon: "alert-circle" as const },
                ].map((f) => (
                  <TouchableOpacity
                    key={f.label}
                    style={[s.filterChip, statusFilter === f.key && s.filterChipActive]}
                    onPress={() => setStatusFilter(statusFilter === f.key ? null : f.key)}
                  >
                    <Feather name={f.icon} size={13} color={statusFilter === f.key ? "#3B82F6" : "#94A3B8"} />
                    <Text style={[s.filterChipText, statusFilter === f.key && s.filterChipTextActive]}>
                      {f.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </Animated.View>
          )}

          {/* ── TENANT LIST ── */}
          {loading ? (
            <Text style={s.emptyText}>Loading...</Text>
          ) : allTenants.length === 0 ? (
            <View style={s.emptyState}>
              <Feather name="users" size={48} color="#334155" />
              <Text style={s.emptyText}>No tenants assigned yet</Text>
              <Text style={s.emptySub}>Assign a tenant to a property to start tracking rent</Text>
            </View>
          ) : filteredTenants.length === 0 ? (
            <View style={s.emptyState}>
              <Feather name="search" size={36} color="#334155" />
              <Text style={s.emptyText}>No tenants match your search</Text>
            </View>
          ) : (
            <>
              {filteredTenants.some((t) => t.unconfigured) && (
                <View style={s.hintBanner}>
                  <Feather name="info" size={16} color="#60A5FA" />
                  <Text style={s.hintBannerText}>
                    Some tenants from your properties need rent details. Tap to configure.
                  </Text>
                </View>
              )}
              {filteredTenants.map((tenant) => {
                const status = !tenant.unconfigured ? getRentStatus(tenant.dueDay, tenant.lastPaidAt) : null;
                return (
                  <View key={tenant.id} style={s.card}>
                    <View style={s.cardTopRow}>
                      <View style={[s.avatarCircle, tenant.unconfigured && s.avatarCircleDim]}>
                        <Feather
                          name={tenant.unconfigured ? "user-plus" : "user"}
                          size={20}
                          color={tenant.unconfigured ? "#475569" : "#60A5FA"}
                        />
                      </View>
                      <View style={s.cardInfoWrap}>
                        <Text style={[s.tenantName, tenant.unconfigured && s.textDim]} numberOfLines={1}>
                          {tenant.tenantName}
                        </Text>
                        <Text style={s.propertyName} numberOfLines={1}>{tenant.propertyName}</Text>
                      </View>
                      <TouchableOpacity style={s.moreBtn} onPress={() => {
                        setActionTenant(tenant);
                        setActionModalOpen(true);
                      }}>
                        <Feather name="more-vertical" size={18} color="#94A3B8" />
                      </TouchableOpacity>
                    </View>

                    {tenant.unconfigured ? (
                      <TouchableOpacity onPress={() => openEditModal(tenant)} activeOpacity={0.7}>
                        <View style={s.unconfRow}>
                          <Feather name="alert-circle" size={14} color="#FACC15" />
                          <Text style={s.unconfText}>Set up rent details</Text>
                        </View>
                      </TouchableOpacity>
                    ) : (
                      <>
                        <View style={s.cardDetailsRow}>
                          <View style={s.rentAmountWrap}>
                            <Text style={s.rentLabel}>Rent</Text>
                            <Text style={s.rentAmount}>${tenant.rentAmount.toLocaleString()}</Text>
                          </View>
                          <View style={s.dueDayWrap}>
                            <Text style={s.rentLabel}>Due Date</Text>
                            <Text style={s.dueDayText}>{formatDueDay(tenant.dueDay)}</Text>
                          </View>
                          <View style={s.statusWrap}>
                            <View style={[s.statusBadge, { backgroundColor: status!.color + "22", borderColor: status!.color + "44" }]}>
                              <Feather name={status!.icon} size={12} color={status!.color} />
                              <Text style={[s.statusText, { color: status!.color }]}>{status!.label}</Text>
                            </View>
                          </View>
                        </View>

                        {tenant.notes ? (
                          <View style={s.notesRow}>
                            <Feather name="file-text" size={13} color="#64748B" />
                            <Text style={s.notesText} numberOfLines={2}>{tenant.notes}</Text>
                          </View>
                        ) : null}

                        {isTenantPaid(tenant) ? (
                          <TouchableOpacity style={s.paidRow} activeOpacity={0.7} onPress={() => markAsUnpaid(tenant)}>
                            <Feather name="check-circle" size={14} color="#22C55E" />
                            <Text style={s.paidRowText}>Paid · {formatPaidAt(tenant.lastPaidAt)}</Text>
                            <Text style={s.paidUndoText}>Tap to undo</Text>
                          </TouchableOpacity>
                        ) : (
                          <TouchableOpacity style={s.paidBtn} activeOpacity={0.8} onPress={() => markAsPaid(tenant)}>
                            <Feather name="check" size={16} color="#22C55E" />
                            <Text style={s.paidBtnText}>Mark as Paid</Text>
                          </TouchableOpacity>
                        )}
                      </>
                    )}
                  </View>
                );
              })}
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>

      {/* ── PROPERTY SELECTOR MODAL ── */}
      <Modal visible={assignModalOpen} transparent animationType="slide" onRequestClose={() => setAssignModalOpen(false)}>
        <View style={s.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setAssignModalOpen(false)} />
          <View style={s.assignModalContent}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <View style={s.assignModalHeader}>
                <Text style={s.modalTitle}>Assign to Property</Text>
                <TouchableOpacity onPress={() => setAssignModalOpen(false)}>
                  <Feather name="x" size={22} color="#94A3B8" />
                </TouchableOpacity>
              </View>
              <Text style={s.assignSub}>Select a property to add a tenant:</Text>

              {properties.length === 0 ? (
                <Text style={s.emptySub}>No properties yet. Add a property first.</Text>
              ) : (
                properties.map((prop) => {
                  const existing = tenants.filter(
                    (t) => t.propertyName.toLowerCase() === prop.propertyName.toLowerCase()
                  );
                  return (
                    <View key={prop.id} style={s.assignCard}>
                      <Image
                        source={prop.photoUrl ? { uri: prop.photoUrl } : require("../assets/placeholder-building.png")}
                        style={s.assignCardPhoto}
                      />
                      <View style={s.assignCardInfo}>
                        <Text style={s.assignPropName} numberOfLines={1}>{prop.propertyName}</Text>
                        <Text style={s.assignPropAddr} numberOfLines={1}>{prop.address}</Text>
                        {existing.length > 0 && (
                          <View style={s.assignExistingRow}>
                            <Feather name="user-check" size={11} color="#22C55E" />
                            <Text style={s.assignExistingText}>
                              {existing.map((t) => t.tenantName).join(", ")}
                            </Text>
                          </View>
                        )}
                      </View>
                      <TouchableOpacity style={s.assignAddBtn} onPress={() => openAddModal(prop.propertyName)}>
                        <Feather name="plus" size={16} color="#fff" />
                        <Text style={s.assignAddBtnText}>Add</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })
              )}

              <TouchableOpacity style={s.cancelBtn} onPress={() => setAssignModalOpen(false)}>
                <Text style={s.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── ADD / EDIT MODAL ── */}
      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={() => setModalOpen(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={s.modalOverlay}>
            <TouchableOpacity style={{ flex: 1 }} onPress={() => setModalOpen(false)} />
            <View style={s.modalContent}>
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <Text style={s.modalTitle}>
                  {editingTenant?.id?.startsWith("unconf_")
                    ? "Configure Tenant"
                    : editingTenant
                      ? "Edit Tenant"
                      : "Add Tenant"}
                </Text>

                <Text style={s.fieldLabel}>Tenant Name *</Text>
                <TextInput style={s.input} placeholder="e.g. John Doe" placeholderTextColor="#64748B" value={formTenantName} onChangeText={setFormTenantName} />

                <Text style={s.fieldLabel}>Tenant Email (for web portal login)</Text>
                <TextInput style={s.input} placeholder="e.g. john@email.com" placeholderTextColor="#64748B" keyboardType="email-address" autoCapitalize="none" value={formTenantEmail} onChangeText={setFormTenantEmail} />

                <Text style={s.fieldLabel}>Property Name *</Text>
                <TextInput style={s.input} placeholder="e.g. Sunset Apartments" placeholderTextColor="#64748B" value={formPropertyName} onChangeText={setFormPropertyName} />

                <Text style={s.fieldLabel}>Monthly Rent Amount *</Text>
                <TextInput style={s.input} placeholder="e.g. 1500" placeholderTextColor="#64748B" keyboardType="decimal-pad" value={formRentAmount} onChangeText={setFormRentAmount} />

                <Text style={s.fieldLabel}>Rent Due Day</Text>
                <TouchableOpacity style={s.dropdownBtn} onPress={() => setDueDayPickerOpen(true)}>
                  <Text style={s.dropdownBtnText}>{formatDueDay(formDueDay)}</Text>
                  <Feather name="chevron-down" size={18} color="#fff" />
                </TouchableOpacity>

                <Text style={s.fieldLabel}>Notes (Optional)</Text>
                <TextInput style={[s.input, { height: 80, textAlignVertical: "top" }]} placeholder="Any notes about this tenant..." placeholderTextColor="#64748B" multiline value={formNotes} onChangeText={setFormNotes} />

                <TouchableOpacity style={[s.saveBtn, { opacity: saving ? 0.7 : 1 }]} onPress={handleSave} disabled={saving}>
                  {!saving && <Feather name="check-circle" size={18} color="#fff" style={{ marginRight: 8 }} />}
                  <Text style={s.saveBtnText}>
                    {saving ? "Saving..." : editingTenant ? "Update Tenant" : "Add Tenant"}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.cancelBtn} onPress={() => setModalOpen(false)}>
                  <Text style={s.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── DUE DAY PICKER ── */}
      <Modal visible={dueDayPickerOpen} transparent animationType="fade" onRequestClose={() => setDueDayPickerOpen(false)}>
        <View style={s.pickerOverlay}>
          <View style={s.pickerContent}>
            <Text style={s.pickerTitle}>Select Due Day</Text>
            <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
              {DUE_DAY_OPTIONS.map((day) => (
                <TouchableOpacity
                  key={String(day)}
                  style={[s.pickerItem, formDueDay === day && s.pickerItemActive]}
                  onPress={() => { setFormDueDay(day); setDueDayPickerOpen(false); }}
                >
                  <Text style={[s.pickerItemText, formDueDay === day && s.pickerItemTextActive]}>
                    {day === "last" ? "Last day of month" : ordinalSuffix(day as number)}
                  </Text>
                  {formDueDay === day && <Feather name="check" size={18} color="#3B82F6" />}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.pickerCloseBtn} onPress={() => setDueDayPickerOpen(false)}>
              <Text style={s.pickerCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── ACTION SHEET ── */}
      <Modal visible={actionModalOpen} transparent animationType="slide" onRequestClose={() => setActionModalOpen(false)}>
        <View style={s.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setActionModalOpen(false)} />
          <View style={s.actionSheet}>
            <Text style={s.actionSheetTitle}>{actionTenant?.tenantName}</Text>
            {actionTenant && !actionTenant.unconfigured && (
              <>
                <TouchableOpacity style={s.actionBtn} onPress={() => {
                  const t = actionTenant;
                  setActionModalOpen(false);
                  if (isTenantPaid(t)) markAsUnpaid(t);
                  else markAsPaid(t);
                }}>
                  <Feather name={isTenantPaid(actionTenant) ? "rotate-ccw" : "check-circle"} size={18} color="#22C55E" />
                  <Text style={[s.actionBtnText, { color: "#22C55E" }]}>
                    {isTenantPaid(actionTenant) ? "Mark as Unpaid" : "Mark as Paid"}
                  </Text>
                </TouchableOpacity>
                <View style={s.actionDivider} />
              </>
            )}
            <TouchableOpacity style={s.actionBtn} onPress={() => {
              if (actionTenant) openEditModal(actionTenant);
              setActionModalOpen(false);
            }}>
              <Feather name="edit-2" size={18} color="#60A5FA" />
              <Text style={s.actionBtnText}>Edit</Text>
            </TouchableOpacity>
            <View style={s.actionDivider} />
            <TouchableOpacity style={s.actionBtn} onPress={() => {
              const t = actionTenant;
              setActionModalOpen(false);
              if (t) handleDelete(t);
            }}>
              <Feather name="trash-2" size={18} color="#EF4444" />
              <Text style={[s.actionBtnText, { color: "#EF4444" }]}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.cancelBtn, { marginTop: 12 }]} onPress={() => setActionModalOpen(false)}>
              <Text style={s.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── DELETE CONFIRMATION ── */}
      <Modal visible={deleteConfirmOpen} transparent animationType="fade" onRequestClose={() => setDeleteConfirmOpen(false)}>
        <View style={s.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setDeleteConfirmOpen(false)} />
          <View style={s.deleteConfirmContent}>
            <Text style={s.deleteConfirmTitle}>Delete Tenant</Text>
            <Text style={s.deleteConfirmSub}>Remove {deleteTarget?.tenantName} from your list?</Text>
            <View style={s.deleteConfirmActions}>
              <TouchableOpacity style={[s.cancelBtn, { flex: 1 }]} onPress={() => setDeleteConfirmOpen(false)}>
                <Text style={s.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.deleteBtn, { flex: 1 }]} onPress={executeDelete}>
                <Text style={s.deleteBtnText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#060D1C" },
  bgImage: { position: "absolute", width: "100%", height: "100%" },
  bgOverlay: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(5,10,20,0.78)" },
  scroll: { padding: SW < 400 ? 16 : 20, gap: 14, paddingBottom: 60 },

  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  backBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },
  headerTitle: { color: "#fff", fontSize: SW < 400 ? 24 : 30, fontWeight: "900", letterSpacing: 0.5 },
  searchToggleBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },

  summaryRow: { flexDirection: "row", gap: 12 },
  summaryCard: { flex: 1, backgroundColor: "rgba(13,25,50,0.95)", borderRadius: 22, padding: 18, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },
  summaryIcon: { width: 40, height: 40, borderRadius: 12, justifyContent: "center", alignItems: "center", marginBottom: 14 },
  summaryLabel: { color: "#B8C3D9", fontSize: 13, lineHeight: 20, marginBottom: 8 },
  summaryAmount: { color: "#fff", fontSize: 24, fontWeight: "800", marginBottom: 4 },
  summarySub: { color: "#64748B", fontSize: 12 },

  dueSoonBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(250,204,21,0.1)", borderRadius: 16, padding: 14, borderWidth: 1, borderColor: "rgba(250,204,21,0.25)" },
  dueSoonText: { color: "#FACC15", fontSize: 14, fontWeight: "700" },

  actionBtnRow: { flexDirection: "row", gap: 10, marginBottom: 6 },
  addButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#2563EB", paddingVertical: SW < 400 ? 14 : 16, borderRadius: 16, gap: 8 },
  addButtonText: { color: "#fff", fontSize: SW < 400 ? 16 : 18, fontWeight: "800" },
  exportBtn: { width: 52, height: "auto", backgroundColor: "#1E40AF", borderRadius: 16, justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: "rgba(96,165,250,0.3)" },

  hintBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(59,130,246,0.1)", borderRadius: 16, padding: 14, borderWidth: 1, borderColor: "rgba(59,130,246,0.25)" },
  hintBannerText: { color: "#60A5FA", fontSize: 13, fontWeight: "600", flex: 1 },

  emptyState: { alignItems: "center", padding: 40, gap: 8 },
  emptyText: { color: "#64748B", textAlign: "center", padding: 24, fontSize: 16 },
  emptySub: { color: "#475569", fontSize: 13, textAlign: "center" },

  // ── Search & Filter ──
  searchContainer: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(30,41,59,0.7)", borderRadius: 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)", paddingHorizontal: 14, marginBottom: 4 },
  searchIcon: { marginRight: 10 },
  searchInput: { flex: 1, color: "#fff", fontSize: 15, paddingVertical: 14, fontWeight: "600" },
  clearBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.08)", justifyContent: "center", alignItems: "center" },
  filterRow: { flexDirection: "row", gap: 8, paddingVertical: 4, marginBottom: 4 },
  filterChip: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(30,41,59,0.7)", paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  filterChipActive: { backgroundColor: "rgba(59,130,246,0.15)", borderColor: "rgba(59,130,246,0.4)" },
  filterChipText: { color: "#94A3B8", fontSize: 13, fontWeight: "700" },
  filterChipTextActive: { color: "#3B82F6" },

  card: { backgroundColor: "rgba(14,22,42,0.92)", borderRadius: 22, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)", padding: SW < 400 ? 14 : 16 },
  cardTopRow: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  avatarCircle: { width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(59,130,246,0.15)", justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: "rgba(59,130,246,0.2)" },
  avatarCircleDim: { backgroundColor: "rgba(71,85,105,0.2)", borderColor: "rgba(71,85,105,0.3)" },
  cardInfoWrap: { flex: 1, marginLeft: 12 },
  tenantName: { color: "#fff", fontSize: SW < 400 ? 16 : 17, fontWeight: "900" },
  propertyName: { color: "#94A3B8", fontSize: SW < 400 ? 12 : 13, marginTop: 2 },
  textDim: { color: "#64748B" },
  moreBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.06)", justifyContent: "center", alignItems: "center" },

  cardDetailsRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  rentAmountWrap: { flex: 1 },
  rentLabel: { color: "#64748B", fontSize: 11, marginBottom: 2 },
  rentAmount: { color: "#22C55E", fontSize: 18, fontWeight: "900" },
  dueDayWrap: { flex: 1 },
  dueDayText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  statusWrap: { alignItems: "flex-end" },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, borderWidth: 1 },
  statusText: { fontSize: 11, fontWeight: "800" },

  notesRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, backgroundColor: "rgba(11,17,32,0.8)", borderRadius: 12, padding: 10 },
  notesText: { color: "#94A3B8", fontSize: 12, flex: 1 },

  paidBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 12, backgroundColor: "rgba(34,197,94,0.12)", borderWidth: 1, borderColor: "rgba(34,197,94,0.35)", borderRadius: 14, paddingVertical: 12 },
  paidBtnText: { color: "#22C55E", fontSize: 14, fontWeight: "800" },

  paidRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12, backgroundColor: "rgba(34,197,94,0.1)", borderWidth: 1, borderColor: "rgba(34,197,94,0.3)", borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14 },
  paidRowText: { color: "#22C55E", fontSize: 13, fontWeight: "800", flex: 1 },
  paidUndoText: { color: "#64748B", fontSize: 12, fontWeight: "600" },

  unconfRow: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(250,204,21,0.08)", borderRadius: 12, padding: 10 },
  unconfText: { color: "#FACC15", fontSize: 13, fontWeight: "700" },

  actionSheet: { backgroundColor: "rgba(15,23,42,0.98)", borderRadius: 28, padding: SW < 400 ? 20 : 24, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },
  actionSheetTitle: { color: "#fff", fontSize: SW < 400 ? 18 : 20, fontWeight: "900", marginBottom: 16, textAlign: "center" },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 8 },
  actionBtnText: { color: "#CBD5E1", fontSize: 16, fontWeight: "700" },
  actionDivider: { height: 1, backgroundColor: "rgba(255,255,255,0.06)" },

  deleteConfirmContent: { backgroundColor: "rgba(15,23,42,0.98)", borderRadius: 28, padding: SW < 400 ? 20 : 24, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)", marginHorizontal: 20 },
  deleteConfirmTitle: { color: "#fff", fontSize: SW < 400 ? 18 : 20, fontWeight: "900", marginBottom: 8, textAlign: "center" },
  deleteConfirmSub: { color: "#94A3B8", fontSize: 14, textAlign: "center", marginBottom: 20, lineHeight: 20 },
  deleteConfirmActions: { flexDirection: "row", gap: 10 },
  deleteBtn: { backgroundColor: "#DC2626", padding: 14, borderRadius: 16, alignItems: "center" },
  deleteBtnText: { color: "#fff", fontSize: 16, fontWeight: "800" },

  assignModalContent: { backgroundColor: "rgba(15,23,42,0.98)", borderRadius: 28, padding: SW < 400 ? 20 : 24, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)", maxHeight: "80%" },
  assignModalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  assignSub: { color: "#94A3B8", fontSize: 14, marginBottom: 16 },
  assignCard: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(14,22,42,0.92)", borderRadius: 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)", padding: 12, marginBottom: 10 },
  assignCardPhoto: { width: 48, height: 48, borderRadius: 10, backgroundColor: "#1E293B" },
  assignCardInfo: { flex: 1, marginLeft: 12 },
  assignPropName: { color: "#fff", fontSize: 15, fontWeight: "800" },
  assignPropAddr: { color: "#64748B", fontSize: 12, marginTop: 2 },
  assignExistingRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  assignExistingText: { color: "#22C55E", fontSize: 11, fontWeight: "600", flex: 1 },
  assignAddBtn: { flexDirection: "row", alignItems: "center", backgroundColor: "#2563EB", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, gap: 4 },
  assignAddBtnText: { color: "#fff", fontSize: 13, fontWeight: "800" },

  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalContent: { backgroundColor: "rgba(15,23,42,0.98)", borderRadius: 28, padding: SW < 400 ? 20 : 24, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)", maxHeight: "90%" },
  modalTitle: { color: "#fff", fontSize: SW < 400 ? 20 : 22, fontWeight: "900", marginBottom: 20 },

  fieldLabel: { color: "#94A3B8", fontSize: 13, marginBottom: 8, fontWeight: "700" },
  input: { backgroundColor: "rgba(30,41,59,0.7)", color: "#fff", padding: 14, borderRadius: 16, marginBottom: 16, fontSize: SW < 400 ? 14 : 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },

  dropdownBtn: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "rgba(30,41,59,0.7)", padding: 14, borderRadius: 16, marginBottom: 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  dropdownBtnText: { color: "#fff", fontSize: SW < 400 ? 14 : 16, fontWeight: "700" },

  saveBtn: { backgroundColor: "#3B82F6", padding: 16, borderRadius: 16, alignItems: "center", marginBottom: 10, flexDirection: "row", justifyContent: "center" },
  saveBtnText: { color: "#fff", fontSize: 16, fontWeight: "900" },
  cancelBtn: { backgroundColor: "#475569", padding: 14, borderRadius: 16, alignItems: "center" },
  cancelBtnText: { color: "#fff", fontSize: 16, fontWeight: "900" },

  pickerOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 20 },
  pickerContent: { backgroundColor: "rgba(15,23,42,0.98)", borderRadius: 22, padding: 20, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },
  pickerTitle: { color: "#fff", fontSize: 18, fontWeight: "900", marginBottom: 16 },
  pickerItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  pickerItemActive: { backgroundColor: "rgba(59,130,246,0.1)", borderRadius: 12 },
  pickerItemText: { color: "#CBD5E1", fontSize: 16, fontWeight: "700" },
  pickerItemTextActive: { color: "#3B82F6" },
  pickerCloseBtn: { backgroundColor: "#475569", padding: 14, borderRadius: 16, alignItems: "center", marginTop: 12 },
  pickerCloseBtnText: { color: "#fff", fontSize: 16, fontWeight: "900" },
});
