import { Platform, Share } from "react-native";

function escapeCSV(value: string | number | null | undefined): string {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSV(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(escapeCSV).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCSV).join(","));
  }
  return lines.join("\n");
}

async function shareOrDownload(csv: string, filename: string) {
  if (Platform.OS === "web") {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return;
  }
  await Share.share({ message: csv }, { dialogTitle: `Export ${filename}` });
}

// ── Properties ──────────────────────────────────────────────────────────────
type Property = {
  propertyName: string;
  address: string;
  propertyType: string;
  numUnits: number;
  ownerName: string;
  value?: number;
  monthlyIncome?: number;
  utilities: Record<string, { amount: string; provider: string; dueDay: number | "last"; notify?: boolean }> | null;
  notes: string | null;
};

export async function exportProperties(properties: Property[]) {
  const headers = [
    "Property Name",
    "Address",
    "Type",
    "Units",
    "Owner",
    "Value",
    "Monthly Income",
    "Utility Costs/mo",
    "Utilities",
    "Notes",
  ];
  const rows = properties.map((p) => {
    const utilEntries = p.utilities ? Object.entries(p.utilities) : [];
    const totalUtil = utilEntries.reduce((s, [, u]) => s + (parseFloat(u.amount) || 0), 0);
    const utilList = utilEntries.map(([k, u]) => `${k}: $${u.amount}`).join("; ");
    return [
      p.propertyName,
      p.address,
      p.propertyType,
      p.numUnits || "",
      p.ownerName,
      p.value ?? "",
      p.monthlyIncome ?? "",
      totalUtil || "",
      utilList,
      p.notes ?? "",
    ];
  });
  const csv = toCSV(headers, rows);
  const date = new Date().toISOString().slice(0, 10);
  await shareOrDownload(csv, `estateflow-properties-${date}.csv`);
}

// ── Tenants ─────────────────────────────────────────────────────────────────
type Tenant = {
  tenantName: string;
  propertyName: string;
  rentAmount: number;
  dueDay: number | "last";
  notes: string;
  lastPaidAt?: any;
};

function formatDueDay(d: number | "last") {
  if (d === "last") return "Last day of month";
  const s = ["th", "st", "nd", "rd"];
  const v = d % 100;
  return `${d}${s[(v - 20) % 10] || s[v] || s[0]} of month`;
}

