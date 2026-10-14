import { Stack, useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform, StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { setupNotifications } from "../lib/notifications";

/**
 * Notification payload → screen. Rent reminders carry tenantId, utility
 * reminders carry propertyId (+utilityName). Anything unrecognized (or a
 * future maintenance payload) falls back to the dashboard. Every target
 * bounces to login on its own when signed out.
 */
function targetForNotificationData(data: any): any {
  if (!data || typeof data !== "object") return null;
  if (typeof data.tenantId === "string" && data.tenantId) return "/tenants";
  if (typeof data.propertyId === "string" && data.propertyId) {
    return { pathname: "/property-breakdown", params: { propertyId: data.propertyId } };
  }
  if (typeof data.maintenanceId === "string" && data.maintenanceId) return "/maintenance";
  if (typeof data.screen === "string" && data.screen.startsWith("/")) return data.screen;
  return "/dashboard";
}

export default function Layout() {
  const router = useRouter();

  useEffect(() => {
    setupNotifications().catch(() => {});
  }, []);

  // Tapping a push notification opens the screen it belongs to — both when
  // the app is open/backgrounded and on cold start (tap launches the app).
  useEffect(() => {
    if (Platform.OS === "web") return;
    let sub: { remove: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const N = require("expo-notifications");
        const last = await N.getLastNotificationResponseAsync().catch(() => null);
        const target = targetForNotificationData(last?.notification?.request?.content?.data);
        if (!cancelled && target) {
          console.log("[notifications] cold-start tap →", JSON.stringify(target));
          timer = setTimeout(() => router.push(target), 600);
        }
        sub = N.addNotificationResponseReceivedListener((response: any) => {
          const t = targetForNotificationData(response?.notification?.request?.content?.data);
          console.log("[notifications] tap →", JSON.stringify(t));
          if (t) router.push(t);
        });
      } catch {
        // Notifications unavailable (Expo Go iOS, etc.) — taps just open the app.
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      try {
        sub?.remove?.();
      } catch {}
    };
  }, [router]);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0B1120" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
