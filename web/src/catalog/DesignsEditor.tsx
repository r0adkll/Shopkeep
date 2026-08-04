import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Material } from "../inventory/api";
import { MaterialPickerDialog } from "../inventory/MaterialPickerDialog";
import type { Slot } from "./api";

/* D20 — Designs & Variants tabs (locked concept, tabbed round 3). */

export type DesignAssignment = { slotPosition: number; materialId: number; qtyOverride: number | null };
export type DesignOverrideSet = { key: string; assignments: DesignAssignment[] };
export type ProductDesign = { id: number | null; name: string; assignments: DesignAssignment[]; overrideSets: DesignOverrideSet[] };
export type SlotDelta = { slotPosition: number; deltaQty: number | null; removed: boolean };
export type VariantAdjustments = { slotDeltas: SlotDelta[]; extras: { materialId: number; quantity: number }[]; laborDeltaMinutes: number };
export type ProductVariant = { id: number | null; name: string; adjustments: VariantAdjustments };

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
function useSavedMsg(): [string | null, (m: string | null) => void] {
  const [msg, setRaw] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setMsg = (m: string | null) => {
    if (timer.current) clearTimeout(timer.current);
    setRaw(m);
    if (m === "Saved.") timer.current = setTimeout(() => setRaw(null), 2500);
  };
  return [msg, setMsg];
}

async function jput<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const matDot = (m: Material | undefined) => (
  <span className="inline-block h-3 w-3 rounded-full border border-line align-[-1px]" style={{ background: m?.attributes?.color ?? "transparent" }} />
);

/** Trigger chip + the shared searchable picker dialog (replaces the old
 *  whole-shelf <select> — unusable at 75+ spools). */
