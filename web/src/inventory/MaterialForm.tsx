import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HexColorPicker } from "react-colorful";
import { inventoryApi, type Material, type MaterialInput } from "./api";
import { Button, ErrorText, Field } from "../ui";

/** Bambu Lab PLA Basic palette — the store's full color roster (variant list
 *  on the product page) with hexes from Bambu's official color card / Studio
 *  presets (vault: Filament Catalog Checklist). Spectrum-ordered. */
const BAMBU_PLA_BASIC: { name: string; hex: string }[] = [
  { name: "Jade White", hex: "#FFFFFF" }, { name: "Beige", hex: "#F7E6DE" },
  { name: "Light Gray", hex: "#D1D3D5" }, { name: "Silver", hex: "#A6A9AA" },
  { name: "Gray", hex: "#8E9089" }, { name: "Dark Gray", hex: "#545454" },
  { name: "Black", hex: "#000000" }, { name: "Blue Gray", hex: "#5B6579" },
  { name: "Yellow", hex: "#F4EE2A" }, { name: "Sunflower Yellow", hex: "#FEC600" },
  { name: "Gold", hex: "#E4BD68" }, { name: "Pumpkin Orange", hex: "#FF9016" },
  { name: "Orange", hex: "#FF6A13" }, { name: "Red", hex: "#C12E1F" },
  { name: "Maroon Red", hex: "#9D2235" }, { name: "Magenta", hex: "#EC008C" },
  { name: "Hot Pink", hex: "#F5547C" }, { name: "Pink", hex: "#F55A74" },
  { name: "Purple", hex: "#5E43B7" }, { name: "Indigo Purple", hex: "#482960" },
  { name: "Cobalt Blue", hex: "#0056B8" }, { name: "Blue", hex: "#0A2989" },
  { name: "Cyan", hex: "#0086D6" }, { name: "Turquoise", hex: "#00B1B7" },
  { name: "Bambu Green", hex: "#00AE42" }, { name: "Mistletoe Green", hex: "#3F8E43" },
  { name: "Bright Green", hex: "#BECF00" }, { name: "Cocoa Brown", hex: "#6F5034" },
  { name: "Brown", hex: "#9D432C" }, { name: "Bronze", hex: "#847D48" },
];

/** Swatch + hex field opening a proper picker popover (react-colorful),
 *  with the Bambu PLA Basic palette as quick swatches. */
