import { Stack } from "expo-router";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { setupNotifications } from "../lib/notifications";

export default function Layout() {
  useEffect(() => {
    setupNotifications().catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0B1120" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
