import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
import { Card, Wordmark } from "../ui";
import { formatQty, inventoryApi, type Material } from "../inventory/api";
import { MaterialGauge } from "../inventory/Gauge";
import { MaterialIcon } from "../inventory/MaterialIcon";
import { MaterialForm } from "../inventory/MaterialForm";
import { MaterialDetailDrawer } from "../inventory/MaterialDetail";

/** Inventory dashboard — first pass of the locked Inventory UX concept:
 *  summary strip (one segmented card), category shelves of gauges,
 *  urgency-sorted health list, needs-purchasing panel. */
export function DashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    enabled: setup.data?.needsSetup === false,
  });
  const materials = useQuery({
    queryKey: ["materials"],
    queryFn: inventoryApi.materials,
    enabled: !!me.data,
  });

  useEffect(() => {
    if (setup.data?.needsSetup) navigate({ to: "/setup" });
  }, [setup.data, navigate]);
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login" });
  }, [me.error, navigate]);

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.removeQueries();
      navigate({ to: "/login" });
    },
  });

  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Material | null>(null);

  const all = useMemo(() => materials.data ?? [], [materials.data]);
  const categories = useMemo(() => [...new Set(all.map((m) => m.category))], [all]);
  const critical = all.filter((m) => m.status === "CRITICAL");
  const low = all.filter((m) => m.status === "LOW");
  const purchasing = [...critical, ...low].sort(
    (a, b) => a.stock.available / (a.lowStockThreshold || 1) - b.stock.available / (b.lowStockThreshold || 1),
  );

  if (!me.data) {
    return <main className="flex min-h-screen items-center justify-center text-mut">Loading…</main>;
  }

  return (
    <div className="mx-auto max-w-6xl px-6 pb-16">
      <header className="mb-6 flex flex-wrap items-center gap-5 border-b border-line py-5">
        <Wordmark />
        <span className="text-xs tracking-widest text-mut uppercase">Inventory</span>
        <nav className="ml-auto flex items-center gap-4 text-sm">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-accent px-3.5 py-1.5 font-semibold text-white hover:opacity-90"
          >
            + Material
          </button>
          <span className="text-ink2">
            {me.data.displayName}
            <span className="ml-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] tracking-wider text-mut uppercase">
              {me.data.role.toLowerCase()}
            </span>
          </span>
          <button type="button" onClick={() => logout.mutate()} className="text-accent hover:underline">
            Sign out
          </button>
        </nav>
      </header>

      {/* Summary strip: one segmented card, label + number only */}
      <div className="grid grid-cols-2 rounded-xl border border-line bg-panel shadow-sm sm:grid-cols-4">
        <Stat label="Critical" value={critical.length} tone="crit" />
        <Stat label="Running low" value={low.length} tone="warn" divider />
        <Stat label="Healthy" value={all.length - critical.length - low.length} tone="good" divider />
        <Stat label="Materials" value={all.length} divider />
      </div>

      {all.length === 0 && !materials.isLoading && (
        <Card className="mt-8 text-center">
          <h2 className="text-lg font-semibold">Stock your shop</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink2">
            Add your first materials — filaments with their colors, screws, magnets, boxes, tape — and Shopkeep
            starts tracking every gram and piece through its ledger.
          </p>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-4 rounded-md bg-accent px-4 py-2 font-semibold text-white hover:opacity-90"
          >
            Add first material
          </button>
        </Card>
      )}

      {/* The wall: gauges grouped by category */}
      {categories.map((cat) => (
        <section key={cat} className="mt-8">
          <h2 className="mb-1 flex items-center gap-2 text-[13px] font-bold tracking-widest uppercase text-ink2">
            <MaterialIcon category={cat} size={16} />
            {cat}
            <span className="ml-1 font-mono text-xs font-normal tracking-normal text-mut">
              {all.filter((m) => m.category === cat).length}
            </span>
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-x-2 gap-y-1 rounded-xl border border-line bg-panel p-3 shadow-sm">
            {all
              .filter((m) => m.category === cat)
              .map((m) => (
                <MaterialGauge key={m.id} m={m} onClick={() => setDetailId(m.id)} />
              ))}
          </div>
        </section>
      ))}

      {/* Needs purchasing, most urgent first */}
      {purchasing.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-1 text-[13px] font-bold tracking-widest uppercase text-ink2">Needs purchasing</h2>
          <div className="divide-y divide-line rounded-xl border border-line bg-panel shadow-sm">
            {purchasing.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span
                  className={`h-2 w-2 rounded-sm ${m.status === "CRITICAL" ? "bg-crit" : "bg-warn"}`}
                  aria-hidden="true"
                />
                <MaterialIcon category={m.category} type={m.type} size={14} className="text-mut" />
                <button type="button" onClick={() => setDetailId(m.id)} className="font-medium hover:underline">
                  {m.name}
                </button>
                <span className="text-xs text-mut">
                  {formatQty(m.stock.available)} {m.unit} left · threshold {formatQty(m.lowStockThreshold ?? 0)}
                </span>
                <span
                  className={`text-[10.5px] font-bold tracking-wider ${m.status === "CRITICAL" ? "text-crit" : "text-warn"}`}
                >
                  {m.status === "CRITICAL" ? "CRITICAL" : "LOW"}
                </span>
                <span className="ml-auto flex items-center gap-3 text-sm">
                  {m.reorderQuantity != null && (
                    <span className="font-mono text-xs text-ink2">
                      reorder {formatQty(m.reorderQuantity)} {m.unit}
                    </span>
                  )}
                  {m.vendorUrl && (
                    <a href={m.vendorUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      Buy ↗
                    </a>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {creating && <MaterialForm categories={categories} onClose={() => setCreating(false)} />}
      {editing && (
        <MaterialForm
          existing={editing}
          categories={categories}
          onClose={() => {
            setEditing(null);
            if (detailId) queryClient.invalidateQueries({ queryKey: ["material", detailId] });
          }}
        />
      )}
      {detailId != null && !editing && (
        <MaterialDetailDrawer
          id={detailId}
          onClose={() => setDetailId(null)}
          onEdit={() => setEditing(all.find((m) => m.id === detailId) ?? null)}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  divider,
}: {
  label: string;
  value: number;
  tone?: "crit" | "warn" | "good";
  divider?: boolean;
}) {
  const toneClass = tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : tone === "good" ? "text-good" : "";
  return (
    <div className={`px-5 py-4 ${divider ? "border-l border-line" : ""}`}>
      <div className="flex items-center gap-2 text-[11px] font-semibold tracking-widest uppercase text-mut">
        {tone && <span className={`h-2 w-2 rounded-sm ${tone === "crit" ? "bg-crit" : tone === "warn" ? "bg-warn" : "bg-good"}`} />}
        {label}
      </div>
      <div className={`mt-0.5 font-mono text-[26px] leading-tight font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
