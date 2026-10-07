import { Link } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { ContentMaxWidth } from "@/constants/responsive";

export default function NotFound() {
  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.code}>404</Text>
        <Text style={styles.title}>Page not found</Text>
        <Text style={styles.subtitle}>This route does not exist or was moved.</Text>
        <Link href="/dashboard" style={styles.link}>
          <Text style={styles.linkText}>Go to dashboard</Text>
        </Link>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#060D1C",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: ContentMaxWidth.narrow,
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.9)",
    borderRadius: 24,
    padding: 32,
    borderWidth: 1,
    borderColor: "rgba(59,130,246,0.18)",
  },
  code: { color: "#3B82F6", fontSize: 56, fontWeight: "900" },
  title: { color: "#FFFFFF", fontSize: 22, fontWeight: "800", marginTop: 8 },
  subtitle: { color: "#94A3B8", fontSize: 14, marginTop: 8, textAlign: "center" },
  link: { marginTop: 20, backgroundColor: "#2563EB", borderRadius: 14, paddingHorizontal: 20, paddingVertical: 12 },
  linkText: { color: "#fff", fontWeight: "800" },
});