function MatSelect({ materials, value, onChange }: { materials: Material[]; value: number; onChange: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const m = materials.find((x) => x.id === value);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex max-w-64 items-center gap-1.5 rounded-md border border-line bg-panel2 px-2 py-1 text-left text-xs hover:border-accent"
      >
        <span className="h-2.5 w-2.5 flex-none rounded-full border border-line" style={{ background: m?.attributes?.color ?? "var(--color-panel2)" }} />
        <span className="min-w-0 truncate">{m?.name ?? "pick a material…"}</span>
        {m?.brand && <span className="max-w-24 flex-none truncate text-[10px] text-mut">{m.brand}</span>}
      </button>
      {open && (
        <MaterialPickerDialog
          all={materials}
          title={m ? `Replace ${m.name}` : "Pick a material"}
          onPick={(id) => { onChange(id); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AssignmentRows(props: {
  slots: Slot[]; materials: Material[]; assignments: DesignAssignment[];
  onChange: (a: DesignAssignment[]) => void;
}) {
  const { slots, materials, assignments, onChange } = props;
  const choice = slots.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === "CHOICE");
  const byId = new Map(materials.map((m) => [m.id, m]));
  return (
    <table className="w-full text-xs">
      <tbody>
        {choice.map(({ s, i }) => {
          const a = assignments.find((x) => x.slotPosition === i);
          return (
            <tr key={i} className="border-b border-line/50 last:border-0">
              <td className="py-1.5 pr-2 font-medium">{s.name}{s.optional && <span className="ml-1.5 rounded-full bg-good/10 px-1.5 text-[8.5px] font-extrabold tracking-wider text-good">OPTIONAL</span>}</td>
              <td className="py-1.5">
                {a ? (
                  <span className="flex items-center gap-1.5">
                    {matDot(byId.get(a.materialId))}
                    <MatSelect materials={materials} value={a.materialId}
                      onChange={(id) => onChange(assignments.map((x) => (x === a ? { ...x, materialId: id } : x)))} />
                    <input
                      type="number" step="any" placeholder={String(s.quantity)}
                      value={a.qtyOverride ?? ""}
                      onChange={(e) => onChange(assignments.map((x) => (x === a ? { ...x, qtyOverride: e.target.value === "" ? null : Number(e.target.value) } : x)))}
                      className={`w-16 rounded-md border px-1.5 py-0.5 text-right font-mono text-xs outline-none ${a.qtyOverride != null ? "border-accent text-accent" : "border-line bg-panel2"}`}
                      title={a.qtyOverride != null ? `override (slot default ${s.quantity})` : `slot default ${s.quantity}`}
                    />
                    <button onClick={() => onChange(assignments.filter((x) => x !== a))} className="text-mut hover:text-crit" title="unassign"><Trash2 size={12} /></button>
                  </span>
                ) : (
                  <button onClick={() => onChange([...assignments, { slotPosition: i, materialId: materials[0]?.id ?? 0, qtyOverride: null }])}
                    className="rounded-md border border-dashed border-line px-2 py-0.5 text-[11px] text-accent hover:border-accent">
                    assign…{s.optional ? " (optional)" : ""}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DesignsTab({ productId, slots, materials }: { productId: number; slots: Slot[]; materials: Material[] }) {
  const [list, setListRaw] = useState<ProductDesign[] | null>(null);
  const [msg, setMsg] = useSavedMsg();
  const setList = (l: ProductDesign[] | null) => { setMsg(null); setListRaw(l); };
  useEffect(() => { jget<ProductDesign[]>(`/api/v1/catalog/products/${productId}/designs`).then(setListRaw).catch((e) => setMsg(String(e))); }, [productId]);
  if (!list) return <p className="py-4 text-sm text-mut">Loading designs…</p>;
  const upd = (i: number, fn: (d: ProductDesign) => ProductDesign) => setList(list.map((d, j) => (j === i ? fn(d) : d)));
  return (
    <div>
      {list.length === 0 && <p className="py-2 text-xs text-mut italic">No designs yet — they earn their keep when one variation value means a multi-color composition.</p>}
      {list.map((d, i) => (
        <div key={d.id ?? `n${i}`} className="mt-2 rounded-xl border border-line bg-panel px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2">
            <input value={d.name} onChange={(e) => upd(i, (x) => ({ ...x, name: e.target.value }))} placeholder="Design name"
              className="w-44 border-b border-dashed border-line bg-transparent text-sm font-semibold outline-none focus:border-accent" />
            <span className="flex items-center gap-1">
              {d.assignments.map((a, k) => matDot(materials.find((m) => m.id === a.materialId)) && (
                <span key={k} className="inline-block rounded-full border border-line" style={{ width: k ? 9 : 13, height: k ? 9 : 13, background: materials.find((m) => m.id === a.materialId)?.attributes?.color ?? "transparent" }} />
              ))}
            </span>
            <button onClick={() => setList(list.filter((_, j) => j !== i))} className="ml-auto text-xs text-mut hover:text-crit">remove</button>
          </div>
          <AssignmentRows slots={slots} materials={materials} assignments={d.assignments} onChange={(a) => upd(i, (x) => ({ ...x, assignments: a }))} />
          {d.overrideSets.map((os, oi) => (
            <div key={oi} className="mt-2 rounded-lg border border-dashed border-line p-2">
              <div className="mb-1 flex items-center gap-2 text-[10px] font-extrabold tracking-widest text-accent uppercase">
                FOR value
                <input value={os.key} onChange={(e) => upd(i, (x) => ({ ...x, overrideSets: x.overrideSets.map((y, k) => (k === oi ? { ...y, key: e.target.value } : y)) }))}
                  placeholder="e.g. 2nd Edition" className="w-32 border-b border-dashed border-line bg-transparent font-mono text-[11px] font-semibold tracking-normal text-ink normal-case outline-none" />
                → assignments below
                <button onClick={() => upd(i, (x) => ({ ...x, overrideSets: x.overrideSets.filter((_, k) => k !== oi) }))} className="ml-auto text-mut normal-case hover:text-crit"><Trash2 size={12} /></button>
              </div>
              <AssignmentRows slots={slots} materials={materials} assignments={os.assignments}
                onChange={(a) => upd(i, (x) => ({ ...x, overrideSets: x.overrideSets.map((y, k) => (k === oi ? { ...y, assignments: a } : y)) }))} />
            </div>
          ))}
          <button onClick={() => upd(i, (x) => ({ ...x, overrideSets: [...x.overrideSets, { key: "", assignments: [...d.assignments] }] }))}
            className="mt-2 w-full rounded-lg border border-dashed border-line py-1 text-[11px] text-accent hover:border-accent">
            + FOR ⟨axis value⟩ → different assignments
          </button>
        </div>
      ))}
      <button onClick={() => setList([...list, { id: null, name: "", assignments: [], overrideSets: [] }])}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-sm text-accent hover:border-accent"><Plus size={14} /> design</button>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={() => jput<ProductDesign[]>(`/api/v1/catalog/products/${productId}/designs`, list).then((r) => { setListRaw(r); setMsg("Saved."); }).catch((e) => setMsg(String(e)))}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:opacity-90">Save designs</button>
        {msg && <span className="text-xs text-ink2">{msg}</span>}
      </div>
    </div>
  );
}

export function VariantsTab({ productId, slots, materials }: { productId: number; slots: Slot[]; materials: Material[] }) {
  const [list, setListRaw] = useState<ProductVariant[] | null>(null);
  const [msg, setMsg] = useSavedMsg();
  const setList = (l: ProductVariant[] | null) => { setMsg(null); setListRaw(l); };
  useEffect(() => { jget<ProductVariant[]>(`/api/v1/catalog/products/${productId}/variants`).then(setListRaw).catch((e) => setMsg(String(e))); }, [productId]);
  if (!list) return <p className="py-4 text-sm text-mut">Loading variants…</p>;
  const upd = (i: number, fn: (v: ProductVariant) => ProductVariant) => setList(list.map((v, j) => (j === i ? fn(v) : v)));
  return (
    <div>
      {list.length === 0 && <p className="py-2 text-xs text-mut italic">No variants yet — they earn their keep when a style changes the build (quantities, extra parts, labor).</p>}
      {list.map((v, i) => (
        <div key={v.id ?? `n${i}`} className="mt-2 rounded-xl border border-line bg-panel px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2">
            <input value={v.name} onChange={(e) => upd(i, (x) => ({ ...x, name: e.target.value }))} placeholder="Variant name (e.g. Slim — No Carts)"
              className="w-60 border-b border-dashed border-line bg-transparent text-sm font-semibold outline-none focus:border-accent" />
            <button onClick={() => setList(list.filter((_, j) => j !== i))} className="ml-auto text-xs text-mut hover:text-crit">remove</button>
          </div>
          <table className="mt-1 w-full text-xs">
            <tbody>
              {slots.map((s, si) => {
                const d = v.adjustments.slotDeltas.find((x) => x.slotPosition === si);
                const setD = (nd: SlotDelta | null) => upd(i, (x) => ({ ...x, adjustments: { ...x.adjustments, slotDeltas: [...x.adjustments.slotDeltas.filter((y) => y.slotPosition !== si), ...(nd ? [nd] : [])] } }));
                return (
                  <tr key={si} className="border-b border-line/40 last:border-0">
                    <td className="py-1 pr-2">{s.name} <span className="font-mono text-[10px] text-mut">{s.quantity}</span></td>
                    <td className="py-1">
                      <span className="flex items-center gap-2">
                        <input type="number" step="any" placeholder="±0" value={d?.deltaQty ?? ""}
                          disabled={d?.removed ?? false}
                          onChange={(e) => setD({ slotPosition: si, deltaQty: e.target.value === "" ? null : Number(e.target.value), removed: false })}
                          className="w-16 rounded-md border border-line bg-panel2 px-1.5 py-0.5 text-right font-mono outline-none focus:border-accent" />
                        <label className="flex items-center gap-1 text-[11px] text-ink2">
                          <input type="checkbox" checked={d?.removed ?? false}
                            onChange={(e) => setD(e.target.checked ? { slotPosition: si, deltaQty: null, removed: true } : null)} /> removed
                        </label>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-1.5">
            {v.adjustments.extras.map((e, ei) => (
              <span key={ei} className="mr-2 inline-flex items-center gap-1.5 text-xs">
                + <MatSelect materials={materials} value={e.materialId}
                  onChange={(id) => upd(i, (x) => ({ ...x, adjustments: { ...x.adjustments, extras: x.adjustments.extras.map((y, k) => (k === ei ? { ...y, materialId: id } : y)) } }))} />
                <input type="number" step="any" value={e.quantity}
                  onChange={(ev) => upd(i, (x) => ({ ...x, adjustments: { ...x.adjustments, extras: x.adjustments.extras.map((y, k) => (k === ei ? { ...y, quantity: Number(ev.target.value) } : y)) } }))}
                  className="w-14 rounded-md border border-line bg-panel2 px-1.5 py-0.5 text-right font-mono text-xs outline-none" />
                <button onClick={() => upd(i, (x) => ({ ...x, adjustments: { ...x.adjustments, extras: x.adjustments.extras.filter((_, k) => k !== ei) } }))} className="text-mut hover:text-crit"><Trash2 size={11} /></button>
              </span>
            ))}
            <button onClick={() => upd(i, (x) => ({ ...x, adjustments: { ...x.adjustments, extras: [...x.adjustments.extras, { materialId: materials[0]?.id ?? 0, quantity: 1 }] } }))}
              className="rounded-md border border-dashed border-line px-2 py-0.5 text-[11px] text-accent hover:border-accent">+ extra material</button>
            <label className="ml-3 text-xs text-ink2">labor Δ
              <input type="number" value={v.adjustments.laborDeltaMinutes}
                onChange={(e) => upd(i, (x) => ({ ...x, adjustments: { ...x.adjustments, laborDeltaMinutes: Number(e.target.value) } }))}
                className="ml-1 w-14 rounded-md border border-line bg-panel2 px-1.5 py-0.5 text-right font-mono text-xs outline-none" /> min
            </label>
          </div>
        </div>
      ))}
      <button onClick={() => setList([...list, { id: null, name: "", adjustments: { slotDeltas: [], extras: [], laborDeltaMinutes: 0 } }])}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-sm text-accent hover:border-accent"><Plus size={14} /> variant</button>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={() => jput<ProductVariant[]>(`/api/v1/catalog/products/${productId}/variants`, list).then((r) => { setListRaw(r); setMsg("Saved."); }).catch((e) => setMsg(String(e)))}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:opacity-90">Save variants</button>
        {msg && <span className="text-xs text-ink2">{msg}</span>}
      </div>
    </div>
  );
}
