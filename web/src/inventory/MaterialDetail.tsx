import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatCost, formatQty, inventoryApi, materialColor, type TxnKind } from "./api";
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

  const [delta, setDelta] = useState("");
  const [kind, setKind] = useState<TxnKind>("PURCHASE");
  const [note, setNote] = useState("");

  const transact = useMutation({
    mutationFn: () => {
      const d = parseFloat(delta);
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
  const { material: m, ledger } = detail.data;
  const color = materialColor(m);

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-xl overflow-y-auto border-l border-line bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-3">
          <span className="h-8 w-8 rounded-lg border border-line" style={{ background: color ?? "var(--color-panel2)" }} />
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{m.name}</h2>
            <p className="text-xs text-mut">
              {m.category} · {m.type} · {formatCost(m)}
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            {m.vendorUrl && (
              <a
                href={m.vendorUrl}
                target="_blank"
                rel="noreferrer"
                title={m.vendorUrl}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90"
              >
                Order{m.reorderQuantity != null ? ` ${formatQty(m.reorderQuantity)} ${m.unit}` : ""} ↗
              </a>
            )}
            <button type="button" onClick={onEdit} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink2 hover:text-ink">
              Edit
            </button>
            <button type="button" onClick={onClose} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink2 hover:text-ink">
              Close
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

        <HistoryChart points={ledger.map((e) => e.runningOnHand)} threshold={m.lowStockThreshold} />

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
            <Button disabled={transact.isPending || !parseFloat(delta)}>Record</Button>
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
      </div>
    </div>
  );
}

function HistoryChart({ points, threshold }: { points: number[]; threshold: number | null }) {
  if (points.length < 2) return null;
  const W = 560;
  const H = 120;
  const pad = 6;
  const series = [0, ...points];
  const max = Math.max(...series, threshold ?? 0) * 1.08 || 1;
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  // Step path: horizontal to the next x, then vertical — purchases read as cliffs.
  let d = `M ${x(0)} ${y(series[0])}`;
  for (let i = 1; i < series.length; i++) d += ` L ${x(i)} ${y(series[i - 1])} L ${x(i)} ${y(series[i])}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-line bg-panel2" aria-label="Stock history">
      {threshold != null && (
        <line x1={pad} x2={W - pad} y1={y(threshold)} y2={y(threshold)} stroke="var(--color-crit)" strokeWidth="1.5" strokeDasharray="2 5" opacity="0.7" />
      )}
      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" />
      <circle cx={x(series.length - 1)} cy={y(series[series.length - 1])} r="4" fill="var(--color-accent)" />
    </svg>
  );
}
