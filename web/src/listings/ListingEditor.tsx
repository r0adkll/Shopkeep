import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PushReview } from "./PushReview";
import { formatQty, inventoryApi, materialColor, type Material } from "../inventory/api";
import { MaterialPicker } from "../inventory/MaterialPicker";
import { catalogApi, documentUrl, skuCodes, uploadImage, type Product, type ServerConfiguration } from "../catalog/api";
import { ProductImage } from "../catalog/ProductImage";
import { Button, ErrorText, Field } from "../ui";
import {
  listingsApi,
  type Axis,
  type Band,
  type Extra,
  type Listing,
  type ListingInput,
  type PersonalizationQuestion,
} from "./api";

const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;

/** Build default axes from a product's choice slots — everything offered,
 *  per-primary platform SKUs prefilled as PREFIX-CODE. */
export function defaultInput(product: Product, byId: Map<number, Material>): ListingInput {
  const codes = skuCodes(product, byId);
  const axes: Axis[] = product.slots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === "CHOICE")
    .map(({ s, i }, axisIdx) => ({
      displayName: s.name,
      productSlotPosition: i,
      values: s.optionMaterialIds.map((materialId) => ({
        materialId,
        offered: true,
        platformSku: axisIdx === 0 ? `${product.skuPrefix}-${codes.get(i)?.get(materialId) ?? "X"}` : null,
        priceOverrideMinor: null,
      })),
    }));
  return {
    productId: product.id,
    title: product.name,
    description: product.description,
    state: "draft",
    basePriceMinor: 0,
    currency: "USD",
    quantity: 0,
    skuMode: "per_combination",
    packagingProfileId: null,
    tags: [],
    materialsList: [],
    shopSection: null,
    personalization: null,
    imageDocumentIds: [],
    axes,
    extras: [],
    disabledSkus: [],
  };
}

