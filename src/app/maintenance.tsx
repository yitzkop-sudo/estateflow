import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { useEffect, useState } from "react";
import {
  Alert,
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
import { auth, db } from "../lib/firebase";

const { width: SW } = Dimensions.get("window");

type Maintenance = {
  id: string;
  propertyId?: string;
  propertyName: string;
  title: string;
  cost?: number;
  date?: any;
  status: "pending" | "in-progress" | "done";
  createdAt: any;
  description?: string;
  tenantName?: string;
  source: "manual" | "tenant";
};

type Property = {
  id: string;
  propertyName: string;
  address: string;
  photoUrl?: string | null;
};

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const toDateStr = (v: any) => {
  const d = v?.toDate ? v.toDate() : v ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const parseDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
};

export default function MaintenanceScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Maintenance[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Maintenance | null>(null);
  const [saving, setSaving] = useState(false);

  const [formPropertyId, setFormPropertyId] = useState("");
  const [formPropertyName, setFormPropertyName] = useState("");
  const [formTitle, setFormTitle] = useState("");
  const [formCost, setFormCost] = useState("");
  const [formDate, setFormDate] = useState(todayStr());
  const [formStatus, setFormStatus] = useState<"pending" | "done">("pending");

  const [propertyPickerOpen, setPropertyPickerOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [actionItem, setActionItem] = useState<Maintenance | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Maintenance | null>(null);

  useEffect(() => {
    let unsubSnapshot: (() => void) | null = null;
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (!user) {
        setItems([]);
        setProperties([]);
        setLoading(false);
        router.replace("/login");
        return;
      }
      unsubSnapshot = loadItems(user.uid);
      loadProperties(user.uid);
    });
    return () => {
      unsubAuth();
      unsubSnapshot?.();
    };
  }, []);

  const loadItems = (uid: string) => {
    const q = query(collection(db, "maintenance"), where("ownerId", "==", uid));
    const reqQ = query(collection(db, "maintenance_requests"), where("ownerId", "==", uid));

    let manual: Maintenance[] = [];
    let tenantReq: Maintenance[] = [];
    let manualDone = false;
    let reqDone = false;

    const combine = () => {
      if (!manualDone || !reqDone) return;
      const list = [...manual, ...tenantReq].sort((a, b) => {
        const ad = a.date?.toDate ? a.date.toDate() : a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.date || a.createdAt);
        const bd = b.date?.toDate ? b.date.toDate() : b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.date || b.createdAt);
        return bd.getTime() - ad.getTime();
      });
      setItems(list);
      setLoading(false);
    };

    const unsubManual = onSnapshot(q, (snap) => {
      manual = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as object),
        source: "manual" as const,
      })) as Maintenance[];
      manualDone = true;
      combine();
    });

    const unsubReqs = onSnapshot(reqQ, (snap) => {
      tenantReq = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as object),
        source: "tenant" as const,
      })) as Maintenance[];
      reqDone = true;
      combine();
    });

    return () => {
      unsubManual();
      unsubReqs();
    };
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

  const openAddModal = () => {
    setEditing(null);
    setFormPropertyId("");
    setFormPropertyName("");
    setFormTitle("");
    setFormCost("");
    setFormDate(todayStr());
    setFormStatus("pending");
    setModalOpen(true);
  };

  const openEditModal = (item: Maintenance) => {
    if (item.source === "tenant") return; // tenant requests aren't edited from this form
    setEditing(item);
    setFormPropertyId(item.propertyId || "");
    setFormPropertyName(item.propertyName);
    setFormTitle(item.title);
    setFormCost(String(item.cost ?? ""));
    setFormDate(toDateStr(item.date));
    setFormStatus(item.status === "done" ? "done" : "pending");
    setActionOpen(false);
    setModalOpen(true);
  };

  const handleSave = async () => {
    const user = auth.currentUser;
    if (!user) return;

    if (!formPropertyName.trim()) {
      Alert.alert("Required", "Select a property.");
      return;
    }
    if (!formTitle.trim()) {
      Alert.alert("Required", "Enter a maintenance title.");
      return;
    }
    const cost = parseFloat(formCost);
    if (!formCost.trim() || isNaN(cost) || cost < 0) {
      Alert.alert("Required", "Enter a valid cost.");
      return;
    }
    const date = parseDate(formDate);
    if (!date) {
      Alert.alert("Required", "Enter a valid date (YYYY-MM-DD).");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ownerId: user.uid,
        propertyId: formPropertyId,
        propertyName: formPropertyName.trim(),
        title: formTitle.trim(),
        cost,
        date,
        status: formStatus,
        createdAt: serverTimestamp(),
      };
      if (editing) {
        const { createdAt, ...rest } = payload as any;
        await updateDoc(doc(db, "maintenance", editing.id), rest);
      } else {
        await addDoc(collection(db, "maintenance"), payload);
      }
      setModalOpen(false);
      setSaving(false);
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to save maintenance.");
      setSaving(false);
    }
  };

  const toggleStatus = async (item: Maintenance) => {
    try {
      const next = item.status === "done" ? "pending" : "done";
      const col = item.source === "tenant" ? "maintenance_requests" : "maintenance";
      await updateDoc(doc(db, col, item.id), { status: next });
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to update status.");
    }
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    try {
      const col = deleteTarget.source === "tenant" ? "maintenance_requests" : "maintenance";
      await deleteDoc(doc(db, col, deleteTarget.id));
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to delete.");
    }
  };

  const pendingCount = items.filter((i) => i.status === "pending").length;
  const totalCost = items.reduce((s, i) => s + (i.cost || 0), 0);

  const selectProperty = (p: Property) => {
    setFormPropertyId(p.id);
    setFormPropertyName(p.propertyName);
    setPropertyPickerOpen(false);
  };

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
            <Text style={s.headerTitle}>Maintenance</Text>
            <View style={{ width: 44 }} />
          </View>

          {/* ── SUMMARY CARDS ── */}
          <View style={s.summaryRow}>
            <View style={s.summaryCard}>
              <View style={[s.summaryIcon, { backgroundColor: "rgba(245,158,11,0.15)" }]}>
                <Feather name="tool" size={18} color="#F59E0B" />
              </View>
              <Text style={s.summaryLabel}>Pending</Text>
              <Text style={[s.summaryAmount, { color: "#F59E0B" }]}>{pendingCount}</Text>
              <Text style={s.summarySub}>Need attention</Text>
            </View>
            <View style={s.summaryCard}>
              <View style={[s.summaryIcon, { backgroundColor: "rgba(34,197,94,0.15)" }]}>
                <Feather name="dollar-sign" size={18} color="#22C55E" />
              </View>
              <Text style={s.summaryLabel}>Total Cost</Text>
              <Text style={s.summaryAmount}>${totalCost.toLocaleString()}</Text>
              <Text style={s.summarySub}>{items.length} record{items.length !== 1 ? "s" : ""}</Text>
            </View>
          </View>

          {/* ── ADD MAINTENANCE BUTTON ── */}
          <TouchableOpacity style={s.addButton} onPress={openAddModal}>
            <Feather name="plus" size={20} color="#fff" />
            <Text style={s.addButtonText}>Add Maintenance</Text>
          </TouchableOpacity>

          {/* ── MAINTENANCE LIST ── */}
          {loading ? (
            <Text style={s.emptyText}>Loading...</Text>
          ) : items.length === 0 ? (
            <View style={s.emptyState}>
              <Feather name="tool" size={48} color="#334155" />
              <Text style={s.emptyText}>No maintenance records yet</Text>
              <Text style={s.emptySub}>Add repairs or upkeep you need to do on a property</Text>
            </View>
          ) : (
            items.map((item) => {
              const done = item.status === "done";
              const inProgress = item.status === "in-progress";
              const accent = done ? "#22C55E" : inProgress ? "#60A5FA" : "#F59E0B";
              const statusLabel = done ? "Done" : inProgress ? "In Progress" : "Pending";
              return (
                <View key={item.id} style={s.card}>
                  <View style={s.cardTopRow}>
                    <View style={[s.avatarCircle, done && s.avatarCircleDone]}>
                      <Feather name="tool" size={18} color={accent} />
                    </View>
                    <View style={s.cardInfoWrap}>
                      <Text style={s.itemTitle} numberOfLines={1}>{item.title}</Text>
                      <Text style={s.propertyName} numberOfLines={1}>
                        {item.propertyName}{item.tenantName ? ` · ${item.tenantName}` : ""}
                      </Text>
                    </View>
                    <TouchableOpacity style={s.moreBtn} onPress={() => { setActionItem(item); setActionOpen(true); }}>
                      <Feather name="more-vertical" size={18} color="#94A3B8" />
                    </TouchableOpacity>
                  </View>

                  {item.source === "tenant" && item.description ? (
                    <Text style={s.requestDesc} numberOfLines={3}>{item.description}</Text>
                  ) : null}

                  <View style={s.cardDetailsRow}>
                    {item.source !== "tenant" ? (
                      <>
                        <View style={s.costWrap}>
                          <Text style={s.detailLabel}>Cost</Text>
                          <Text style={s.costText}>${(item.cost || 0).toLocaleString()}</Text>
                        </View>
                        <View style={s.dateWrap}>
                          <Text style={s.detailLabel}>Date</Text>
                          <Text style={s.dateText}>{toDateStr(item.date) || "—"}</Text>
                        </View>
                      </>
                    ) : (
                      <View style={[s.costWrap, { flex: 2 }]}>
                        <Text style={s.detailLabel}>{item.tenantName ? "Requested by" : "Tenant request"}</Text>
                        <Text style={s.dateText}>{item.tenantName || "—"}</Text>
                      </View>
                    )}
                    <View style={s.statusWrap}>
                      <View style={[s.statusBadge, { backgroundColor: accent + "22", borderColor: accent + "44" }]}>
                        <Feather name={done ? "check-circle" : "clock"} size={12} color={accent} />
                        <Text style={[s.statusText, { color: accent }]}>
                          {statusLabel}
                        </Text>
                      </View>
                    </View>
                  </View>

                  <TouchableOpacity
                    style={[s.toggleBtn, done ? s.toggleBtnDone : s.toggleBtnPending]}
                    activeOpacity={0.8}
                    onPress={() => toggleStatus(item)}
                  >
                    <Feather name={done ? "rotate-ccw" : "check"} size={16} color={accent} />
                    <Text style={[s.toggleBtnText, { color: accent }]}>
                      {done ? "Mark as Pending" : "Mark as Done"}
                    </Text>
                  </TouchableOpacity>
                </View>
              );
            })
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>

      {/* ── ADD / EDIT MODAL ── */}
      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={() => setModalOpen(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={s.modalOverlay}>
            <TouchableOpacity style={{ flex: 1 }} onPress={() => setModalOpen(false)} />
            <View style={s.modalContent}>
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <Text style={s.modalTitle}>{editing ? "Edit Maintenance" : "Add Maintenance"}</Text>

                <Text style={s.fieldLabel}>Property *</Text>
                <TouchableOpacity style={s.dropdownBtn} onPress={() => setPropertyPickerOpen(true)}>
                  <Text style={[s.dropdownBtnText, !formPropertyName && { color: "#64748B" }]}>
                    {formPropertyName || "Select a property"}
                  </Text>
                  <Feather name="chevron-down" size={18} color="#fff" />
                </TouchableOpacity>

                <Text style={s.fieldLabel}>Title *</Text>
                <TextInput style={s.input} placeholder="e.g. Fix leaking faucet" placeholderTextColor="#64748B" value={formTitle} onChangeText={setFormTitle} />

                <Text style={s.fieldLabel}>Cost ($) *</Text>
                <TextInput style={s.input} placeholder="e.g. 150" placeholderTextColor="#64748B" keyboardType="decimal-pad" value={formCost} onChangeText={setFormCost} />

                <Text style={s.fieldLabel}>Date (YYYY-MM-DD) *</Text>
                <TextInput style={s.input} placeholder="e.g. 2026-08-14" placeholderTextColor="#64748B" autoCapitalize="none" value={formDate} onChangeText={setFormDate} />

                <Text style={s.fieldLabel}>Status</Text>
                <View style={s.statusToggleRow}>
                  <TouchableOpacity
                    style={[s.statusToggle, formStatus === "pending" && s.statusTogglePendingActive]}
                    onPress={() => setFormStatus("pending")}
                  >
                    <Text style={[s.statusToggleText, { color: formStatus === "pending" ? "#F59E0B" : "#94A3B8" }]}>
                      Pending
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.statusToggle, formStatus === "done" && s.statusToggleDoneActive]}
                    onPress={() => setFormStatus("done")}
                  >
                    <Text style={[s.statusToggleText, { color: formStatus === "done" ? "#22C55E" : "#94A3B8" }]}>
                      Done
                    </Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity style={[s.saveBtn, { opacity: saving ? 0.7 : 1 }]} onPress={handleSave} disabled={saving}>
                  {!saving && <Feather name="check-circle" size={18} color="#fff" style={{ marginRight: 8 }} />}
                  <Text style={s.saveBtnText}>{saving ? "Saving..." : editing ? "Update" : "Add"}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.cancelBtn} onPress={() => setModalOpen(false)}>
                  <Text style={s.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── PROPERTY PICKER ── */}
      <Modal visible={propertyPickerOpen} transparent animationType="slide" onRequestClose={() => setPropertyPickerOpen(false)}>
        <View style={s.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setPropertyPickerOpen(false)} />
          <View style={s.pickerContent}>
            <Text style={s.modalTitle}>Select Property</Text>
            <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled>
              {properties.length === 0 ? (
                <Text style={s.emptySub}>No properties yet. Add a property first.</Text>
              ) : (
                properties.map((p) => (
                  <TouchableOpacity key={p.id} style={s.pickerItem} onPress={() => selectProperty(p)}>
                    <View style={s.pickerItemLeft}>
                      <Text style={s.pickerItemName} numberOfLines={1}>{p.propertyName}</Text>
                      <Text style={s.pickerItemAddr} numberOfLines={1}>{p.address}</Text>
                    </View>
                    {formPropertyName === p.propertyName && <Feather name="check" size={18} color="#3B82F6" />}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setPropertyPickerOpen(false)}>
              <Text style={s.cancelBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── ACTION SHEET ── */}
      <Modal visible={actionOpen} transparent animationType="slide" onRequestClose={() => setActionOpen(false)}>
        <View style={s.modalOverlay}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setActionOpen(false)} />
          <View style={s.actionSheet}>
            <Text style={s.actionSheetTitle}>{actionItem?.title}</Text>
            <TouchableOpacity style={s.actionBtn} onPress={() => {
              if (actionItem) toggleStatus(actionItem);
              setActionOpen(false);
            }}>
              <Feather name={actionItem?.status === "done" ? "rotate-ccw" : "check-circle"} size={18} color="#F59E0B" />
              <Text style={[s.actionBtnText, { color: "#F59E0B" }]}>
                {actionItem?.status === "done" ? "Mark as Pending" : "Mark as Done"}
              </Text>
            </TouchableOpacity>
            {actionItem?.source !== "tenant" && (
              <>
                <View style={s.actionDivider} />
                <TouchableOpacity style={s.actionBtn} onPress={() => {
                  if (actionItem) openEditModal(actionItem);
                }}>
                  <Feather name="edit-2" size={18} color="#60A5FA" />
                  <Text style={s.actionBtnText}>Edit</Text>
                </TouchableOpacity>
              </>
            )}
            <View style={s.actionDivider} />
            <TouchableOpacity style={s.actionBtn} onPress={() => {
              const t = actionItem;
              setActionOpen(false);
              if (t) { setDeleteTarget(t); setDeleteConfirmOpen(true); }
            }}>
              <Feather name="trash-2" size={18} color="#EF4444" />
              <Text style={[s.actionBtnText, { color: "#EF4444" }]}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.cancelBtn, { marginTop: 12 }]} onPress={() => setActionOpen(false)}>
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
            <Text style={s.deleteConfirmTitle}>Delete Record</Text>
            <Text style={s.deleteConfirmSub}>Remove "{deleteTarget?.title}" from your maintenance list?</Text>
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
  bgOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(5,10,20,0.78)" },
  scroll: { padding: SW < 400 ? 16 : 20, gap: 14, paddingBottom: 60 },

  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  backBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },
  headerTitle: { color: "#fff", fontSize: SW < 400 ? 24 : 30, fontWeight: "900", letterSpacing: 0.5 },

  summaryRow: { flexDirection: "row", gap: 12 },
  summaryCard: { flex: 1, backgroundColor: "rgba(13,25,50,0.95)", borderRadius: 22, padding: 18, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },
  summaryIcon: { width: 40, height: 40, borderRadius: 12, justifyContent: "center", alignItems: "center", marginBottom: 14 },
  summaryLabel: { color: "#B8C3D9", fontSize: 13, lineHeight: 20, marginBottom: 8 },
  summaryAmount: { color: "#fff", fontSize: 24, fontWeight: "800", marginBottom: 4 },
  summarySub: { color: "#64748B", fontSize: 12 },

  addButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#2563EB", paddingVertical: SW < 400 ? 14 : 16, borderRadius: 16, gap: 8, marginBottom: 6 },
  addButtonText: { color: "#fff", fontSize: SW < 400 ? 16 : 18, fontWeight: "800" },

  emptyState: { alignItems: "center", padding: 40, gap: 8 },
  emptyText: { color: "#64748B", textAlign: "center", padding: 24, fontSize: 16 },
  emptySub: { color: "#475569", fontSize: 13, textAlign: "center" },

  card: { backgroundColor: "rgba(14,22,42,0.92)", borderRadius: 22, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)", padding: SW < 400 ? 14 : 16 },
  cardTopRow: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  avatarCircle: { width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(245,158,11,0.15)", justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: "rgba(245,158,11,0.3)" },
  avatarCircleDone: { backgroundColor: "rgba(34,197,94,0.15)", borderColor: "rgba(34,197,94,0.3)" },
  cardInfoWrap: { flex: 1, marginLeft: 12 },
  itemTitle: { color: "#fff", fontSize: SW < 400 ? 16 : 17, fontWeight: "900" },
  propertyName: { color: "#94A3B8", fontSize: SW < 400 ? 12 : 13, marginTop: 2 },
  moreBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.06)", justifyContent: "center", alignItems: "center" },

  cardDetailsRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  requestDesc: { color: "#94A3B8", fontSize: 13, lineHeight: 20, marginBottom: 10 },
  costWrap: { flex: 1 },
  dateWrap: { flex: 1 },
  detailLabel: { color: "#64748B", fontSize: 11, marginBottom: 2 },
  costText: { color: "#F59E0B", fontSize: 18, fontWeight: "900" },
  dateText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  statusWrap: { alignItems: "flex-end" },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, borderWidth: 1 },
  statusText: { fontSize: 11, fontWeight: "800" },

  toggleBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 12, borderRadius: 14, paddingVertical: 12, borderWidth: 1 },
  toggleBtnPending: { backgroundColor: "rgba(245,158,11,0.12)", borderColor: "rgba(245,158,11,0.35)" },
  toggleBtnDone: { backgroundColor: "rgba(34,197,94,0.12)", borderColor: "rgba(34,197,94,0.35)" },
  toggleBtnText: { fontSize: 14, fontWeight: "800" },

  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalContent: { backgroundColor: "rgba(15,23,42,0.98)", borderRadius: 28, padding: SW < 400 ? 20 : 24, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)", maxHeight: "90%" },
  modalTitle: { color: "#fff", fontSize: SW < 400 ? 20 : 22, fontWeight: "900", marginBottom: 20 },

  fieldLabel: { color: "#94A3B8", fontSize: 13, marginBottom: 8, fontWeight: "700" },
  input: { backgroundColor: "rgba(30,41,59,0.7)", color: "#fff", padding: 14, borderRadius: 16, marginBottom: 16, fontSize: SW < 400 ? 14 : 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  dropdownBtn: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "rgba(30,41,59,0.7)", padding: 14, borderRadius: 16, marginBottom: 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  dropdownBtnText: { color: "#fff", fontSize: SW < 400 ? 14 : 16, fontWeight: "700", flex: 1, marginRight: 8 },

  statusToggleRow: { flexDirection: "row", gap: 10, marginBottom: 20 },
  statusToggle: { flex: 1, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: "rgba(148,163,184,0.25)", backgroundColor: "rgba(30,41,59,0.5)", alignItems: "center" },
  statusTogglePendingActive: { borderColor: "rgba(245,158,11,0.5)", backgroundColor: "rgba(245,158,11,0.12)" },
  statusToggleDoneActive: { borderColor: "rgba(34,197,94,0.5)", backgroundColor: "rgba(34,197,94,0.12)" },
  statusToggleText: { fontSize: 15, fontWeight: "800" },

  saveBtn: { backgroundColor: "#3B82F6", padding: 16, borderRadius: 16, alignItems: "center", marginBottom: 10, flexDirection: "row", justifyContent: "center" },
  saveBtnText: { color: "#fff", fontSize: 16, fontWeight: "900" },
  cancelBtn: { backgroundColor: "#475569", padding: 14, borderRadius: 16, alignItems: "center" },
  cancelBtnText: { color: "#fff", fontSize: 16, fontWeight: "900" },

  pickerContent: { backgroundColor: "rgba(15,23,42,0.98)", borderRadius: 28, padding: SW < 400 ? 20 : 24, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },
  pickerItem: { flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  pickerItemLeft: { flex: 1, marginRight: 8 },
  pickerItemName: { color: "#fff", fontSize: 16, fontWeight: "700" },
  pickerItemAddr: { color: "#64748B", fontSize: 12, marginTop: 2 },

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
});
