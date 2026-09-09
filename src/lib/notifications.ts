import { Platform } from "react-native";
import { computeNextDueDate } from "./date";

let Notifications: any = null;
let _native = false;
try {
  Notifications = require("expo-notifications");
  _native = Platform.OS === "ios" || Platform.OS === "android";
} catch {}

export type UtilityEntry = {
  amount: string;
  provider: string;
  dueDay: number | "last";
  notify?: boolean;
};

export type RentReminder = {
  tenantName: string;
  propertyName: string;
  amount: number;
  dueDate: Date;
  overdue: boolean;
};

export async function setupNotifications(): Promise<boolean> {
  if (!Notifications || !_native) return false;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("utility-dues", {
      name: "Utility Due Reminders",
      importance: Notifications.AndroidImportance?.HIGH || 4,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

function nextDueDate(dueDay: number | "last"): Date | null {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  if (dueDay === "last") {
    const lastDay = new Date(year, month + 1, 0).getDate();
    const d = new Date(year, month, lastDay);
    if (d <= now) d.setMonth(d.getMonth() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }

  const d = new Date(year, month, dueDay, 9, 0, 0, 0);
  if (d <= now) d.setMonth(d.getMonth() + 1);
  return d;
}

export async function scheduleRentReminders(
  tenants: {
    id: string;
    tenantName: string;
    propertyName: string;
    rentAmount: number;
    dueDay: number | "last";
    lastPaidAt?: any;
  }[]
): Promise<{ count: number; upcoming: RentReminder[] }> {
  // The alert list is computed regardless of OS notification permission —
  // only the scheduled push notifications require it.
  let canNotify = !!(Notifications && _native);
  if (canNotify) {
    const granted = await setupNotifications();
    if (!granted) canNotify = false;
  }

  const upcoming: RentReminder[] = [];
  const now = new Date();

  for (const tenant of tenants) {
    if (!tenant.rentAmount || tenant.rentAmount <= 0) continue;

    // Already paid and the payment covers the current period → skip
    if (tenant.lastPaidAt) {
      const paidOn = tenant.lastPaidAt.toDate ? tenant.lastPaidAt.toDate() : new Date(tenant.lastPaidAt);
      if (!isNaN(paidOn.getTime()) && computeNextDueDate(tenant.dueDay, paidOn) > now) continue;
    }

    // Overdue: this month's due day has already passed
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dueDayNum = tenant.dueDay === "last" ? lastDay : tenant.dueDay;
    const overdue = now.getDate() > dueDayNum;

    if (overdue) {
      upcoming.push({
        tenantName: tenant.tenantName,
        propertyName: tenant.propertyName,
        amount: tenant.rentAmount,
        dueDate: now,
        overdue: true,
      });
      if (canNotify) {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: "Rent Overdue",
            body: `${tenant.tenantName} at ${tenant.propertyName}: $${tenant.rentAmount.toLocaleString()} rent is overdue`,
            data: { tenantId: tenant.id, overdue: true },
          },
          trigger: { seconds: 60, type: Notifications.SchedulableTriggerInputTypes?.TIME_INTERVAL || 0 },
        });
      }
      continue;
    }

    const due = nextDueDate(tenant.dueDay);
    if (!due) continue;

    const diffMs = due.getTime() - Date.now();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    // Only surface items that are actually due soon (next 3 days)
    if (!(diffDays > 0 && diffDays <= 3)) continue;

    upcoming.push({
      tenantName: tenant.tenantName,
      propertyName: tenant.propertyName,
      amount: tenant.rentAmount,
      dueDate: due,
      overdue: false,
    });

    if (canNotify && diffDays <= 2 && diffDays > 0) {
      const triggerSec = Math.max(Math.round(diffMs / 1000) - 86400, 60);
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "Rent Due Tomorrow",
          body: `${tenant.tenantName} at ${tenant.propertyName}: $${tenant.rentAmount.toLocaleString()} rent is due ${due.toLocaleDateString()}`,
          data: { tenantId: tenant.id },
        },
        trigger: { seconds: triggerSec, type: Notifications.SchedulableTriggerInputTypes?.TIME_INTERVAL || 0 },
      });
    }
  }

  // Due items only (overdue or within the next 3 days)
  const count = upcoming.length;

  return { count, upcoming };
}

export async function scheduleUtilityReminders(
  properties: { id: string; propertyName: string; utilities: Record<string, UtilityEntry> }[]
) {
  // Alert list is computed regardless of OS permission; only the push notification needs it.
  let canNotify = !!(Notifications && _native);
  if (canNotify) {
    const granted = await setupNotifications();
    if (!granted) canNotify = false;
    else await Notifications.cancelAllScheduledNotificationsAsync();
  }

  const upcoming: { propertyName: string; utilityName: string; amount: string; dueDate: Date }[] = [];

  for (const property of properties) {
    if (!property.utilities) continue;
    for (const [utilityName, utility] of Object.entries(property.utilities)) {
      // Opt-out: user disabled reminders for this utility
      if (utility.notify === false) continue;
      const due = nextDueDate(utility.dueDay);
      if (!due) continue;

      const diffMs = due.getTime() - Date.now();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      // Only surface utilities that are due soon (next 3 days)
      if (!(diffDays > 0 && diffDays <= 3)) continue;

      upcoming.push({ propertyName: property.propertyName, utilityName, amount: utility.amount, dueDate: due });

      if (canNotify && diffDays <= 2 && diffDays > 0) {
        const triggerSec = Math.max(Math.round(diffMs / 1000) - 86400, 60);
        await Notifications.scheduleNotificationAsync({
          content: {
            title: "Utility Due Tomorrow",
            body: `${property.propertyName}: ${utilityName} bill of $${Number(utility.amount).toLocaleString()} is due ${due.toLocaleDateString()}`,
            data: { propertyId: property.id, utilityName },
          },
          trigger: { seconds: triggerSec, type: Notifications.SchedulableTriggerInputTypes?.TIME_INTERVAL || 0 },
        });
      }
    }
  }

  return { count: upcoming.length, upcoming };
}
