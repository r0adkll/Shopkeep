import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatCost, formatQty, inventoryApi, materialColor, parseQtyAs, type Forecast, type LedgerEntry as LedgerEntryT, type TxnKind } from "./api";
import { Archive, ArchiveRestore, Scale, Trash2, X } from "lucide-react";
import { MaterialIcon } from "./MaterialIcon";
import { WeighInSheet } from "./WeighInSheet";
import { Button, ErrorText, Field } from "../ui";

/** Detail drawer: ledger history chart (step line straight from the ledger),
 *  stock numbers, and the manual adjust/receive flow. */
export function MaterialDetailDrawer({
  id,
  onClose,
  onEdit,
}: {
  id: number;
  onClose: () => void;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["material", id], queryFn: () => inventoryApi.material(id) });
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const archiveMut = useMutation({
    mutationFn: (archived: boolean) => inventoryApi.setArchived(id, archived),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["materials"] });
      qc.invalidateQueries({ queryKey: ["material", id] });
    },
  });
  const deleteMut = useMutation({
    mutationFn: () => inventoryApi.deleteMaterial(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["materials"] });
      onClose();
    },
    onError: (e) => setRemoveError(e instanceof Error ? e.message.replace(/^\d+\s*/, "") : "Delete failed."),
  });

  const [delta, setDelta] = useState("");
  const [kind, setKind] = useState<TxnKind>("PURCHASE");
  const [note, setNote] = useState("");
  const [weighing, setWeighing] = useState(false);

  const transact = useMutation({
    mutationFn: () => {
      const d = parseQtyAs(detail.data?.material.unit ?? "", delta) ?? NaN;
      const signed = kind === "CONSUMPTION" ? -Math.abs(d) : d;
      return inventoryApi.transact(id, signed, kind, note || undefined);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["material", id], data);
      queryClient.invalidateQueries({ queryKey: ["materials"] });
      setDelta("");
      setNote("");
    },
  });

  if (!detail.data) return null;
  const { material: m, ledger, forecast } = detail.data;
  const color = materialColor(m);

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-xl overflow-y-auto border-l border-line bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start gap-3.5">
          <span
            className="flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-line"
            style={{ background: color ? `color-mix(in srgb, ${color} 14%, transparent)` : "var(--color-panel2)" }}
          >
            <MaterialIcon category={m.category} type={m.type} size={22} style={{ color: color ?? "var(--color-ink2)" }} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 truncate text-lg leading-tight font-semibold">{m.name}</h2>
              {m.brand && (
                <span className="flex-none rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-extrabold tracking-wider text-accent uppercase">
                  {m.brand}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-mut">
              <span className="capitalize">{m.category}</span> · {m.type} · {formatCost(m)}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            {m.vendorUrl && (
              <a
                href={m.vendorUrl}
                target="_blank"
                rel="noreferrer"
                title={m.reorderQuantity != null ? `Reorder ${formatQty(m.reorderQuantity)} ${m.unit} — ${m.vendorUrl}` : m.vendorUrl}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-white hover:opacity-90"
              >
                Order ↗
              </a>
            )}
            {m.category === "filament" && !m.archived && (
              <button type="button" onClick={() => setWeighing(true)} title="Put the spool on a scale — Shopkeep does the tare math"
                className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-ink2 hover:border-accent hover:text-ink">
                <Scale size={14} /> Weigh in
              </button>
            )}
            <button type="button" onClick={onEdit} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink2 hover:border-accent hover:text-ink">
              Edit
            </button>
            <button type="button" onClick={onClose} title="close" className="rounded-md p-1.5 text-mut hover:bg-panel2 hover:text-ink">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="mb-5 grid grid-cols-3 rounded-xl border border-line bg-panel2">
          {(
            [
              ["On hand", m.stock.onHand],
              ["Reserved", m.stock.reserved],
              ["Available", m.stock.available],
            ] as const
          ).map(([label, v], i) => (
            <div key={label} className={`px-4 py-3 ${i > 0 ? "border-l border-line" : ""}`}>
              <div className="text-[10.5px] tracking-widest uppercase text-mut">{label}</div>
              <div className="font-mono text-lg font-semibold">
                {formatQty(v)} <span className="text-xs font-normal text-mut">{m.unit}</span>
              </div>
            </div>
          ))}
        </div>

        {forecast && (
          <div className={`mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xl px-4 py-2.5 text-[12.5px] ${new Date(forecast.orderByDate) <= new Date() ? "bg-crit/10 text-crit" : "bg-warn/10 text-warn"}`}>
            <span>
              burning <b className="font-mono">{forecast.ratePerDay >= 10 ? Math.round(forecast.ratePerDay) : forecast.ratePerDay.toFixed(1)} {m.unit}/day</b>
              {" "}→ runs out <b>{new Date(forecast.runOutDate + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</b>
              {" "}(~{Math.round(forecast.daysLeft)} d)
            </span>
            <span className="font-semibold">
              {new Date(forecast.orderByDate) <= new Date() ? "order now" : `order by ${new Date(forecast.orderByDate + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
              <span className="ml-1 font-normal opacity-75">({forecast.leadTimeDays} d lead time)</span>
            </span>
          </div>
        )}
        <HistoryChart ledger={ledger} threshold={m.lowStockThreshold} forecast={forecast} />

        <form
          className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-panel2 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            transact.mutate();
          }}
        >
          <label className="block">
            <span className="mb-1 block text-xs font-semibold tracking-widest uppercase text-mut">Action</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as TxnKind)}
              className="rounded-md border border-line bg-panel px-3 py-2"
            >
              <option value="PURCHASE">Receive purchase (+)</option>
              <option value="CONSUMPTION">Use / consume (−)</option>
              <option value="ADJUSTMENT">Adjust (recount, ±)</option>
            </select>
          </label>
          <div className="w-28">
            <Field label={`Qty (${m.unit})`} value={delta} onChange={setDelta} />
          </div>
          <div className="min-w-40 flex-1">
            <Field label="Note" value={note} onChange={setNote} />
          </div>
          <div className="w-32">
            <Button disabled={transact.isPending || !parseQtyAs(m.unit, delta)}>Record</Button>
          </div>
          <div className="w-full">
            <ErrorText>{transact.error?.message}</ErrorText>
          </div>
        </form>

        <h3 className="mt-6 mb-2 text-xs font-bold tracking-widest uppercase text-ink2">Ledger</h3>
        <ul className="divide-y divide-line text-sm">
          {[...ledger].reverse().map((e) => (
            <li key={e.id} className="flex items-baseline gap-3 py-2">
              <span className={`font-mono font-semibold ${e.delta < 0 ? "text-crit" : "text-good"}`}>
                {e.delta > 0 ? "+" : ""}
                {formatQty(e.delta)}
              </span>
              <span className="text-[11px] tracking-wider text-mut uppercase">{e.kind.toLowerCase()}</span>
              <span className="min-w-0 flex-1 truncate text-ink2">{e.note}</span>
              <span className="font-mono text-xs text-mut">
                → {formatQty(e.runningOnHand)} {m.unit}
              </span>
            </li>
          ))}
          {ledger.length === 0 && <li className="py-2 text-mut">No ledger entries yet.</li>}
        </ul>

        {/* remove: archive hides from active views (history kept); delete only
            works when nothing references the material */}
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <button
            type="button"
            onClick={() => archiveMut.mutate(!m.archived)}
            disabled={archiveMut.isPending}
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-ink2 hover:border-accent hover:text-ink"
          >
            {m.archived ? <><ArchiveRestore size={14} /> Unarchive</> : <><Archive size={14} /> Archive</>}
          </button>
          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => { setConfirmDelete(true); setRemoveError(null); }}
              className="flex items-center gap-1.5 rounded-md border border-crit/40 px-3 py-1.5 text-sm text-crit hover:border-crit hover:bg-crit/10"
            >
              <Trash2 size={14} /> Delete…
            </button>
          ) : (
            <span className="flex items-center gap-2 rounded-lg border border-crit/40 bg-crit/5 px-3 py-1.5">
              <span className="text-xs font-semibold text-crit">Permanently delete {m.name}?</span>
              <button type="button" onClick={() => deleteMut.mutate()} disabled={deleteMut.isPending}
                className="rounded-md bg-crit px-2.5 py-1 text-xs font-bold text-white">
                {deleteMut.isPending ? "Deleting…" : "Delete"}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-xs text-ink2 hover:text-ink">cancel</button>
            </span>
          )}
          {m.archived && <span className="rounded-full bg-line/60 px-2 py-0.5 text-[10px] font-extrabold tracking-wider text-mut">ARCHIVED</span>}
          {removeError && <span className="text-xs font-medium text-crit">{removeError}</span>}
        </div>
      </div>
      {weighing && (
        // stop clicks bubbling to the drawer's close-on-overlay handler
        <div onClick={(e) => e.stopPropagation()}>
          <WeighInSheet material={m} onRecorded={() => setWeighing(false)} onClose={() => setWeighing(false)} />
        </div>
      )}
    </div>
  );
}

/** Time-based step history with the locked concept's forecast payload: dashed
 *  depletion line to the trend's zero crossing and the order-by marker
 *  (run-out minus lead time) — the chart's actionable date. */
function HistoryChart({ ledger, threshold, forecast }: { ledger: LedgerEntryT[]; threshold: number | null; forecast: Forecast | null }) {
  const pts = ledger
    .filter((e) => e.createdAt)
    .map((e) => ({ t: new Date(e.createdAt!).getTime(), v: e.runningOnHand }));
  if (pts.length < 2) return null;
  const W = 560, H = 130, pad = 8, padB = 16;
  const now = Date.now();
  const tEnd = forecast ? new Date(forecast.runOutDate + "T12:00").getTime() : now;
  const t0 = pts[0].t;
  const span = Math.max(tEnd - t0, 1);
  const max = Math.max(...pts.map((p) => p.v), threshold ?? 0) * 1.08 || 1;
  const x = (t: number) => pad + ((t - t0) / span) * (W - pad * 2);
  const y = (v: number) => H - padB - (v / max) * (H - padB - pad);
  let d = `M ${x(pts[0].t)} ${y(0)} L ${x(pts[0].t)} ${y(pts[0].v)}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${x(pts[i].t)} ${y(pts[i - 1].v)} L ${x(pts[i].t)} ${y(pts[i].v)}`;
  const last = pts[pts.length - 1];
  d += ` L ${x(now)} ${y(last.v)}`;
  const orderBy = forecast ? new Date(forecast.orderByDate + "T12:00").getTime() : null;
  const fmtD = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-line bg-panel2" aria-label="Stock history and depletion forecast">
      {threshold != null && (
        <line x1={pad} x2={W - pad} y1={y(threshold)} y2={y(threshold)} stroke="var(--color-crit)" strokeWidth="1.5" strokeDasharray="2 5" opacity="0.7" />
      )}
      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" />
      {forecast && (
        <>
          <line x1={x(now)} y1={y(last.v)} x2={x(tEnd)} y2={y(0)} stroke="var(--color-accent)" strokeWidth="1.8" strokeDasharray="4 4" opacity="0.65" />
          <text x={Math.min(x(tEnd), W - pad) - 2} y={y(0) - 4} textAnchor="end" fontSize="8.5" fill="var(--color-mut)" fontFamily="var(--font-mono)">
            {fmtD(tEnd)}
          </text>
          {orderBy != null && orderBy > t0 && (
            <>
              <line x1={x(orderBy)} x2={x(orderBy)} y1={pad} y2={H - padB} stroke="var(--color-warn)" strokeWidth="1.5" strokeDasharray="3 3" />
              <text x={x(orderBy)} y={H - 4} textAnchor="middle" fontSize="8.5" fontWeight="700" fill="var(--color-warn)" fontFamily="var(--font-mono)">
                order by {fmtD(orderBy)}
              </text>
            </>
          )}
        </>
      )}
      <circle cx={x(now)} cy={y(last.v)} r="4" fill="var(--color-accent)" />
      <text x={pad} y={H - 4} fontSize="8.5" fill="var(--color-mut)" fontFamily="var(--font-mono)">{fmtD(t0)}</text>
    </svg>
  );
}
