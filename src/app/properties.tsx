import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import {
    collection,
    deleteDoc,
    doc,
    getDocs,
    query,
    where,
} from "firebase/firestore";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, Dimensions, Image, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { auth, db } from "../lib/firebase";
import { exportProperties } from "../lib/export";
import { requirePlanFeature } from "../lib/plans";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

type UtilityItem = {
  amount: string;
  provider: string;
  dueDay: number | "last";
  notify?: boolean;
};

type TenantRef = {
  id: string;
  tenantName: string;
  propertyName: string;
};

type Property = {
  id: string;
  propertyName: string;
  address: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  propertyType: string;
  numUnits: number;
  ownerName: string;
  tenantName: string | null;
  tenants?: string[];
  utilities: Record<string, UtilityItem>;
  photoUrl?: string | null;
  notes: string | null;
  createdAt: any;
};

const ordinalSuffix = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const formatDueDay = (d: number | "last") => {
  if (d === "last") return "Last";
  return ordinalSuffix(d);
};

const UTILITY_META: Record<string, { icon: React.ComponentProps<typeof Feather>["name"]; color: string }> = {
  Electric: { icon: "zap", color: "#A78BFA" },
  Water: { icon: "droplet", color: "#60A5FA" },
  Gas: { icon: "wind", color: "#34D399" },
  Oil: { icon: "droplet", color: "#FB923C" },
  Sewer: { icon: "layers", color: "#2DD4BF" },
  Trash: { icon: "trash-2", color: "#78716C" },
};

