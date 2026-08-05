import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { inventoryApi, type CatalogFilament } from "./api";

/** Browse the Open Filament Database mirror: search across brand / line /
 *  color, brand filter, keyboard nav — same feel as the material picker.
 *  Picking a row prefills the material form; nothing is locked in. */
export function FilamentCatalogDialog({
  onPick,
  onClose,
}: {
  onPick: (f: CatalogFilament) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [material, setMaterial] = useState("");
  const [hideDiscontinued, setHideDiscontinued] = useState(false);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const status = useQuery({ queryKey: ["filamentdb", "status"], queryFn: inventoryApi.filamentDbStatus });
  // Facets cross-narrow: pick a brand and the material list shrinks to what
  // that brand actually makes, and vice versa.
  const facets = useQuery({
    queryKey: ["filamentdb", "facets", brand, material],
    queryFn: () => inventoryApi.filamentDbFacets(brand || null, material || null),
  });
  // Small debounce keeps the mirror queries calm while typing.
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  const results = useQuery({
    queryKey: ["filamentdb", "search", debouncedQ, brand, material, hideDiscontinued],
    queryFn: () => inventoryApi.filamentDbSearch(debouncedQ, { brand: brand || null, material: material || null, hideDiscontinued }),
    enabled: (status.data?.variants ?? 0) > 0 && (debouncedQ.trim().length > 0 || !!brand || !!material),
  });
  const refresh = useMutation({
    mutationFn: inventoryApi.filamentDbRefresh,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["filamentdb"] }),
  });

  const rows = results.data ?? [];
  useEffect(() => { setHi(0); }, [debouncedQ, brand, material, hideDiscontinued]);
  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[hi]) onPick(rows[hi]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  const empty = status.data != null && status.data.variants === 0;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div className="fixed inset-x-0 top-12 bottom-12 z-50 mx-auto flex w-[min(640px,94vw)] flex-col rounded-2xl border border-line bg-bg shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <span className="min-w-0 flex-1 truncate text-[14px] font-bold">Filament catalog</span>
          <button onClick={onClose} className="rounded-md border border-line p-1 text-ink2 hover:text-ink"><X size={15} /></button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search — brand, line, color… e.g. bambu matte sage"
            className="min-w-40 flex-1 rounded-md border border-line bg-panel2 px-3 py-1.5 text-sm outline-none placeholder:text-mut focus:border-accent"
          />
          <select value={brand} onChange={(e) => setBrand(e.target.value)}
            className="max-w-40 rounded-md border border-line bg-panel2 px-2 py-1.5 text-xs outline-none focus:border-accent">
            <option value="">all brands</option>
            {(facets.data?.brands ?? []).map((b) => (
              <option key={b.name} value={b.name}>{b.name} ({b.variants})</option>
            ))}
          </select>
          <select value={material} onChange={(e) => setMaterial(e.target.value)}
            className="max-w-36 rounded-md border border-line bg-panel2 px-2 py-1.5 text-xs outline-none focus:border-accent">
            <option value="">all materials</option>
            {(facets.data?.materials ?? []).map((m) => (
              <option key={m.name} value={m.name}>{m.name} ({m.variants})</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setHideDiscontinued((v) => !v)}
            aria-pressed={hideDiscontinued}
            className={`rounded-full border px-2.5 py-1 text-[10.5px] font-semibold ${hideDiscontinued ? "border-accent text-accent" : "border-line text-mut hover:text-ink"}`}
          >
            hide discontinued
          </button>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2">
          {empty && (
            <div className="px-2 py-8 text-center text-sm text-mut">
              <p>The catalog hasn't been downloaded yet.</p>
              <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}
                className="mt-3 rounded-md border border-accent/40 px-3.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent/5 disabled:opacity-50">
                {refresh.isPending ? "Downloading…" : "Download it now (~2 MB)"}
              </button>
              {refresh.isError && <p className="mt-2 text-xs text-warn">{refresh.error.message}</p>}
            </div>
          )}
          {!empty && rows.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-mut">
              {debouncedQ.trim() || brand || material
                ? results.isFetching ? "Searching…" : "Nothing matches — try fewer words or filters."
                : "Type to search 14,000+ colors across 150+ brands."}
            </p>
          )}
          {rows.map((f, i) => (
            <button
              key={f.variantId}
              type="button"
              onClick={() => onPick(f)}
              onMouseEnter={() => setHi(i)}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm ${i === hi ? "bg-accent/10 ring-1 ring-accent/40" : i % 2 ? "hover:bg-accent/5" : "bg-panel2/60 hover:bg-accent/5"}`}
            >
              <span
                className="h-4 w-4 flex-none rounded-full border border-line"
                style={{ background: f.colorHex ?? "repeating-conic-gradient(var(--color-panel2) 0% 25%, var(--color-panel) 0% 50%) 0 0 / 8px 8px" }}
              />
              <span className="min-w-0 flex-1 truncate">
                {f.colorName}
                <span className="ml-1.5 text-[11px] text-mut">{f.line}</span>
                {f.discontinued && (
                  <span className="ml-1.5 rounded-full bg-line/60 px-1.5 py-0.5 text-[8.5px] font-extrabold tracking-wider text-mut">DISCONTINUED</span>
                )}
              </span>
              <span className="flex-none text-[11px] text-mut">{f.material}</span>
              <span className="w-24 flex-none truncate text-right text-[11px] text-ink2">{f.brand}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-2.5 text-[11px] text-mut">
          <span>
            Open Filament Database · {status.data?.variants?.toLocaleString() ?? "…"} colors
            {status.data?.version ? ` · v${status.data.version}` : ""}
          </span>
          <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}
            className="ml-auto rounded-md border border-line px-2 py-1 font-semibold text-ink2 hover:border-accent hover:text-accent disabled:opacity-50">
            {refresh.isPending ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
    </>
  );
}
