import { ApiError } from "../api";
import type { Material } from "../inventory/api";

export type SlotKind = "FIXED" | "CHOICE" | "RULE";

export type Slot = {
  name: string;
  kind: SlotKind;
  quantity: number;
  fixedMaterialId: number | null;
  defaultMaterialId: number | null;
  optionMaterialIds: number[];
  optional?: boolean;
};

export type Rule = {
  whenSlot: number;
  thenSlot: number;
  thenMaterialId: number;
  whenMaterialIds: number[];
};

export type ProductInput = {
  name: string;
  description: string;
  skuPrefix: string;
  laborMinutes: number;
  shipWeightGrams?: number | null; // override; else derived from BOM (D22 USPS quotes)
  imageDocumentId: number | null;
  slots: Slot[];
  rules: Rule[];
};

export type Product = ProductInput & { id: number; archived: boolean };

export type ProductSummary = {
  id: number;
  name: string;
  skuPrefix: string;
  laborMinutes: number;
  imageDocumentId: number | null;
  archived: boolean;
  slotCount: number;
  configurationCount: number;
  unresolvedCount: number;
  materialCostMinor: number | null;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/catalog${path}`, {
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

export type ServerConfiguration = {
  sku: string | null;
  selections: { slotIndex: number; slotName: string; materialId: number; materialName: string; color: string | null }[];
  resolved: boolean;
  materialCostMinor: number;
  buildableUnits: number | null;
  cappedBy: string | null;
};

export const catalogApi = {
  products: () => req<ProductSummary[]>("/products"),
  product: (id: number) => req<Product>(`/products/${id}`),
  configurations: (id: number) => req<ServerConfiguration[]>(`/products/${id}/configurations`),
  create: (input: ProductInput) => req<Product>("/products", { method: "POST", body: JSON.stringify(input) }),
  update: (id: number, input: ProductInput) =>
    req<Product>(`/products/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  archive: (id: number, archived: boolean) =>
    req<Product>(`/products/${id}/archive`, { method: "POST", body: JSON.stringify({ archived }) }),
  laborRate: () => req<{ rateMinor: number }>("/labor-rate"),
  setLaborRate: (rateMinor: number) =>
    req<{ rateMinor: number }>("/labor-rate", { method: "PUT", body: JSON.stringify({ rateMinor }) }),
};

export const documentUrl = (id: number) => `/api/v1/documents/${id}`;

export async function uploadImage(file: File, kind = "product-image"): Promise<number> {
  const res = await fetch(
    `/api/v1/documents?kind=${encodeURIComponent(kind)}&filename=${encodeURIComponent(file.name)}`,
    { method: "POST", headers: { "Content-Type": file.type }, body: file },
  );
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { message: string }).message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  return ((await res.json()) as { id: number }).id;
}

/* ---------- client-side enumeration mirroring the server (live preview) ---------- */

export type PreviewConfig = {
  sku: string | null;
  selections: { slotName: string; material: Material }[];
  resolved: boolean;
  materialCostMinor: number;
  buildableUnits: number | null;
  cappedBy: string | null;
};

/** Distinctive-token SKU codes: strip words shared by every option in the
 *  slot, so "PLA Matte Charcoal" codes as CHAR, not PLAM (mirrors server). */
