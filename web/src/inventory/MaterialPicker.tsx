import { useState } from "react";
import { formatQty, matchesQuery, materialColor, sortMaterials, type Material } from "./api";

/** Shared searchable material picker: collapsed chip once chosen, token
 *  search over name/type/category/attributes while picking. */
export function MaterialPicker({
  all,
  value,
  onChange,
  category,
  placeholder = "Search materials — name, type, category…",
}: {
  all: Material[];
  value: Material | null;
  onChange: (id: number) => void;
  category?: string;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(value == null);

  if (value && !open) {
    return (
      <span className="flex items-center gap-2 text-sm text-ink2">
        <span className="h-3.5 w-3.5 flex-none rounded-full border border-line" style={{ background: materialColor(value) ?? "var(--color-panel2)" }} />
        {value.name}
        <span className="font-mono text-[11px] text-mut">
          {formatQty(value.stock.available)} {value.unit}
        </span>
        <button type="button" onClick={() => setOpen(true)} className="text-xs text-accent hover:underline">
          change
        </button>
      </span>
    );
  }

  const pool = category ? all.filter((m) => m.category === category) : all;
  const matches = sortMaterials(pool.filter((m) => matchesQuery(m, q)), "name").slice(0, 8);
  return (
    <span className="block">
      <input
        autoFocus={value != null}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="w-full max-w-sm rounded-md border border-line bg-panel2 px-3 py-1.5 text-sm outline-none placeholder:text-mut focus:border-accent"
      />
      <span className="mt-1 flex flex-col items-start gap-0.5">
        {matches.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              onChange(m.id);
              setOpen(false);
              setQ("");
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-ink2 hover:bg-panel2 hover:text-ink"
          >
            <span className="h-3.5 w-3.5 rounded-full border border-line" style={{ background: materialColor(m) ?? "var(--color-panel2)" }} />
            {m.name}
            <span className="text-[11px] text-mut">{m.brand ?? m.category}</span>
            <span className="font-mono text-[11px] text-mut">
              {formatQty(m.stock.available)} {m.unit}
            </span>
          </button>
        ))}
        {matches.length === 0 && <span className="px-2 py-1 text-xs text-mut">No materials match.</span>}
      </span>
    </span>
  );
}
