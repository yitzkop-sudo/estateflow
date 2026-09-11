import { Feather } from "@expo/vector-icons";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { addDoc, collection, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { auth, db, storage } from "../lib/firebase";
import { consumePendingUtilityLink } from "../lib/pendingUtilityLink";
import {
  getUtilitySubscriptionStatus,
  refreshUtilityForProperty,
  type UtilitySubStatus,
} from "../lib/utilityapi";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

type PropertyType = "house" | "apartment" | "condo" | "commercial" | "multi-family";
type DueDay = number | "last";

interface PropertyData {
  propertyName: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  mapAddress: string;
  propertyType: PropertyType | null;
  numUnits: string;
  ownerName: string;
  tenants: string[];
  notes: string;
  value: string;
  downPayment: string;
}

interface AddressSuggestion {
  street: string;
  city: string;
  state: string;
  zip: string;
  placeName?: string;
}

type UtilityKey = "Electric" | "Water" | "Gas" | "Oil" | "Sewer" | "Trash";

interface UtilityItem {
  amount: string;
  provider: string;
  dueDay: DueDay;
  meterUid?: string;
  auto?: boolean;
  notify?: boolean;
}

const PROPERTY_TYPES: PropertyType[] = ["house", "apartment", "condo", "commercial", "multi-family"];
const PROPERTY_TYPE_ICONS: Record<PropertyType, React.ComponentProps<typeof Feather>["name"]> = {
  house: "home",
  apartment: "grid",
  condo: "home",
  commercial: "briefcase",
  "multi-family": "users",
};
const DUE_DAYS: DueDay[] = [1, 15, "last"];
const UTILITY_KEYS: UtilityKey[] = ["Electric", "Water", "Gas", "Oil", "Sewer", "Trash"];

// ── Per-utility icon + accent color, matches the blueprint's colored icon chips ──
const UTILITY_META: Record<UtilityKey, { icon: React.ComponentProps<typeof Feather>["name"]; color: string }> = {
  Electric: { icon: "zap", color: "#A78BFA" },
  Water: { icon: "droplet", color: "#60A5FA" },
  Gas: { icon: "wind", color: "#34D399" },
  Oil: { icon: "droplet", color: "#FB923C" },
  Sewer: { icon: "layers", color: "#2DD4BF" },
  Trash: { icon: "trash-2", color: "#78716C" },
};

// ── Icon shown in each step's card header, matches the blueprint ──
const STEP_META: Record<number, { icon: React.ComponentProps<typeof Feather>["name"]; title: string; subtitle: string }> = {
  1: { icon: "home", title: "Property Details", subtitle: "Let's start with the basic information about your property." },
  2: { icon: "home", title: "Property Type & Units", subtitle: "Tell us more about the type of property you have." },
  3: { icon: "user", title: "Owner & Tenant", subtitle: "Add the owner and tenant information." },
  4: { icon: "zap", title: "Utilities", subtitle: "Add the monthly utilities and billing details." },
  5: { icon: "file-text", title: "Notes", subtitle: "Add any important notes about this property." },
  6: { icon: "check-circle", title: "Review & Confirm", subtitle: "Review your property details before saving." },
};

const EDITABLE_SECTIONS = [
  { key: 1, label: "Details" },
  { key: 2, label: "Type" },
  { key: 3, label: "Owner" },
  { key: 4, label: "Utilities" },
  { key: 5, label: "Notes" },
  { key: 6, label: "Review" },
];

const NOTES_MAX_LENGTH = 500;

// Photos are stored as compressed data URLs inside the Firestore property
// document (no Firebase Storage / Blaze plan needed). Must stay well under
// Firestore's 1 MiB per-document limit.
const MAX_PHOTO_DATA_URL_LENGTH = 700000;

const formatCurrency = (value: string) => {
  const num = Number(value);
  if (!value.trim() || Number.isNaN(num)) return "";
  return `$${num.toLocaleString()}`;
};

const formatUtilityDueDay = (dueDay: DueDay) => {
  if (dueDay === "last") return "Last day of every month";
  const s = ["th", "st", "nd", "rd"];
  const v = (dueDay as number) % 100;
  const ord = dueDay + (s[(v - 20) % 10] || s[v] || s[0]);
  return `${ord} of every month`;
};

export default function AddProperty() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const [isEditing, setIsEditing] = useState(false);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dueDayModalOpen, setDueDayModalOpen] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [showAddressSuggestions, setShowAddressSuggestions] = useState(false);
  const [searchingAddress, setSearchingAddress] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addressInputRef = useRef<View | null>(null);
  const [suggestionsLayout, setSuggestionsLayout] = useState({ top: 0, left: 0, width: 0 });
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoModalOpen, setPhotoModalOpen] = useState(false);
  const [photoActionOpen, setPhotoActionOpen] = useState(false);

  const [form, setForm] = useState<PropertyData>({
    propertyName: "",
    street: "",
    city: "",
    state: "",
    zip: "",
    mapAddress: "",
    propertyType: null,
    numUnits: "1",
    ownerName: "",
    tenants: [],
    notes: "",
    value: "",
    downPayment: "",
  });

  const [newTenant, setNewTenant] = useState("");
  const [utilities, setUtilities] = useState<Partial<Record<UtilityKey, UtilityItem>>>({});
  const [utilityModalOpen, setUtilityModalOpen] = useState(false);
  const [editingUtility, setEditingUtility] = useState<UtilityKey | null>(null);
  const [modalAmount, setModalAmount] = useState("");
  const [modalProvider, setModalProvider] = useState("");
  const [modalDueDay, setModalDueDay] = useState<DueDay>(15);
  const [modalNotify, setModalNotify] = useState(true);
  const [connectingUtility, setConnectingUtility] = useState<UtilityKey | null>(null);
  const [connectStatus, setConnectStatus] = useState("");
  const [subStatus, setSubStatus] = useState<UtilitySubStatus | null>(null);

  useEffect(() => {
    const user = auth.currentUser;
    if (!user) { router.replace("/login"); return; }

    // Fetch whether the user has a paid auto-sync subscription.
    getUtilitySubscriptionStatus()
      .then(setSubStatus)
      .catch(() => setSubStatus({ active: false, plan: null, currentPeriodEnd: null, portalUrl: null, meterLimit: 0, linkedMeters: 0 }));

    if (params.propertyId && params.propertyData && !isEditing) {
      try {
        setIsEditing(true);
        setPropertyId(params.propertyId as string);
        const propertyData = JSON.parse(decodeURIComponent(params.propertyData as string));
        setForm({
          propertyName: propertyData.propertyName || "",
          street: propertyData.street || "",
          city: propertyData.city || "",
          state: propertyData.state || "",
          zip: propertyData.zip || "",
          mapAddress: propertyData.mapAddress || "",
          propertyType: propertyData.propertyType || null,
          numUnits: propertyData.numUnits?.toString() || "1",
          ownerName: propertyData.ownerName || "",
          tenants: propertyData.tenants || [],
          notes: propertyData.notes || "",
          value: propertyData.value?.toString() || "",
          downPayment: propertyData.downPayment?.toString() || "",
        });
        if (propertyData.photoUrl) setPhotoUrl(propertyData.photoUrl);
        if (propertyData.utilities) setUtilities(propertyData.utilities);
      } catch (e) {
        console.error("Error parsing property data:", e);
      }
    }
  }, [router, params.propertyId, params.propertyData, isEditing]);

  // Pick up a provider link completed on the Connect screen (and refresh the
  // subscription status in case the user just paid). Form state is preserved
  // because the link travels through the handoff store, not route params.
  useFocusEffect(
    useCallback(() => {
      getUtilitySubscriptionStatus()
        .then(setSubStatus)
        .catch(() => {});
      const pending = consumePendingUtilityLink();
      if (pending && (UTILITY_KEYS as readonly string[]).includes(pending.key)) {
        const key = pending.key as UtilityKey;
        setUtilities((u) => ({
          ...u,
          [key]: {
            amount: pending.amount,
            provider: pending.provider,
            dueDay: pending.dueDay,
            meterUid: pending.meterUid,
            auto: true,
            notify: pending.notify ?? true,
          },
        }));
        setSubStatus((s) => (s ? { ...s, linkedMeters: s.linkedMeters + 1 } : s));
        Alert.alert("Connected", `${key} bill auto-filled from ${pending.provider}: $${pending.amount}.`);
      }
    }, [])
  );

  const updateForm = (key: keyof PropertyData, value: any) =>
    setForm((p) => ({ ...p, [key]: value }));

  const searchAddress = async (query: string) => {
    if (query.trim().length < 3) {
      setShowAddressSuggestions(false);
      return;
    }
    setSearchingAddress(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=5`,
        { headers: { "Accept-Language": "en" } }
      );
      const data = await res.json();
      const suggestions: AddressSuggestion[] = (data || []).map((item: any) => ({
        street: [item.address?.house_number, item.address?.road || item.address?.footway || item.address?.street].filter(Boolean).join(" ") || item.display_name?.split(",")[0]?.trim() || "",
        city: item.address?.city || item.address?.town || item.address?.village || item.address?.county || "",
        state: item.address?.state || "",
        zip: item.address?.postcode || "",
        placeName: item.display_name || "",
      }));
      setAddressSuggestions(suggestions);
      if (suggestions.length > 0) {
        addressInputRef.current?.measureInWindow?.((x: number, y: number, width: number, height: number) => {
          setSuggestionsLayout({ top: y + height, left: x, width });
          setShowAddressSuggestions(true);
        });
      } else {
        setShowAddressSuggestions(false);
      }
    } catch {
      setAddressSuggestions([]);
      setShowAddressSuggestions(false);
    } finally {
      setSearchingAddress(false);
    }
  };

  const handleAddressInput = (value: string) => {
    updateForm("street", value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (value.trim().length < 3) {
      setShowAddressSuggestions(false);
      return;
    }
    searchTimeout.current = setTimeout(() => searchAddress(value), 300);
  };

  useEffect(() => {
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, []);

  const selectAddress = (address: AddressSuggestion) => {
    updateForm("street", address.street);
    updateForm("city", address.city);
    updateForm("state", address.state);
    updateForm("zip", address.zip);
    updateForm("mapAddress", address.placeName || address.street);
    setAddressSuggestions([]);
    setShowAddressSuggestions(false);
  };

  const validateStep = (stepNum: number) => {
    setError(null);
    if (stepNum === 1) {
      if (!form.propertyName.trim()) return setError("Property Name is required."), false;
      if (!form.street.trim()) return setError("Street Address is required."), false;
      if (!form.city.trim()) return setError("City is required."), false;
      if (!form.state.trim()) return setError("State is required."), false;
      if (!form.zip.trim()) return setError("ZIP Code is required."), false;
      return true;
    }
    if (stepNum === 2) {
      if (!form.propertyType) return setError("Please select a Property Type."), false;
      if (form.propertyType === "multi-family" && !form.numUnits.trim()) return setError("Number of Units is required."), false;
      return true;
    }
    if (stepNum === 3) {
      if (!form.ownerName.trim()) return setError("Owner Name is required."), false;
      if (form.value.trim() && isNaN(Number(form.value)))
        return setError("Property Value must be a number."), false;
      if (form.downPayment.trim() && isNaN(Number(form.downPayment)))
        return setError("Cash Invested must be a number."), false;
      return true;
    }
    return true;
  };

  // Compress any image URI into a small data URL that fits in Firestore.
  // Returns null when it can't be squeezed under the size cap.
  const compressToDataUrl = async (uri: string): Promise<string | null> => {
    const attempts = [
      { width: 900, compress: 0.6 },
      { width: 600, compress: 0.5 },
      { width: 400, compress: 0.5 },
    ];
    for (const { width, compress } of attempts) {
      const out = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width } }],
        { compress, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      if (out.base64) {
        const dataUrl = `data:image/jpeg;base64,${out.base64}`;
        if (dataUrl.length <= MAX_PHOTO_DATA_URL_LENGTH) return dataUrl;
      }
    }
    return null;
  };

  const pickPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Please allow access to your photos to upload a property image.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [4, 3],
      quality: 1,
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    try {
      const dataUrl = await compressToDataUrl(result.assets[0].uri);
      if (!dataUrl) {
        Alert.alert("Photo too large", "That photo couldn't be compressed small enough, try another one.");
        return;
      }
      setPhotoUrl(dataUrl);
    } catch {
      Alert.alert("Photo failed", "Could not process that photo, please try another one.");
    }
  };

  const replacePhoto = () => {
    setPhotoModalOpen(false);
    // Let the preview modal finish dismissing before presenting the image
    // library — launching both in the same tick gets swallowed (notably on iOS).
    setTimeout(() => { pickPhoto(); }, 350);
  };

  const changePhotoFromAction = () => {
    setPhotoActionOpen(false);
    setTimeout(() => { pickPhoto(); }, 250);
  };

  const removePhotoFromAction = () => {
    setPhotoUrl(null);
    setPhotoActionOpen(false);
  };

  const uploadPhoto = async (uri: string, uid: string) => {
    const response = await fetch(uri);
    const blob = await response.blob();
    if (!blob || blob.size === 0) throw new Error("Empty image data.");
    // User-scoped path so storage.rules can verify ownership:
    // properties/{uid}/{timestamp}-{rand}.jpg
    const fileName = `properties/${uid}/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const imageRef = ref(storage, fileName);
    await uploadBytes(imageRef, blob, { contentType: blob.type || "image/jpeg" });
    return getDownloadURL(imageRef);
  };

  const handleNext = () => { if (validateStep(step)) setStep((s) => s + 1); };
  const handlePrev = () => setStep((s) => Math.max(1, s - 1));

  const openUtilityModal = (key: UtilityKey) => {
    const item = utilities[key];
    setEditingUtility(key);
    setModalAmount(item?.amount ?? "");
    setModalProvider(item?.provider ?? "");
    setModalDueDay(item?.dueDay ?? 15);
    setModalNotify(item?.notify ?? true);
    setUtilityModalOpen(true);
  };

  const ordinalSuffix = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const applyUtilityModal = () => {
    if (!editingUtility) return;
    if (modalAmount.trim() === "" || Number.isNaN(Number(modalAmount))) {
      Alert.alert("Invalid amount", "Please enter a valid numeric amount.");
      return;
    }
    const prev = utilities[editingUtility];
    const buildItem = (dueDay: DueDay): UtilityItem => ({
      amount: modalAmount.trim(),
      provider: modalProvider.trim(),
      dueDay,
      notify: modalNotify,
      ...(prev?.meterUid ? { meterUid: prev.meterUid } : {}),
      ...(prev?.auto ? { auto: prev.auto } : {}),
    });
    if (modalDueDay !== "last") {
      const d = Number(modalDueDay);
      if (!Number.isInteger(d) || d < 1 || d > 31) {
        Alert.alert("Invalid due day", "Please enter a day between 1 and 31, or choose Last.");
        return;
      }
      setUtilities((u) => ({ ...u, [editingUtility]: buildItem(d) }));
    } else {
      setUtilities((u) => ({ ...u, [editingUtility]: buildItem("last") }));
    }
    setUtilityModalOpen(false);
    setEditingUtility(null);
  };

  const removeUtility = (key: UtilityKey) => {
    const copy = { ...utilities } as any;
    delete copy[key];
    setUtilities(copy);
  };

  // Per-utility billing: every connect goes through the wizard so each
  // utility gets its own $20/mo subscription (pay → authorize → data back).
  const handleLinkUtility = (key: UtilityKey) => {
    router.push({ pathname: "/connect-utility", params: { utilityKey: key } });
  };

  const handleRefreshUtility = async (key: UtilityKey) => {
    const item = utilities[key];
    if (!item?.meterUid) return;
    if (!subStatus?.active) {
      Alert.alert("Upgrade required", "Auto utility sync is a paid feature.");
      return;
    }
    setConnectingUtility(key);
    setConnectStatus("Refreshing your latest bill...");
    try {
      const data = await refreshUtilityForProperty(item.meterUid);
      setUtilities((u) => ({
        ...u,
        [key]: { ...(u[key] as UtilityItem), amount: data.amount, provider: data.provider, dueDay: data.dueDay },
      }));
      Alert.alert("Refreshed", `${key} bill updated to $${data.amount} from ${data.provider}.`);
    } catch (e: any) {
      Alert.alert("Refresh failed", e?.message || "Could not refresh the bill.");
    } finally {
      setConnectingUtility(null);
      setConnectStatus("");
    }
  };

  const handleSave = async () => {
    // Validate all required steps (edit mode lets users jump straight to Review).
    for (const n of [1, 2, 3]) {
      if (!validateStep(n)) { setStep(n); return; }
    }
    const user = auth.currentUser;
    if (!user) { setError("You must be signed in."); router.replace("/login"); return; }

    setSaving(true);
    setError(null);
    let finalPhotoUrl = photoUrl;

    // Photo handling (no Firebase Storage / Blaze plan needed):
    // - data: URLs (what pickPhoto now produces) are saved straight into
    //   the Firestore document.
    // - http(s) URLs (older properties uploaded to Storage) are kept as-is.
    // - Other local URIs (legacy) are compressed first; Firebase Storage is
    //   only a last resort since it requires the Blaze plan.
    // A photo problem must NEVER block saving the property.
    const isRemoteUrl =
      !!photoUrl &&
      (photoUrl.startsWith("http://") || photoUrl.startsWith("https://"));
    if (photoUrl && !isRemoteUrl) {
      try {
        setUploadingPhoto(true);
        if (photoUrl.startsWith("data:image")) {
          if (photoUrl.length > MAX_PHOTO_DATA_URL_LENGTH) {
            Alert.alert("Photo too large", "Saving the property without a photo.");
            finalPhotoUrl = null;
          } else {
            finalPhotoUrl = photoUrl;
          }
        } else {
          const compressed = await compressToDataUrl(photoUrl).catch(() => null);
          if (compressed) {
            finalPhotoUrl = compressed;
          } else {
            try {
              finalPhotoUrl = await uploadPhoto(photoUrl, user.uid);
            } catch (e: any) {
              console.warn("Photo upload failed, saving property without photo:", e?.code || e?.message || e);
              finalPhotoUrl = null;
              Alert.alert("Photo upload failed", "Saving the property without a photo.");
            }
          }
        }
      } finally {
        setUploadingPhoto(false);
      }
    }

    const payload = {
      ownerId: user.uid,
      propertyName: form.propertyName.trim(),
      address: `${form.street.trim()}, ${form.city.trim()}, ${form.state.trim()} ${form.zip.trim()}`,
      street: form.street.trim(),
      city: form.city.trim(),
      state: form.state.trim(),
      zip: form.zip.trim(),
      propertyType: form.propertyType,
      numUnits: form.propertyType === "multi-family" ? Number(form.numUnits) || 1 : 1,
      ownerName: form.ownerName.trim(),
      tenants: form.tenants,
      utilities,
      notes: form.notes.trim() || null,
      photoUrl: finalPhotoUrl,
      value: Number(form.value) || 0,
      downPayment: Number(form.downPayment) || 0,
      updatedAt: serverTimestamp(),
    } as any;

    try {
      if (isEditing && propertyId) {
        await updateDoc(doc(db, "properties", propertyId), payload);
      } else {
        payload.createdAt = serverTimestamp();
        await addDoc(collection(db, "properties"), payload);
      }
      setSaving(false);
      router.replace("/properties");
    } catch (err: any) {
      setError(err?.message || "Failed to save property.");
      setSaving(false);
    }
  };

  // ── Reusable card header (icon chip + title + subtitle), matches the blueprint on every step ──
  const renderCardHeader = (stepNum: number) => {
    const meta = STEP_META[stepNum];
    return (
      <View style={styles.cardHeaderRow}>
        <View style={styles.cardHeaderIcon}>
          <Feather name={meta.icon} size={SCREEN_WIDTH < 400 ? 20 : 22} color="#60A5FA" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.stepTitle}>{meta.title}</Text>
          <Text style={styles.stepSubtitle}>{meta.subtitle}</Text>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <SafeAreaView style={styles.container}>
        <Image source={require("../assets/login-bg.png")} style={styles.backgroundImage} resizeMode="cover" />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(5,10,20,0.78)" }]} />
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

          {/* ── HEADER ── */}
          <View style={styles.headerContainer}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <TouchableOpacity
                onPress={() => router.canGoBack() ? router.back() : router.replace("/dashboard")}
                style={{ backgroundColor: "#1E293B", padding: SCREEN_WIDTH < 400 ? 8 : 10, borderRadius: SCREEN_WIDTH < 400 ? 8 : 10, marginRight: SCREEN_WIDTH < 400 ? 12 : 16 }}
              >
                <Feather name="arrow-left" size={SCREEN_WIDTH < 400 ? 20 : 24} color="white" />
              </TouchableOpacity>
              <Text style={styles.headerTitle}>{isEditing ? "Edit Property" : "Add Property"}</Text>
            </View>
          </View>

          {/* ── PROGRESS / STEP DOTS ── */}
          <View style={styles.progressContainer}>
            <Text style={styles.progressText}>{isEditing ? "Edit a section below" : `Step ${step} of 6`}</Text>
            {!isEditing && (
              <View style={styles.stepDotsRow}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <View key={n} style={[styles.stepDot, n === step && styles.stepDotActive]}>
                    <Text style={[styles.stepDotText, n === step && styles.stepDotTextActive]}>{n}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          {isEditing && (
            <View style={styles.editSectionRow}>
              {EDITABLE_SECTIONS.map((section) => (
                <TouchableOpacity key={section.key} style={[styles.editSectionChip, step === section.key && styles.editSectionChipActive]} onPress={() => setStep(section.key)}>
                  <Text style={[styles.editSectionChipText, step === section.key && styles.editSectionChipTextActive]}>{section.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {error ? (
            <View style={styles.errorContainer}><Text style={styles.errorText}>{error}</Text></View>
          ) : null}

          {/* ── STEP 1: Details ── */}
          {step === 1 && (
            <View style={styles.cardSection}>
              {renderCardHeader(1)}
              <Text style={styles.label}>Property Name *</Text>
              <TextInput style={styles.input} placeholder="Sunset Apartments" placeholderTextColor="#94A3B8" value={form.propertyName} onChangeText={(v) => updateForm("propertyName", v)} />
              <Text style={styles.label}>Street Address *</Text>
              <View ref={addressInputRef} style={styles.addressInputContainer}>
                <TextInput style={styles.input} placeholder="123 Sunset Blvd" placeholderTextColor="#94A3B8" value={form.street} onChangeText={handleAddressInput} />
              </View>
              <View style={styles.rowGroup}>
                <View style={styles.halfInput}>
                  <Text style={styles.label}>City *</Text>
                  <TextInput style={styles.input} placeholder="Los Angeles" placeholderTextColor="#94A3B8" value={form.city} onChangeText={(v) => updateForm("city", v)} />
                </View>
                <View style={styles.halfInput}>
                  <Text style={styles.label}>State *</Text>
                  <TextInput style={styles.input} placeholder="CA" placeholderTextColor="#94A3B8" value={form.state} onChangeText={(v) => updateForm("state", v)} />
                </View>
              </View>
              <View style={styles.rowGroup}>
                <View style={styles.halfInput}>
                  <Text style={styles.label}>ZIP Code *</Text>
                  <TextInput style={styles.input} placeholder="90001" placeholderTextColor="#94A3B8" keyboardType="numeric" value={form.zip} onChangeText={(v) => updateForm("zip", v)} />
                </View>
              </View>
            </View>
          )}

          {/* ── STEP 2: Type & Photo ── */}
          {step === 2 && (
            <View style={styles.cardSection}>
              {renderCardHeader(2)}
              <Text style={styles.label}>Property Type *</Text>
              <View style={styles.propertyTypeGrid}>
                {PROPERTY_TYPES.map((type) => {
                  const selected = form.propertyType === type;
                  return (
                    <TouchableOpacity key={type} style={[styles.typeCard, selected && styles.typeCardSelected]} onPress={() => updateForm("propertyType", type)}>
                      <View style={[styles.typeIcon, selected && styles.typeIconSelected]}>
                        <Feather name={PROPERTY_TYPE_ICONS[type]} size={SCREEN_WIDTH < 400 ? 18 : 20} color={selected ? "#FFFFFF" : "#60A5FA"} />
                      </View>
                      <Text style={[styles.typeLabel, selected && styles.typeLabelSelected]}>{type.charAt(0).toUpperCase() + type.slice(1).replace("-", " ")}</Text>
                      {selected && (
                        <View style={styles.typeCheckBadge}>
                          <Feather name="check" size={12} color="#FFFFFF" />
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
              {form.propertyType === "multi-family" && (
                <>
                  <Text style={[styles.label, { marginTop: 10 }]}>Number of Units *</Text>
                  <TextInput style={styles.input} placeholder="12" placeholderTextColor="#94A3B8" keyboardType="numeric" value={form.numUnits} onChangeText={(v) => updateForm("numUnits", v)} />
                </>
              )}

              {/* ── Property photo, part of the Type step per the blueprint ── */}
              <View style={styles.photoSectionRow}>
                <View style={styles.cardHeaderIcon}>
                  <Feather name="home" size={SCREEN_WIDTH < 400 ? 18 : 20} color="#60A5FA" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.photoSectionTitle}>Property Photo <Text style={styles.optionalText}>(Optional)</Text></Text>
                  <Text style={styles.photoSectionSubtitle}>Add a photo to easily identify this property.</Text>
                </View>
              </View>
              <View style={styles.photoRow}>
                {photoUrl ? (
                  <TouchableOpacity style={styles.photoThumb} onPress={() => setPhotoModalOpen(true)}>
                    <Image source={{ uri: photoUrl }} style={styles.photoThumbImage} resizeMode="cover" />
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={styles.addPhotoButton} onPress={pickPhoto}>
                  <Feather name="camera" size={SCREEN_WIDTH < 400 ? 18 : 20} color="#94A3B8" />
                  <Text style={styles.addPhotoButtonText}>{photoUrl ? "Change" : "Add Photo"}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── STEP 3: Owner & Tenant + Financial Fields ── */}
          {step === 3 && (
            <View style={styles.cardSection}>
              {renderCardHeader(3)}

              <Text style={styles.label}>Owner Name *</Text>
              <TextInput style={styles.input} placeholder="John Doe" placeholderTextColor="#94A3B8" value={form.ownerName} onChangeText={(v) => updateForm("ownerName", v)} />

              <Text style={styles.label}>Tenants</Text>
              {form.tenants.map((t, i) => (
                <View key={i} style={styles.tenantRow}>
                  <Text style={styles.tenantRowText}>{t}</Text>
                  <TouchableOpacity onPress={() => updateForm("tenants", form.tenants.filter((_, idx) => idx !== i))}>
                    <Feather name="x-circle" size={20} color="#EF4444" />
                  </TouchableOpacity>
                </View>
              ))}
              <View style={styles.addTenantRow}>
                <TextInput style={[styles.input, { flex: 1, marginBottom: 0 }]} placeholder="Add a tenant" placeholderTextColor="#94A3B8" value={newTenant} onChangeText={setNewTenant} />
                <TouchableOpacity style={styles.addTenantButton} onPress={() => {
                  if (newTenant.trim()) {
                    updateForm("tenants", [...form.tenants, newTenant.trim()]);
                    setNewTenant("");
                  }
                }}>
                  <Feather name="plus" size={20} color="#FFFFFF" />
                </TouchableOpacity>
              </View>

              <View style={styles.financialRow}>
                <View style={styles.financialCard}>
                  <Text style={styles.financialCardLabel}>Property Value</Text>
                  <View style={styles.financialCardInputRow}>
                    <View style={styles.financialCardIcon}>
                      <Feather name="trending-up" size={14} color="#60A5FA" />
                    </View>
                    <TextInput
                      style={styles.financialCardInput}
                      placeholder="2,500,000"
                      placeholderTextColor="#4B5563"
                      keyboardType="decimal-pad"
                      value={form.value}
                      onChangeText={(v) => updateForm("value", v)}
                    />
                  </View>
                </View>
                <View style={styles.financialCard}>
                  <Text style={styles.financialCardLabel}>Cash Invested (Down Payment)</Text>
                  <View style={styles.financialCardInputRow}>
                    <View style={styles.financialCardIcon}>
                      <Feather name="dollar-sign" size={14} color="#60A5FA" />
                    </View>
                    <TextInput
                      style={styles.financialCardInput}
                      placeholder="500,000"
                      placeholderTextColor="#4B5563"
                      keyboardType="decimal-pad"
                      value={form.downPayment}
                      onChangeText={(v) => updateForm("downPayment", v)}
                    />
                  </View>
                </View>
              </View>
            </View>
          )}

          {/* ── STEP 4: Utilities ── */}
          {step === 4 && (
            <View style={styles.cardSection}>
              {renderCardHeader(4)}
              <TouchableOpacity style={styles.connectProviderButton} onPress={() => router.push("/connect-utility")}>
                <View style={styles.connectProviderIcon}>
                  <Feather name="link" size={SCREEN_WIDTH < 400 ? 16 : 18} color="#FFFFFF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.connectProviderTitle}>Connect Utility Provider</Text>
                  <Text style={styles.connectProviderSubtitle}>Auto-sync bills • $20 per meter/month</Text>
                </View>
                <Feather name="chevron-right" size={SCREEN_WIDTH < 400 ? 16 : 18} color="#94A3B8" />
              </TouchableOpacity>
              {subStatus === null ? null : subStatus.active ? (
                subStatus.meterLimit > 0 && subStatus.linkedMeters >= subStatus.meterLimit ? (
                  <View style={[styles.connectBanner, { borderColor: "rgba(251,191,36,0.3)", backgroundColor: "rgba(251,191,36,0.08)" }]}>
                    <Feather name="alert-triangle" size={14} color="#FBBF24" />
                    <Text style={[styles.connectBannerText, { color: "#FCD34D" }]}>Meter limit reached ({subStatus.linkedMeters}/{subStatus.meterLimit}). Remove a linked utility or manage your plan to add capacity. You can still enter utilities manually.</Text>
                  </View>
                ) : (
                  <View style={styles.connectBanner}>
                    <Feather name="link" size={14} color="#34D399" />
                    <Text style={styles.connectBannerText}>Auto-sync is on: tap the link icon on a utility to pull your latest bill straight from the provider. ({subStatus.linkedMeters}/{subStatus.meterLimit} meters)</Text>
                  </View>
                )
              ) : null}
              {connectingUtility ? (
                <View style={styles.connectStatusRow}>
                  <ActivityIndicator size="small" color="#34D399" />
                  <Text style={styles.connectStatusText}>{connectStatus}</Text>
                </View>
              ) : null}
              <View style={styles.utilitiesContainer}>
                {UTILITY_KEYS.map((key) => {
                  const utility = utilities[key];
                  const meta = UTILITY_META[key];
                  const connecting = connectingUtility === key;
                  const atMeterCap =
                    (subStatus?.meterLimit ?? 0) > 0 &&
                    (subStatus?.linkedMeters ?? 0) >= (subStatus?.meterLimit ?? 0);
                  return (
                    <View key={key} style={styles.utilityItem}>
                      <TouchableOpacity style={styles.utilityRowMain} onPress={() => openUtilityModal(key)}>
                        <View style={[styles.utilityIconChip, { backgroundColor: `${meta.color}22` }]}>
                          <Feather name={meta.icon} size={SCREEN_WIDTH < 400 ? 16 : 18} color={meta.color} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.utilityLabel}>{key}</Text>
                          {utility ? (
                            <Text style={styles.utilityDetailText}>{`${utility.provider || "No provider"}${utility.meterUid ? " • linked" : ""}${utility.notify === false ? " • muted" : ""}`}</Text>
                          ) : (
                            <Text style={styles.utilityPlaceholder}>Not added yet</Text>
                          )}
                        </View>
                        {utility ? (
                          <View style={{ alignItems: "flex-end" }}>
                            <Text style={styles.utilityAmountText}>{`$${utility.amount}`}</Text>
                            <Text style={styles.utilityDueText}>{`Due: ${formatUtilityDueDay(utility.dueDay)}`}</Text>
                            {utility.notify === false ? (
                              <Feather name="bell-off" size={12} color="#64748B" style={{ marginTop: 2 }} />
                            ) : null}
                          </View>
                        ) : (
                          <Text style={styles.utilityAddLink}>Add</Text>
                        )}
                      </TouchableOpacity>
                      {subStatus?.active && (
                        <TouchableOpacity
                          style={[styles.utilityLinkBtn, atMeterCap && !utility?.meterUid && { opacity: 0.4 }]}
                          onPress={() => (utility?.meterUid ? handleRefreshUtility(key) : handleLinkUtility(key))}
                          disabled={connectingUtility !== null || (atMeterCap && !utility?.meterUid)}
                        >
                          {connecting ? (
                            <ActivityIndicator size="small" color="#34D399" />
                          ) : (
                            <Feather name={utility?.meterUid ? "refresh-cw" : "link"} size={SCREEN_WIDTH < 400 ? 15 : 16} color="#34D399" />
                          )}
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </View>

              {/* Utility Edit Modal */}
              <Modal visible={utilityModalOpen} transparent animationType="slide">
                <View style={styles.modalOverlay}>
                  <TouchableOpacity style={{ flex: 1 }} onPress={() => setUtilityModalOpen(false)} />
                  <View style={styles.modalContent}>
                    <Text style={styles.modalTitle}>{editingUtility && utilities[editingUtility] ? `Edit ${editingUtility}` : `Add ${editingUtility ?? "Utility"}`}</Text>
                    <Text style={styles.modalLabel}>Amount</Text>
                    <TextInput style={styles.modalInput} placeholder="Enter amount" placeholderTextColor="#94A3B8" keyboardType="decimal-pad" value={modalAmount} onChangeText={setModalAmount} />
                    <Text style={styles.modalLabel}>Provider</Text>
                    <TextInput style={styles.modalInput} placeholder="Enter provider name" placeholderTextColor="#94A3B8" value={modalProvider} onChangeText={setModalProvider} />
                    <Text style={styles.modalLabel}>Due Day</Text>
                    <TouchableOpacity style={styles.dropdownButton} onPress={() => setDueDayModalOpen(true)}>
                      <Text style={styles.dropdownButtonText}>{modalDueDay === "last" ? "Last" : String(modalDueDay)}</Text>
                      <Feather name="chevron-down" size={SCREEN_WIDTH < 400 ? 16 : 18} color="white" />
                    </TouchableOpacity>
                    <View style={styles.notifyRow}>
                      <View style={styles.notifyTextWrap}>
                        <Feather name={modalNotify ? "bell" : "bell-off"} size={16} color={modalNotify ? "#34D399" : "#64748B"} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.notifyTitle}>Notify me when due</Text>
                          <Text style={styles.notifySubtitle}>Get a reminder before this bill is due.</Text>
                        </View>
                      </View>
                      <Switch value={modalNotify} onValueChange={setModalNotify} trackColor={{ false: "#334155", true: "rgba(52,211,153,0.4)" }} thumbColor={modalNotify ? "#34D399" : "#94A3B8"} />
                    </View>
                    <Modal visible={dueDayModalOpen} transparent animationType="fade" onRequestClose={() => setDueDayModalOpen(false)}>
                      <View style={styles.modalOverlay}>
                        <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setDueDayModalOpen(false)} />
                        <View style={styles.modalContent}>
                          <Text style={styles.modalLabel}>Choose a preset</Text>
                          <FlatList
                            data={DUE_DAYS}
                            keyExtractor={(item) => String(item)}
                            renderItem={({ item }) => (
                              <TouchableOpacity style={styles.modalItem} onPress={() => { setModalDueDay(item); setDueDayModalOpen(false); }}>
                                <Text style={styles.modalItemText}>{item === "last" ? "Last" : ordinalSuffix(item as number)}</Text>
                              </TouchableOpacity>
                            )}
                          />
                          <Text style={[styles.modalLabel, { marginTop: 12 }]}>Or enter a custom day</Text>
                          <TextInput
                            style={styles.modalInput}
                            placeholder="Enter day (1-31)"
                            placeholderTextColor="#94A3B8"
                            keyboardType="numeric"
                            value={typeof modalDueDay === "number" ? String(modalDueDay) : ""}
                            onChangeText={(v) => setModalDueDay(v.trim() === "" ? "last" : Number(v))}
                          />
                          <TouchableOpacity style={[styles.closeButton, { marginTop: 8 }]} onPress={() => setDueDayModalOpen(false)}>
                            <Text style={styles.closeButtonText}>Close</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    </Modal>
                    <TouchableOpacity style={styles.applyButton} onPress={applyUtilityModal}>
                      <Text style={styles.applyButtonText}>{editingUtility && utilities[editingUtility] ? "Update" : "Add"} Utility</Text>
                    </TouchableOpacity>
                    {editingUtility && utilities[editingUtility] && (
                      <TouchableOpacity style={styles.removeButton} onPress={() => { if (editingUtility) removeUtility(editingUtility); setUtilityModalOpen(false); }}>
                        <Text style={styles.removeButtonText}>Remove Utility</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity style={styles.closeButton} onPress={() => setUtilityModalOpen(false)}>
                      <Text style={styles.closeButtonText}>Close</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </Modal>
            </View>
          )}

          {/* ── STEP 5: Notes ── */}
          {step === 5 && (
            <View style={styles.cardSection}>
              {renderCardHeader(5)}
              <Text style={styles.label}>Additional Notes (Optional)</Text>
              <TextInput
                style={[styles.input, { height: 140, textAlignVertical: "top" }]}
                placeholder="Add any additional notes about the property..."
                placeholderTextColor="#94A3B8"
                multiline
                numberOfLines={6}
                maxLength={NOTES_MAX_LENGTH}
                value={form.notes}
                onChangeText={(v) => updateForm("notes", v)}
              />
              <Text style={styles.notesCounter}>{`${form.notes.length}/${NOTES_MAX_LENGTH}`}</Text>
            </View>
          )}

          {/* ── STEP 6: Review ── */}
          {step === 6 && (
            <View style={styles.cardSection}>
              {renderCardHeader(6)}
              <View style={styles.reviewCard}>
                <View style={styles.reviewPhotoWrap}>
                  {photoUrl ? (
                    <TouchableOpacity activeOpacity={0.9} onPress={() => setPhotoModalOpen(true)}>
                      <Image source={{ uri: photoUrl }} style={styles.reviewPhoto} resizeMode="cover" />
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity activeOpacity={0.9} onPress={pickPhoto}>
                      <View style={styles.reviewPhotoPlaceholder}>
                        <Feather name="camera" size={SCREEN_WIDTH < 400 ? 24 : 28} color="#94A3B8" />
                        <Text style={styles.reviewPhotoPlaceholderText}>No photo added yet — tap to add</Text>
                      </View>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={styles.reviewPhotoEditButton}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    onPress={() => (photoUrl ? setPhotoActionOpen(true) : pickPhoto())}
                  >
                    <Feather name="edit-2" size={14} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>
                <View style={styles.reviewSummary}>
                  <Text style={styles.reviewPropertyName}>{form.propertyName || "Untitled Property"}</Text>
                  <Text style={styles.reviewPropertySubtext}>{`${form.street}${form.street ? ", " : ""}${form.city}${form.city ? ", " : ""}${form.state} ${form.zip}`.trim()}</Text>
                </View>
                <View style={styles.reviewDataGrid}>
                  <View style={styles.reviewDataRow}>
                    <Text style={styles.reviewLabel}>Property Name</Text>
                    <Text style={styles.reviewValue}>{form.propertyName || "-"}</Text>
                  </View>
                  <View style={styles.reviewDataRow}>
                    <Text style={styles.reviewLabel}>Address</Text>
                    <Text style={[styles.reviewValue, { textAlign: "right", flex: 1, marginLeft: 12 }]}>{`${form.street}${form.street ? ", " : ""}${form.city}, ${form.state} ${form.zip}`.trim()}</Text>
                  </View>
                  <View style={styles.reviewDataRow}>
                    <Text style={styles.reviewLabel}>Property Type</Text>
                    <Text style={styles.reviewValue}>{form.propertyType ? form.propertyType.charAt(0).toUpperCase() + form.propertyType.slice(1).replace("-", " ") : "-"}</Text>
                  </View>
                  {form.propertyType === "multi-family" && (
                    <View style={styles.reviewDataRow}>
                      <Text style={styles.reviewLabel}>Units</Text>
                      <Text style={styles.reviewValue}>{form.numUnits}</Text>
                    </View>
                  )}
                  <View style={styles.reviewDataRow}>
                    <Text style={styles.reviewLabel}>Property Value</Text>
                    <Text style={styles.reviewValue}>{formatCurrency(form.value) || "-"}</Text>
                  </View>
                  <View style={styles.reviewDataRow}>
                    <Text style={styles.reviewLabel}>Cash Invested</Text>
                    <Text style={styles.reviewValue}>{formatCurrency(form.downPayment) || "-"}</Text>
                  </View>
                  <View style={styles.reviewDataRow}>
                    <Text style={styles.reviewLabel}>Owner</Text>
                    <Text style={styles.reviewValue}>{form.ownerName || "-"}</Text>
                  </View>
                  <View style={styles.reviewDataRow}>
                    <Text style={styles.reviewLabel}>Tenants</Text>
                    <Text style={[styles.reviewValue, { textAlign: "right", flex: 1, marginLeft: 12 }]}>{form.tenants.length ? form.tenants.join(", ") : "-"}</Text>
                  </View>
                  <View style={[styles.reviewDataRow, { marginBottom: 0 }]}>
                    <Text style={styles.reviewLabel}>Monthly Utilities</Text>
                    <Text style={styles.reviewValue}>{Object.values(utilities).reduce((sum, item) => sum + Number(item?.amount || 0), 0) ? `$${Object.values(utilities).reduce((sum, item) => sum + Number(item?.amount || 0), 0).toLocaleString()}` : "-"}</Text>
                  </View>
                </View>
              </View>
            </View>
          )}

          {/* ── NAV BUTTONS ── */}
          <View style={styles.navContainer}>
            {step > 1 && (
              <TouchableOpacity style={[styles.button, styles.prevButton]} onPress={handlePrev}>
                <Feather name="arrow-left" size={16} color="#FFFFFF" style={{ marginRight: 6 }} />
                <Text style={styles.buttonText}>Back</Text>
              </TouchableOpacity>
            )}
            {step < 6 ? (
              <TouchableOpacity style={[styles.button, { flex: 1, marginLeft: step > 1 ? 8 : 0 }]} onPress={handleNext}>
                <Text style={styles.buttonText}>Next</Text>
                <Feather name="arrow-right" size={16} color="#FFFFFF" style={{ marginLeft: 6 }} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={[styles.button, styles.saveButton, { flex: 1, marginLeft: 8, opacity: saving ? 0.7 : 1 }]} onPress={handleSave} disabled={saving}>
                {!saving && <Feather name="check-circle" size={16} color="#FFFFFF" style={{ marginRight: 6 }} />}
                <Text style={styles.buttonText}>{saving ? "Saving..." : isEditing ? "Update Property" : "Save Property"}</Text>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>

      {/* Address suggestions overlay */}
      {showAddressSuggestions && (
        <View style={[styles.suggestionsOverlay, { top: suggestionsLayout.top, left: suggestionsLayout.left, width: suggestionsLayout.width }]}>
          {searchingAddress && addressSuggestions.length === 0 ? (
            <View style={styles.suggestionItem}>
              <Text style={[styles.suggestionSubtext, { textAlign: "center", flex: 1 }]}>Searching...</Text>
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
              {addressSuggestions.map((suggestion, index) => (
                <TouchableOpacity key={index} style={styles.suggestionItem} onPress={() => selectAddress(suggestion)}>
                  <Feather name="map-pin" size={SCREEN_WIDTH < 400 ? 14 : 16} color="#60A5FA" style={{ marginTop: 2 }} />
                  <View style={{ marginLeft: 8, flex: 1 }}>
                    <Text style={styles.suggestionText} numberOfLines={1}>{suggestion.street || suggestion.placeName}</Text>
                    <Text style={styles.suggestionSubtext} numberOfLines={1}>{`${suggestion.city}${suggestion.city ? ", " : ""}${suggestion.state} ${suggestion.zip}`.trim()}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
      )}

      {/* Photo preview modal */}
      <Modal visible={photoModalOpen} transparent animationType="fade" onRequestClose={() => setPhotoModalOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { alignItems: "center" }]}>
            {photoUrl ? <Image source={{ uri: photoUrl }} style={{ width: SCREEN_WIDTH - 48, height: (SCREEN_WIDTH - 48) * 0.7, borderRadius: 12, marginBottom: 12 }} resizeMode="cover" /> : null}
            <TouchableOpacity style={[styles.button, { backgroundColor: "#3B82F6", marginBottom: 8, width: "100%" }]} onPress={replacePhoto}>
              <Text style={styles.buttonText}>Replace Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, { backgroundColor: "#DC2626", marginBottom: 8, width: "100%" }]} onPress={() => { setPhotoUrl(null); setPhotoModalOpen(false); }}>
              <Text style={styles.buttonText}>Remove Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.closeButton} onPress={() => setPhotoModalOpen(false)}>
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Pencil action menu: change or remove the photo */}
      <Modal visible={photoActionOpen} transparent animationType="fade" onRequestClose={() => setPhotoActionOpen(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setPhotoActionOpen(false)} />
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Property Photo</Text>
            <TouchableOpacity style={[styles.applyButton, { marginBottom: 8 }]} onPress={changePhotoFromAction}>
              <Text style={styles.applyButtonText}>Change Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.removeButton, { marginBottom: 8 }]} onPress={removePhotoFromAction}>
              <Text style={styles.removeButtonText}>Remove Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.closeButton} onPress={() => setPhotoActionOpen(false)}>
              <Text style={styles.closeButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#060D1C", position: "relative" },
  backgroundImage: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  scrollContent: { padding: SCREEN_WIDTH < 400 ? 16 : 20, gap: 14 },
  headerContainer: { marginBottom: SCREEN_WIDTH < 400 ? 12 : 16 },
  headerTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 24 : 32, fontWeight: "900", letterSpacing: 0.5, marginBottom: 4 },
  progressContainer: { marginBottom: SCREEN_WIDTH < 400 ? 18 : 24 },
  progressText: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, marginBottom: 10 },

  stepDotsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepDot: { width: SCREEN_WIDTH < 400 ? 26 : 30, height: SCREEN_WIDTH < 400 ? 26 : 30, borderRadius: 999, backgroundColor: "rgba(30,41,59,0.9)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(59,130,246,0.14)" },
  stepDotActive: { backgroundColor: "#3B82F6", borderColor: "#3B82F6" },
  stepDotText: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, fontWeight: "800" },
  stepDotTextActive: { color: "#FFFFFF" },

  editSectionRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: SCREEN_WIDTH < 400 ? 12 : 16 },
  editSectionChip: { backgroundColor: "rgba(30,41,59,0.55)", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginBottom: 0, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  editSectionChipActive: { backgroundColor: "rgba(37,99,235,0.95)", borderColor: "rgba(59,130,246,0.35)" },
  editSectionChipText: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, fontWeight: "700" },
  editSectionChipTextActive: { color: "#FFFFFF" },

  errorContainer: { backgroundColor: "rgba(239,68,68,0.08)", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 14, marginBottom: SCREEN_WIDTH < 400 ? 12 : 16, borderWidth: 1, borderColor: "rgba(239,68,68,0.25)" },
  errorText: { color: "#EF4444", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, fontWeight: "700" },

  cardSection: { backgroundColor: "rgba(15,23,42,0.9)", borderRadius: 28, padding: SCREEN_WIDTH < 400 ? 16 : 20, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },

  cardHeaderRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: SCREEN_WIDTH < 400 ? 16 : 20 },
  cardHeaderIcon: { width: SCREEN_WIDTH < 400 ? 40 : 44, height: SCREEN_WIDTH < 400 ? 40 : 44, borderRadius: 14, backgroundColor: "rgba(59,130,246,0.14)", alignItems: "center", justifyContent: "center", marginRight: 12, borderWidth: 1, borderColor: "rgba(59,130,246,0.22)" },
  stepTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 18 : 20, fontWeight: "900", marginBottom: 4 },
  stepSubtitle: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, lineHeight: 18 },

  label: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, marginBottom: 8, fontWeight: "600" },

  input: { backgroundColor: "rgba(30,41,59,0.65)", color: "#FFFFFF", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, marginBottom: SCREEN_WIDTH < 400 ? 12 : 16, fontSize: SCREEN_WIDTH < 400 ? 14 : 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.10)" },

  rowGroup: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  halfInput: { flex: 1, minWidth: 140 },
  addressInputContainer: { position: "relative", zIndex: 1000 },
  suggestionsOverlay: { position: "absolute", backgroundColor: "rgba(30,41,59,0.98)", borderRadius: 16, maxHeight: 240, borderWidth: 1, borderColor: "rgba(59,130,246,0.14)", zIndex: 9999, elevation: 20, shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16 },
  suggestionItem: { padding: SCREEN_WIDTH < 400 ? 12 : 14, borderBottomWidth: 1, borderBottomColor: "rgba(51,65,85,0.6)", flexDirection: "row", alignItems: "center" },
  suggestionText: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, fontWeight: "700" },
  suggestionSubtext: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 10 : 12, marginTop: 2 },

  propertyTypeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "space-between", marginBottom: SCREEN_WIDTH < 400 ? 8 : 12 },
  typeCard: { flexBasis: "48%", backgroundColor: "rgba(30,41,59,0.6)", borderRadius: 20, padding: SCREEN_WIDTH < 400 ? 14 : 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(71,85,105,0.35)", marginBottom: 10, position: "relative" },
  typeCardSelected: { backgroundColor: "rgba(59,130,246,0.18)", borderColor: "#3B82F6" },
  typeIcon: { width: SCREEN_WIDTH < 400 ? 40 : 44, height: SCREEN_WIDTH < 400 ? 40 : 44, borderRadius: 14, backgroundColor: "rgba(15,23,42,0.95)", alignItems: "center", justifyContent: "center", marginBottom: 10, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  typeIconSelected: { backgroundColor: "#3B82F6" },
  typeLabel: { color: "#E2E8F0", fontSize: SCREEN_WIDTH < 400 ? 14 : 15, fontWeight: "800" },
  typeLabelSelected: { color: "#FFFFFF" },
  typeCheckBadge: { position: "absolute", top: 10, right: 10, width: 20, height: 20, borderRadius: 10, backgroundColor: "#3B82F6", alignItems: "center", justifyContent: "center" },

  photoSectionRow: { flexDirection: "row", alignItems: "flex-start", marginTop: SCREEN_WIDTH < 400 ? 8 : 12, marginBottom: 12 },
  photoSectionTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 14 : 15, fontWeight: "800", marginBottom: 4 },
  optionalText: { color: "#94A3B8", fontWeight: "600", fontSize: SCREEN_WIDTH < 400 ? 12 : 13 },
  photoSectionSubtitle: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, lineHeight: 18 },
  photoRow: { flexDirection: "row", gap: 12 },
  photoThumb: { width: SCREEN_WIDTH < 400 ? 84 : 96, height: SCREEN_WIDTH < 400 ? 84 : 96, borderRadius: 16, overflow: "hidden" },
  photoThumbImage: { width: "100%", height: "100%" },
  addPhotoButton: { flex: 1, height: SCREEN_WIDTH < 400 ? 84 : 96, borderRadius: 16, borderWidth: 1, borderStyle: "dashed", borderColor: "rgba(148,163,184,0.35)", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(30,41,59,0.4)" },
  addPhotoButtonText: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, fontWeight: "700", marginTop: 6 },

  tenantRow: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(30,41,59,0.65)", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, marginBottom: 8, borderWidth: 1, borderColor: "rgba(59,130,246,0.10)" },
  tenantRowText: { flex: 1, color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 14 : 16, fontWeight: "700" },
  addTenantRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: SCREEN_WIDTH < 400 ? 12 : 16 },
  addTenantButton: { backgroundColor: "#3B82F6", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  financialRow: { flexDirection: "row", gap: 10, flexWrap: "wrap", marginTop: 6 },
  financialCard: { backgroundColor: "rgba(30,41,59,0.85)", borderRadius: 18, padding: SCREEN_WIDTH < 400 ? 14 : 16, flex: 1, minWidth: 140, borderWidth: 1, borderColor: "rgba(59,130,246,0.16)" },
  financialCardLabel: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, marginBottom: 8, fontWeight: "700" },
  financialCardInputRow: { flexDirection: "row", alignItems: "center" },
  financialCardIcon: { width: 22, height: 22, borderRadius: 8, alignItems: "center", justifyContent: "center", marginRight: 8, backgroundColor: "rgba(15,23,42,0.7)" },
  financialCardInput: { flex: 1, color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 16 : 18, fontWeight: "900", padding: 0 },

  connectProviderButton: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(16,185,129,0.12)", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 18, marginBottom: SCREEN_WIDTH < 400 ? 10 : 12, borderWidth: 1, borderColor: "rgba(16,185,129,0.35)" },
  connectProviderIcon: { width: SCREEN_WIDTH < 400 ? 38 : 42, height: SCREEN_WIDTH < 400 ? 38 : 42, borderRadius: 13, backgroundColor: "#10B981", alignItems: "center", justifyContent: "center", marginRight: 12 },
  connectProviderTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 14 : 16, fontWeight: "900" },
  connectProviderSubtitle: { color: "#6EE7B7", fontSize: SCREEN_WIDTH < 400 ? 11 : 12, fontWeight: "600", marginTop: 2 },

  utilitiesContainer: { marginBottom: SCREEN_WIDTH < 400 ? 4 : 6 },
  utilityItem: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(30,41,59,0.65)", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, marginBottom: 10, borderWidth: 1, borderColor: "rgba(59,130,246,0.10)" },
  utilityRowMain: { flex: 1, flexDirection: "row", alignItems: "center" },
  utilityIconChip: { width: SCREEN_WIDTH < 400 ? 36 : 40, height: SCREEN_WIDTH < 400 ? 36 : 40, borderRadius: 12, alignItems: "center", justifyContent: "center", marginRight: 12 },
  utilityLabel: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 14 : 16, fontWeight: "900" },
  utilityDetailText: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, fontWeight: "600", marginTop: 2 },
  utilityPlaceholder: { color: "#64748B", fontSize: SCREEN_WIDTH < 400 ? 12 : 13, fontWeight: "600", marginTop: 2 },
  utilityAmountText: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 13 : 14, fontWeight: "800" },
  utilityDueText: { color: "#64748B", fontSize: SCREEN_WIDTH < 400 ? 10 : 11, fontWeight: "600", marginTop: 2 },
  utilityAddLink: { color: "#3B82F6", fontSize: SCREEN_WIDTH < 400 ? 13 : 14, fontWeight: "800" },
  utilityLinkBtn: { marginLeft: 8, width: 36, height: 36, borderRadius: 12, backgroundColor: "rgba(52,211,153,0.12)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(52,211,153,0.22)" },
  connectBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(52,211,153,0.08)", borderRadius: 14, padding: SCREEN_WIDTH < 400 ? 10 : 12, marginBottom: SCREEN_WIDTH < 400 ? 10 : 12, borderWidth: 1, borderColor: "rgba(52,211,153,0.25)" },
  connectBannerText: { flex: 1, color: "#6EE7B7", fontSize: SCREEN_WIDTH < 400 ? 11 : 12, fontWeight: "600", lineHeight: 17 },
  connectStatusRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(59,130,246,0.08)", borderRadius: 14, padding: SCREEN_WIDTH < 400 ? 10 : 12, marginBottom: SCREEN_WIDTH < 400 ? 10 : 12, borderWidth: 1, borderColor: "rgba(59,130,246,0.2)" },
  connectStatusText: { flex: 1, color: "#93C5FD", fontSize: SCREEN_WIDTH < 400 ? 11 : 12, fontWeight: "600" },

  notesCounter: { color: "#64748B", fontSize: 12, textAlign: "right", marginTop: -8 },

  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: SCREEN_WIDTH < 400 ? 16 : 20 },
  modalContent: { backgroundColor: "rgba(30,41,59,0.98)", borderRadius: 22, padding: SCREEN_WIDTH < 400 ? 14 : 18, borderWidth: 1, borderColor: "rgba(59,130,246,0.18)" },
  modalTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 16 : 18, fontWeight: "900", marginBottom: SCREEN_WIDTH < 400 ? 12 : 16 },
  modalLabel: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, marginBottom: 8, fontWeight: "700" },
  modalInput: { backgroundColor: "rgba(11,17,32,0.9)", color: "#FFFFFF", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, marginBottom: SCREEN_WIDTH < 400 ? 12 : 16, fontSize: SCREEN_WIDTH < 400 ? 14 : 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  dropdownButton: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "rgba(11,17,32,0.9)", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, marginBottom: SCREEN_WIDTH < 400 ? 12 : 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.12)" },
  dropdownButtonText: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 14 : 16, fontWeight: "800" },
  notifyRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "rgba(11,17,32,0.9)", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, marginBottom: SCREEN_WIDTH < 400 ? 12 : 16, borderWidth: 1, borderColor: "rgba(52,211,153,0.18)" },
  notifyTextWrap: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, marginRight: 12 },
  notifyTitle: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 13 : 14, fontWeight: "800" },
  notifySubtitle: { color: "#64748B", fontSize: SCREEN_WIDTH < 400 ? 11 : 12, fontWeight: "600", marginTop: 2 },
  modalItem: { padding: SCREEN_WIDTH < 400 ? 12 : 14, borderBottomWidth: 1, borderBottomColor: "rgba(51,65,85,0.65)" },
  modalItemText: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 14 : 16, fontWeight: "800" },
  applyButton: { backgroundColor: "#3B82F6", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, alignItems: "center", marginBottom: 8, shadowColor: "#1D4ED8", shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.25, shadowRadius: 18, elevation: 10 },
  applyButtonText: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 14 : 16, fontWeight: "900" },
  removeButton: { backgroundColor: "#DC2626", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, alignItems: "center", marginBottom: 8, shadowColor: "#991B1B", shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.25, shadowRadius: 18, elevation: 10 },
  removeButtonText: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 14 : 16, fontWeight: "900" },
  closeButton: { backgroundColor: "#475569", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, alignItems: "center" },
  closeButtonText: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 14 : 16, fontWeight: "900" },

  reviewCard: { backgroundColor: "rgba(15,23,42,0.96)", borderRadius: 28, padding: SCREEN_WIDTH < 400 ? 0 : 0 },
  reviewPhotoWrap: { position: "relative", marginBottom: SCREEN_WIDTH < 400 ? 14 : 16 },
  reviewPhoto: { width: "100%", height: 180, borderRadius: 22 },
  reviewPhotoPlaceholder: { width: "100%", height: 180, borderRadius: 22, borderWidth: 1, borderStyle: "dashed", borderColor: "rgba(148,163,184,0.35)", alignItems: "center", justifyContent: "center" },
  reviewPhotoPlaceholderText: { color: "#94A3B8", marginTop: 8, fontSize: SCREEN_WIDTH < 400 ? 13 : 14 },
  reviewPhotoEditButton: { position: "absolute", top: 12, right: 12, width: 32, height: 32, borderRadius: 10, backgroundColor: "rgba(15,23,42,0.85)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.15)" },
  reviewSummary: { marginBottom: SCREEN_WIDTH < 400 ? 14 : 16 },
  reviewPropertyName: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 18 : 20, fontWeight: "900", marginBottom: 4 },
  reviewPropertySubtext: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, lineHeight: 18 },
  reviewDataGrid: { backgroundColor: "rgba(30,41,59,0.7)", borderRadius: 22, padding: SCREEN_WIDTH < 400 ? 14 : 16 },
  reviewDataRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: SCREEN_WIDTH < 400 ? 10 : 12 },
  reviewLabel: { color: "#94A3B8", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, fontWeight: "700" },
  reviewValue: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 12 : 14, fontWeight: "900" },

  button: { flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "#3B82F6", padding: SCREEN_WIDTH < 400 ? 12 : 14, borderRadius: 16, borderWidth: 1, borderColor: "rgba(59,130,246,0.20)", shadowColor: "#1D4ED8", shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.25, shadowRadius: 18, elevation: 12 },
  buttonText: { color: "#FFFFFF", fontSize: SCREEN_WIDTH < 400 ? 14 : 16, fontWeight: "900" },
  navContainer: { flexDirection: "row", marginTop: SCREEN_WIDTH < 400 ? 12 : 16 },
  prevButton: { backgroundColor: "rgba(71,85,105,0.95)" },
  saveButton: { backgroundColor: "#10B981" },
});