export function skuCodes(p: ProductInput, byId: Map<number, Material>): Map<number, Map<number, string>> {
  const codeOf = (t: string[]) => t.join("").replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() || "X";
  const sharedOf = (lists: string[][]) =>
    lists.length
      ? lists.map((t) => new Set(t.map((x) => x.toLowerCase()))).reduce((a, b) => new Set([...a].filter((x) => b.has(x))))
      : new Set<string>();
  const out = new Map<number, Map<number, string>>();
  p.slots.forEach((slot, idx) => {
    if (slot.kind === "FIXED") return;
    let working = new Map(
      slot.optionMaterialIds.map((id) => [id, (byId.get(id)?.name ?? "?").split(/[^A-Za-z0-9]+/).filter(Boolean)]),
    );
    // Mirror of the server's distinctCodes: strip globally-shared tokens, then
    // per-collision-group shared tokens, with a numeric-suffix fallback.
    for (let pass = 0; pass < 3; pass++) {
      const shared = sharedOf([...working.values()]);
      working = new Map([...working].map(([id, t]) => [id, t.filter((x) => !shared.has(x.toLowerCase())) .length ? t.filter((x) => !shared.has(x.toLowerCase())) : t]));
      const codes = new Map([...working].map(([id, t]) => [id, codeOf(t)]));
      const groups = new Map<string, number[]>();
      codes.forEach((c, id) => groups.set(c, [...(groups.get(c) ?? []), id]));
      const dups = [...groups.values()].filter((g) => g.length > 1);
      if (!dups.length) {
        out.set(idx, codes);
        return;
      }
      for (const ids of dups) {
        const groupShared = sharedOf(ids.map((id) => working.get(id)!));
        ids.forEach((id) => {
          const t = working.get(id)!.filter((x) => !groupShared.has(x.toLowerCase()));
          if (t.length) working.set(id, t);
        });
      }
    }
    const codes = new Map([...working].map(([id, t]) => [id, codeOf(t)]));
    const seen = new Map<string, number>();
    codes.forEach((c, id) => {
      const n = seen.get(c) ?? 0;
      if (n > 0) codes.set(id, c.slice(0, 3) + (n + 1));
      seen.set(c, n + 1);
    });
    out.set(idx, codes);
  });
  return out;
}

export function enumerate(p: ProductInput, byId: Map<number, Material>): PreviewConfig[] {
  const codes = skuCodes(p, byId);
  const choice = p.slots.map((s, i) => [s, i] as const).filter(([s]) => s.kind === "CHOICE");
  let combos: Map<number, number>[] = [new Map()];
  for (const [slot, idx] of choice) {
    combos = combos.flatMap((base) => slot.optionMaterialIds.map((m) => new Map(base).set(idx, m)));
    if (combos.length > 2000) return [];
  }
  return combos.map((combo) => {
    const selections: PreviewConfig["selections"] = [];
    const skuParts: string[] = [p.skuPrefix];
    const bom: { slotName: string; qty: number; material: Material }[] = [];
    let resolved = true;
    p.slots.forEach((slot, idx) => {
      let materialId: number | null | undefined;
      if (slot.kind === "FIXED") materialId = slot.fixedMaterialId;
      else if (slot.kind === "CHOICE") materialId = combo.get(idx);
      else {
        const match = p.rules.find(
          (r) => r.thenSlot === idx && r.whenMaterialIds.includes(combo.get(r.whenSlot) ?? -1),
        );
        materialId = match ? match.thenMaterialId : slot.defaultMaterialId;
      }
      const material = materialId != null ? byId.get(materialId) : undefined;
      if (!material) {
        resolved = false;
        return;
      }
      bom.push({ slotName: slot.name, qty: slot.quantity, material });
      // Only CHOICE slots carry identity/SKU; rule slots are derived BOM.
      if (slot.kind === "CHOICE") {
        selections.push({ slotName: slot.name, material });
        skuParts.push(codes.get(idx)?.get(material.id) ?? "X");
      }
    });
    const materialCostMinor = Math.round(
      bom.reduce((sum, b) => sum + (b.material.costQuantity > 0 ? (b.qty * b.material.costMinor) / b.material.costQuantity : 0), 0),
    );
    let buildableUnits: number | null = null;
    let cappedBy: string | null = null;
    if (resolved) {
      for (const b of bom) {
        if (b.qty <= 0) continue;
        const u = Math.floor(b.material.stock.available / b.qty);
        if (buildableUnits == null || u < buildableUnits) {
          buildableUnits = u;
          cappedBy = `${b.material.name} (${b.slotName})`;
        }
      }
    }
    const sku = resolved ? skuParts.join("-") : null;
    return { sku, selections, resolved, materialCostMinor, buildableUnits, cappedBy };
  });
}