function fmtDate(v: any): string {
  if (!v) return "";
  const d = v.toDate ? v.toDate() : new Date(v);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export async function exportTenants(tenants: Tenant[]) {
  const headers = [
    "Tenant Name",
    "Property",
    "Rent Amount",
    "Due Day",
    "Notes",
    "Last Paid",
  ];
  const rows = tenants.map((t) => [
    t.tenantName,
    t.propertyName,
    t.rentAmount || 0,
    formatDueDay(t.dueDay),
    t.notes ?? "",
    fmtDate(t.lastPaidAt),
  ]);
  const csv = toCSV(headers, rows);
  const date = new Date().toISOString().slice(0, 10);
  await shareOrDownload(csv, `estateflow-tenants-${date}.csv`);
}

// ── Payment History ─────────────────────────────────────────────────────────
type Payment = {
  tenantName: string;
  propertyName: string;
  rentAmount: number;
  paidAt: any;
};

export async function exportPayments(payments: Payment[]) {
  const headers = ["Tenant", "Property", "Amount", "Date Paid"];
  const rows = payments.map((p) => [
    p.tenantName,
    p.propertyName,
    p.rentAmount || 0,
    fmtDate(p.paidAt),
  ]);
  const csv = toCSV(headers, rows);
  const date = new Date().toISOString().slice(0, 10);
  await shareOrDownload(csv, `estateflow-payments-${date}.csv`);
}

// ── Maintenance ─────────────────────────────────────────────────────────────
type Maintenance = {
  title: string;
  propertyName: string;
  cost: number;
  date: any;
  notes?: string;
  status?: string;
};

export async function exportMaintenance(items: Maintenance[]) {
  const headers = ["Title", "Property", "Cost", "Date", "Status", "Notes"];
  const rows = items.map((m) => [
    m.title,
    m.propertyName,
    m.cost || 0,
    fmtDate(m.date),
    m.status ?? "",
    m.notes ?? "",
  ]);
  const csv = toCSV(headers, rows);
  const date = new Date().toISOString().slice(0, 10);
  await shareOrDownload(csv, `estateflow-maintenance-${date}.csv`);
}

// ── Full Report (all data combined) ────────────────────────────────────────
export async function exportFullReport(opts: {
  properties: Property[];
  tenants: Tenant[];
  payments: Payment[];
  maintenance: Maintenance[];
}) {
  const sections: string[] = [];

  // Properties section
  sections.push("--- PROPERTIES ---");
  const propHeaders = ["Property Name", "Address", "Type", "Owner", "Value", "Monthly Income", "Utilities/mo"];
  const propRows = opts.properties.map((p) => {
    const utilTotal = p.utilities
      ? Object.values(p.utilities).reduce((s, u) => s + (parseFloat(u.amount) || 0), 0)
      : 0;
    return [p.propertyName, p.address, p.propertyType, p.ownerName, p.value ?? "", p.monthlyIncome ?? "", utilTotal || ""];
  });
  sections.push(toCSV(propHeaders, propRows));

  // Tenants section
  sections.push("\n--- TENANTS ---");
  const tenHeaders = ["Tenant Name", "Property", "Rent Amount", "Due Day", "Last Paid"];
  const tenRows = opts.tenants.map((t) => [
    t.tenantName,
    t.propertyName,
    t.rentAmount || 0,
    formatDueDay(t.dueDay),
    fmtDate(t.lastPaidAt),
  ]);
  sections.push(toCSV(tenHeaders, tenRows));

  // Payments section
  if (opts.payments.length > 0) {
    sections.push("\n--- PAYMENT HISTORY ---");
    const payHeaders = ["Tenant", "Property", "Amount", "Date Paid"];
    const payRows = opts.payments.map((p) => [
      p.tenantName,
      p.propertyName,
      p.rentAmount || 0,
      fmtDate(p.paidAt),
    ]);
    sections.push(toCSV(payHeaders, payRows));
  }

  // Maintenance section
  if (opts.maintenance.length > 0) {
    sections.push("\n--- MAINTENANCE ---");
    const mHeaders = ["Title", "Property", "Cost", "Date", "Notes"];
    const mRows = opts.maintenance.map((m) => [
      m.title,
      m.propertyName,
      m.cost || 0,
      fmtDate(m.date),
      m.notes ?? "",
    ]);
    sections.push(toCSV(mHeaders, mRows));
  }

  const csv = sections.join("\n");
  const date = new Date().toISOString().slice(0, 10);
  await shareOrDownload(csv, `estateflow-full-report-${date}.csv`);
}

// ── Insights / Monthly Report ──────────────────────────────────────────────
type MonthSnapshot = {
  totalCost: number;
  monthlyIncome: number;
  portfolioValue: number;
  recordedAt: string;
};

export async function exportInsights(opts: {
  snapshots: Record<string, MonthSnapshot>;
  paidByMonth: Record<string, number>;
  maintenance: { title: string; propertyName: string; cost: number; date: any }[];
}) {
  const headers = ["Month", "Income", "Expenses", "Net", "Portfolio Value", "Rent Collected"];
  const sortedKeys = Object.keys(opts.snapshots).sort();
  const rows = sortedKeys.map((key) => {
    const s = opts.snapshots[key];
    return [
      key,
      s.monthlyIncome || 0,
      s.totalCost || 0,
      (s.monthlyIncome || 0) - (s.totalCost || 0),
      s.portfolioValue || 0,
      opts.paidByMonth[key] || 0,
    ];
  });
  const sections = [toCSV(headers, rows)];

  // Maintenance breakdown
  if (opts.maintenance.length > 0) {
    sections.push("\n--- MAINTENANCE BY PROPERTY ---");
    const byProp: Record<string, number> = {};
    opts.maintenance.forEach((m) => {
      byProp[m.propertyName] = (byProp[m.propertyName] || 0) + (m.cost || 0);
    });
    const mHeaders = ["Property", "Total Maintenance Cost"];
    const mRows = Object.entries(byProp).map(([prop, cost]) => [prop, cost]);
    sections.push(toCSV(mHeaders, mRows));
  }

  const csv = sections.join("\n");
  const date = new Date().toISOString().slice(0, 10);
  await shareOrDownload(csv, `estateflow-insights-${date}.csv`);
}
