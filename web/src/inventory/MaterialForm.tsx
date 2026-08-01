import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { inventoryApi, type Material, type MaterialInput } from "./api";
import { Button, ErrorText, Field } from "../ui";

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
}: {
  existing?: Material;
  categories: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [m, setM] = useState<MaterialInput>(existing ?? EMPTY);
  const [costDollars, setCostDollars] = useState(existing ? (existing.costMinor / 100).toFixed(2) : "");
  const [initialQty, setInitialQty] = useState("");
  const [color, setColor] = useState(existing?.attributes.color ?? "");

  const set = (patch: Partial<MaterialInput>) => setM((prev) => ({ ...prev, ...patch }));

  const save = useMutation({
    mutationFn: async () => {
      const input: MaterialInput = {
        ...m,
        costMinor: Math.round(parseFloat(costDollars || "0") * 100),
        attributes: color ? { ...m.attributes, color } : Object.fromEntries(Object.entries(m.attributes).filter(([k]) => k !== "color")),
      };
      return existing
        ? inventoryApi.update(existing.id, input)
        : inventoryApi.create(input, parseFloat(initialQty) || undefined);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["materials"] });
      onClose();
    },
  });

  const num = (v: string) => (v === "" ? null : parseFloat(v) || 0);

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-6" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-line bg-panel p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold">{existing ? `Edit ${existing.name}` : "New material"}</h2>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="col-span-2">
            <Field label="Name" value={m.name} onChange={(v) => set({ name: v })} autoFocus />
          </div>
          <div>
            <Field label="Category" value={m.category} onChange={(v) => set({ category: v })} />
            {categories.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set({ category: c })}
                    className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink2 hover:border-accent"
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Field label="Type (PLA, screw…)" value={m.type} onChange={(v) => set({ type: v })} />
          <Field label="Unit (g, piece, roll…)" value={m.unit} onChange={(v) => set({ unit: v })} />
          <label className="block">
            <span className="mb-1 block text-xs font-semibold tracking-widest uppercase text-mut">Color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#888888"}
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border border-line bg-panel2"
              />
              <button type="button" onClick={() => setColor("")} className="text-xs text-mut hover:text-ink">
                {color ? "clear" : "none"}
              </button>
            </div>
          </label>
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
          <Field
            label="Full size (gauge ref)"
            value={m.fullQuantity == null ? "" : String(m.fullQuantity)}
            onChange={(v) => set({ fullQuantity: num(v) })}
          />
          {!existing && <Field label="Starting stock" value={initialQty} onChange={setInitialQty} />}
          <div className="col-span-2">
            <Field label="Vendor URL" value={m.vendorUrl ?? ""} onChange={(v) => set({ vendorUrl: v || null })} />
          </div>
          <div className="col-span-2 space-y-2">
            <ErrorText>{save.error?.message}</ErrorText>
            <div className="flex gap-3">
              <Button disabled={save.isPending}>{save.isPending ? "Saving…" : existing ? "Save changes" : "Create material"}</Button>
              <button type="button" onClick={onClose} className="rounded-md border border-line px-4 py-2 text-ink2 hover:text-ink">
                Cancel
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
