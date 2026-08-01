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

export function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function formatCost(m: Material): string {
  const perUnit = m.costQuantity > 0 ? m.costMinor / 100 / m.costQuantity : 0;
  return `$${(m.costMinor / 100).toFixed(2)} / ${formatQty(m.costQuantity)} ${m.unit} ($${perUnit.toFixed(3)}/${m.unit})`;
}
