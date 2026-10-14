import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

interface Props {
  title: string;
  subtitle?: string;
  /** Defaults to back-or-dashboard. Pass null-ish handling via showBack. */
  onBack?: () => void;
  showBack?: boolean;
  /** Right-side action(s), e.g. search / export buttons. */
  right?: ReactNode;
}

/**
 * Shared professional screen header: refined back button, title with an
 * optional subtitle, and a slot for right-side actions. Used by every
 * screen except the dashboard.
 */
export function ScreenHeader({ title, subtitle, onBack, showBack = true, right }: Props) {
  const router = useRouter();
  const goBack = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace("/dashboard")));

  return (
    <View style={s.row}>
      {showBack ? (
        <TouchableOpacity
          onPress={goBack}
          style={s.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="chevron-left" size={22} color="#fff" />
        </TouchableOpacity>
      ) : null}
      <View style={s.titleWrap}>
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={s.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ?? (showBack ? <View style={s.backSpacer} /> : null)}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 6,
    minHeight: 48,
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  titleWrap: { flex: 1, minWidth: 0, justifyContent: "center" },
  title: {
    color: "#fff",
    fontSize: 23,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  subtitle: { color: "#8B93A7", fontSize: 12, fontWeight: "600", marginTop: 3 },
  backSpacer: { width: 42 },
});
