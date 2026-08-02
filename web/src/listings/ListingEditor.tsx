import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatQty, inventoryApi, materialColor, type Material } from "../inventory/api";
import { catalogApi, skuCodes, type Product } from "../catalog/api";
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
  const byId = useMemo(() => new Map((materials.data ?? []).map((m) => [m.id, m])), [materials.data]);

  const [l, setL] = useState<ListingInput>(existing?.input ?? defaultInput(product, byId));
  const [priceStr, setPriceStr] = useState(existing ? (existing.input.basePriceMinor / 100).toFixed(2) : "");
  const [editingProfile, setEditingProfile] = useState(false);
  const set = (patch: Partial<ListingInput>) => setL((prev) => ({ ...prev, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const input = { ...l, basePriceMinor: Math.round(parseFloat(priceStr || "0") * 100) };
      return existing ? listingsApi.update(existing.id, input) : listingsApi.create(input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["listings"] });
      onClose();
    },
  });

  const mat = (id: number) => byId.get(id);
  const offeredCount = l.axes.map((a) => a.values.filter((v) => v.offered).length);
  const laborMinor = Math.round(((laborRate.data?.rateMinor ?? 0) * product.laborMinutes) / 60);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_270px]">
      <div className="min-w-0">
        {/* header */}
        <div className="rounded-xl border border-line bg-panel p-5 shadow-sm">
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
            {l.title.length}/140 · Etsy title limit · from recipe <b className="text-ink2">{product.name}</b>{" "}
            <span className="font-mono">{product.skuPrefix}</span>
          </div>
          <textarea
            rows={3}
            value={l.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Storefront description…"
            className="mt-3 w-full rounded-md border border-line bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>

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
              <option value="per_combination">per-combination (API)</option>
              <option value="per_primary">per-primary (legacy)</option>
            </select>
          </label>
        </SectionTitle>
        {l.axes.map((axis, ai) => (
          <div key={ai} className="mt-2 rounded-xl border border-line bg-panel p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[10px] font-extrabold tracking-widest text-accent">
                {ai === 0 ? "PRIMARY" : "SECONDARY"}
              </span>
              <input
                value={axis.displayName}
                onChange={(e) =>
                  set({ axes: l.axes.map((a, j) => (j === ai ? { ...a, displayName: e.target.value } : a)) })
                }
                className="w-40 border-b border-dashed border-line bg-transparent font-semibold outline-none focus:border-accent"
              />
              <span className="text-xs text-mut">← {product.slots[axis.productSlotPosition]?.name}</span>
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
                return (
                  <div key={v.materialId} className={`flex flex-wrap items-center gap-2.5 text-sm ${v.offered ? "" : "opacity-45"}`}>
                    <input type="checkbox" checked={v.offered} onChange={(e) => patchValue({ offered: e.target.checked })} className="h-4 w-4 accent-accent" />
                    <span className="h-3.5 w-3.5 rounded-full border border-line" style={{ background: m ? (materialColor(m) ?? "var(--color-panel2)") : undefined }} />
                    <span className="min-w-28">{m?.name ?? "?"}</span>
                    {ai === 0 && l.skuMode === "per_primary" && (
                      <>
                        <input
                          value={v.platformSku ?? ""}
                          onChange={(e) => patchValue({ platformSku: e.target.value || null })}
                          placeholder="Etsy SKU"
                          className="w-36 rounded border border-line bg-panel2 px-2 py-0.5 font-mono text-xs"
                        />
                        <input
                          value={v.priceOverrideMinor != null ? (v.priceOverrideMinor / 100).toFixed(2) : ""}
                          onChange={(e) =>
                            patchValue({ priceOverrideMinor: e.target.value ? Math.round(parseFloat(e.target.value) * 100) : null })
                          }
                          placeholder={priceStr || "price"}
                          className="w-20 rounded border border-line bg-panel2 px-2 py-0.5 text-right font-mono text-xs"
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

        {/* configurations */}
        {existing && existing.configurations.length > 0 && (
          <>
            <SectionTitle>
              Configurations <span className="font-mono font-normal text-mut">{existing.configurations.length}</span>
              <Hint>durable SKUs — unchecking hides a pair (pushed as is_enabled=false)</Hint>
            </SectionTitle>
            <div className="overflow-x-auto rounded-xl border border-line bg-panel shadow-sm">
              <table className="w-full min-w-[480px] border-collapse text-[13px]">
                <tbody>
                  {existing.configurations.map((c) => {
                    const disabled = l.disabledSkus.includes(c.sku);
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
                                  : [...l.disabledSkus, c.sku],
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
                        <td className="border-b border-line/40 px-3 py-1.5 font-mono font-semibold">{c.sku}</td>
                      </tr>
                    );
                  })}
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
              const cost = (productCost(product, byId) ?? 0) + laborMinor;
              const margin = base - cost;
              return base > 0 ? (
                <>
                  unit cost {money(cost)} → margin{" "}
                  <b className={margin > 0 ? "text-good" : "text-crit"}>{money(margin)}</b> before fees
                </>
              ) : (
                <span className="text-mut">set a price to see margin</span>
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
            <span className="rounded-full bg-line/60 px-2 py-0.5 text-[10px] font-extrabold tracking-wider text-mut">
              {existing ? existing.syncState.replace("_", " ").toUpperCase() : "NOT PUBLISHED"}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-mut">Review &amp; push lands with Phase 3's OAuth connect.</div>
        </div>
        <ErrorText>{save.error?.message}</ErrorText>
        <Button type="button" disabled={save.isPending || !l.title} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : existing ? "Save listing" : "Create listing"}
        </Button>
        <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-2 text-sm text-ink2 hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}

function productCost(product: Product, byId: Map<number, Material>): number | null {
  let total = 0;
  for (const s of product.slots) {
    const ids = s.fixedMaterialId ? [s.fixedMaterialId] : s.optionMaterialIds;
    const costs = ids.map((id) => byId.get(id)).filter(Boolean)
      .map((m) => (m!.costQuantity > 0 ? (s.quantity * m!.costMinor) / m!.costQuantity : 0));
    if (costs.length) total += Math.min(...costs);
  }
  return Math.round(total);
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
            value={p.feeMinor != null ? (p.feeMinor / 100).toFixed(2) : ""}
            onChange={(e) => onChange({ ...p, feeMinor: e.target.value ? Math.round(parseFloat(e.target.value) * 100) : null })}
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
          <select
            value={e.materialId}
            onChange={(ev) => onChange(extras.map((x, j) => (j === i ? { ...x, materialId: +ev.target.value } : x)))}
            className="rounded border border-line bg-panel2 px-2 py-1 text-sm"
          >
            {materials.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
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
        onClick={() => materials.length && onChange([...extras, { materialId: materials[0].id, quantity: 1, basis: "per_order" }])}
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
