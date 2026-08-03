import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { DesignsTab, VariantsTab } from "./DesignsEditor";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  formatQty,
  inventoryApi,
  matchesQuery,
  materialColor,
  parseQty,
  sortMaterials,
  type Material,
  type SortKey,
} from "../inventory/api";
import { MaterialIcon } from "../inventory/MaterialIcon";
import { MaterialPicker } from "../inventory/MaterialPicker";
import { Button, ErrorText, Field } from "../ui";
import { catalogApi, documentUrl, uploadImage, type Product, type ProductInput, type Rule, type Slot } from "./api";

/** The recipe builder, built to the locked concept (vault: Products.md):
 *  slots define the possibility space, sentence rules resolve dependent
 *  slots, gaps are loud, and the config preview is live. */

const EMPTY: ProductInput = {
  name: "",
  description: "",
  skuPrefix: "",
  laborMinutes: 0,
  imageDocumentId: null,
  slots: [],
  rules: [],
};

const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;

export function RecipeEditor({ existing, onClose }: { existing?: Product; onClose: () => void }) {
  const queryClient = useQueryClient();
  const materials = useQuery({ queryKey: ["materials"], queryFn: inventoryApi.materials });
  const laborRate = useQuery({ queryKey: ["laborRate"], queryFn: catalogApi.laborRate });

  const [p, setP] = useState<ProductInput>(existing ?? EMPTY);
  const [tab, setTab] = useState<"recipe" | "designs" | "variants">("recipe");
  const [composer, setComposer] = useState<{ index: number | null; rule: Rule } | null>(null);

  const byId = useMemo(() => new Map((materials.data ?? []).map((m) => [m.id, m])), [materials.data]);
  // Products don't own SKUs (listings do, D17) — no enumeration here. The
  // count is arithmetic over choice palettes; coverage checks rules/defaults.
  const comboCount = useMemo(() => {
    const choice = p.slots.filter((s) => s.kind === "CHOICE");
    if (choice.length === 0) return 0;
    return choice.reduce((n, s) => n * s.optionMaterialIds.length, 1);
  }, [p.slots]);
  const coverageWarnings = useMemo(() => {
    const warnings: string[] = [];
    p.slots.forEach((slot, idx) => {
      if (slot.kind !== "RULE" || slot.defaultMaterialId != null) return;
      const rules = p.rules.filter((r) => r.thenSlot === idx);
      if (rules.length === 0) {
        warnings.push(`${slot.name || `slot ${idx + 1}`}: no rules and no default`);
        return;
      }
      const byWhen = new Map<number, Set<number>>();
      rules.forEach((r) => {
        const set = byWhen.get(r.whenSlot) ?? new Set<number>();
        r.whenMaterialIds.forEach((m) => set.add(m));
        byWhen.set(r.whenSlot, set);
      });
      const fullyCovered = [...byWhen.entries()].some(([w, covered]) =>
        (p.slots[w]?.optionMaterialIds ?? []).every((m) => covered.has(m)),
      );
      if (!fullyCovered) warnings.push(`${slot.name || `slot ${idx + 1}`}: some options fall through — add a rule or default`);
    });
    return warnings;
  }, [p.slots, p.rules]);

  const set = (patch: Partial<ProductInput>) => setP((prev) => ({ ...prev, ...patch }));
  const setSlot = (i: number, patch: Partial<Slot>) =>
    setP((prev) => ({ ...prev, slots: prev.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  const addSlot = (kind: Slot["kind"]) =>
    set({
      slots: [
        ...p.slots,
        { name: "", kind, quantity: 1, fixedMaterialId: null, defaultMaterialId: null, optionMaterialIds: [] },
      ],
    });

  const removeSlot = (i: number) =>
    setP((prev) => ({
      ...prev,
      slots: prev.slots.filter((_, j) => j !== i),
      rules: prev.rules
        .filter((r) => r.whenSlot !== i && r.thenSlot !== i)
        .map((r) => ({
          ...r,
          whenSlot: r.whenSlot > i ? r.whenSlot - 1 : r.whenSlot,
          thenSlot: r.thenSlot > i ? r.thenSlot - 1 : r.thenSlot,
        })),
    }));

  const save = useMutation({
    mutationFn: () => (existing ? catalogApi.update(existing.id, p) : catalogApi.create(p)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      onClose();
    },
  });

  const all = materials.data ?? [];
  const choiceSlots = p.slots.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === "CHOICE");
  const ruleSlots = p.slots.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === "RULE");
  const laborMinor = Math.round(((laborRate.data?.rateMinor ?? 0) * p.laborMinutes) / 60);

  // Itemized per-slot costs; choice/rule slots show a min–max range when
  // their palette's materials are priced differently.
  const costLines = useMemo(() => {
    const perUnit = (m: Material | undefined) =>
      m && m.costQuantity > 0 ? (m.costMinor / m.costQuantity) : 0;
    return p.slots
      .filter((s) => s.quantity > 0)
      .map((s) => {
        const mats =
          s.kind === "FIXED"
            ? [s.fixedMaterialId != null ? byId.get(s.fixedMaterialId) : undefined]
            : s.optionMaterialIds.map((id) => byId.get(id));
        const costs = mats.filter(Boolean).map((m) => Math.round(s.quantity * perUnit(m)));
        const unit = mats.find(Boolean)?.unit ?? "";
        return {
          label: `${s.name || "Slot"} · ${s.quantity} ${unit}`,
          min: costs.length ? Math.min(...costs) : 0,
          max: costs.length ? Math.max(...costs) : 0,
        };
      });
  }, [p.slots, byId]);
  const matMin = costLines.reduce((a, l) => a + l.min, 0);
  const matMax = costLines.reduce((a, l) => a + l.max, 0);
  const range = (min: number, max: number) => (min === max ? money(min) : `${money(min)}–${money(max)}`);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
      <div>
        {/* D20: Recipe | Designs | Variants tabs (existing products only) */}
        {existing?.id != null && (
          <div className="mb-4 flex gap-0.5 border-b border-line">
            {(["recipe", "designs", "variants"] as const).map((t) => (
              <button
                key={t} type="button" onClick={() => setTab(t)}
                className={`relative top-px border-b-2 px-4 py-2 text-[13px] font-semibold capitalize ${tab === t ? "border-accent font-bold text-accent" : "border-transparent text-ink2 hover:text-ink"}`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
        {/* Keep mounted across tab switches so in-progress edits survive. */}
        {existing?.id != null && (
          <div style={{ display: tab === "designs" ? undefined : "none" }}>
            <DesignsTab productId={existing.id} slots={p.slots} materials={materials.data ?? []} />
          </div>
        )}
        {existing?.id != null && (
          <div style={{ display: tab === "variants" ? undefined : "none" }}>
            <VariantsTab productId={existing.id} slots={p.slots} materials={materials.data ?? []} />
          </div>
        )}
        <div style={{ display: tab === "recipe" ? undefined : "none" }}>
        {/* product header */}
        <div className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <div className="flex gap-4">
            <ImagePicker
              imageDocumentId={p.imageDocumentId}
              onChange={(id) => set({ imageDocumentId: id })}
            />
            <div className="grid flex-1 gap-4 sm:grid-cols-[1fr_130px_110px]">
              <Field label="Product name" value={p.name} onChange={(v) => set({ name: v })} autoFocus={!existing} />
              <Field label="SKU prefix" value={p.skuPrefix} onChange={(v) => set({ skuPrefix: v.toUpperCase() })} />
              <Field
                label="Labor (min)"
                value={String(p.laborMinutes || "")}
                onChange={(v) => set({ laborMinutes: parseInt(v) || 0 })}
              />
            </div>
          </div>
        </div>

        {/* slots */}
        <h2 className="mt-6 mb-1 text-[13px] font-bold tracking-widest uppercase text-ink2">
          Material slots{" "}
          <span className="font-normal tracking-normal normal-case text-mut">
            fixed = always this material · choice = palette defines variants · by rule = resolved by rules
          </span>
        </h2>
        {p.slots.map((slot, i) => (
          <SlotCard
            key={i}
            slot={slot}
            all={all}
            byId={byId}
            onChange={(patch) => setSlot(i, patch)}
            onRemove={() => removeSlot(i)}
          />
        ))}
        <div className="mt-2 flex gap-2">
          {(["FIXED", "CHOICE", "RULE"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => addSlot(k)}
              className="flex-1 rounded-lg border border-dashed border-line py-2 text-sm text-accent hover:border-accent"
            >
              + {k === "FIXED" ? "Fixed slot" : k === "CHOICE" ? "Choice slot" : "By-rule slot"}
            </button>
          ))}
        </div>

        {/* rules */}
        {ruleSlots.length > 0 && (
          <>
            <h2 className="mt-6 mb-1 text-[13px] font-bold tracking-widest uppercase text-ink2">
              Dependency rules{" "}
              <span className="font-normal tracking-normal normal-case text-mut">first matching rule wins</span>
            </h2>
            {p.rules.map((r, i) => (
              <div key={i} className="group mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-4 py-3 text-sm shadow-sm">
                <span className="text-[10px] font-extrabold tracking-wider text-mut">RULE {i + 1}</span>
                <span className="text-[10px] font-extrabold tracking-widest text-accent">WHEN</span>
                {p.slots[r.whenSlot]?.name || "?"} is
                <span className="flex gap-1">
                  {r.whenMaterialIds.map((id) => (
                    <span
                      key={id}
                      title={byId.get(id)?.name}
                      className="h-3.5 w-3.5 rounded-full border border-line"
                      style={{ background: byId.get(id) ? (materialColor(byId.get(id)!) ?? "var(--color-mut)") : "var(--color-mut)" }}
                    />
                  ))}
                </span>
                <span className="text-[10px] font-extrabold tracking-widest text-accent">THEN</span>
                {p.slots[r.thenSlot]?.name || "?"} = <b>{byId.get(r.thenMaterialId)?.name ?? "?"}</b>
                <span className="ml-auto flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button type="button" onClick={() => setComposer({ index: i, rule: { ...r } })} className="rounded border border-line px-2 py-0.5 text-xs text-ink2 hover:text-ink">
                    Edit
                  </button>
                  <button type="button" onClick={() => set({ rules: p.rules.filter((_, j) => j !== i) })} className="rounded border border-line px-2 py-0.5 text-xs text-ink2 hover:text-crit">
                    Delete
                  </button>
                </span>
              </div>
            ))}

            {/* OTHERWISE defaults per rule slot */}
            {ruleSlots.map(({ s, i }) => (
              <div key={i} className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line bg-panel px-4 py-3 text-sm">
                <span className="text-[10px] font-extrabold tracking-wider text-mut">OTHERWISE</span>
                {s.name || "slot"} =
                <select
                  value={s.defaultMaterialId ?? ""}
                  onChange={(e) => setSlot(i, { defaultMaterialId: e.target.value ? +e.target.value : null })}
                  className="rounded-md border border-line bg-panel2 px-2 py-1 text-sm"
                >
                  <option value="">— none (uncovered = unresolved)</option>
                  {s.optionMaterialIds.map((id) => (
                    <option key={id} value={id}>
                      {byId.get(id)?.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}

            {composer ? (
              <RuleComposer
                p={p}
                byId={byId}
                choiceSlots={choiceSlots}
                ruleSlots={ruleSlots}
                state={composer}
                onSave={(rule) => {
                  set({
                    rules:
                      composer.index != null
                        ? p.rules.map((r, j) => (j === composer.index ? rule : r))
                        : [...p.rules, rule],
                  });
                  setComposer(null);
                }}
                onCancel={() => setComposer(null)}
              />
            ) : (
              choiceSlots.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setComposer({
                      index: null,
                      rule: { whenSlot: choiceSlots[0].i, thenSlot: ruleSlots[0].i, thenMaterialId: ruleSlots[0].s.optionMaterialIds[0] ?? 0, whenMaterialIds: [] },
                    })
                  }
                  className="mt-2 w-full rounded-lg border border-dashed border-line py-2 text-sm text-accent hover:border-accent"
                >
                  + Add rule
                </button>
              )
            )}
          </>
        )}
        </div>
      </div>

      {/* summary rail */}
      <div className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
          <div className="text-[10.5px] tracking-widest uppercase text-mut">Configurations</div>
          <div className="font-mono text-2xl font-semibold">{comboCount.toLocaleString()}</div>
          <div className="mt-0.5 text-[11px] text-mut">choice combinations — SKUs are the listing's job</div>
          {coverageWarnings.map((w) => (
            <div key={w} className="mt-1 text-xs font-semibold text-warn">▲ {w}</div>
          ))}
        </div>
        <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
          <div className="text-[10.5px] tracking-widest uppercase text-mut">Unit cost</div>
          <div className="font-mono text-2xl font-semibold">{range(matMin + laborMinor, matMax + laborMinor)}</div>
          <div className="mt-2 text-xs">
            {costLines.map((l) => (
              <div key={l.label} className="flex justify-between gap-2 border-b border-dotted border-line/60 py-1 text-ink2">
                <span className="truncate">{l.label}</span>
                <span className="font-mono whitespace-nowrap">{range(l.min, l.max)}</span>
              </div>
            ))}
            <div className="flex justify-between gap-2 border-b border-dotted border-line/60 py-1 text-ink2">
              <span>Materials</span>
              <span className="font-mono whitespace-nowrap">{range(matMin, matMax)}</span>
            </div>
            <div className="flex justify-between gap-2 border-b border-dotted border-line/60 py-1 text-ink2">
              <span>
                Labor · {p.laborMinutes} min <span className="text-mut">@ {money(laborRate.data?.rateMinor ?? 0)}/hr</span>
              </span>
              <span className="font-mono whitespace-nowrap">{money(laborMinor)}</span>
            </div>
            <div className="flex justify-between gap-2 py-1 font-semibold">
              <span>Unit total</span>
              <span className="font-mono whitespace-nowrap">{range(matMin + laborMinor, matMax + laborMinor)}</span>
            </div>
          </div>
        </div>
        <ErrorText>{save.error?.message}</ErrorText>
        <Button disabled={save.isPending || !p.name || !p.skuPrefix} onClick={() => save.mutate()} type="button">
          {save.isPending ? "Saving…" : existing ? "Save product" : "Create product"}
        </Button>
        <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-2 text-sm text-ink2 hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ---------------- quantity input ---------------- */

/** String-buffered so decimals type naturally ("0." doesn't collapse) and
 *  fraction shorthand works: "1/20" commits as 0.05. */
function QtyInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [raw, setRaw] = useState(value ? formatQty(value) : "");
  return (
    <input
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        const parsed = parseQty(e.target.value);
        if (parsed != null && parsed >= 0) onCommit(parsed);
      }}
      onBlur={() => {
        const parsed = parseQty(raw);
        setRaw(parsed != null && parsed > 0 ? formatQty(parsed) : value ? formatQty(value) : "");
      }}
      placeholder="0.05 or 1/20"
      className="w-20 rounded border border-line bg-panel2 px-2 py-1 text-right font-mono text-sm"
    />
  );
}

/* ---------------- image picker ---------------- */

function ImagePicker({
  imageDocumentId,
  onChange,
}: {
  imageDocumentId: number | null;
  onChange: (id: number | null) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      onChange(await uploadImage(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <label
        className="relative flex h-24 w-24 cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-dashed border-line bg-panel2 text-center text-[10px] leading-tight text-mut hover:border-accent"
        title={error ?? "Product photo (optional)"}
      >
        {imageDocumentId ? (
          <img src={documentUrl(imageDocumentId)} alt="Product" className="h-full w-full object-cover" />
        ) : (
          <span className="flex flex-col items-center gap-1">
            <MaterialIcon category="product" size={28} />
            {uploading ? "Uploading…" : error ? "⚠ retry" : "+ photo"}
          </span>
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0])}
        />
      </label>
      {imageDocumentId && (
        <button type="button" onClick={() => onChange(null)} title="remove image" className="rounded-md border border-crit/40 p-1 text-crit hover:border-crit hover:bg-crit/10">
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

/* ---------------- slot card ---------------- */

function SlotCard({
  slot,
  all,
  byId,
  onChange,
  onRemove,
}: {
  slot: Slot;
  all: Material[];
  byId: Map<number, Material>;
  onChange: (patch: Partial<Slot>) => void;
  onRemove: () => void;
}) {
  // Remember the slot's world: default the category filter to whatever the
  // slot already contains (a hardware rule slot reopens on hardware).
  const [catFilter, setCatFilter] = useState<string>(
    () => byId.get(slot.optionMaterialIds[0] ?? slot.fixedMaterialId ?? -1)?.category ?? "filament",
  );
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("color");
  const categories = [...new Set(all.map((m) => m.category))];
  const unit = slot.fixedMaterialId
    ? byId.get(slot.fixedMaterialId)?.unit
    : byId.get(slot.optionMaterialIds[0] ?? -1)?.unit;

  const toggleOption = (id: number) =>
    onChange({
      optionMaterialIds: slot.optionMaterialIds.includes(id)
        ? slot.optionMaterialIds.filter((x) => x !== id)
        : [...slot.optionMaterialIds, id],
    });

  // The set the filter row currently describes — bulk actions act on exactly this.
  const filtered = all.filter((m) => m.category === catFilter && matchesQuery(m, query));
  const filteredSelected = filtered.filter((m) => slot.optionMaterialIds.includes(m.id)).length;
  const selectAllFiltered = () =>
    onChange({ optionMaterialIds: [...new Set([...slot.optionMaterialIds, ...filtered.map((m) => m.id)])] });
  const clearFiltered = () => {
    const ids = new Set(filtered.map((m) => m.id));
    onChange({ optionMaterialIds: slot.optionMaterialIds.filter((x) => !ids.has(x)) });
  };

  return (
    <div className="group mt-2 rounded-xl border border-line bg-panel px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={slot.name}
          placeholder="Slot name (Shell filament…)"
          onChange={(e) => onChange({ name: e.target.value })}
          className="min-w-40 flex-1 border-b border-dashed border-transparent bg-transparent text-sm font-semibold outline-none focus:border-accent"
        />
        <span
          className={`rounded-full px-2 py-0.5 text-[9.5px] font-extrabold tracking-wider ${
            slot.kind === "FIXED" ? "bg-line/60 text-ink2" : "bg-accent text-white"
          }`}
        >
          {slot.kind === "RULE" ? "DYNAMIC · BY RULE" : slot.kind}
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink2">
          <QtyInput value={slot.quantity} onCommit={(quantity) => onChange({ quantity })} />
          {unit ?? "unit"} / unit
        </label>
        <button
          type="button"
          onClick={onRemove}
          title="remove slot"
          className="rounded-md border border-crit/40 p-1 text-crit hover:border-crit hover:bg-crit/10"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {slot.kind === "FIXED" ? (
        <div className="mt-2">
          <MaterialPicker
            all={all}
            value={slot.fixedMaterialId != null ? (byId.get(slot.fixedMaterialId) ?? null) : null}
            onChange={(id) => onChange({ fixedMaterialId: id })}
          />
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-mut">
            {slot.kind === "CHOICE" ? "Allowed palette" : "Candidate materials"}
            <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} className="rounded border border-line bg-panel2 px-1.5 py-0.5 text-[11px]">
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter…"
              className="w-28 rounded border border-line bg-panel2 px-2 py-0.5 text-[11px] outline-none placeholder:text-mut focus:border-accent"
            />
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rounded border border-line bg-panel2 px-1.5 py-0.5 text-[11px]" title="Sort">
              <option value="color">color</option>
              <option value="name">name</option>
              <option value="type">type</option>
              <option value="stock">stock</option>
            </select>
            <span className="ml-auto flex items-center gap-2">
              <span className="font-mono">{filteredSelected}/{filtered.length}</span>
              <button
                type="button"
                onClick={selectAllFiltered}
                disabled={filteredSelected === filtered.length || filtered.length === 0}
                className="text-accent underline-offset-2 hover:underline disabled:cursor-default disabled:text-mut disabled:no-underline"
                title="add every material matching the current filter"
              >
                select all
              </button>
              <button
                type="button"
                onClick={clearFiltered}
                disabled={filteredSelected === 0}
                className="text-accent underline-offset-2 hover:underline disabled:cursor-default disabled:text-mut disabled:no-underline"
                title="remove every filtered material from the palette (selections outside the filter are kept)"
              >
                none
              </button>
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {sortMaterials(
              all.filter(
                (m) =>
                  slot.optionMaterialIds.includes(m.id) ||
                  (m.category === catFilter && matchesQuery(m, query)),
              ),
              sort,
            ).map((m) => {
              const on = slot.optionMaterialIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleOption(m.id)}
                  className={`flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1.5 text-xs ${
                    on ? "border-accent font-semibold text-ink" : "border-line text-ink2 opacity-60 hover:opacity-100"
                  }`}
                >
                  <span className="h-3.5 w-3.5 rounded-full border border-line" style={{ background: materialColor(m) ?? "var(--color-panel2)" }} />
                  {m.name}
                  <span className="font-mono text-[10px] text-mut">{formatQty(m.stock.available)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- rule composer ---------------- */

function RuleComposer({
  p,
  byId,
  choiceSlots,
  ruleSlots,
  state,
  onSave,
  onCancel,
}: {
  p: ProductInput;
  byId: Map<number, Material>;
  choiceSlots: { s: Slot; i: number }[];
  ruleSlots: { s: Slot; i: number }[];
  state: { index: number | null; rule: Rule };
  onSave: (r: Rule) => void;
  onCancel: () => void;
}) {
  const [r, setR] = useState<Rule>(state.rule);
  const [q, setQ] = useState("");
  const [sortK, setSortK] = useState<SortKey>("color");
  const whenSlot = p.slots[r.whenSlot];
  const thenSlot = p.slots[r.thenSlot];
  const claimed = new Set(
    p.rules.flatMap((other, j) => (j === state.index ? [] : other.whenSlot === r.whenSlot ? other.whenMaterialIds : [])),
  );

  return (
    <div className="mt-2 rounded-xl border-2 border-accent bg-panel p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[10px] font-extrabold tracking-widest text-accent">WHEN</span>
        <select
          value={r.whenSlot}
          onChange={(e) => setR({ ...r, whenSlot: +e.target.value, whenMaterialIds: [] })}
          className="rounded-md border border-line bg-panel2 px-2 py-1"
        >
          {choiceSlots.map(({ s, i }) => (
            <option key={i} value={i}>
              {s.name || `slot ${i + 1}`}
            </option>
          ))}
        </select>
        <span className="text-mut">is any of</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-mut">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter…"
            className="w-28 rounded border border-line bg-panel2 px-2 py-0.5 text-[11px] outline-none placeholder:text-mut focus:border-accent"
          />
          <select value={sortK} onChange={(e) => setSortK(e.target.value as SortKey)} className="rounded border border-line bg-panel2 px-1.5 py-0.5 text-[11px]" title="Sort">
            <option value="color">color</option>
            <option value="name">name</option>
            <option value="type">type</option>
            <option value="stock">stock</option>
          </select>
          {(() => {
            const opts = (whenSlot?.optionMaterialIds ?? []).map((id) => byId.get(id)).filter((m): m is Material => !!m);
            const shown = opts.filter((m) => matchesQuery(m, q));
            const sel = shown.filter((m) => r.whenMaterialIds.includes(m.id)).length;
            return (
              <>
                <span className="font-mono">{sel}/{shown.length}</span>
                <button
                  type="button"
                  disabled={sel === shown.length || shown.length === 0}
                  onClick={() => setR({ ...r, whenMaterialIds: [...new Set([...r.whenMaterialIds, ...shown.map((m) => m.id)])] })}
                  className="text-accent underline-offset-2 hover:underline disabled:text-mut disabled:no-underline"
                >
                  select all
                </button>
                <button
                  type="button"
                  disabled={sel === 0}
                  onClick={() => {
                    const ids = new Set(shown.map((m) => m.id));
                    setR({ ...r, whenMaterialIds: r.whenMaterialIds.filter((x) => !ids.has(x)) });
                  }}
                  className="text-accent underline-offset-2 hover:underline disabled:text-mut disabled:no-underline"
                >
                  none
                </button>
              </>
            );
          })()}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {sortMaterials(
          (whenSlot?.optionMaterialIds ?? []).map((id) => byId.get(id)).filter((m): m is Material => !!m && matchesQuery(m, q)),
          sortK,
        ).map((m) => {
          const id = m.id;
          const on = r.whenMaterialIds.includes(id);
          return (
            <button
              key={id}
              type="button"
              title={claimed.has(id) ? "already covered by another rule — first match wins" : undefined}
              onClick={() =>
                setR({
                  ...r,
                  whenMaterialIds: on ? r.whenMaterialIds.filter((x) => x !== id) : [...r.whenMaterialIds, id],
                })
              }
              className={`flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1.5 text-xs ${
                on ? "border-accent font-semibold" : "border-line text-ink2 opacity-60 hover:opacity-100"
              } ${claimed.has(id) ? "border-warn" : ""}`}
            >
              <span className="h-3.5 w-3.5 rounded-full border border-line" style={{ background: m ? (materialColor(m) ?? "var(--color-panel2)") : undefined }} />
              {m?.name}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[10px] font-extrabold tracking-widest text-accent">THEN</span>
        <select value={r.thenSlot} onChange={(e) => setR({ ...r, thenSlot: +e.target.value })} className="rounded-md border border-line bg-panel2 px-2 py-1">
          {ruleSlots.map(({ s, i }) => (
            <option key={i} value={i}>
              {s.name || `slot ${i + 1}`}
            </option>
          ))}
        </select>
        <span className="text-mut">must be</span>
        <select value={r.thenMaterialId} onChange={(e) => setR({ ...r, thenMaterialId: +e.target.value })} className="rounded-md border border-line bg-panel2 px-2 py-1">
          {(thenSlot?.optionMaterialIds ?? []).map((id) => (
            <option key={id} value={id}>
              {byId.get(id)?.name}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={r.whenMaterialIds.length === 0}
          onClick={() => onSave(r)}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {state.index != null ? "Save rule" : "Add rule"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border border-line px-4 py-1.5 text-sm text-ink2">
          Cancel
        </button>
      </div>
    </div>
  );
}