function ColorField({ value, onChange, presets }: { value: string; onChange: (v: string) => void; presets: { name: string; hex: string }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={value || "pick a color"}
          className="h-9 w-14 rounded border border-line"
          style={valid ? { background: value } : { background: "repeating-conic-gradient(var(--color-panel2) 0% 25%, var(--color-panel) 0% 50%) 0 0 / 12px 12px" }}
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          onFocus={() => setOpen(true)}
          placeholder="#RRGGBB"
          className={`w-24 rounded-md border bg-panel2 px-2 py-1.5 font-mono text-sm outline-none focus:border-accent ${value && !valid ? "border-warn" : "border-line"}`}
        />
        <button type="button" onClick={() => { onChange(""); setOpen(false); }} className="text-xs text-mut hover:text-ink">
          {value ? "clear" : "none"}
        </button>
      </div>
      {open && (
        <div className="absolute z-20 mt-2 rounded-xl border border-line bg-panel p-3 shadow-lg">
          <HexColorPicker color={valid ? value : "#888888"} onChange={onChange} />
          {presets.length > 0 && (
            <div className="mt-2.5 grid w-[200px] justify-between gap-y-1.5 [grid-template-columns:repeat(7,1.25rem)]">
              {presets.map((p) => (
                <button
                  key={p.hex + p.name}
                  type="button"
                  title={p.name}
                  onClick={() => onChange(p.hex)}
                  className={`h-5 w-5 rounded-full border ${p.hex.toLowerCase() === value.toLowerCase() ? "border-accent ring-1 ring-accent" : "border-line"}`}
                  style={{ background: p.hex }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Category-aware material form. Filament is a first-class citizen: curated
 * type dropdown, gram/spool defaults, and prominent color. Other known
 * categories get type suggestions; anything custom stays free-text.
 */
type CategoryProfile = {
  types: string[];
  /** Applied on category selection during creation (never on edit). */
  defaults?: Partial<Pick<MaterialInput, "unit" | "costQuantity" | "fullQuantity">>;
  colorPrimary?: boolean;
  typeStrict?: boolean;
};

const PROFILES: Record<string, CategoryProfile> = {
  filament: {
    types: [
      "PLA Basic",
      "PLA Matte",
      "PLA Silk",
      "PLA-CF",
      "PETG",
      "PETG-CF",
      "ABS",
      "ASA",
      "TPU",
      "PC",
      "PA (Nylon)",
      "PVA (Support)",
    ],
    defaults: { unit: "g", costQuantity: 1000, fullQuantity: 1000 },
    colorPrimary: true,
    typeStrict: true,
  },
  hardware: {
    types: ["screw", "bolt", "nut", "washer", "magnet", "heat insert", "spring", "adhesive", "bearing"],
  },
  packaging: {
    types: ["box", "mailer", "tape", "label", "insert card", "sticker", "bubble wrap", "void fill"],
  },
};

const KNOWN_CATEGORIES = Object.keys(PROFILES);
const COMMON_UNITS = ["g", "piece", "roll", "bottle", "m", "sheet"];

const EMPTY: MaterialInput = {
  name: "",
  category: "",
  type: "",
  unit: "",
  costMinor: 0,
  costQuantity: 1,
  currency: "USD",
  lowStockThreshold: null,
  reorderQuantity: null,
  fullQuantity: null,
  vendorUrl: null,
  attributes: {},
};

export function MaterialForm({
  existing,
  categories,
  onClose,
  initialName,
  onSaved,
}: {
  existing?: Material;
  categories: string[];
  onClose: () => void;
  /** Prefill for create flows (e.g. the importer's on-the-fly create). */
  initialName?: string;
  /** Fires with the saved material so callers can chain (e.g. auto-pick it). */
  onSaved?: (m: Material) => void;
}) {
  const queryClient = useQueryClient();
  const allMaterials = useQuery({ queryKey: ["materials"], queryFn: inventoryApi.materials });
  const brandSuggestions = [...new Set((allMaterials.data ?? []).map((x) => x.brand).filter((b): b is string => !!b))].sort();
  const [m, setM] = useState<MaterialInput>(existing ?? (initialName ? { ...EMPTY, name: initialName } : EMPTY));
  const [costDollars, setCostDollars] = useState(existing ? (existing.costMinor / 100).toFixed(2) : "");
  const [initialQty, setInitialQty] = useState("");
  const [color, setColor] = useState(existing?.attributes.color ?? "");
  const [customType, setCustomType] = useState(
    !!existing && !!PROFILES[existing.category]?.typeStrict && !PROFILES[existing.category].types.includes(existing.type),
  );

  const profile: CategoryProfile | undefined = PROFILES[m.category];
  const allCategories = [...new Set([...KNOWN_CATEGORIES, ...categories])];

  const set = (patch: Partial<MaterialInput>) => setM((prev) => ({ ...prev, ...patch }));

  const pickCategory = (cat: string) => {
    const p = PROFILES[cat];
    setCustomType(false);
    if (existing) {
      set({ category: cat });
      return;
    }
    // Smart defaults on create: only fill fields the user hasn't touched.
    set({
      category: cat,
      type: p?.typeStrict ? "" : m.type,
      unit: m.unit || p?.defaults?.unit || "",
      costQuantity: m.costQuantity !== 1 ? m.costQuantity : (p?.defaults?.costQuantity ?? 1),
      fullQuantity: m.fullQuantity ?? p?.defaults?.fullQuantity ?? null,
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const input: MaterialInput = {
        ...m,
        costMinor: Math.round(parseFloat(costDollars || "0") * 100),
        attributes: color
          ? { ...m.attributes, color }
          : Object.fromEntries(Object.entries(m.attributes).filter(([k]) => k !== "color")),
      };
      return existing
        ? inventoryApi.update(existing.id, input)
        : inventoryApi.create(input, parseFloat(initialQty) || undefined);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["materials"] });
      onSaved?.(saved);
      onClose();
    },
  });

  const num = (v: string) => (v === "" ? null : parseFloat(v) || 0);
  const isFilament = !!profile?.colorPrimary;

  // Paste-a-vendor-link prefill: fills only fields still untouched.
  const [prefillUrl, setPrefillUrl] = useState("");
  const [prefillNote, setPrefillNote] = useState<string | null>(null);
  const prefill = useMutation({
    mutationFn: () => inventoryApi.prefill(prefillUrl.trim()),
    onSuccess: (r) => {
      setM((prev) => ({
        ...prev,
        name: prev.name || r.name || "",
        brand: prev.brand || r.brand || prev.brand,
        category: prev.category || r.category || prev.category,
        type: prev.type || r.type || prev.type,
        unit: prev.unit || r.unit || prev.unit,
        currency: r.currency || prev.currency,
        costQuantity: prev.costQuantity !== 1 ? prev.costQuantity : (r.costQuantity ?? prev.costQuantity),
        fullQuantity: prev.fullQuantity ?? r.fullQuantity ?? null,
        vendorUrl: r.vendorUrl,
      }));
      if (r.costMinor != null && !costDollars) setCostDollars((r.costMinor / 100).toFixed(2));
      if (r.colorHex && !color) setColor(r.colorHex);
      setPrefillNote(
        r.source === "none"
          ? (r.note ?? "Nothing found on that page — URL kept.")
          : `Found (${r.source})${r.rawTitle ? `: ${r.rawTitle.slice(0, 80)}` : ""}${r.colorName ? ` · color: ${r.colorName}` : ""}`,
      );
    },
    onError: (e) => setPrefillNote(e instanceof Error ? e.message : "Prefill failed."),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-6" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-line bg-panel p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">{existing ? `Edit ${existing.name}` : "New material"}</h2>
        {!existing && (
          <div className="mb-4 rounded-lg border border-dashed border-line bg-panel2 p-3">
            <div className="flex gap-2">
              <input
                value={prefillUrl}
                onChange={(e) => setPrefillUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (prefillUrl.trim()) prefill.mutate(); } }}
                placeholder="Paste a product link (Overture, Polymaker, Bambu Lab, …) to prefill"
                className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-1.5 text-sm outline-none placeholder:text-mut focus:border-accent"
              />
              <button
                type="button"
                onClick={() => prefill.mutate()}
                disabled={prefill.isPending || !prefillUrl.trim()}
                className="rounded-md border border-accent/40 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/5 disabled:opacity-50"
              >
                {prefill.isPending ? "Fetching…" : "Prefill"}
              </button>
            </div>
            {prefillNote && <p className="mt-1.5 text-[11px] text-ink2">{prefillNote}</p>}
            <p className="mt-1 text-[10.5px] text-mut">Fills only fields you haven't touched — everything stays editable. Amazon links often block fetches; the URL is kept either way.</p>
          </div>
        )}
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {/* Category chips first — they shape the rest of the form */}
          <div>
            <span className="mb-1 block text-xs font-semibold tracking-widest uppercase text-mut">Category</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {allCategories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => pickCategory(c)}
                  className={`rounded-full border px-3 py-1 text-sm capitalize ${
                    m.category === c
                      ? "border-accent bg-accent font-semibold text-white"
                      : "border-line text-ink2 hover:border-accent"
                  }`}
                >
                  {c}
                </button>
              ))}
              <input
                placeholder="other…"
                value={KNOWN_CATEGORIES.includes(m.category) || categories.includes(m.category) ? "" : m.category}
                onChange={(e) => set({ category: e.target.value })}
                className="w-24 rounded-full border border-dashed border-line bg-panel2 px-3 py-1 text-sm outline-none focus:border-accent"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Field label="Name" value={m.name} onChange={(v) => set({ name: v })} autoFocus />
      <label className="block">
        <span className="mb-1 block text-xs font-semibold tracking-widest uppercase text-mut">Brand</span>
        <input
          value={m.brand ?? ""}
          onChange={(e) => set({ brand: e.target.value || null })}
          list="brand-suggestions"
          placeholder={brandSuggestions[0] ? `e.g. ${brandSuggestions.slice(0, 3).join(", ")}…` : undefined}
          className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <datalist id="brand-suggestions">
          {brandSuggestions.map((b) => <option key={b} value={b} />)}
        </datalist>
      </label>
            </div>

            {/* Type: dropdown for filament, suggestions for other known categories */}
            {profile?.typeStrict && !customType ? (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold tracking-widest uppercase text-mut">Type</span>
                <select
                  value={profile.types.includes(m.type) ? m.type : ""}
                  onChange={(e) => {
                    if (e.target.value === "__custom__") {
                      setCustomType(true);
                      set({ type: "" });
                    } else {
                      set({ type: e.target.value });
                    }
                  }}
                  className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-ink outline-none focus:border-accent"
                >
                  <option value="" disabled>
                    Select…
                  </option>
                  {profile.types.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
              </label>
            ) : (
              <div>
                <Field label="Type" value={m.type} onChange={(v) => set({ type: v })} />
                {profile && !profile.typeStrict && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {profile.types.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => set({ type: t })}
                        className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink2 hover:border-accent"
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                {customType && (
                  <button type="button" onClick={() => setCustomType(false)} className="mt-1 text-[11px] text-accent hover:underline">
                    ← back to filament types
                  </button>
                )}
              </div>
            )}

            {/* Color: front and center for filament, available elsewhere */}
            <label className="block">
              <span className="mb-1 block text-xs font-semibold tracking-widest uppercase text-mut">
                {isFilament ? "Filament color" : "Color (optional)"}
              </span>
              <ColorField value={color} onChange={setColor} presets={BAMBU_PLA_BASIC} />
              {isFilament && !color && <span className="mt-1 block text-[11px] text-warn">Spool gauges use this color on the wall.</span>}
            </label>

            <div>
              <Field label="Unit" value={m.unit} onChange={(v) => set({ unit: v })} />
              <div className="mt-1 flex flex-wrap gap-1">
                {COMMON_UNITS.map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => set({ unit: u })}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${m.unit === u ? "border-accent text-accent" : "border-line text-ink2 hover:border-accent"}`}
                  >
                    {u}
                  </button>
                ))}
              </div>
            </div>
            <Field
              label={isFilament ? "Spool size (g)" : "Full size (gauge ref)"}
              value={m.fullQuantity == null ? "" : String(m.fullQuantity)}
              onChange={(v) => set({ fullQuantity: num(v) })}
            />
            <Field label="Cost ($)" value={costDollars} onChange={setCostDollars} />
            <Field
              label={`…for how many ${m.unit || "units"}`}
              value={String(m.costQuantity ?? "")}
              onChange={(v) => set({ costQuantity: parseFloat(v) || 1 })}
            />
            <Field
              label="Low-stock threshold"
              value={m.lowStockThreshold == null ? "" : String(m.lowStockThreshold)}
              onChange={(v) => set({ lowStockThreshold: num(v) })}
            />
            <Field
              label="Reorder quantity"
              value={m.reorderQuantity == null ? "" : String(m.reorderQuantity)}
              onChange={(v) => set({ reorderQuantity: num(v) })}
            />
            {!existing && <Field label="Starting stock" value={initialQty} onChange={setInitialQty} />}
            <div className={existing ? "col-span-2" : ""}>
              <Field label="Vendor URL" value={m.vendorUrl ?? ""} onChange={(v) => set({ vendorUrl: v || null })} />
            </div>
          </div>

          <ErrorText>{save.error?.message}</ErrorText>
          <div className="flex gap-3">
            <Button disabled={save.isPending || !m.name || !m.category || !m.unit}>
              {save.isPending ? "Saving…" : existing ? "Save changes" : "Create material"}
            </Button>
            <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-2 text-ink2 hover:text-ink">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
