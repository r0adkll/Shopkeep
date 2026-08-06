import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatQty, inventoryApi, materialColor, type Material } from "./api";

/** Weigh-in bottom sheet (vault: Inventory UX, locked 2026-08-06): spool on
 *  the scale → gross grams → minus tare → one ADJUSTMENT event. Tare is
 *  one-time setup, saved to the material. Manual entry is the whole MVP —
 *  a connected bench scale would only ever fill the same field. */

/** Drift severity vs. spool size: ≤3% quiet match, ≤10% drift, beyond = check. */
export function driftBand(deltaAbs: number, full: number): ["good" | "warn" | "crit", string] {
  const p = deltaAbs / (full || 1000);
  if (p <= 0.03) return ["good", "MATCHES"];
  if (p <= 0.1) return ["warn", "DRIFT"];
  return ["crit", "CHECK SPOOL"];
}

const NEAR_EMPTY_G = 30;

export function WeighInSheet({
  material: m,
  onRecorded,
  onSkip,
  onClose,
}: {
  material: Material;
  onRecorded: (measured: number, delta: number) => void;
  /** Present only during an audit session. */
  onSkip?: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const savedTare = parseFloat(m.attributes.spoolWeightGrams ?? "");
  const [tare, setTare] = useState<number | null>(Number.isFinite(savedTare) ? savedTare : null);
  const [tareEdited, setTareEdited] = useState(false);
  const [tareInput, setTareInput] = useState("");
  const [editingTare, setEditingTare] = useState(!Number.isFinite(savedTare));
  const [gross, setGross] = useState("");
  const [markEmpty, setMarkEmpty] = useState(false);

  // Multi-spool holdings: the scale only sees the open spool — whole
  // spool-sizes below on-hand are assumed sealed and untouched. The count is
  // editable in case reality differs (two spools open, one gifted away…).
  const fullSize = m.fullQuantity && m.fullQuantity > 0 ? m.fullQuantity : 1000;
  const defaultSealed = m.stock.onHand > fullSize ? Math.ceil(m.stock.onHand / fullSize) - 1 : 0;
  const [sealedCount, setSealedCount] = useState(defaultSealed);
  const sealedGrams = sealedCount * fullSize;
  const openExpected = Math.max(0, m.stock.onHand - sealedGrams);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const g = parseFloat(gross);
  const measured = tare != null && Number.isFinite(g) ? Math.max(0, g - tare) : null;
  // Drift is judged against the OPEN spool only — sealed spools ride along.
  const delta = measured != null ? measured - openExpected : null;
  const [tone, label] = delta != null ? driftBand(Math.abs(delta), fullSize) : ["good", ""];
  const nearEmpty = measured != null && measured <= NEAR_EMPTY_G && sealedCount === 0;
  const isBambu = (m.brand ?? "").toLowerCase().includes("bambu");

  const record = useMutation({
    mutationFn: () =>
      inventoryApi.weighIn(m.id, {
        grossGrams: g,
        tareGrams: tare!,
        sealedGrams,
        saveTare: tareEdited,
        markEmpty: nearEmpty && markEmpty,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["materials"] });
      qc.invalidateQueries({ queryKey: ["material", m.id] });
      onRecorded(measured!, delta!);
    },
  });

  const pickTare = (v: number) => {
    if (!Number.isFinite(v) || v < 0) return;
    setTare(v);
    setTareEdited(true);
    setEditingTare(false);
  };

  const color = materialColor(m);
  const toneText = { good: "text-good", warn: "text-warn", crit: "text-crit" }[tone as "good" | "warn" | "crit"];
  const toneBg = { good: "bg-good/10", warn: "bg-warn/10", crit: "bg-crit/10" }[tone as "good" | "warn" | "crit"];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/35" onClick={onClose} />
      <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center">
        <div className="w-[min(560px,100vw)] rounded-t-2xl border border-b-0 border-line bg-panel p-5 pb-7 shadow-2xl">
          <div className="flex items-baseline gap-2.5">
            <span className="h-5 w-5 flex-none self-center rounded-md border border-line" style={{ background: color ?? "var(--color-panel2)" }} />
            <b className="min-w-0 flex-1 truncate text-[15px]">{m.name}</b>
            <span className="flex-none text-[11px] text-mut">
              on the open spool: <b className="font-mono text-ink">{formatQty(openExpected)} g</b>
              {m.stock.reserved > 0 && <> · {formatQty(m.stock.reserved)} g reserved (unaffected)</>}
            </span>
          </div>

          <div className="mt-3.5 flex items-center gap-2.5">
            <input
              autoFocus
              value={gross}
              onChange={(e) => setGross(e.target.value)}
              inputMode="decimal"
              placeholder="spool on scale…"
              className="min-w-0 flex-1 rounded-xl border-[1.5px] border-line bg-panel2 px-3.5 py-2 font-mono text-[26px] font-bold outline-none placeholder:text-[15px] placeholder:font-sans placeholder:font-normal placeholder:text-mut focus:border-accent"
            />
            <span className="flex-none text-sm font-bold text-mut">g gross</span>
          </div>

          {editingTare ? (
            <div className="mt-3 rounded-xl border border-dashed border-line bg-panel2 px-3.5 py-3 text-[12.5px]">
              <b>{tare == null ? "No tare on file for this spool." : "Re-measure the empty spool weight."}</b>{" "}
              <span className="text-ink2">One-time setup — after this it's automatic:</span>
              <div className="mt-2 flex flex-wrap items-center gap-2.5">
                {isBambu && (
                  <button type="button" onClick={() => pickTare(250)}
                    className="rounded-md border border-line px-2.5 py-1 text-xs font-semibold text-ink2 hover:border-accent hover:text-accent">
                    use 250 g (standard Bambu spool)
                  </button>
                )}
                <span className="flex items-center gap-1.5 text-ink2">
                  {isBambu ? "or " : ""}empty spool weighs
                  <input value={tareInput} onChange={(e) => setTareInput(e.target.value)} inputMode="decimal" placeholder="g"
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); pickTare(parseFloat(tareInput)); } }}
                    className="w-16 rounded-md border border-line bg-panel px-2 py-1 text-right font-mono text-xs outline-none focus:border-accent" />
                  <button type="button" onClick={() => pickTare(parseFloat(tareInput))}
                    className="rounded-md border border-accent/40 px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent/5">
                    save
                  </button>
                  {tare != null && (
                    <button type="button" onClick={() => setEditingTare(false)} className="text-xs text-mut hover:text-ink">cancel</button>
                  )}
                </span>
              </div>
            </div>
          ) : (
            <div className="mt-3 grid gap-1 border-t border-dotted border-line pt-2.5 text-[13px]">
              {(defaultSealed > 0 || sealedCount > 0) && (
                <div className="flex justify-between gap-3">
                  <span className="text-ink2">sealed spools — assumed untouched</span>
                  <span className="flex items-center gap-1.5 font-mono">
                    <button type="button" onClick={() => setSealedCount(Math.max(0, sealedCount - 1))}
                      className="rounded border border-line px-1.5 text-xs text-ink2 hover:border-accent hover:text-accent">−</button>
                    {sealedCount} × {formatQty(fullSize)} g
                    <button type="button" onClick={() => setSealedCount(sealedCount + 1)}
                      className="rounded border border-line px-1.5 text-xs text-ink2 hover:border-accent hover:text-accent">+</button>
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span className="text-ink2">tare — {tareEdited ? "set this session" : "on file"}</span>
                <span className="font-mono">
                  − {formatQty(tare!)} g{" "}
                  <button type="button" onClick={() => { setTareInput(String(tare)); setEditingTare(true); }}
                    className="text-[11px] font-semibold text-accent hover:underline" title="re-measure the empty spool">
                    edit
                  </button>
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-ink2">on the open spool</span>
                <span className="font-mono">{measured != null ? `= ${formatQty(measured)} g` : "—"}</span>
              </div>
              {sealedGrams > 0 && measured != null && (
                <div className="flex justify-between gap-3">
                  <span className="text-ink2">new total (open + sealed)</span>
                  <span className="font-mono">{formatQty(measured + sealedGrams)} g</span>
                </div>
              )}
            </div>
          )}

          {delta != null && !editingTare && (
            <div className={`mt-3 flex flex-wrap items-baseline gap-2 rounded-xl px-3.5 py-2.5 text-[13px] ${toneBg} ${toneText}`}>
              <b className="text-[15px]">{delta === 0 ? "±0 g" : `${delta > 0 ? "+" : "−"}${formatQty(Math.abs(delta))} g`}</b>
              <span>
                {label === "MATCHES" ? `matches the ledger${sealedGrams > 0 ? "'s open spool" : ""}` :
                  label === "DRIFT" ? `vs. the ${sealedGrams > 0 ? "open spool — " : "ledger — "}the adjustment will correct it` :
                    "big gap vs. the open spool — wrong spool, wrong sealed count, or usage never logged?"}
              </span>
              {nearEmpty && (
                <label className="flex w-full items-center gap-1.5 text-[12px] font-medium">
                  <input type="checkbox" checked={markEmpty} onChange={(e) => setMarkEmpty(e.target.checked)} className="accent-accent" />
                  nearly empty — also mark empty &amp; archive this spool
                </label>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={measured == null || editingTare || record.isPending}
              onClick={() => record.mutate()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-45"
            >
              {record.isPending ? "Recording…" : "Record adjustment"}
            </button>
            {onSkip && (
              <button type="button" onClick={onSkip} className="rounded-lg border border-line px-3.5 py-2 text-sm font-semibold text-ink2 hover:border-accent hover:text-accent">
                Skip
              </button>
            )}
            <button type="button" onClick={onClose} className="rounded-lg border border-line px-3.5 py-2 text-sm font-semibold text-ink2 hover:border-accent hover:text-accent">
              Close
            </button>
            {record.isError && <span className="text-xs font-medium text-crit">{record.error.message}</span>}
          </div>
          <p className="mt-2.5 text-[11px] text-mut">
            Writes one adjustment event — reserved stock is untouched; gauges update instantly.
          </p>
        </div>
      </div>
    </>
  );
}
