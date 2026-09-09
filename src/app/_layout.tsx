import { Stack } from "expo-router";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { setupNotifications } from "../lib/notifications";

export default function Layout() {
  useEffect(() => {
    setupNotifications();
  }, []);

  return (
    <>
      <StatusBar barStyle="light-content" backgroundColor="#0B1120" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
