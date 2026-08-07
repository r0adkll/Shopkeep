import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Plus } from "lucide-react";
import { formatQty, materialColor, type Material } from "./api";
import { MaterialIcon } from "./MaterialIcon";
import { MaterialPickerDialog } from "./MaterialPickerDialog";

/* Purchasing panel (vault: locked 2026-08-07): need → ordered → received.
 * Lives on the Inventory dashboard where "Needs purchasing" was. Receiving
 * writes the PURCHASE ledger entry and updates the cost basis. */

type PanelNeed = { material: Material; suggestedQty: number; estCostMinor: number; purchaseId: number | null; daysLeft: number | null };
type PanelOnOrder = { id: number; material: Material; quantity: number; estCostMinor: number | null; orderedAt: string | null };
type Panel = { needs: PanelNeed[]; onOrder: PanelOnOrder[] };

const $ = (minor: number) => "$" + Math.round(minor / 100).toLocaleString();

async function post<T>(path: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v1/inventory/purchasing${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { message?: string } | null)?.message ?? r.statusText);
  return (await r.json()) as T;
}

/** Store label from the vendor link so one group = one checkout pass. */
function vendorOf(m: Material): { label: string; origin: string | null } {
  if (m.vendorUrl) {
    try {
      const u = new URL(m.vendorUrl);
      return { label: u.hostname.replace(/^(www|us\.store|store)\./, ""), origin: u.origin };
    } catch { /* fall through */ }
  }
  return { label: m.brand ?? "no vendor link", origin: null };
}