export function ListingEditor({
  existing,
  product,
  onClose,
}: {
  existing?: Listing;
  product: Product;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const materials = useQuery({ queryKey: ["materials"], queryFn: inventoryApi.materials });
  const profiles = useQuery({ queryKey: ["packagingProfiles"], queryFn: listingsApi.profiles });
  const laborRate = useQuery({ queryKey: ["laborRate"], queryFn: catalogApi.laborRate });
  const pDesigns = useQuery({
    queryKey: ["designs", product.id],
    queryFn: async () => {
      const r = await fetch(`/api/v1/catalog/products/${product.id}/designs`);
      return (await r.json()) as { id: number; name: string; assignments: { slotPosition: number; materialId: number; qtyOverride: number | null }[]; overrideSets: { key: string }[] }[];
    },
  });
  const pVariants = useQuery({
    queryKey: ["variants", product.id],
    queryFn: async () => {
      const r = await fetch(`/api/v1/catalog/products/${product.id}/variants`);
      return (await r.json()) as { id: number; name: string; adjustments: { slotDeltas: { slotPosition: number; deltaQty: number | null; removed: boolean }[]; extras: { materialId: number; quantity: number }[] } }[];
    },
  });
  const productConfigs = useQuery({
    queryKey: ["productConfigs", product.id],
    queryFn: () => catalogApi.configurations(product.id),
  });
  const byId = useMemo(() => new Map((materials.data ?? []).map((m) => [m.id, m])), [materials.data]);

  const [l, setL] = useState<ListingInput>(existing?.input ?? defaultInput(product, byId));
  const [reviewing, setReviewing] = useState(false);
  const [priceStr, setPriceStr] = useState(existing ? (existing.input.basePriceMinor / 100).toFixed(2) : "");
  const [savedBaseline, setSavedBaseline] = useState(() => JSON.stringify(existing?.input ?? null));
  const [editingProfile, setEditingProfile] = useState(false);
  const set = (patch: Partial<ListingInput>) => setL((prev) => ({ ...prev, ...patch }));

  const currentInput = () => ({ ...l, basePriceMinor: Math.round(parseFloat(priceStr || "0") * 100) });
  const dirty = !existing || JSON.stringify(currentInput()) !== savedBaseline;

  const save = useMutation({
    mutationFn: () => {
      const input = currentInput();
      return existing ? listingsApi.update(existing.id, input) : listingsApi.create(input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["listings"] });
      queryClient.invalidateQueries({ queryKey: ["push-preview"] });
      if (existing) setSavedBaseline(JSON.stringify(currentInput()));
      else onClose(); // creation returns to the list; edits stay in place
    },
  });

  // Live "changes to sync" signal — only meaningful against SAVED state.
  const pushPreview = useQuery({
    queryKey: ["push-preview", existing?.id],
    queryFn: async () => {
      const r = await fetch(`/api/v1/listings/${existing!.id}/push-preview`);
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()) as { changes: unknown[]; driftCount: number; canPush: boolean; blockedReason: string | null };
    },
    enabled: !!existing?.etsyListingId && !dirty,
    staleTime: 60_000,
  });

  const mat = (id: number | null | undefined) => (id == null ? undefined : byId.get(id));

  /* Combinations preview for non-material listings: cartesian product of
   * offered values; BOM applies the design (with any override-set value in
   * the combo) plus variant slot-deltas/extras. */
  const comboRows = useMemo(() => {
    if (!l.axes.some((a) => (a.valueSource ?? "materials") !== "materials")) return [];
    const axesVals = l.axes.map((a) => a.values.filter((v) => v.offered));
    if (axesVals.some((vs) => vs.length === 0)) return [];
    const combos: (typeof axesVals)[number][] = axesVals.reduce<(typeof axesVals)[number][]>(
      (acc, vs) => acc.flatMap((c) => vs.map((v) => [...c, v])),
      [[]],
    );
    return combos.slice(0, 400).map((combo) => {
      const labels = combo.map((v, k) => {
        const a = l.axes[k];
        const src =
          v.designId != null ? (pDesigns.data ?? []).find((d) => d.id === v.designId)?.name
          : v.variantId != null ? (pVariants.data ?? []).find((d) => d.id === v.variantId)?.name
          : v.overrideKey != null ? (v.overrideKey === "base" ? "Standard" : v.overrideKey)
          : mat(v.materialId)?.name;
        void a;
        return v.displayLabel || src || "?";
      });
      const overrideKey = combo.find((v) => v.overrideKey && v.overrideKey !== "base")?.overrideKey ?? null;
      const dv = combo.find((v) => v.designId != null);
      const design = dv ? (pDesigns.data ?? []).find((d) => d.id === dv.designId) : undefined;
      const assignments = design
        ? (overrideKey && design.overrideSets.find((o) => o.key.toLowerCase() === overrideKey.toLowerCase())
            ? (design.overrideSets.find((o) => o.key.toLowerCase() === overrideKey.toLowerCase()) as unknown as { assignments: typeof design.assignments }).assignments ?? design.assignments
            : design.assignments)
        : [];
      let cost = 0;
      let buildable = Infinity;
      const perMat: { id: number; qty: number }[] = [];
      assignments.forEach((asg) => {
        const qty = asg.qtyOverride ?? product.slots[asg.slotPosition]?.quantity ?? 0;
        if (qty > 0) perMat.push({ id: asg.materialId, qty });
      });
      combo.forEach((v, k) => {
        if (v.materialId != null && (l.axes[k].valueSource ?? "materials") === "materials") {
          const qty = product.slots[l.axes[k].productSlotPosition]?.quantity ?? 0;
          if (qty > 0) perMat.push({ id: v.materialId, qty });
        }
      });
      const variant = combo.find((v) => v.variantId != null);
      const vAdj = variant ? (pVariants.data ?? []).find((d) => d.id === variant.variantId)?.adjustments : undefined;
      vAdj?.slotDeltas.forEach((d) => {
        const asg = assignments.find((a) => a.slotPosition === d.slotPosition);
        const target = asg?.materialId ?? product.slots[d.slotPosition]?.fixedMaterialId ?? null;
        const hit = target != null ? perMat.find((p) => p.id === target) : undefined;
        if (hit) {
          if (d.removed) hit.qty = 0;
          else if (d.deltaQty != null) hit.qty = Math.max(0, hit.qty + d.deltaQty);
        }
      });
      vAdj?.extras.forEach((e) => perMat.push({ id: e.materialId, qty: e.quantity }));
      perMat.forEach((p) => {
        const m = byId.get(p.id);
        if (m && p.qty > 0) {
          cost += (p.qty * m.costMinor) / (m.costQuantity || 1);
          buildable = Math.min(buildable, Math.floor(m.stock.available / p.qty));
        }
      });
      const designCol = combo.findIndex((v) => v.designId != null);
      const dots = design ? (
        <span>
          {assignments.map((asg, k) => {
            const m = byId.get(asg.materialId);
            return (
              <span key={k} className="mr-0.5 inline-block rounded-full border border-line align-[-1px]"
                style={{ width: k ? 9 : 13, height: k ? 9 : 13, background: m ? (materialColor(m) ?? "var(--color-panel2)") : undefined }} />
            );
          })}
        </span>
      ) : null;
      const codes = labels.map((lb) => lb.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() || "X");
      return {
        key: labels.join("|"),
        labels,
        designCol,
        dots,
        cost,
        buildable: buildable === Infinity ? 0 : buildable,
        suggestedSku: `${l.listingSku || product.skuPrefix || "SKU"}-${codes.join("-")}`,
        primarySku: combo[0]?.platformSku ?? null,
      };
    });
  }, [l.axes, l.listingSku, pDesigns.data, pVariants.data, byId, product]);

  const offeredCount = l.axes.map((a) => a.values.filter((v) => v.offered).length);
  const laborMinor = Math.round(((laborRate.data?.rateMinor ?? 0) * product.laborMinutes) / 60);

  // The listing IS a projection of the product: derive the live configuration
  // matrix from the recipe, filtered to what this listing offers.
  const derived: ServerConfiguration[] = useMemo(() => {
    const offeredBySlot = new Map(
      l.axes.map((a) => [a.productSlotPosition, new Set(a.values.filter((v) => v.offered).map((v) => v.materialId))]),
    );
    return (productConfigs.data ?? []).filter(
      (c) =>
        c.resolved &&
        c.sku != null &&
        c.selections.every((s) => offeredBySlot.get(s.slotIndex)?.has(s.materialId) ?? true),
    );
  }, [productConfigs.data, l.axes]);
  const bomMin = derived.length ? Math.min(...derived.map((c) => c.materialCostMinor)) : 0;
  const bomMax = derived.length ? Math.max(...derived.map((c) => c.materialCostMinor)) : 0;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_270px]">
      <div className="min-w-0">
        {/* header — anchored to the recipe it projects */}
        <div className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <div className="flex gap-4">
            <ProductImage imageDocumentId={product.imageDocumentId} size={56} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  value={l.title}
                  onChange={(e) => set({ title: e.target.value })}
                  className="min-w-60 flex-1 border-b border-dashed border-transparent bg-transparent text-lg font-semibold outline-none focus:border-accent"
                />
                <select
                  value={l.state}
                  onChange={(e) => set({ state: e.target.value as ListingInput["state"] })}
                  className={`rounded-full border border-line px-2.5 py-1 text-[10px] font-extrabold tracking-wider ${
                    l.state === "active" ? "bg-good/10 text-good" : l.state === "draft" ? "bg-panel2 text-ink2" : "bg-warn/10 text-warn"
                  }`}
                >
                  <option value="draft">DRAFT</option>
                  <option value="active">ACTIVE</option>
                  <option value="inactive">INACTIVE</option>
                </select>
              </div>
              <div className={`mt-1 text-[11px] ${l.title.length > 140 ? "font-bold text-warn" : "text-mut"}`}>
                {l.title.length}/140 · Etsy title limit
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink2">
                <span className="text-[10px] font-extrabold tracking-widest text-accent">RECIPE</span>
                <b>{product.name}</b>
                <span className="font-mono text-mut">{product.skuPrefix}</span>
                <span className="text-mut">{product.slots.length} slots · {product.laborMinutes} min labor · variations &amp; costs derive from it</span>
              </div>
            </div>
          </div>
          <textarea
            rows={3}
            value={l.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Storefront description…"
            className="mt-3 w-full rounded-md border border-line bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>

        {/* photos & video */}
        <SectionTitle>
          Photos &amp; video
          <Hint>up to 20 photos + 1 video · first photo is the thumbnail</Hint>
        </SectionTitle>
        <PhotoStrip ids={l.imageDocumentIds} onChange={(imageDocumentIds) => set({ imageDocumentIds })} />

        {/* tags & materials */}
        <SectionTitle>Tags &amp; materials <Hint>tags ≤13 × 20 chars · materials ≤13</Hint></SectionTitle>
        <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
          <ChipList
            label={`Tags ${l.tags.length}/13`}
            items={l.tags}
            max={13}
            charMax={20}
            onChange={(tags) => set({ tags })}
          />
          <div className="mt-3">
            <ChipList
              label={`Materials ${l.materialsList.length}/13`}
              items={l.materialsList}
              max={13}
              charMax={45}
              onChange={(materialsList) => set({ materialsList })}
              suggest={() => {
                const fromRecipe = [...new Set(
                  product.slots.flatMap((s) => (s.fixedMaterialId ? [s.fixedMaterialId] : s.optionMaterialIds))
                    .map((id) => mat(id)?.type ?? "")
                    .filter(Boolean),
                )];
                set({ materialsList: [...new Set([...l.materialsList, ...fromRecipe])].slice(0, 13) });
              }}
            />
          </div>
        </div>

        {/* personalization */}
        <SectionTitle>Personalization <Hint>up to 5 questions · text / dropdown / file</Hint></SectionTitle>
        <PersonalizationEditor
          value={l.personalization}
          onChange={(personalization) => set({ personalization })}
        />

        {/* axes */}
        <SectionTitle>
          Variation axes
          <Hint>SKU &amp; price vary on the primary axis in per-primary mode</Hint>
          <label className="ml-auto flex items-center gap-2 text-xs font-normal tracking-normal normal-case text-ink2">
            SKU mode
            <select
              value={l.skuMode}
              onChange={(e) => set({ skuMode: e.target.value as ListingInput["skuMode"] })}
              className="rounded-md border border-line bg-panel px-2 py-1 text-xs"
            >
              <option value="listing_level">one SKU for the listing</option>
              <option value="per_primary">SKU per primary value</option>
              <option value="per_combination">
                SKU per combination ({l.axes.reduce((n, a) => n * Math.max(a.values.filter((v) => v.offered).length, 1), l.axes.length ? 1 : 0)}/400)
              </option>
            </select>
            {l.skuMode === "per_combination" &&
              l.axes.reduce((n, a) => n * Math.max(a.values.filter((v) => v.offered).length, 1), l.axes.length ? 1 : 0) > 400 && (
                <span className="text-[11px] font-bold text-crit">▲ over Etsy's 400-combination cap — trim offered values or switch mode</span>
              )}
            {l.skuMode === "listing_level" && (
              <input
                value={l.listingSku ?? ""}
                onChange={(e) => set({ listingSku: e.target.value || null })}
                placeholder="listing SKU"
                className="w-28 rounded border border-line bg-panel px-2 py-1 font-mono text-xs"
              />
            )}
          </label>
        </SectionTitle>
        {l.axes.map((axis, ai) => (
          <div key={ai} className="relative mt-2 rounded-xl border border-line bg-panel p-4 pr-10 shadow-sm">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[10px] font-extrabold tracking-widest text-accent">
                {["PRIMARY", "SECONDARY", "TERTIARY"][ai] ?? `AXIS ${ai + 1}`}
              </span>
              <input
                value={axis.displayName}
                onChange={(e) =>
                  set({ axes: l.axes.map((a, j) => (j === ai ? { ...a, displayName: e.target.value } : a)) })
                }
                className="w-40 border-b border-dashed border-line bg-transparent font-semibold outline-none focus:border-accent"
              />
              <span className="text-xs text-mut">values from</span>
              <select
                value={axis.valueSource ?? "materials"}
                onChange={(e) => {
                  const src = e.target.value;
                  const values =
                    src === "designs"
                      ? (pDesigns.data ?? []).map((d) => ({ materialId: null, offered: true, designId: d.id, displayLabel: d.name }))
                      : src === "variants"
                        ? (pVariants.data ?? []).map((d) => ({ materialId: null, offered: true, variantId: d.id, displayLabel: d.name }))
                        : src === "override_sets"
                          ? [
                              { materialId: null, offered: true, overrideKey: "base", displayLabel: "Standard" },
                              ...[...new Set((pDesigns.data ?? []).flatMap((d) => d.overrideSets.map((o) => o.key)))].map((k) => ({ materialId: null, offered: true, overrideKey: k, displayLabel: k })),
                            ]
                          : defaultInput(product, byId).axes[ai]?.values ?? [];
                  set({
                    axes: l.axes.map((a, j) => (j === ai ? { ...a, valueSource: src, values } : a)),
                  });
                }}
                className="rounded-md border border-line bg-panel2 px-2 py-1 text-xs"
                title="where this axis's values come from"
              >
                <option value="materials">slot materials — one material per choice</option>
                <option value="designs">this product's designs (multi-color colorways)</option>
                <option value="variants">this product's variants (Slim, Cable Winder…)</option>
                <option value="override_sets">design override sets (editions)</option>
              </select>
              {(axis.valueSource ?? "materials") === "materials" ? (
                <>
                  <span className="text-xs text-mut">fills →</span>
                  <select
                    value={axis.productSlotPosition}
                    onChange={(e) => {
                      const pos = Number(e.target.value);
                      const tmpl = defaultInput(product, byId).axes.find((a) => a.productSlotPosition === pos);
                      set({
                        axes: l.axes.map((a, j) =>
                          j === ai ? { ...a, productSlotPosition: pos, values: tmpl?.values ?? [] } : a,
                        ),
                      });
                    }}
                    className="rounded-md border border-line bg-panel2 px-2 py-1 text-xs"
                    title="which recipe slot this axis fills"
                  >
                    {product.slots.map((sl, si) =>
                      sl.kind === "CHOICE" ? (
                        <option key={si} value={si}>{sl.name} ({sl.quantity}{sl.optional ? ", optional" : ""})</option>
                      ) : null,
                    )}
                  </select>
                </>
              ) : (
                <span className="text-xs text-mut">
                  {axis.valueSource === "designs" && <>values are <b className="text-ink2">{product.name}</b>'s designs — edit them on the product's Designs tab</>}
                  {axis.valueSource === "variants" && <>values are <b className="text-ink2">{product.name}</b>'s variants — edit them on the product's Variants tab</>}
                  {axis.valueSource === "override_sets" && <>values bind to override sets defined on <b className="text-ink2">{product.name}</b>'s designs (e.g. editions)</>}
                </span>
              )}
              <button
                type="button"
                onClick={() => set({ axes: l.axes.filter((_, j) => j !== ai) })}
                title="remove this axis"
                className="absolute top-3 right-3 rounded-md border border-crit/40 p-1 text-crit hover:border-crit hover:bg-crit/10"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="mt-2 space-y-1">
              {axis.values.map((v, vi) => {
                const m = mat(v.materialId);
                const patchValue = (patch: Partial<typeof v>) =>
                  set({
                    axes: l.axes.map((a, j) =>
                      j === ai ? { ...a, values: a.values.map((x, k) => (k === vi ? { ...x, ...patch } : x)) } : a,
                    ),
                  });
                const srcName = m?.name
                  ?? (v.designId != null ? (pDesigns.data ?? []).find((d) => d.id === v.designId)?.name
                  : v.variantId != null ? (pVariants.data ?? []).find((d) => d.id === v.variantId)?.name
                  : v.overrideKey === "base" ? "base composition" : v.overrideKey) ?? "?";
                return (
                  <div key={vi} className={`flex flex-wrap items-center gap-2.5 text-sm ${v.offered ? "" : "opacity-45"}`}>
                    <input type="checkbox" checked={v.offered} onChange={(e) => patchValue({ offered: e.target.checked })} className="h-4 w-4 accent-accent" />
                    <span className="h-3.5 w-3.5 rounded-full border border-line" style={{ background: m ? (materialColor(m) ?? "var(--color-panel2)") : undefined }} />
                    <span className="w-40 flex-none truncate" title={srcName}>{srcName}</span>
                    <input
                      value={v.displayLabel ?? ""}
                      onChange={(e) => patchValue({ displayLabel: e.target.value || null })}
                      placeholder={srcName}
                      title="buyer-facing label — renaming never renames the design/material underneath"
                      className="w-36 flex-none rounded border border-line bg-panel2 px-2 py-0.5 text-xs"
                    />
                    {ai === 0 && l.skuMode === "per_primary" && (
                      <>
                        <input
                          value={v.platformSku ?? ""}
                          onChange={(e) => patchValue({ platformSku: e.target.value || null })}
                          placeholder="Etsy SKU"
                          className="w-36 flex-none rounded border border-line bg-panel2 px-2 py-0.5 font-mono text-xs"
                        />
                        <input
                          key={`p-${v.priceOverrideMinor ?? "none"}`}
                          defaultValue={v.priceOverrideMinor != null ? (v.priceOverrideMinor / 100).toFixed(2) : ""}
                          onBlur={(e) =>
                            patchValue({ priceOverrideMinor: e.target.value ? Math.round(parseFloat(e.target.value) * 100) : null })
                          }
                          placeholder={priceStr || "price"}
                          className="w-20 flex-none rounded border border-line bg-panel2 px-2 py-0.5 text-right font-mono text-xs"
                        />
                      </>
                    )}
                    <span className="ml-auto font-mono text-[11px] text-mut">
                      {m ? `${formatQty(m.stock.available)} ${m.unit}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <button
          type="button"
          disabled={l.axes.length >= 3}
          onClick={() => {
            const tmpl = defaultInput(product, byId).axes;
            const used = new Set(l.axes.map((a) => a.productSlotPosition));
            const next = tmpl.find((a) => !used.has(a.productSlotPosition)) ?? tmpl[0];
            if (next) set({ axes: [...l.axes, { ...next, values: [...next.values] }] });
          }}
          title={l.axes.length >= 3 ? "Etsy allows at most 3 variation axes" : "add a variation axis"}
          className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-sm text-accent hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus size={14} /> axis {l.axes.length >= 3 ? "(Etsy max 3)" : ""}
        </button>

        {/* per-combo configurations for material listings; designs preview for
            listing-level ones (locked concept: no SKU table when a design axis
            resolves the BOM at order time) */}
        {l.axes.some((a) => (a.valueSource ?? "materials") !== "materials") ? (
          <>
            <SectionTitle>
              Combinations <span className="font-mono font-normal text-mut">{comboRows.length}</span>
              <Hint>
                {l.skuMode === "per_combination"
                  ? "one SKU per combination — edit below"
                  : l.skuMode === "per_primary"
                    ? "SKU varies on the primary axis (edit on its value rows above)"
                    : "one SKU for the whole listing — BOM resolves per combination at order time"}
              </Hint>
            </SectionTitle>
            <div className="overflow-x-auto rounded-xl border border-line bg-panel shadow-sm">
              <table className="w-full min-w-[520px] border-collapse text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] tracking-widest text-mut uppercase">
                    {l.axes.map((a) => (
                      <th key={a.displayName} className="border-b border-line px-3 py-2">{a.displayName}</th>
                    ))}
                    <th className="border-b border-line px-3 py-2">SKU</th>
                    <th className="border-b border-line px-3 py-2">BOM</th>
                    <th className="border-b border-line px-3 py-2">Buildable</th>
                  </tr>
                </thead>
                <tbody>
                  {comboRows.map((row, i) => (
                    <tr key={i}>
                      {row.labels.map((lb, k) => (
                        <td key={k} className="border-b border-line/40 px-3 py-1.5">
                          {k === row.designCol ? (
                            <span>{row.dots}<span className="ml-1 font-semibold">{lb}</span></span>
                          ) : (
                            lb
                          )}
                        </td>
                      ))}
                      <td className="border-b border-line/40 px-3 py-1.5 font-mono">
                        {l.skuMode === "per_combination" ? (
                          <input
                            value={l.comboSkus?.find((c) => c.values.join("|") === row.key)?.sku ?? ""}
                            placeholder={row.suggestedSku}
                            onChange={(e) => {
                              const others = (l.comboSkus ?? []).filter((c) => c.values.join("|") !== row.key);
                              set({ comboSkus: e.target.value ? [...others, { values: row.key.split("|"), sku: e.target.value }] : others });
                            }}
                            className="w-40 rounded border border-line bg-panel2 px-2 py-0.5 font-mono text-xs"
                          />
                        ) : l.skuMode === "listing_level" ? (
                          <span className="text-mut">{l.listingSku || "listing SKU"}</span>
                        ) : (
                          <span className="text-mut">{row.primarySku ?? "—"}</span>
                        )}
                      </td>
                      <td className="border-b border-line/40 px-3 py-1.5 font-mono">{money(Math.round(row.cost))}</td>
                      <td className={`border-b border-line/40 px-3 py-1.5 font-mono font-bold ${row.buildable < 3 ? "text-crit" : row.buildable < 8 ? "text-warn" : "text-good"}`}>{row.buildable}</td>
                    </tr>
                  ))}
                  {comboRows.length === 0 && (
                    <tr><td className="px-3 py-3 text-mut" colSpan={l.axes.length + 3}>Offer at least one value per axis.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
        <SectionTitle>
          Configurations <span className="font-mono font-normal text-mut">{derived.length}</span>
          <Hint>derived live from the recipe · SKUs become durable on save · unchecking hides a pair (is_enabled=false)</Hint>
        </SectionTitle>
        <div className="overflow-x-auto rounded-xl border border-line bg-panel shadow-sm">
          <table className="w-full min-w-[560px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-[10px] tracking-widest text-mut uppercase">
                <th className="border-b border-line px-3 py-2"></th>
                {derived[0]?.selections.map((s) => (
                  <th key={s.slotIndex} className="border-b border-line px-3 py-2">{s.slotName}</th>
                ))}
                <th className="border-b border-line px-3 py-2">SKU</th>
                <th className="border-b border-line px-3 py-2">BOM</th>
                <th className="border-b border-line px-3 py-2">Buildable</th>
              </tr>
            </thead>
            <tbody>
              {derived.map((c) => {
                const disabled = l.disabledSkus.includes(c.sku!);
                const durable = existing?.configurations.some((x) => x.sku === c.sku);
                return (
                  <tr key={c.sku} className={disabled ? "opacity-45" : ""}>
                    <td className="border-b border-line/40 px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={!disabled}
                        onChange={(e) =>
                          set({
                            disabledSkus: e.target.checked
                              ? l.disabledSkus.filter((s) => s !== c.sku)
                              : [...l.disabledSkus, c.sku!],
                          })
                        }
                        className="h-4 w-4 accent-accent"
                      />
                    </td>
                    {c.selections.map((s) => (
                      <td key={s.slotIndex} className="border-b border-line/40 px-3 py-1.5 text-ink2">
                        <span className="mr-1.5 inline-block h-3 w-3 rounded-full border border-line align-[-1px]" style={{ background: s.color ?? "var(--color-panel2)" }} />
                        {s.materialName}
                      </td>
                    ))}
                    <td className="border-b border-line/40 px-3 py-1.5 font-mono font-semibold">
                      {c.sku}
                      {existing && !durable && <span className="ml-1.5 text-[9px] font-extrabold tracking-wider text-accent" title="new combination — becomes durable on save">NEW</span>}
                    </td>
                    <td className="border-b border-line/40 px-3 py-1.5 font-mono">{money(c.materialCostMinor)}</td>
                    <td
                      className={`border-b border-line/40 px-3 py-1.5 font-mono font-bold ${
                        (c.buildableUnits ?? 0) < 3 ? "text-crit" : (c.buildableUnits ?? 0) < 8 ? "text-warn" : "text-good"
                      }`}
                      title={c.cappedBy ? `limited by ${c.cappedBy}` : undefined}
                    >
                      {c.buildableUnits}
                    </td>
                  </tr>
                );
              })}
              {derived.length === 0 && (
                <tr><td className="px-3 py-3 text-mut" colSpan={5}>No configurations — offer at least one value per axis.</td></tr>
              )}
            </tbody>
          </table>
        </div>
          </>
        )}

        {/* extras */}
        <SectionTitle>Per-order extras <Hint>consumed by every order, beyond the recipe</Hint></SectionTitle>
        <ExtrasEditor extras={l.extras} materials={materials.data ?? []} onChange={(extras) => set({ extras })} />

        {/* packaging */}
        <SectionTitle>Packaging <Hint>quantity-banded profile (D14), shared across listings</Hint></SectionTitle>
        <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            Profile
            <select
              value={l.packagingProfileId ?? ""}
              onChange={(e) => set({ packagingProfileId: e.target.value ? +e.target.value : null })}
              className="rounded-md border border-line bg-panel2 px-2 py-1.5 text-sm"
            >
              <option value="">— none —</option>
              {(profiles.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.listingCount} listings)
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setEditingProfile(true)} className="text-xs text-accent hover:underline">
              + new profile
            </button>
          </div>
          {l.packagingProfileId != null &&
            (profiles.data ?? [])
              .find((p) => p.id === l.packagingProfileId)
              ?.bands.map((b, i) => (
                <div key={i} className={`mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[13px] ${b.kind === "adhoc" ? "border-dashed border-line text-ink2" : "border-line"}`}>
                  <span className="text-[10px] font-extrabold tracking-widest text-accent">QTY</span>
                  <span className="font-mono font-bold">{b.maxQty != null ? (b.minQty === b.maxQty ? b.minQty : `${b.minQty}–${b.maxQty}`) : `${b.minQty}+`}</span>
                  →{" "}
                  {b.kind === "adhoc"
                    ? "Ad-hoc (flags for packing review)"
                    : b.materials.map((bm) => `${formatQty(bm.quantity)}× ${mat(bm.materialId)?.name ?? "?"}`).join(" + ")}
                  {b.kind === "adhoc" && b.materials.length > 0 && (
                    <span className="text-mut">+ {b.materials.map((bm) => mat(bm.materialId)?.name).join(", ")}</span>
                  )}
                </div>
              ))}
        </div>
        {editingProfile && (
          <ProfileEditor
            materials={materials.data ?? []}
            onSaved={(id) => {
              queryClient.invalidateQueries({ queryKey: ["packagingProfiles"] });
              set({ packagingProfileId: id });
              setEditingProfile(false);
            }}
            onClose={() => setEditingProfile(false)}
          />
        )}
      </div>

      {/* rail */}
      <div className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
          <div className="text-[10.5px] tracking-widest uppercase text-mut">Base price</div>
          <div className="mt-1 flex items-center gap-2">
            <input value={priceStr} onChange={(e) => setPriceStr(e.target.value)} placeholder="34.99" className="w-24 rounded-md border border-line bg-panel2 px-2 py-1.5 text-right font-mono" />
            <span className="text-xs text-mut">USD</span>
          </div>
          <div className="mt-2 text-xs text-ink2">
            {(() => {
              const base = Math.round(parseFloat(priceStr || "0") * 100);
              if (!base) return <span className="text-mut">set a price to see margin</span>;
              const lo = bomMin + laborMinor;
              const hi = bomMax + laborMinor;
              const range = (a: number, b: number) => (a === b ? money(a) : `${money(a)}–${money(b)}`);
              return (
                <>
                  unit cost {range(lo, hi)} <span className="text-mut">(BOM + {product.laborMinutes} min labor)</span> → margin{" "}
                  <b className={base - hi > 0 ? "text-good" : "text-crit"}>{range(base - hi, base - lo)}</b> before fees
                </>
              );
            })()}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
          <div className="text-[10.5px] tracking-widest uppercase text-mut">Offered</div>
          <div className="font-mono text-2xl font-semibold">{offeredCount.join("×") || "—"}</div>
          <div className="text-xs text-ink2">{offeredCount.reduce((a, b) => a * b, 1)} combinations</div>
        </div>
        <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
          <div className="text-[10.5px] tracking-widest uppercase text-mut">Quantity on Etsy</div>
          <input
            value={String(l.quantity || "")}
            onChange={(e) => set({ quantity: parseInt(e.target.value) || 0 })}
            className="mt-1 w-20 rounded-md border border-line bg-panel2 px-2 py-1.5 text-right font-mono"
          />
          <div className="mt-1 text-[11px] text-mut">Synced &amp; renewal ceremony arrive with Etsy connect (Phase 3).</div>
        </div>
        <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
          <div className="text-[10.5px] tracking-widest uppercase text-mut">Platforms</div>
          <div className="mt-1.5 flex items-center gap-2 text-sm">
            <span className="font-semibold">Etsy</span>
            {existing?.etsyListingId ? (
              <>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold tracking-wider ${
                  dirty || (pushPreview.data?.changes.length ?? 0) > 0 ? "bg-warn/10 text-warn" : existing.syncState === "in_sync" ? "bg-good/10 text-good" : "bg-line/60 text-mut"
                }`}>
                  {dirty ? "UNSAVED EDITS" : pushPreview.isLoading ? "CHECKING…" : (pushPreview.data?.changes.length ?? 0) > 0 ? `${pushPreview.data!.changes.length} TO PUSH` : "IN SYNC"}
                </span>
                <span className="font-mono text-[11px] text-mut">#{existing.etsyListingId}</span>
              </>
            ) : (
              <span className="rounded-full bg-line/60 px-2 py-0.5 text-[10px] font-extrabold tracking-wider text-mut">NOT LINKED</span>
            )}
          </div>
          {existing?.etsyListingId && (
            <>
              {(pushPreview.data?.driftCount ?? 0) > 0 && !dirty && (
                <div className="mt-1 text-[11px] font-semibold text-warn">▲ {pushPreview.data!.driftCount} field(s) changed on Etsy since last sync</div>
              )}
              <button
                type="button"
                onClick={() => setReviewing(true)}
                disabled={dirty}
                title={dirty ? "save your edits first — the review diffs saved state" : "diff against the live Etsy listing"}
                className="mt-2 w-full rounded-md border border-accent px-3 py-1.5 text-sm font-semibold text-accent hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {dirty ? "Save first, then review & push" : "Review & push to Etsy…"}
              </button>
            </>
          )}
          {existing && !existing.etsyListingId && (
            <div className="mt-1 text-[11px] text-mut">Link by importing the Etsy listing, or create it on Etsy and import.</div>
          )}
        </div>
        <ErrorText>{save.error?.message}</ErrorText>
        <Button type="button" disabled={save.isPending || !l.title || !dirty} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : !existing ? "Create listing" : dirty ? "Save listing" : "Saved ✓"}
        </Button>
        {reviewing && existing && (
          <PushReview
            listingId={existing.id}
            onClose={() => setReviewing(false)}
            onPushed={() => {
              queryClient.invalidateQueries({ queryKey: ["listings"] });
              queryClient.invalidateQueries({ queryKey: ["push-preview"] });
            }}
          />
        )}
        <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-2 text-sm text-ink2 hover:text-ink">
          Cancel
        </button>
        {existing && <DangerZone listing={existing} onDone={onClose} />}
      </div>
    </div>
  );
}

function DangerZone({ listing, onDone }: { listing: Listing; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(null);
  const act = useMutation({
    mutationFn: async () => {
      if (confirming === "delete") await listingsApi.delete(listing.id);
      else await listingsApi.archive(listing.id, !listing.archived);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["listings"] });
      onDone();
    },
  });
  const neverPublished = listing.syncState === "not_published" && !listing.etsyListingId;

  const confirmBlock = (
    tone: "accent" | "crit",
    message: string,
    confirmLabel: string,
  ) => (
    <div className={`rounded-lg border p-3 ${tone === "crit" ? "border-crit bg-crit/5" : "border-accent bg-accent/5"}`}>
      <p className="text-xs leading-relaxed text-ink2">{message}</p>
      <ErrorText>{act.error?.message}</ErrorText>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          disabled={act.isPending}
          onClick={() => act.mutate()}
          className={`flex-1 rounded-md px-3 py-2 text-xs font-bold text-white disabled:opacity-50 ${tone === "crit" ? "bg-crit" : "bg-accent"}`}
        >
          {act.isPending ? "Working…" : confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(null)}
          className="flex-1 rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink2 hover:text-ink"
        >
          Keep listing
        </button>
      </div>
    </div>
  );

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
      {confirming === "archive" ? (
        confirmBlock(
          "accent",
          listing.archived
            ? "Restore this listing to the active list?"
            : "Archive this listing? It disappears from active views; its SKUs stay reserved for order history. Once Etsy is connected, archiving a published listing will also ask whether to deactivate or delete it on the platform.",
          listing.archived ? "Restore listing" : "Archive listing",
        )
      ) : (
        <button
          type="button"
          onClick={() => setConfirming("archive")}
          className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink2 hover:border-accent hover:text-ink"
        >
          {listing.archived ? "Restore listing" : "Archive listing"}
        </button>
      )}
      {neverPublished && !listing.archived &&
        (confirming === "delete" ? (
          confirmBlock(
            "crit",
            "Permanently delete this listing? It has never been published, so nothing exists on any platform — its SKUs are freed for reuse. This cannot be undone.",
            "Delete permanently",
          )
        ) : (
          <button
            type="button"
            onClick={() => setConfirming("delete")}
            className="rounded-md border border-crit/40 px-4 py-2 text-sm font-medium text-crit hover:border-crit hover:bg-crit/5"
          >
            Delete permanently
          </button>
        ))}
    </div>
  );
}

function PhotoStrip({ ids, onChange }: { ids: number[]; onChange: (ids: number[]) => void }) {
  const MAX_PHOTOS = 20; // Etsy limit — becomes adapter capability metadata in Phase 3
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded: number[] = [];
      for (const f of [...files].slice(0, MAX_PHOTOS - ids.length)) {
        uploaded.push(await uploadImage(f, "listing-image"));
      }
      onChange([...ids, ...uploaded]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
      <div className="flex flex-wrap gap-2.5">
        {ids.map((id, i) => (
          <div key={id} className="group relative">
            <img src={documentUrl(id)} alt="" className="h-[74px] w-[74px] rounded-lg border border-line object-cover" />
            {i === 0 && (
              <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-accent px-1 text-[8px] font-extrabold tracking-wider text-white">
                THUMBNAIL
              </span>
            )}
            <div className="absolute -top-1.5 -right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              {i !== 0 && (
                <button
                  type="button"
                  title="Make thumbnail"
                  onClick={() => onChange([id, ...ids.filter((x) => x !== id)])}
                  className="flex h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-[10px] text-accent shadow-sm"
                >
                  ★
                </button>
              )}
              <button
                type="button"
                title="Remove photo"
                onClick={() => onChange(ids.filter((x) => x !== id))}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-[11px] text-crit shadow-sm"
              >
                ×
              </button>
            </div>
          </div>
        ))}
        {ids.length < MAX_PHOTOS && (
          <label className="flex h-[74px] w-[74px] cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-line bg-panel2 text-[11px] text-mut hover:border-accent">
            {busy ? "…" : "+ photo"}
            {!busy && <span className="text-[9px]">{ids.length}/{MAX_PHOTOS}</span>}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={(e) => {
                void add(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        )}
        <div
          className="flex h-[74px] w-[74px] flex-col items-center justify-center rounded-lg border border-dashed border-line text-[10px] text-mut"
          title="Video upload arrives with the Etsy connect (Phase 3)"
        >
          ▷ video
          <span className="text-[8px] tracking-wider uppercase">Phase 3</span>
        </div>
      </div>
      {error && <p className="mt-2 text-xs font-medium text-crit">{error}</p>}
      <p className="mt-2 text-[11px] text-mut">
        Stored in Shopkeep's document store (D12 — pg_dump backs these up too); pushed with the listing once Etsy connects. Hover a photo to promote it to thumbnail or remove it.
      </p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-6 mb-1 flex flex-wrap items-baseline gap-2 text-[13px] font-bold tracking-widest uppercase text-ink2">
      {children}
    </h2>
  );
}
function Hint({ children }: { children: React.ReactNode }) {
  return <span className="font-normal tracking-normal normal-case text-mut">{children}</span>;
}

function ChipList({
  label,
  items,
  max,
  charMax,
  onChange,
  suggest,
}: {
  label: string;
  items: string[];
  max: number;
  charMax: number;
  onChange: (items: string[]) => void;
  suggest?: () => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="text-[10px] font-semibold tracking-widest uppercase text-mut">{label}</span>
        {suggest && (
          <button type="button" onClick={suggest} className="text-[11px] text-accent hover:underline">
            ✨ suggest from recipe
          </button>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {items.map((t, i) => (
          <span key={i} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${t.length > charMax ? "border-warn text-warn" : "border-line text-ink2"}`}>
            {t}
            <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-mut hover:text-crit">×</button>
          </span>
        ))}
        {items.length < max && (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) {
                e.preventDefault();
                onChange([...items, draft.trim()]);
                setDraft("");
              }
            }}
            placeholder="add…"
            className="w-20 rounded-full border border-dashed border-line bg-transparent px-2.5 py-0.5 text-xs outline-none focus:border-accent"
          />
        )}
      </div>
    </div>
  );
}

function PersonalizationEditor({
  value,
  onChange,
}: {
  value: ListingInput["personalization"];
  onChange: (p: ListingInput["personalization"]) => void;
}) {
  const p = value ?? { questions: [], feeMinor: null, extraLaborMinutes: null };
  const setQ = (qs: PersonalizationQuestion[]) => onChange({ ...p, questions: qs });
  return (
    <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
      {p.questions.map((q, i) => (
        <div key={i} className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <select
            value={q.type}
            onChange={(e) => setQ(p.questions.map((x, j) => (j === i ? { ...x, type: e.target.value as PersonalizationQuestion["type"] } : x)))}
            className="rounded border border-line bg-panel2 px-1.5 py-1 text-xs"
          >
            <option value="text">text</option>
            <option value="dropdown">dropdown</option>
            <option value="file">file</option>
          </select>
          <input
            value={q.questionText}
            onChange={(e) => setQ(p.questions.map((x, j) => (j === i ? { ...x, questionText: e.target.value } : x)))}
            placeholder="Question (≤45 chars)"
            className="w-48 rounded border border-line bg-panel2 px-2 py-1 text-sm"
          />
          {q.type === "text" && (
            <input
              value={q.maxChars ?? ""}
              onChange={(e) => setQ(p.questions.map((x, j) => (j === i ? { ...x, maxChars: parseInt(e.target.value) || null } : x)))}
              placeholder="max chars"
              className="w-20 rounded border border-line bg-panel2 px-2 py-1 text-xs"
            />
          )}
          {q.type === "dropdown" && (
            <input
              value={q.options.join(", ")}
              onChange={(e) => setQ(p.questions.map((x, j) => (j === i ? { ...x, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x)))}
              placeholder="options, comma-separated"
              className="w-52 rounded border border-line bg-panel2 px-2 py-1 text-xs"
            />
          )}
          <label className="flex items-center gap-1 text-xs text-ink2">
            <input type="checkbox" checked={q.required} onChange={(e) => setQ(p.questions.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} className="accent-accent" />
            required
          </label>
          <button type="button" onClick={() => setQ(p.questions.filter((_, j) => j !== i))} className="text-xs text-mut hover:text-crit">remove</button>
        </div>
      ))}
      {p.questions.length < 5 && (
        <button
          type="button"
          onClick={() => setQ([...p.questions, { type: "text", questionText: "", required: false, maxChars: 64, options: [] }])}
          className="w-full rounded-lg border border-dashed border-line py-1.5 text-xs text-accent hover:border-accent"
        >
          + Add question · {5 - p.questions.length} remaining
        </button>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-dotted border-line pt-3 text-sm">
        <label className="flex items-center gap-2 text-xs text-ink2">
          Fee $
          <input
            key={`fee-${p.feeMinor ?? "none"}`}
            defaultValue={p.feeMinor != null ? (p.feeMinor / 100).toFixed(2) : ""}
            onBlur={(e) => onChange({ ...p, feeMinor: e.target.value ? Math.round(parseFloat(e.target.value) * 100) : null })}
            className="w-16 rounded border border-line bg-panel2 px-2 py-1 text-right font-mono text-xs"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-ink2">
          Extra labor
          <input
            value={p.extraLaborMinutes ?? ""}
            onChange={(e) => onChange({ ...p, extraLaborMinutes: parseInt(e.target.value) || null })}
            className="w-12 rounded border border-line bg-panel2 px-2 py-1 text-right font-mono text-xs"
          />
          min
        </label>
        <span className="text-[11px] text-mut">fee compiles to a variation axis on push (no native price on Etsy personalization)</span>
      </div>
    </div>
  );
}

function ExtrasEditor({
  extras,
  materials,
  onChange,
}: {
  extras: Extra[];
  materials: Material[];
  onChange: (e: Extra[]) => void;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
      {extras.map((e, i) => (
        <div key={i} className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <MaterialPicker
            all={materials}
            value={materials.find((m) => m.id === e.materialId) ?? null}
            onChange={(id) => onChange(extras.map((x, j) => (j === i ? { ...x, materialId: id } : x)))}
          />
          <input
            value={String(e.quantity || "")}
            onChange={(ev) => onChange(extras.map((x, j) => (j === i ? { ...x, quantity: parseFloat(ev.target.value) || 0 } : x)))}
            className="w-16 rounded border border-line bg-panel2 px-2 py-1 text-right font-mono text-xs"
          />
          <select
            value={e.basis}
            onChange={(ev) => onChange(extras.map((x, j) => (j === i ? { ...x, basis: ev.target.value as Extra["basis"] } : x)))}
            className="rounded border border-line bg-panel2 px-1.5 py-1 text-xs"
          >
            <option value="per_order">per order</option>
            <option value="per_unit">per unit</option>
          </select>
          <button type="button" onClick={() => onChange(extras.filter((_, j) => j !== i))} className="text-xs text-mut hover:text-crit">remove</button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => materials.length && onChange([...extras, { materialId: 0, quantity: 1, basis: "per_order" }])}
        className="w-full rounded-lg border border-dashed border-line py-1.5 text-xs text-accent hover:border-accent"
      >
        + Add extra
      </button>
    </div>
  );
}

function ProfileEditor({
  materials,
  onSaved,
  onClose,
}: {
  materials: Material[];
  onSaved: (id: number) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [bands, setBands] = useState<Band[]>([
    { minQty: 1, maxQty: 1, kind: "stocked", materials: [] },
    { minQty: 2, maxQty: null, kind: "adhoc", materials: [] },
  ]);
  const save = useMutation({
    mutationFn: () => listingsApi.createProfile(name, bands),
    onSuccess: (p) => onSaved(p.id),
  });
  const patchBand = (i: number, patch: Partial<Band>) => setBands(bands.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <div className="mt-2 rounded-xl border-2 border-accent bg-panel p-4 shadow-sm">
      <Field label="Profile name" value={name} onChange={setName} autoFocus />
      {bands.map((b, i) => (
        <div key={i} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[10px] font-extrabold tracking-widest text-accent">QTY</span>
          <input value={b.minQty} onChange={(e) => patchBand(i, { minQty: parseInt(e.target.value) || 1 })} className="w-12 rounded border border-line bg-panel2 px-1.5 py-1 text-right font-mono text-xs" />
          –
          <input
            value={b.maxQty ?? ""}
            placeholder="∞"
            onChange={(e) => patchBand(i, { maxQty: e.target.value ? parseInt(e.target.value) : null })}
            className="w-12 rounded border border-line bg-panel2 px-1.5 py-1 text-right font-mono text-xs"
          />
          <select value={b.kind} onChange={(e) => patchBand(i, { kind: e.target.value as Band["kind"] })} className="rounded border border-line bg-panel2 px-1.5 py-1 text-xs">
            <option value="stocked">stocked</option>
            <option value="adhoc">ad-hoc</option>
          </select>
          <select
            value=""
            onChange={(e) => e.target.value && patchBand(i, { materials: [...b.materials, { materialId: +e.target.value, quantity: 1, basis: "per_order" }] })}
            className="rounded border border-line bg-panel2 px-1.5 py-1 text-xs"
          >
            <option value="">+ material…</option>
            {materials.filter((m) => m.category === "packaging").map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <span className="text-xs text-ink2">
            {b.materials.map((bm, k) => (
              <span key={k} className="mr-2">
                {formatQty(bm.quantity)}× {materials.find((m) => m.id === bm.materialId)?.name}
                <button type="button" onClick={() => patchBand(i, { materials: b.materials.filter((_, x) => x !== k) })} className="ml-0.5 text-mut hover:text-crit">×</button>
              </span>
            ))}
          </span>
          <button type="button" onClick={() => setBands(bands.filter((_, j) => j !== i))} className="ml-auto text-xs text-mut hover:text-crit">remove</button>
        </div>
      ))}
      <button type="button" onClick={() => setBands([...bands, { minQty: (bands[bands.length - 1]?.maxQty ?? 0) + 1, maxQty: null, kind: "stocked", materials: [] }])} className="mt-2 text-xs text-accent hover:underline">
        + band
      </button>
      <ErrorText>{save.error?.message}</ErrorText>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={!name || save.isPending} onClick={() => save.mutate()} className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          Save profile
        </button>
        <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-1.5 text-sm text-ink2">Cancel</button>
      </div>
    </div>
  );
}
