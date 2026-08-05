import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { formatQty, matchesQuery, materialColor, sortMaterials, type Material, type SortKey } from "./api";

/** Modal single-pick over the whole material shelf: token search, category
 *  chips, sort — the editor picker's toolkit, sized for hundreds of spools.
 *  Optional footer resolutions (review / no-impact) for mapping flows. */
export function MaterialPickerDialog({
  all,
  title,
  onPick,
  onReview,
  onIgnore,
  onCreateNew,
  onClose,
}: {
  all: Material[];
  title: string;
  onPick: (id: number) => void;
  onReview?: () => void;
  onIgnore?: () => void;
  /** On-the-fly create: caller opens its material form and chains the pick. */
  onCreateNew?: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("name");
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const pool = useMemo(() => all.filter((m) => !m.archived), [all]);
  const cats = useMemo(() => [...new Set(pool.map((m) => m.category))].sort(), [pool]);
  const rows = sortMaterials(pool.filter((m) => (!cat || m.category === cat) && matchesQuery(m, q)), sort);

  // arrows walk the filtered list; the highlight resets when it changes
  useEffect(() => { setHi(0); }, [q, cat, sort]);
  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView({ block: "nearest" });
  }, [hi]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[hi]) onPick(rows[hi].id); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div className="fixed inset-x-0 top-12 bottom-12 z-50 mx-auto flex w-[min(620px,94vw)] flex-col rounded-2xl border border-line bg-bg shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <span className="min-w-0 flex-1 truncate text-[14px] font-bold">{title}</span>
          <button onClick={onClose} className="rounded-md border border-line p-1 text-ink2 hover:text-ink"><X size={15} /></button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search — name, brand, type, color…"
            className="min-w-40 flex-1 rounded-md border border-line bg-panel2 px-3 py-1.5 text-sm outline-none placeholder:text-mut focus:border-accent"
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-md border border-line bg-panel2 px-2 py-1.5 text-xs outline-none focus:border-accent">
            <option value="name">sort: name</option>
            <option value="type">sort: type</option>
            <option value="color">sort: color</option>
            <option value="stock">sort: stock</option>
          </select>
          {cats.length > 1 && (
            <div className="flex w-full flex-wrap gap-1.5">
              <button type="button" onClick={() => setCat(null)}
                className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold ${cat == null ? "border-accent text-accent" : "border-line text-mut hover:text-ink"}`}>
                all
              </button>
              {cats.map((c) => (
                <button key={c} type="button" onClick={() => setCat(cat === c ? null : c)}
                  className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold ${cat === c ? "border-accent text-accent" : "border-line text-mut hover:text-ink"}`}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2">
          {rows.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-mut">
              Nothing matches.
              {onCreateNew && (
                <button type="button" onClick={onCreateNew} className="ml-1.5 font-semibold text-accent hover:underline">
                  + Create it as a new material
                </button>
              )}
            </p>
          )}
          {rows.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onPick(m.id)}
              onMouseEnter={() => setHi(i)}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm ${i === hi ? "bg-accent/10 ring-1 ring-accent/40" : i % 2 ? "hover:bg-accent/5" : "bg-panel2/60 hover:bg-accent/5"}`}
            >
              <span className="h-4 w-4 flex-none rounded-full border border-line" style={{ background: materialColor(m) ?? "var(--color-panel2)" }} />
              <span className="min-w-0 flex-1 truncate">
                {m.name}
                {m.brand && <span className="ml-1.5 text-[11px] text-mut">{m.brand}</span>}
              </span>
              <span className="flex-none text-[11px] text-mut">{m.type}</span>
              <span className={`w-20 flex-none text-right font-mono text-[11px] ${m.stock.available <= 0 ? "text-warn" : "text-ink2"}`}>
                {formatQty(m.stock.available)} {m.unit}
              </span>
            </button>
          ))}
        </div>

        {(onReview || onIgnore || onCreateNew) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
            {onCreateNew && (
              <button type="button" onClick={onCreateNew}
                className="rounded-md border border-accent/40 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/5">
                + New material…
              </button>
            )}
            {onReview && (
              <button type="button" onClick={onReview}
                className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink2 hover:border-accent hover:text-accent">
                review per order
              </button>
            )}
            {onIgnore && (
              <button type="button" onClick={onIgnore}
                className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink2 hover:border-accent hover:text-accent">
                no material impact
              </button>
            )}
            <span className="ml-auto text-[11px] text-mut">{rows.length} of {pool.length} materials</span>
          </div>
        )}
      </div>
    </>
  );
}