export function PurchasingPanel({ allMaterials, onOpenDetail }: { allMaterials: Material[]; onOpenDetail: (id: number) => void }) {
  const qc = useQueryClient();
  const panel = useQuery({
    queryKey: ["purchasing", "panel"],
    queryFn: () => post<Panel>("/panel", "GET"),
  });
  const refreshAll = (p: Panel) => {
    qc.setQueryData(["purchasing", "panel"], p);
    qc.invalidateQueries({ queryKey: ["materials"] });
  };
  const [err, setErr] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<number, number>>({}); // materialId -> chosen qty
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState<PanelOnOrder | null>(null);
  const [rcvQty, setRcvQty] = useState("");
  const [rcvCost, setRcvCost] = useState("");

  const act = (fn: () => Promise<Panel>) => {
    setErr(null);
    fn().then(refreshAll).catch((e: Error) => setErr(e.message));
  };

  const p = panel.data;
  if (!p || (p.needs.length === 0 && p.onOrder.length === 0)) return null;

  const qtyOf = (n: PanelNeed) => qty[n.material.id] ?? n.suggestedQty;
  const unitCost = (m: Material) => (m.costQuantity > 0 ? m.costMinor / m.costQuantity : 0);
  const estOf = (n: PanelNeed) => Math.round(unitCost(n.material) * qtyOf(n));
  const totalEst = p.needs.reduce((a, n) => a + estOf(n), 0);

  // vendor groups, most-urgent group first (needs arrive urgency-sorted)
  const groups: { label: string; origin: string | null; rows: PanelNeed[] }[] = [];
  for (const n of p.needs) {
    const v = vendorOf(n.material);
    const g = groups.find((x) => x.label === v.label);
    if (g) g.rows.push(n);
    else groups.push({ label: v.label, origin: v.origin, rows: [n] });
  }

  return (
    <section className="mt-8">
      <h2 className="mb-1 flex flex-wrap items-baseline gap-x-3 text-[13px] font-bold tracking-widest uppercase text-ink2">
        Purchasing
        <span className="font-mono text-xs font-normal tracking-normal text-mut">
          {p.needs.length > 0 && <>{p.needs.length} to buy · est. {$(totalEst)}</>}
          {p.needs.length > 0 && p.onOrder.length > 0 && " · "}
          {p.onOrder.length > 0 && <>{p.onOrder.length} on order</>}
        </span>
        <button type="button" onClick={() => setAdding(true)}
          className="ml-auto flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] font-semibold tracking-normal normal-case text-ink2 hover:border-accent hover:text-accent">
          <Plus size={12} /> add to list
        </button>
      </h2>
      {err && <p className="mb-1 text-xs font-medium text-crit">{err}</p>}

      <div className="rounded-xl border border-line bg-panel shadow-sm">
        {groups.map((g, gi) => (
          <div key={g.label} className={gi > 0 ? "border-t border-line" : ""}>
            <div className="flex items-baseline gap-2.5 px-4 pt-2.5 pb-1">
              <b className="text-[12.5px]">{g.label}</b>
              <span className="text-[11px] text-mut">
                {g.rows.length} item{g.rows.length > 1 ? "s" : ""} · est. {$(g.rows.reduce((a, n) => a + estOf(n), 0))}
              </span>
              {g.origin && (
                <a href={g.origin} target="_blank" rel="noreferrer" className="ml-auto text-[11px] font-semibold text-accent hover:underline">
                  open store ↗
                </a>
              )}
            </div>
            {g.rows.map((n) => {
              const m = n.material;
              const color = materialColor(m);
              return (
                <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2 hover:bg-accent/5">
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg border border-line"
                    style={{ background: color ? `color-mix(in srgb, ${color} 16%, transparent)` : "var(--color-panel2)" }}>
                    <MaterialIcon category={m.category} type={m.type} size={14} style={{ color: color ?? "var(--color-ink2)" }} />
                  </span>
                  <button type="button" onClick={() => onOpenDetail(m.id)} className="min-w-0 text-left hover:underline">
                    <b className="block text-[13px] leading-tight">{m.name}</b>
                    <span className="text-[10.5px] text-mut">{m.brand ?? m.type}</span>
                  </button>
                  {n.purchaseId != null ? (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[9px] font-extrabold tracking-wider text-accent">QUEUED</span>
                  ) : (
                    <span className={`text-[10px] font-extrabold tracking-wider ${m.status === "CRITICAL" ? "text-crit" : "text-warn"}`}>
                      {m.status === "CRITICAL" ? "CRITICAL" : "LOW"}
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-ink2">
                    {formatQty(m.stock.available)} {m.unit} left
                    {n.daysLeft != null && <b className={n.daysLeft <= 10 ? "text-crit" : "text-warn"}> · ~{Math.round(n.daysLeft)} d</b>}
                    {m.lowStockThreshold != null && <span className="text-mut"> · thr {formatQty(m.lowStockThreshold)}</span>}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <span className="flex items-center gap-1 font-mono text-xs">
                      <button type="button" onClick={() => setQty({ ...qty, [m.id]: Math.max(n.suggestedQty, qtyOf(n) - n.suggestedQty) })}
                        className="h-5 w-5 rounded border border-line leading-none text-ink2 hover:border-accent hover:text-accent">−</button>
                      {formatQty(qtyOf(n))} {m.unit}
                      <button type="button" onClick={() => setQty({ ...qty, [m.id]: qtyOf(n) + n.suggestedQty })}
                        className="h-5 w-5 rounded border border-line leading-none text-ink2 hover:border-accent hover:text-accent">+</button>
                    </span>
                    <span className="w-12 text-right font-mono text-xs text-ink2">{$(estOf(n))}</span>
                    {m.vendorUrl && (
                      <a href={m.vendorUrl} target="_blank" rel="noreferrer" title="open the product page"
                        className="flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline">
                        buy <ExternalLink size={11} />
                      </a>
                    )}
                    <button type="button"
                      onClick={() => act(() =>
                        n.purchaseId != null
                          ? post<Panel>(`/${n.purchaseId}`, "DELETE").then(() =>
                              post<Panel>("", "POST", { materialId: m.id, quantity: qtyOf(n), estCostMinor: estOf(n), ordered: true }))
                          : post<Panel>("", "POST", { materialId: m.id, quantity: qtyOf(n), estCostMinor: estOf(n), ordered: true }))}
                      className="rounded-md border border-accent/50 px-2.5 py-1 text-[11px] font-bold text-accent hover:bg-accent/5">
                      ordered ✓
                    </button>
                    {n.purchaseId != null && (
                      <button type="button" onClick={() => act(() => post<Panel>(`/${n.purchaseId}`, "DELETE"))}
                        className="text-[11px] text-mut hover:text-ink" title="remove from list">✕</button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}

        {p.onOrder.length > 0 && (
          <div className={groups.length > 0 ? "border-t border-line" : ""}>
            <div className="px-4 pt-2.5 pb-1 text-[10.5px] font-bold tracking-widest uppercase text-mut">On order</div>
            {p.onOrder.map((o) => {
              const color = materialColor(o.material);
              const when = o.orderedAt ? new Date(o.orderedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
              return (
                <div key={o.id} className="flex flex-wrap items-center gap-3 border-t border-line/60 px-4 py-2">
                  <span className="h-4 w-4 flex-none rounded-md border border-line" style={{ background: color ?? "var(--color-panel2)" }} />
                  <span className="min-w-0">
                    <b className="block text-[13px] leading-tight">{o.material.name}</b>
                    <span className="text-[10.5px] text-mut">
                      {formatQty(o.quantity)} {o.material.unit}{o.estCostMinor != null && ` · ~${$(o.estCostMinor)}`}{when && ` · ordered ${when}`}
                    </span>
                  </span>
                  <span className="rounded-full bg-good/10 px-2 py-0.5 text-[9px] font-extrabold tracking-wider text-good">ON ORDER</span>
                  <span className="ml-auto flex items-center gap-2">
                    <button type="button"
                      onClick={() => { setReceiving(o); setRcvQty(String(o.quantity)); setRcvCost(o.estCostMinor != null ? (o.estCostMinor / 100).toFixed(2) : ""); }}
                      className="rounded-md bg-accent px-3 py-1 text-[11px] font-bold text-white hover:opacity-90">
                      Arrived — receive
                    </button>
                    <button type="button" onClick={() => act(() => post<Panel>(`/${o.id}`, "DELETE"))}
                      className="rounded-md border border-line px-2.5 py-1 text-[11px] font-semibold text-ink2 hover:border-accent hover:text-accent">
                      didn't order
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {adding && (
        <MaterialPickerDialog
          all={allMaterials}
          title="Add to the shopping list"
          onPick={(id) => {
            const m = allMaterials.find((x) => x.id === id);
            const q = m?.reorderQuantity ?? m?.fullQuantity ?? m?.lowStockThreshold ?? 1;
            act(() => post<Panel>("", "POST", { materialId: id, quantity: q, ordered: false }));
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      )}

      {receiving && (
        <>
          <div className="fixed inset-0 z-40 bg-black/35" onClick={() => setReceiving(null)} />
          <div className="fixed inset-x-0 top-28 z-50 mx-auto w-[min(420px,94vw)] rounded-2xl border border-line bg-bg p-5 shadow-2xl">
            <b className="text-[15px]">Receive — {receiving.material.name}</b>
            <p className="mt-1 text-xs text-mut">
              Writes one PURCHASE ledger entry; the cost updates the material's cost basis if the price changed.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block text-xs">
                <span className="mb-1 block font-semibold tracking-widest uppercase text-mut">Qty received ({receiving.material.unit})</span>
                <input value={rcvQty} onChange={(e) => setRcvQty(e.target.value)} inputMode="decimal" autoFocus
                  className="w-full rounded-md border border-line bg-panel2 px-3 py-1.5 font-mono text-sm outline-none focus:border-accent" />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-semibold tracking-widest uppercase text-mut">Actual cost ($, opt.)</span>
                <input value={rcvCost} onChange={(e) => setRcvCost(e.target.value)} inputMode="decimal"
                  className="w-full rounded-md border border-line bg-panel2 px-3 py-1.5 font-mono text-sm outline-none focus:border-accent" />
              </label>
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" disabled={!(parseFloat(rcvQty) > 0)}
                onClick={() => {
                  const body = {
                    quantity: parseFloat(rcvQty),
                    costMinor: rcvCost.trim() ? Math.round(parseFloat(rcvCost) * 100) : null,
                  };
                  act(() => post<Panel>(`/${receiving.id}/receive`, "POST", body));
                  setReceiving(null);
                }}
                className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                Receive into stock
              </button>
              <button type="button" onClick={() => setReceiving(null)} className="rounded-md border border-line px-3 py-1.5 text-xs text-ink2">cancel</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
