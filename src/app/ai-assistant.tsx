import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import { collection, getDocs, query, where } from "firebase/firestore";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { QUICK_QUESTIONS, askAssistant, makeAssistantMessage, makeUserMessage, type AIMessage, type PortfolioContext } from "../lib/ai";
import { computeNextDueDate } from "../lib/date";
import { auth, db } from "../lib/firebase";

/** Mirrors the Tenants screen's overdue check using the dates stored on a tenant. */
function isOverdueTenant(t: any): boolean {
  if (t.dueDay == null && t.dueDay !== "last") return false;
  const now = new Date();
  if (t.lastPaidAt) {
    const paidOn = t.lastPaidAt.toDate ? t.lastPaidAt.toDate() : new Date(t.lastPaidAt);
    if (!isNaN(paidOn.getTime()) && computeNextDueDate(t.dueDay, paidOn) > now) return false;
  }
  const currentDay = now.getDate();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dueDayNum = t.dueDay === "last" ? lastDay : Number(t.dueDay);
  return isFinite(dueDayNum) && dueDayNum < currentDay;
}

export default function AiAssistant() {
  const router = useRouter();
  const [messages, setMessages] = useState<AIMessage[]>([
    makeAssistantMessage(
      "Hi, I'm your EstateFlow assistant! Ask me anything about the app (properties, tenants, rent, utilities, maintenance, payouts, plans) or real-estate topics (leases, screening, cap rate, deposits…). How can I help?"
    ),
  ]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [cloudBadge, setCloudBadge] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [ctx, setCtx] = useState<PortfolioContext>({});
  const scrollRef = useRef<ScrollView>(null);

  // Load light portfolio context so answers can be personalized.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) return;
      try {
        const [pSnap, tSnap] = await Promise.all([
          getDocs(query(collection(db, "properties"), where("ownerId", "==", user.uid))),
          getDocs(query(collection(db, "tenants"), where("ownerId", "==", user.uid))),
        ]);
        let income = 0;
        let expense = 0;
        let portfolioValue = 0;
        pSnap.docs.forEach((d) => {
          const p = d.data() as any;
          income += Number(p.monthlyIncome) || 0;
          portfolioValue += Number(p.marketValue) || 0;
          const utils = p.utilities || {};
          Object.values(utils).forEach((u: any) => {
            expense += parseFloat(u?.amount) || 0;
          });
        });
        let tenantIncome = 0;
        let overdueCount = 0;
        tSnap.docs.forEach((d) => {
          const t = d.data() as any;
          tenantIncome += Number(t.rentAmount) || 0;
          if (isOverdueTenant(t)) overdueCount += 1;
        });
        setCtx({
          propertyCount: pSnap.size,
          tenantCount: tSnap.size,
          monthlyIncome: tenantIncome || income,
          monthlyExpense: expense,
          overdueCount,
          portfolioValue,
        });
      } catch {}
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length, thinking]);

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || thinking) return;
    setInput("");
    // Snapshot current history BEFORE adding the new user message — the
    // assistant gets the previous turns as context for follow-up questions.
    const history = messages;
    setMessages((m) => [...m, makeUserMessage(text)]);
    setThinking(true);
    const { text: reply, cloud, provider: p } = await askAssistant(text, ctx, history);
    setCloudBadge(cloud);
    setProvider(p ?? null);
    setMessages((m) => [...m, makeAssistantMessage(reply)]);
    setThinking(false);
  };

  return (
    <View style={s.root}>
      <Image
        source={require("../assets/ai-background.png")}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
        }}
        resizeMode="cover"
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(5,10,20,0.80)" }]} />

      <SafeAreaView style={{ flex: 1 }}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/dashboard"))} style={s.iconBtn}>
            <Feather name="arrow-left" size={20} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.title}>EstateFlow Assistant</Text>
            <Text style={s.subtitle}>{cloudBadge ? `Cloud AI • live${provider ? ` (${provider})` : ""}` : "Built-in AI • offline-ready"}</Text>
          </View>
          <View style={s.sparkle}>
            <Feather name="zap" size={18} color="#93C5FD" />
          </View>
        </View>

        <ScrollView ref={scrollRef} contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
          {messages.map((m) => (
            <View key={m.id} style={[s.bubble, m.role === "user" ? s.user : s.assistant]}>
              {m.role === "assistant" && <Feather name="cpu" size={14} color="#93C5FD" style={{ marginBottom: 4 }} />}
              <Text style={[s.msgText, m.role === "user" ? { color: "#fff" } : { color: "#E2E8F0" }]}>{m.text}</Text>
            </View>
          ))}
          {thinking && (
            <View style={[s.bubble, s.assistant]}>
              <ActivityIndicator size="small" color="#93C5FD" />
              <Text style={[s.msgText, { color: "#94A3B8", marginTop: 6 }]}>Thinking…</Text>
            </View>
          )}
        </ScrollView>

        <View style={s.chipsWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
            {QUICK_QUESTIONS.map((q) => (
              <TouchableOpacity key={q} style={s.chip} onPress={() => send(q)}>
                <Text style={s.chipText}>{q}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={s.composer}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Ask about the app or real estate…"
              placeholderTextColor="#475569"
              style={s.input}
              multiline
              onSubmitEditing={() => send()}
              returnKeyType="send"
            />
            <TouchableOpacity style={[s.sendBtn, (!input.trim() || thinking) && { opacity: 0.4 }]} onPress={() => send()} disabled={!input.trim() || thinking}>
              <Feather name="send" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#060D1C" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "rgba(59,130,246,0.15)" },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.1)", justifyContent: "center", alignItems: "center" },
  title: { color: "#fff", fontSize: 17, fontWeight: "800" },
  subtitle: { color: "#64748B", fontSize: 12, marginTop: 2 },
  sparkle: { width: 40, height: 40, borderRadius: 12, backgroundColor: "rgba(59,130,246,0.15)", justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: "rgba(59,130,246,0.3)" },
  list: { width: "100%", maxWidth: 768, alignSelf: "center", padding: 16, gap: 10, paddingBottom: 8 },
  bubble: { maxWidth: "85%", borderRadius: 16, padding: 12 },
  user: { alignSelf: "flex-end", backgroundColor: "#2563EB" },
  assistant: { alignSelf: "flex-start", backgroundColor: "rgba(14,22,42,0.95)", borderWidth: 1, borderColor: "rgba(59,130,246,0.2)" },
  msgText: { fontSize: 14, lineHeight: 20 },
  chipsWrap: { width: "100%", maxWidth: 768, alignSelf: "center", paddingVertical: 8 },
  chip: { backgroundColor: "rgba(59,130,246,0.12)", borderWidth: 1, borderColor: "rgba(59,130,246,0.3)", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8 },
  chipText: { color: "#93C5FD", fontSize: 12, fontWeight: "600" },
  composer: { width: "100%", maxWidth: 768, alignSelf: "center", flexDirection: "row", alignItems: "flex-end", gap: 10, padding: 16, borderTopWidth: 1, borderTopColor: "rgba(59,130,246,0.15)" },
  input: { flex: 1, backgroundColor: "rgba(14,22,42,0.95)", borderWidth: 1, borderColor: "rgba(59,130,246,0.25)", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: "#fff", fontSize: 14, maxHeight: 110 },
  sendBtn: { width: 46, height: 46, borderRadius: 14, backgroundColor: "#2563EB", justifyContent: "center", alignItems: "center" },
});
