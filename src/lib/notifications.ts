import { Platform } from "react-native";
import { computeNextDueDate } from "./date";
import { utilityMeters } from "./utilities";

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

export type MaintenanceTask = {
  id: string;
  title: string;
  propertyName: string;
  cost: number;
  date: any;
  status?: string;
  createdAt?: any;
};

export type MaintenanceReminder = {
  id: string;
  title: string;
  propertyName: string;
  cost: number;
  dueDate: Date;
  overdue: boolean;
};

// Session-level dedupe so a new request doesn't re-push on every app open.
const notifiedNewMaintenanceIds = new Set<string>();

/**
 * Tenant-portal maintenance requests only (landlord manual tasks never
 * notify). Pushes for newly arrived requests + overdue/due-soon open ones.
 */
export async function scheduleMaintenanceReminders(
  tasks: MaintenanceTask[]
): Promise<{ count: number; upcoming: MaintenanceReminder[] }> {
  // Same pattern as rent/utilities: the due list is computed regardless of
  // OS permission — only the scheduled push needs it.
  let canNotify = !!(Notifications && _native);
  if (canNotify) {
    const granted = await setupNotifications();
    if (!granted) canNotify = false;
  }

  const upcoming: MaintenanceReminder[] = [];
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const task of tasks) {
    if (!task || !task.id) continue;
    // Done tasks never remind.
    if (String(task.status || "").toLowerCase() === "done") continue;
    const raw = task.date;
    const due = raw?.toDate ? raw.toDate() : raw ? new Date(raw) : null;
    if (!due || isNaN(due.getTime())) continue;

    const pushNow = async (title: string, body: string, extra?: Record<string, any>) => {
      if (!canNotify) return;
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          data: { maintenanceId: task.id, ...(extra || {}) },
        },
        trigger: { seconds: 60, type: Notifications.SchedulableTriggerInputTypes?.TIME_INTERVAL || 0 },
      });
    };

    const addUpcoming = (overdue: boolean) => {
      upcoming.push({
        id: task.id,
        title: task.title || "Maintenance request",
        propertyName: task.propertyName || "",
        cost: task.cost || 0,
        dueDate: due,
        overdue,
      });
    };

    // Fresh tenant request (arrived in the last 24h): always surface + push once.
    const createdRaw = task.createdAt;
    const created = createdRaw?.toDate ? createdRaw.toDate() : createdRaw ? new Date(createdRaw) : null;
    const isNew =
      created && !isNaN(created.getTime()) && Date.now() - created.getTime() < 24 * 60 * 60 * 1000;
    if (isNew) {
      addUpcoming(due < todayStart);
      if (!notifiedNewMaintenanceIds.has(task.id)) {
        notifiedNewMaintenanceIds.add(task.id);
        await pushNow(
          "New maintenance request",
          `${task.title || "Maintenance request"}${task.propertyName ? ` at ${task.propertyName}` : ""} — tap to review`
        );
      }
      continue;
    }

    const overdue = due < todayStart;
    const diffMs = due.getTime() - Date.now();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    if (overdue) {
      addUpcoming(true);
      await pushNow(
        "Maintenance Overdue",
        `${task.title || "Maintenance request"}${task.propertyName ? ` at ${task.propertyName}` : ""} is still open`,
        { overdue: true }
      );
      continue;
    }

    // Only surface requests due soon (today through next 3 days).
    if (!(diffDays <= 3)) continue;
    addUpcoming(false);

    if (canNotify && diffDays <= 2) {
      const triggerSec = diffDays > 0 ? Math.max(Math.round(diffMs / 1000) - 86400, 60) : 60;
      const trigger: any = { seconds: triggerSec };
      if (Notifications.SchedulableTriggerInputTypes?.TIME_INTERVAL !== undefined) {
        trigger.type = Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL;
      }
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "Maintenance Due Soon",
          body: `${task.title || "Maintenance request"}${task.propertyName ? ` at ${task.propertyName}` : ""} is due ${due.toLocaleDateString()}`,
          data: { maintenanceId: task.id },
        },
        trigger,
      });
    }
  }

  return { count: upcoming.length, upcoming };
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

  const upcoming: { propertyId: string; propertyName: string; utilityName: string; amount: string; dueDate: Date }[] = [];

  for (const property of properties) {
    if (!property.utilities) continue;
    for (const [utilityName, utility] of Object.entries(property.utilities)) {
      // Opt-out: user disabled reminders for this utility
      if (utility.notify === false) continue;
      for (const meter of utilityMeters(utility as any)) {
        const notify = meter.notify ?? (utility as any).notify ?? true;
        if (notify === false) continue;
        const label = meter.label ? `${utilityName} (${meter.label})` : utilityName;
        const due = nextDueDate(meter.dueDay);
        if (!due) continue;

        const diffMs = due.getTime() - Date.now();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        // Only surface utilities that are due soon (next 3 days)
        if (!(diffDays > 0 && diffDays <= 3)) continue;

        upcoming.push({ propertyId: property.id, propertyName: property.propertyName, utilityName: label, amount: meter.amount, dueDate: due });

        if (canNotify && diffDays <= 2 && diffDays > 0) {
          const triggerSec = Math.max(Math.round(diffMs / 1000) - 86400, 60);
          await Notifications.scheduleNotificationAsync({
            content: {
              title: "Utility Due Tomorrow",
              body: `${property.propertyName}: ${label} bill of $${Number(meter.amount).toLocaleString()} is due ${due.toLocaleDateString()}`,
              data: { propertyId: property.id, utilityName: label },
            },
            trigger: { seconds: triggerSec, type: Notifications.SchedulableTriggerInputTypes?.TIME_INTERVAL || 0 },
          });
        }
      }
    }
  }

  return { count: upcoming.length, upcoming };
}