export default function Properties() {
  const router = useRouter();
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [propertyToDelete, setPropertyToDelete] = useState<string | null>(null);
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [imageToShow, setImageToShow] = useState<string | null>(null);
  const [tenantRefs, setTenantRefs] = useState<TenantRef[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchInputRef = useRef<TextInput>(null);

  const PROPERTY_TYPES = ["house", "apartment", "condo", "commercial", "multi-family"];

  const filteredProperties = useMemo(() => {
    let list = properties;
    if (typeFilter) {
      list = list.filter((p) => p.propertyType?.toLowerCase() === typeFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((p) => {
        const tenantNames = getPropertyTenants(p).join(" ").toLowerCase();
        return (
          p.propertyName?.toLowerCase().includes(q) ||
          p.address?.toLowerCase().includes(q) ||
          p.ownerName?.toLowerCase().includes(q) ||
          p.propertyType?.toLowerCase().includes(q) ||
          tenantNames.includes(q)
        );
      });
    }
    return list;
  }, [properties, searchQuery, typeFilter, tenantRefs]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        setProperties([]);
        setLoading(false);
        return;
      }
      loadProperties(user);
    });
    return () => unsubscribe();
  }, []);

  const loadProperties = async (currentUser = auth.currentUser) => {
    setLoading(true);
    try {
      if (!currentUser) {
        setProperties([]);
        setLoading(false);
        return;
      }
      const q = query(
        collection(db, "properties"),
        where("ownerId", "==", currentUser.uid)
      );
      const snapshot = await getDocs(q);
      const list: Property[] = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Omit<Property, "id">),
      }));
      setProperties(list);

      const tq = query(collection(db, "tenants"), where("ownerId", "==", currentUser.uid));
      const tSnap = await getDocs(tq);
      setTenantRefs(tSnap.docs.map(d => ({
        id: d.id,
        ...(d.data() as Omit<TenantRef, "id">),
      })));
    } catch (error) {
      console.log(error);
      setProperties([]);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!propertyToDelete) return;
    try {
      await deleteDoc(doc(db, "properties", propertyToDelete));
      setProperties(properties.filter(p => p.id !== propertyToDelete));
      setDeleteModalOpen(false);
      setPropertyToDelete(null);
    } catch (error) {
      console.log("Error deleting property:", error);
      Alert.alert("Error", "Failed to delete property");
    }
  };

  const confirmDelete = (propertyId: string) => {
    setPropertyToDelete(propertyId);
    setDeleteModalOpen(true);
  };

  const handleEdit = (property: Property) => {
    router.push(`/add-property?propertyId=${property.id}&propertyData=${encodeURIComponent(JSON.stringify(property))}`);
  };

  const calculateTotalUtilities = (utilities: Record<string, UtilityItem> | null | undefined) => {
    let total = 0;
    if (utilities) {
      Object.values(utilities).forEach(utility => {
        total += parseFloat(utility.amount) || 0;
      });
    }
    return total;
  };

  const getPropertyTenants = (prop: Property): string[] => {
    const inline = prop.tenants?.length ? prop.tenants : (prop.tenantName ? [prop.tenantName] : []);
    const fromCollection = tenantRefs
      .filter(t => t.propertyName.toLowerCase() === prop.propertyName.toLowerCase())
      .map(t => t.tenantName);
    return [...new Set([...inline, ...fromCollection])];
  };

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
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scrollContent}>

          {/* ── HEADER ── */}
          <View style={s.headerRow}>
            <TouchableOpacity
              onPress={() => router.canGoBack() ? router.back() : router.replace("/dashboard")}
              style={s.backBtn}
            >
              <Feather name="arrow-left" size={22} color="#fff" />
            </TouchableOpacity>
            <Text style={s.headerTitle}>My Properties</Text>
            <TouchableOpacity style={s.searchToggleBtn} onPress={toggleSearch}>
              <Feather name={searchOpen ? "x" : "search"} size={20} color="#fff" />
            </TouchableOpacity>
          </View>

          {/* ── ACTION BUTTONS ── */}
          <View style={s.actionBtnRow}>
            <TouchableOpacity style={[s.addButton, { flex: 1 }]} onPress={() => router.push("/add-property")}>
              <Feather name="plus" size={20} color="#fff" />
              <Text style={s.addButtonText}>New Property</Text>
            </TouchableOpacity>
            {properties.length > 0 && (
              <TouchableOpacity
                style={s.exportBtn}
                onPress={async () => {
                  if (await requirePlanFeature("exports", "Excel exports")) exportProperties(properties);
                }}
              >
                <Feather name="download" size={20} color="#fff" />
              </TouchableOpacity>
            )}
          </View>

          {/* ── SEARCH BAR (animated) ── */}
          <Animated.View style={{ overflow: "hidden", maxHeight: searchMaxHeight, opacity: searchOpacity }}>
            <View style={s.searchContainer}>
              <Feather name="search" size={18} color="#64748B" style={s.searchIcon} />
              <TextInput
                ref={searchInputRef}
                style={s.searchInput}
                placeholder="Search properties..."
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
              <TouchableOpacity
                style={[s.filterChip, !typeFilter && s.filterChipActive]}
                onPress={() => setTypeFilter(null)}
              >
                <Text style={[s.filterChipText, !typeFilter && s.filterChipTextActive]}>All</Text>
              </TouchableOpacity>
              {PROPERTY_TYPES.map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[s.filterChip, typeFilter === t && s.filterChipActive]}
                  onPress={() => setTypeFilter(typeFilter === t ? null : t)}
                >
                  <Feather name={t === "commercial" ? "briefcase" : t === "multi-family" ? "users" : "home"} size={13} color={typeFilter === t ? "#3B82F6" : "#94A3B8"} />
                  <Text style={[s.filterChipText, typeFilter === t && s.filterChipTextActive]}>
                    {t.charAt(0).toUpperCase() + t.slice(1).replace("-", " ")}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Animated.View>

          {/* ── PROPERTY LIST ── */}
          {loading ? (
            <Text style={s.emptyText}>Loading...</Text>
          ) : properties.length === 0 ? (
            <Text style={s.emptyText}>No properties yet.</Text>
          ) : filteredProperties.length === 0 ? (
            <View style={s.noResults}>
              <Feather name="search" size={36} color="#334155" />
              <Text style={s.emptyText}>No properties match your search</Text>
            </View>
          ) : (
            filteredProperties.map((property) => {
              const totalUtilities = calculateTotalUtilities(property.utilities);

              return (
                <View key={property.id} style={s.card}>

                  {/* ── Photo + Name + Address + Actions ── */}
                  <View style={s.cardTopRow}>
                    <TouchableOpacity
                      onPress={() => {
                        if (property.photoUrl) {
                          setImageToShow(property.photoUrl);
                          setImageModalOpen(true);
                        }
                      }}
                    >
                      <Image
                        source={property.photoUrl ? { uri: property.photoUrl } : require("../assets/placeholder-building.png")}
                        style={s.cardPhoto}
                        resizeMode="cover"
                      />
                    </TouchableOpacity>

                    <View style={s.cardInfoWrap}>
                      <Text style={s.propertyName} numberOfLines={1}>{property.propertyName}</Text>
                      <View style={s.addressRow}>
                        <Feather name="map-pin" size={13} color="#60A5FA" />
                        <Text style={s.propertyAddress} numberOfLines={1}>{property.address}</Text>
                      </View>
                    </View>

                    <View style={s.actionRow}>
                      <TouchableOpacity style={s.editBtn} onPress={() => handleEdit(property)}>
                        <Feather name="edit-2" size={16} color="#fff" />
                      </TouchableOpacity>
                      <TouchableOpacity style={s.deleteBtn} onPress={() => confirmDelete(property.id)}>
                        <Feather name="trash-2" size={16} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* ── Property Info ── */}
                  <View style={s.infoRow}>
                    <View style={s.infoChip}>
                      <Feather name="home" size={13} color="#60A5FA" />
                      <Text style={s.infoChipText}>
                        {property.propertyType?.charAt(0).toUpperCase() + property.propertyType?.slice(1)?.replace("-", " ")}
                      </Text>
                    </View>
                    {property.propertyType === "multi-family" && (
                      <View style={s.infoChip}>
                        <Feather name="users" size={13} color="#60A5FA" />
                        <Text style={s.infoChipText}>{property.numUnits} {property.numUnits === 1 ? "unit" : "units"}</Text>
                      </View>
                    )}
                    <View style={s.infoChip}>
                      <Feather name="user" size={13} color="#60A5FA" />
                      <Text style={s.infoChipText} numberOfLines={1}>{property.ownerName}</Text>
                    </View>
                    {getPropertyTenants(property).map((t, i) => (
                      <View key={i} style={s.infoChip}>
                        <Feather name="users" size={13} color="#60A5FA" />
                        <Text style={s.infoChipText} numberOfLines={1}>{t}</Text>
                      </View>
                    ))}
                  </View>

                  {/* ── Utilities ── */}
                  {property.utilities && Object.keys(property.utilities).length > 0 && (
                    <View style={s.utilitiesSection}>
                      <View style={s.utilitiesHeaderRow}>
                        <Text style={s.utilitiesTitle}>Utilities</Text>
                        <Text style={s.utilitiesTotal}>${totalUtilities.toLocaleString()}/mo</Text>
                      </View>
                      {Object.entries(property.utilities).map(([key, utility]) => {
                        const meta = UTILITY_META[key] || { icon: "zap" as const, color: "#94A3B8" };
                        return (
                          <View key={key} style={s.utilityRow}>
                            <View style={[s.utilityIcon, { backgroundColor: `${meta.color}22` }]}>
                              <Feather name={meta.icon} size={13} color={meta.color} />
                            </View>
                            <Text style={s.utilityName}>{key}</Text>
                            <Text style={s.utilityAmount}>${Number(utility.amount).toLocaleString()}</Text>
                            <Text style={s.utilityDue}>Due: {formatDueDay(utility.dueDay)}</Text>
                          </View>
                        );
                      })}
                    </View>
                  )}

                  {/* ── Notes ── */}
                  {property.notes && (
                    <View style={s.notesRow}>
                      <Text style={s.notesLabel}>Notes</Text>
                      <Text style={s.notesText} numberOfLines={2}>{property.notes}</Text>
                      <Feather name="chevron-right" size={16} color="#4B5563" />
                    </View>
                  )}

                </View>
              );
            })
          )}
        </ScrollView>
      </SafeAreaView>

      {/* ── DELETE MODAL ── */}
      <Modal visible={deleteModalOpen} transparent animationType="fade" onRequestClose={() => setDeleteModalOpen(false)}>
        <TouchableOpacity style={s.modalOverlay} onPress={() => setDeleteModalOpen(false)} activeOpacity={1}>
          <View style={s.modalContent}>
            <Text style={s.modalTitle}>Delete Property</Text>
            <Text style={s.modalSub}>Are you sure you want to delete this property? This action cannot be undone.</Text>
            <View style={s.modalActions}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => setDeleteModalOpen(false)}>
                <Text style={s.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.deleteConfirmBtn} onPress={handleDelete}>
                <Text style={s.deleteConfirmText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── IMAGE MODAL ── */}
      <Modal visible={imageModalOpen} transparent animationType="fade" onRequestClose={() => setImageModalOpen(false)}>
        <TouchableOpacity style={s.imageModalOverlay} onPress={() => setImageModalOpen(false)} activeOpacity={1}>
          {imageToShow && (
            <Image source={{ uri: imageToShow }} style={s.imageModalImg} resizeMode="cover" />
          )}
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#060D1C" },
  bgImage: { position: "absolute", width: "100%", height: "100%" },
  bgOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(5,10,20,0.78)" },

  scrollContent: { padding: SCREEN_WIDTH < 400 ? 16 : 20, gap: 14, paddingBottom: 60 },

  // ── Header ──
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  backBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },
  headerTitle: { color: "#fff", fontSize: SCREEN_WIDTH < 400 ? 24 : 30, fontWeight: "900", letterSpacing: 0.5 },
  searchToggleBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },

  // ── Add Button ──
  actionBtnRow: { flexDirection: "row", gap: 10, marginBottom: 6 },
  addButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#2563EB", paddingVertical: SCREEN_WIDTH < 400 ? 14 : 16, borderRadius: 16, gap: 8 },
  addButtonText: { color: "#fff", fontSize: SCREEN_WIDTH < 400 ? 16 : 18, fontWeight: "800" },
  exportBtn: { width: 52, height: "auto", backgroundColor: "#1E40AF", borderRadius: 16, justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: "rgba(96,165,250,0.3)" },

  // ── Card ──
  card: { backgroundColor: "rgba(14,22,42,0.92)", borderRadius: 22, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)", padding: SCREEN_WIDTH < 400 ? 14 : 16, marginBottom: 4 },

  // ── Card Top ──
  cardTopRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 12 },
  cardPhoto: { width: SCREEN_WIDTH < 400 ? 64 : 72, height: SCREEN_WIDTH < 400 ? 64 : 72, borderRadius: 14, backgroundColor: "#1E293B" },
  cardInfoWrap: { flex: 1, marginLeft: 12, justifyContent: "center", paddingTop: 2 },
  propertyName: { color: "#fff", fontSize: SCREEN_WIDTH < 400 ? 17 : 19, fontWeight: "900" },
  addressRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  propertyAddress: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, flex: 1 },
  actionRow: { flexDirection: "row", gap: 8, marginLeft: 8 },
  editBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: "#3B82F6", justifyContent: "center", alignItems: "center" },
  deleteBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: "#DC2626", justifyContent: "center", alignItems: "center" },

  // ── Info Chips ──
  infoRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  infoChip: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(30,41,59,0.7)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  infoChipText: { color: "#CBD5E1", fontSize: SCREEN_WIDTH < 400 ? 11 : 12, fontWeight: "700" },

  // ── Utilities ──
  utilitiesSection: { backgroundColor: "rgba(11,17,32,0.8)", borderRadius: 18, padding: SCREEN_WIDTH < 400 ? 12 : 14, marginBottom: 12, borderWidth: 1, borderColor: "rgba(59,130,246,0.10)" },
  utilitiesHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  utilitiesTitle: { color: "#fff", fontSize: SCREEN_WIDTH < 400 ? 14 : 15, fontWeight: "800" },
  utilitiesTotal: { color: "#22C55E", fontSize: SCREEN_WIDTH < 400 ? 14 : 15, fontWeight: "800" },
  utilityRow: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  utilityIcon: { width: 28, height: 28, borderRadius: 8, justifyContent: "center", alignItems: "center", marginRight: 8 },
  utilityName: { color: "#CBD5E1", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, fontWeight: "600", flex: 1 },
  utilityAmount: { color: "#fff", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, fontWeight: "800", marginRight: 12 },
  utilityDue: { color: "#64748B", fontSize: SCREEN_WIDTH < 400 ? 10 : 11, fontWeight: "600" },

  // ── Notes ──
  notesRow: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(11,17,32,0.8)", borderRadius: 18, padding: SCREEN_WIDTH < 400 ? 12 : 14, borderWidth: 1, borderColor: "rgba(59,130,246,0.10)" },
  notesLabel: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 11 : 12, fontWeight: "700", marginRight: 8 },
  notesText: { flex: 1, color: "#CBD5E1", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, fontWeight: "600" },

  emptyText: { color: "#64748B", textAlign: "center", padding: 24, fontSize: 16 },

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
  noResults: { alignItems: "center", padding: 40, gap: 8 },

  // ── Modals ──
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: SCREEN_WIDTH < 400 ? 16 : 20 },
  modalContent: { backgroundColor: "rgba(30,41,59,0.98)", borderRadius: 22, padding: SCREEN_WIDTH < 400 ? 16 : 20, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },
  modalTitle: { color: "#fff", fontSize: SCREEN_WIDTH < 400 ? 17 : 19, fontWeight: "900", marginBottom: 8 },
  modalSub: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 13 : 14, marginBottom: SCREEN_WIDTH < 400 ? 16 : 20, lineHeight: 20 },
  modalActions: { flexDirection: "row", gap: 10 },
  cancelBtn: { flex: 1, backgroundColor: "#475569", paddingVertical: 14, borderRadius: 16, alignItems: "center" },
  cancelBtnText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  deleteConfirmBtn: { flex: 1, backgroundColor: "#DC2626", paddingVertical: 14, borderRadius: 16, alignItems: "center" },
  deleteConfirmText: { color: "#fff", fontSize: 16, fontWeight: "800" },

  imageModalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "center", alignItems: "center", padding: 24 },
  imageModalImg: { width: SCREEN_WIDTH - 48, height: (SCREEN_WIDTH - 48) * 0.66, borderRadius: 16 },
});
