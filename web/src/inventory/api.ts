import { ApiError } from "../api";

export type StockStatus = "OK" | "LOW" | "CRITICAL";
export type TxnKind = "PURCHASE" | "RESERVATION" | "RELEASE" | "CONSUMPTION" | "ADJUSTMENT";

export type Stock = { onHand: number; reserved: number; available: number };

export type Material = {
  id: number;
  name: string;
  category: string;
  type: string;
  unit: string;
  costMinor: number;
  costQuantity: number;
  currency: string;
  lowStockThreshold: number | null;
  reorderQuantity: number | null;
  fullQuantity: number | null;
  vendorUrl: string | null;
  attributes: Record<string, string>;
  archived: boolean;
  stock: Stock;
  status: StockStatus;
};

export type MaterialInput = Omit<Material, "id" | "archived" | "stock" | "status">;

export type LedgerEntry = {
  id: number;
  delta: number;
  kind: TxnKind;
  note: string | null;
  runningOnHand: number;
  createdAt: string | null;
};

export type MaterialDetail = { material: Material; ledger: LedgerEntry[] };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/inventory${path}`, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { message: string }).message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const inventoryApi = {
  materials: () => req<Material[]>("/materials"),
  material: (id: number) => req<MaterialDetail>(`/materials/${id}`),
  create: (material: MaterialInput, initialQuantity?: number) =>
    req<Material>("/materials", {
      method: "POST",
      body: JSON.stringify({ material, initialQuantity }),
    }),
  update: (id: number, material: MaterialInput) =>
    req<Material>(`/materials/${id}`, { method: "PATCH", body: JSON.stringify(material) }),
  archive: (id: number, archived: boolean) =>
    req<Material>(`/materials/${id}/archive`, { method: "POST", body: JSON.stringify({ archived }) }),
  transact: (id: number, delta: number, kind: TxnKind, note?: string) =>
    req<MaterialDetail>(`/materials/${id}/transactions`, {
      method: "POST",
      body: JSON.stringify({ delta, kind, note }),
    }),
  purchasing: () => req<Material[]>("/purchasing"),
};

/** Ring-fill fraction for gauges: full_quantity is the reference capacity;
 *  fall back to 3× threshold so low stock still reads visually. */
export function gaugeFraction(m: Material): number {
  const ref = m.fullQuantity ?? (m.lowStockThreshold ? m.lowStockThreshold * 3 : null);
  if (!ref || ref <= 0) return 1;
  return Math.max(0, Math.min(1, m.stock.available / ref));
}

/** A material's display color: its `color` attribute when it looks like a color. */
export function materialColor(m: Material): string | null {
  const c = m.attributes.color;
  return c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : null;
}

export type SortKey = "urgency" | "name" | "type" | "color" | "stock";

const STATUS_RANK: Record<StockStatus, number> = { CRITICAL: 0, LOW: 1, OK: 2 };

/** Hue-first color key: chromatic colors by hue then lightness; grays after,
 *  by lightness; colorless materials last. Makes "sort by color" read as a
 *  rainbow across the filament wall. */
function colorKey(m: Material): number {
  const hex = materialColor(m);
  if (!hex) return 9999;
  const n = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (c) => c + c).slice(1) : hex.slice(1);
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 0.08) return 1000 + (1 - l) * 100; // grays, light → dark
  let h = 0;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h * 60 + (1 - l) * 0.5;
}

export function sortMaterials(list: Material[], sort: SortKey): Material[] {
  const byName = (a: Material, b: Material) => a.name.localeCompare(b.name);
  const sorted = [...list];
  switch (sort) {
    case "name":
      return sorted.sort(byName);
    case "type":
      return sorted.sort((a, b) => a.type.localeCompare(b.type) || byName(a, b));
    case "color":
      return sorted.sort((a, b) => colorKey(a) - colorKey(b) || byName(a, b));
    case "stock":
      return sorted.sort((a, b) => b.stock.available - a.stock.available || byName(a, b));
    case "urgency":
    default:
      return sorted.sort((a, b) => {
        const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
        if (rank !== 0) return rank;
        const ra = a.lowStockThreshold ? a.stock.available / a.lowStockThreshold : Infinity;
        const rb = b.lowStockThreshold ? b.stock.available / b.lowStockThreshold : Infinity;
        return ra - rb || byName(a, b);
      });
  }
}

export function matchesQuery(m: Material, q: string): boolean {
  if (!q) return true;
  const hay = `${m.name} ${m.type} ${m.category} ${Object.values(m.attributes).join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((term) => hay.includes(term));
}

export function formatQty(n: number): string {
  // Up to 3 decimals, trailing zeros trimmed: 0.05 stays "0.05", not "0.1".
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
}

/** Parses "0.05" and fraction shorthand like "1/20"; null when incomplete/invalid. */
export function parseQty(raw: string): number | null {
  const s = raw.trim();
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) {
    const d = parseFloat(frac[2]);
    return d > 0 ? parseFloat(frac[1]) / d : null;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function formatCost(m: Material): string {
  const perUnit = m.costQuantity > 0 ? m.costMinor / 100 / m.costQuantity : 0;
  return `$${(m.costMinor / 100).toFixed(2)} / ${formatQty(m.costQuantity)} ${m.unit} ($${perUnit.toFixed(3)}/${m.unit})`;
}
