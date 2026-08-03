import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RotateCw, X } from "lucide-react";

/* D17 review & push (locked concept 2026-08-03): grouped change list, one
 * field per line, all-or-nothing push; drift rows carry the only escape
 * hatch (pull Etsy's value into Shopkeep). Push order: inventory ->
 * details -> state. */

type Change = { section: string; field: string; oldValue: string | null; newValue: string | null; kind: string; note: string | null };
type Preview = {
  listingId: number; etsyListingId: string | null; changes: Change[];
  driftCount: number; renewal: boolean; comboCount: number; canPush: boolean; blockedReason: string | null;
};

const KIND_CHIP: Record<string, [string, string]> = {
  added: ["ADDED", "bg-good/10 text-good"],
  changed: ["CHANGED", "bg-accent/10 text-accent"],
  removed: ["REMOVED", "bg-crit/10 text-crit"],
  drift: ["DRIFT — ETSY CHANGED THIS", "bg-warn/10 text-warn"],
};
const PULLABLE = new Set(["Title", "Description", "Price", "Quantity", "Tags", "State"]);

export function PushReview({ listingId, onClose, onPushed }: { listingId: number; onClose: () => void; onPushed: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushed, setPushed] = useState(false);

  const load = useCallback(async () => {
    setPreview(null);
    setError(null);
    const r = await fetch(`/api/v1/listings/${listingId}/push-preview`);
    if (!r.ok) setError(await r.text());
    else setPreview(await r.json());
  }, [listingId]);
  useEffect(() => { load(); }, [load]);

  const pull = async (field: string) => {
    setBusy(true);
    await fetch(`/api/v1/listings/${listingId}/pull-field`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field }),
    });
    setBusy(false);
    load();
  };

  const push = async () => {
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/v1/listings/${listingId}/push`, { method: "POST" });
    const j = await r.json().catch(() => null);
    setBusy(false);
    if (r.ok) { setPushed(true); onPushed(); }
    else setError(j?.error ?? "Push failed.");
  };

  const sections = ["details", "variations"];
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div className="fixed inset-x-0 top-8 bottom-8 z-50 mx-auto flex w-[min(760px,94vw)] flex-col rounded-2xl border border-line bg-bg shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <span className="text-[15px] font-bold">Review & push to Etsy</span>
          {preview && (
            <>
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[9px] font-extrabold tracking-wider text-accent">{preview.changes.length} CHANGES</span>
              {preview.driftCount > 0 && <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[9px] font-extrabold tracking-wider text-warn">{preview.driftCount} DRIFT</span>}
            </>
          )}
          <button onClick={onClose} className="ml-auto rounded-md border border-line p-1 text-ink2 hover:text-ink"><X size={15} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!preview && !error && (
            <p className="flex items-center gap-2 py-8 text-sm text-ink2"><Loader2 size={15} className="animate-spin text-accent" /> Fetching the listing from Etsy to diff…</p>
          )}
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-crit/40 bg-crit/5 px-4 py-2.5 text-sm text-crit">
              <AlertTriangle size={14} /> {error}
              <button onClick={load} className="ml-auto flex items-center gap-1 rounded-md border border-crit/40 px-2 py-1 text-xs font-bold"><RotateCw size={11} /> Retry</button>
            </div>
          )}
          {preview?.blockedReason && (
            <div className="mb-3 rounded-lg border border-crit/40 bg-crit/5 px-4 py-2.5 text-sm font-semibold text-crit">{preview.blockedReason}</div>
          )}
          {preview?.renewal && (
            <div className="mb-3 rounded-lg border border-dashed border-warn bg-warn/10 px-4 py-2.5 text-sm text-warn">
              <b>Renewal:</b> Etsy has this listing sold out. This push renews it — <b>$0.20 fee</b>. Quantities go first so the renewal takes the new stock.
            </div>
          )}
          {preview && preview.changes.length === 0 && !preview.blockedReason && (
            <p className="py-6 text-center text-sm text-ink2">In sync — nothing to push.</p>
          )}
          {preview && sections.map((sec) => {
            const rows = preview.changes.filter((c) => c.section === sec);
            if (rows.length === 0) return null;
            return (
              <div key={sec} className="mb-4 rounded-xl border border-line bg-panel p-4 shadow-sm">
                <div className="mb-1.5 text-[10px] font-extrabold tracking-widest text-mut uppercase">
                  {sec} <span className="font-mono">{rows.length}</span>
                  {sec === "variations" && <span className="ml-2 font-semibold tracking-normal normal-case">{preview.comboCount} combinations</span>}
                </div>
                {rows.map((c, i) => {
                  const [label, tone] = KIND_CHIP[c.kind] ?? [c.kind.toUpperCase(), "bg-panel2 text-mut"];
                  return (
                    <div key={i}>
                      <div className={`flex flex-wrap items-baseline gap-2.5 rounded-md px-2 py-1.5 text-[13px] ${i % 2 ? "" : "bg-panel2"}`}>
                        <span className="w-28 flex-none text-xs text-ink2">{c.field}</span>
                        {c.oldValue != null && <span className="text-mut line-through decoration-crit/60">{c.oldValue}</span>}
                        {c.oldValue != null && c.newValue != null && <span className="text-[11px] text-mut">→</span>}
                        {c.newValue != null && <span className="font-semibold">{c.newValue}</span>}
                        <span className={`rounded-full px-2 py-0.5 text-[8.5px] font-extrabold tracking-wider ${tone}`}>{label}</span>
                        {c.note && <span className="text-[11px] text-warn">⚠ {c.note}</span>}
                      </div>
                      {c.kind === "drift" && PULLABLE.has(c.field) && (
                        <div className="px-2 pb-1 text-[11px] text-ink2">
                          Shopkeep wins on push · escape hatch:{" "}
                          <button onClick={() => pull(c.field)} disabled={busy} className="text-accent underline disabled:opacity-50">
                            keep Etsy's — pull into Shopkeep instead
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line px-6 py-4">
          <button
            onClick={push}
            disabled={busy || pushed || !preview?.canPush}
            className={`rounded-lg px-5 py-2 text-sm font-bold text-white disabled:opacity-40 ${pushed ? "bg-good" : "bg-accent hover:opacity-90"}`}
          >
            {busy ? "Pushing…" : pushed ? "Pushed ✓" : `Push ${preview?.changes.length ?? 0} changes to Etsy`}
          </button>
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm text-ink2 hover:text-ink">
            {pushed ? "Close" : "Cancel — nothing sent"}
          </button>
          <span className="ml-auto text-[11px] text-mut">Order: inventory → details → state. Nothing pushes without this screen.</span>
        </div>
      </div>
    </>
  );
}
