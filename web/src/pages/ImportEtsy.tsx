import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import { ApiError, api } from "../api";
import { type Material, inventoryApi } from "../inventory/api";
import { type ProductSummary, catalogApi } from "../catalog/api";
import { NavTabs, Skeleton, Wordmark } from "../ui";

/* Etsy import & mapping workspace per the locked concept (2026-08-02):
 * picker over live listings -> product + axis->slot link -> value grid with
 * name auto-match -> save partial or activate (canonical + retro-match). */

type EtsyListing = {
  listing_id: number;
  title: string;
  state: string;
  quantity: number;
  tags: string[];
  inventory: { products: { sku: string | null; property_values: { property_name: string; values: string[] }[]; offerings: { price: { amount: number; divisor: number } }[] }[] } | null;
};
type ValueMapping = { value: string; resolution: string; materialId: number | null; designId?: number | null; variantId?: number | null };
type AxisMapping = { name: string; slotPosition: number | null; mode?: string | null; values: ValueMapping[] };
type Mapping = { productId: number | null; axes: AxisMapping[] };
type EtsyImport = { id: number; connectionId: number; etsyListingId: string; payload: EtsyListing; mapping: Mapping; listingId: number | null };
type Connection = { id: number; platform: string; status: string; shopName: string | null };

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new ApiError(r.status, (await r.text().catch(() => "")) || r.statusText);
  return (await r.json()) as T;
}
const post = (body?: unknown) =>
  ({ method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }) as RequestInit;

/** Name-based auto-match: exact tail match auto-maps; contains-match suggests. */
function autoMap(value: string, materials: Material[]): ValueMapping {
  const v = value.toLowerCase();
  if (v === "custom") return { value, resolution: "review", materialId: null };
  const exact = materials.filter((m) => m.name.toLowerCase().endsWith(" " + v));
  if (exact.length === 1) return { value, resolution: "material", materialId: exact[0].id };
  const alt = v.replace("transparent", "translucent");
  const close = materials.filter((m) => m.name.toLowerCase().includes(alt) || m.name.toLowerCase().includes(v));
  if (close.length >= 1) return { value, resolution: "material", materialId: close[0].id };
  return { value, resolution: "unmapped", materialId: null };
}

export function ImportEtsyPage() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login" });
  }, [me.error, navigate]);

  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => jsonFetch<Connection[]>("/api/v1/integrations/connections"),
    enabled: !!me.data,
  });
  const conn = connections.data?.find((c) => c.status === "connected");
  const listings = useQuery({
    queryKey: ["etsy-listings", conn?.id],
    queryFn: () => jsonFetch<EtsyListing[]>(`/api/v1/integrations/connections/${conn!.id}/etsy-listings`),
    enabled: !!conn,
    staleTime: 5 * 60_000,
  });
  const imports = useQuery({
    queryKey: ["imports"],
    queryFn: () => jsonFetch<EtsyImport[]>("/api/v1/integrations/imports"),
    enabled: !!me.data,
  });
  const materials = useQuery({ queryKey: ["materials"], queryFn: inventoryApi.materials, enabled: !!me.data });
  const products = useQuery({ queryKey: ["products"], queryFn: catalogApi.products, enabled: !!me.data });

  const [openImport, setOpenImport] = useState<EtsyImport | null>(null);

  const qc = useQueryClient();
  const startImport = useMutation({
    mutationFn: (etsyListingId: number) =>
      jsonFetch<EtsyImport>("/api/v1/integrations/imports", post({ connectionId: conn!.id, etsyListingId })),
    onSuccess: (imp) => {
      qc.invalidateQueries({ queryKey: ["imports"] });
      // Prefill auto-match on first open if the mapping is untouched.
      if (imp.mapping.productId == null && materials.data) {
        imp = {
          ...imp,
          mapping: {
            ...imp.mapping,
            axes: imp.mapping.axes.map((ax) => ({
              ...ax,
              values: ax.values.map((v) => (v.resolution === "unmapped" ? autoMap(v.value, materials.data!) : v)),
            })),
          },
        };
      }
      setOpenImport(imp);
    },
  });

  if (!me.data) return <main className="flex min-h-screen items-center justify-center text-mut">Loading…</main>;

  return (
    <div className="mx-auto max-w-5xl px-6 pb-16">
      <header className="mb-6 flex flex-wrap items-center gap-5 border-b border-line py-5">
        <Wordmark />
        <NavTabs active="Listings" />
        <span className="ml-auto text-sm text-ink2">{me.data.displayName}</span>
      </header>

      {openImport ? (
        <MappingWorkspace
          imp={openImport}
          materials={materials.data ?? []}
          products={products.data ?? []}
          onBack={() => {
            setOpenImport(null);
            qc.invalidateQueries({ queryKey: ["imports"] });
          }}
        />
      ) : (
        <div className="rounded-xl border border-line bg-panel p-5 shadow-sm">
          <div className="mb-2 flex items-baseline gap-3">
            <h2 className="text-[11px] font-extrabold tracking-widest text-mut uppercase">
              Import from Etsy {conn ? `— ${conn.shopName}` : ""}
            </h2>
            <Link to="/listings" className="ml-auto flex items-center gap-1 text-xs text-accent hover:underline"><ArrowLeft size={12} /> back to listings</Link>
          </div>
          {!conn && <p className="py-4 text-sm text-ink2">No connected Etsy shop.</p>}
          {listings.isLoading && (
            <div aria-busy="true" aria-label="Fetching listings from Etsy">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center gap-3 border-b border-line/60 py-3 last:border-0">
                  <Skeleton className="h-4 flex-1 basis-64" />
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-7 w-20 rounded-lg" />
                </div>
              ))}
              <p className="pt-3 text-center text-xs text-mut">Fetching your live listings from Etsy — this asks for active and draft listings with their full variation trees, usually a few seconds.</p>
            </div>
          )}
          {(listings.data ?? []).map((l) => {
            const prods = l.inventory?.products ?? [];
            const axes = new Map<string, Set<string>>();
            prods.forEach((p) => p.property_values.forEach((pv) => {
              const s = axes.get(pv.property_name) ?? new Set();
              pv.values.forEach((v) => s.add(v));
              axes.set(pv.property_name, s);
            }));
            const skus = [...new Set(prods.map((p) => p.sku).filter(Boolean))];
            const price = prods[0]?.offerings[0]?.price;
            const existing = imports.data?.find((i) => i.etsyListingId === String(l.listing_id));
            return (
              <div key={l.listing_id} className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2.5 last:border-0">
                <span className="min-w-0 flex-1 basis-64 text-sm font-bold">{l.title}</span>
                <span className="flex flex-wrap items-center gap-2.5 font-mono text-[11.5px] text-ink2">
                  {price && <span>${(price.amount / price.divisor).toFixed(2)}</span>}
                  <span>qty {l.quantity}</span>
                  <span>{[...axes.entries()].map(([a, v]) => `${a} (${v.size})`).join(" × ") || "no variations"}</span>
                  <span>{prods.length} combos</span>
                  {skus.length > 0
                    ? <span>sku {skus.join(", ")}</span>
                    : <span className="rounded-full bg-panel2 px-2 py-0.5 text-[9px] font-extrabold tracking-wider">NO SKU</span>}
                  {l.state !== "active" && <span className="rounded-full bg-panel2 px-2 py-0.5 text-[9px] font-extrabold tracking-wider uppercase">{l.state}</span>}
                </span>
                {existing?.listingId != null ? (
                  <span className="rounded-full bg-good/10 px-2.5 py-1 text-[10px] font-extrabold tracking-wider text-good">IMPORTED ✓</span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <button
                      onClick={() => startImport.mutate(l.listing_id)}
                      disabled={startImport.isPending}
                      className="rounded-lg bg-accent px-4 py-1.5 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {existing ? "Resume mapping…" : "Import"}
                    </button>
                    {existing && (
                      <button
                        onClick={async () => {
                          await fetch(`/api/v1/integrations/imports/${existing.id}`, { method: "DELETE" });
                          qc.invalidateQueries({ queryKey: ["imports"] });
                        }}
                        title="abandon this mapping draft — the Etsy listing is untouched; you can re-import anytime"
                        className="rounded-md border border-crit/40 p-1.5 text-crit hover:border-crit hover:bg-crit/10"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OverrideMatchCheck({ axisValues, designs }: { axisValues: string[]; designs: { name: string; overrideSets: { key: string }[] }[] }) {
  const withSets = designs.filter((d) => d.overrideSets.length > 0);
  const allKeys = withSets.flatMap((d) => d.overrideSets.map((os) => ({ design: d.name, key: os.key })));
  const orphans = allKeys.filter((k) => !axisValues.some((v) => v.toLowerCase() === k.key.toLowerCase()));
  return (
    <div className="mt-1.5 w-full rounded-lg border border-dashed border-line px-3 py-2 text-xs">
      <div className="mb-1 text-[9px] font-extrabold tracking-widest text-mut uppercase">Override match check</div>
      {axisValues.map((v) => {
        const hits = allKeys.filter((k) => k.key.toLowerCase() === v.toLowerCase());
        return (
          <div key={v} className="flex gap-2 py-0.5 text-ink2">
            <span className="w-28 flex-none font-mono">“{v}”</span>
            <span>
              {hits.length ? <>matches override set on <b>{hits.map((h) => h.design).join(", ")}</b> ✓ · others use base</> : "no override sets — all designs use base composition"}
              <span className="ml-1.5 rounded-full bg-good/10 px-1.5 text-[8.5px] font-extrabold text-good">OK</span>
            </span>
          </div>
        );
      })}
      {orphans.map((o, i) => (
        <div key={i} className="flex gap-2 py-0.5 text-warn">
          <span className="w-28 flex-none">—</span>
          <span>
            <b>{o.design}</b> has an override set <span className="font-mono">“{o.key}”</span> matching no value here — it will never fire.
            <span className="ml-1.5 rounded-full bg-warn/10 px-1.5 text-[8.5px] font-extrabold text-warn">NEVER MATCHES</span>
          </span>
        </div>
      ))}
    </div>
  );
}

const axisMode = (a: AxisMapping) => a.mode ?? (a.slotPosition != null ? "materials" : "modifier");

function MappingWorkspace(props: { imp: EtsyImport; materials: Material[]; products: ProductSummary[]; onBack: () => void }) {
  const { imp, materials, products, onBack } = props;
  const [mapping, setMapping] = useState<Mapping>(imp.mapping);
  const designs = useQuery({
    queryKey: ["designs", mapping.productId],
    queryFn: () => jsonFetch<{ id: number; name: string; overrideSets: { key: string }[] }[]>(`/api/v1/catalog/products/${mapping.productId}/designs`),
    enabled: mapping.productId != null,
  });
  const productDetail = useQuery({
    queryKey: ["product", mapping.productId],
    queryFn: () => catalogApi.product(mapping.productId!),
    enabled: mapping.productId != null,
  });
  const variants = useQuery({
    queryKey: ["variants", mapping.productId],
    queryFn: () => jsonFetch<{ id: number; name: string }[]>(`/api/v1/catalog/products/${mapping.productId}/variants`),
    enabled: mapping.productId != null,
  });
  const [error, setError] = useState<string | null>(null);
  const [activated, setActivated] = useState<number | null>(null);
  const matById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);

  const resolvedCount = mapping.axes.filter((a) => axisMode(a) !== "modifier").flatMap((a) => a.values)
    .filter((v) => v.resolution !== "unmapped" && !(v.resolution === "material" && v.materialId == null)
      && !(v.resolution === "design" && v.designId == null) && !(v.resolution === "variant" && v.variantId == null)).length;
  const totalCount = mapping.axes.filter((a) => axisMode(a) !== "modifier").flatMap((a) => a.values).length;
  const complete = mapping.productId != null && resolvedCount === totalCount && totalCount > 0;

  const save = useMutation({
    mutationFn: () =>
      jsonFetch(`/api/v1/integrations/imports/${imp.id}/mapping`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mapping) }),
    onError: (e) => setError(e instanceof Error ? e.message : "Save failed"),
  });
  const activate = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return jsonFetch<{ listingId: number; retroMatchedLines: number }>(`/api/v1/integrations/imports/${imp.id}/activate`, post({}));
    },
    onSuccess: (r) => setActivated(r.retroMatchedLines),
    onError: (e) => setError(e instanceof Error ? e.message : "Activation failed"),
  });

  const setAxis = (i: number, fn: (a: AxisMapping) => AxisMapping) =>
    setMapping((m) => ({ ...m, axes: m.axes.map((a, j) => (j === i ? fn(a) : a)) }));

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="flex items-center gap-1 rounded-lg border border-line bg-panel px-3 py-1 text-xs text-ink2 hover:text-ink"><ArrowLeft size={13} /> listings</button>
        <h2 className="text-[17px] font-bold">{imp.payload.title}</h2>
        {activated != null ? (
          <span className="rounded-full bg-good/10 px-2.5 py-0.5 text-[9px] font-extrabold tracking-wider text-good">IN SYNC · {activated} ORDER LINES RETRO-MATCHED</span>
        ) : (
          <span className="rounded-full bg-warn/10 px-2.5 py-0.5 text-[9px] font-extrabold tracking-wider text-warn">IMPORTED · NEEDS MAPPING</span>
        )}
      </div>
      <div className="mb-4 flex gap-3 font-mono text-xs text-ink2">
        <span>etsy #{imp.etsyListingId}</span><span>qty {imp.payload.quantity}</span><span>{imp.payload.state}</span>
      </div>

      <div className="mb-3 rounded-lg bg-panel2 px-4 py-2.5 text-xs text-ink2">
        How matching works: an <b className="text-ink">Etsy variation</b> → fills a <b className="text-ink">recipe slot</b> → each value picks <b className="text-ink">what goes in it</b> — a material, a design (colorway), or a variant (build style).
      </div>
      <div className="mb-3 rounded-xl border border-line bg-panel p-4 shadow-sm">
        <div className="mb-2 text-[10px] font-extrabold tracking-widest text-mut uppercase">1 · Link a product, then say what each Etsy axis means</div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={mapping.productId ?? ""}
            onChange={(e) => setMapping((m) => ({ ...m, productId: e.target.value ? Number(e.target.value) : null }))}
            className="rounded-md border border-line bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
          >
            <option value="">Choose product (recipe)…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {mapping.productId != null && (
            <span className="rounded-full bg-good/10 px-2.5 py-0.5 text-[9px] font-extrabold tracking-wider text-good">
              {(designs.data ?? []).length} DESIGNS · {(variants.data ?? []).length} VARIANTS AVAILABLE
            </span>
          )}
        </div>
        <div className="mt-2 grid gap-1.5">
          {mapping.axes.map((ax, i) => (
            <div key={ax.name} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-40 flex-none text-ink2">{ax.name}</span>
              <select
                value={ax.mode ?? (ax.slotPosition != null ? `slot:${ax.slotPosition}` : "modifier")}
                onChange={(e) => {
                  const val = e.target.value;
                  setAxis(i, (a) => ({
                    ...a,
                    mode: val.startsWith("slot:") ? "materials" : val,
                    slotPosition: val.startsWith("slot:") ? Number(val.slice(5)) : null,
                  }));
                }}
                className="rounded-md border border-line bg-panel2 px-2 py-1 text-xs outline-none focus:border-accent"
              >
                <option value="designs">values are designs (colorways) of the product</option>
                <option value="variants">values are variants (build styles) of the product</option>
                {(productDetail.data?.slots ?? []).map((sl, si) =>
                  sl.kind === "CHOICE" ? (
                    <option key={si} value={`slot:${si}`}>
                      values are materials filling → {sl.name} ({sl.quantity}{sl.optional ? ", optional" : ""})
                    </option>
                  ) : null,
                )}
                <option value="modifier">no materials — matches design override sets (editions) or is cosmetic</option>
              </select>
              {axisMode(ax) === "modifier" && (designs.data ?? []).some((d) => d.overrideSets.length > 0) && (
                <OverrideMatchCheck axisValues={ax.values.map((v) => v.value)} designs={designs.data!} />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mb-3 rounded-xl border border-line bg-panel p-4 shadow-sm">
        <div className="mb-2 text-[10px] font-extrabold tracking-widest text-mut uppercase">2 · Resolve every value</div>
        <div className="grid gap-5 md:grid-cols-2">
          {mapping.axes.filter((a) => axisMode(a) !== "modifier").map((ax) => {
            const i = mapping.axes.indexOf(ax);
            return (
              <div key={ax.name}>
                <div className="mb-1 text-[13px] font-bold">{ax.name}</div>
                {ax.values.map((v, vi) => (
                  <div key={v.value} className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-xs ${vi % 2 ? "" : "bg-panel2"}`}>
                    <span className="w-36 flex-none truncate" title={v.value}>{v.value}</span>
                    <span className="flex-none text-[10px] text-mut">→</span>
                    <select
                      value={
                        v.resolution === "material" ? String(v.materialId ?? "")
                        : v.resolution === "design" ? `d:${v.designId ?? ""}`
                        : v.resolution === "variant" ? `v:${v.variantId ?? ""}`
                        : v.resolution
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val.startsWith("create:")) {
                          const name = val.slice(7);
                          (async () => {
                            const cur = await jsonFetch<{ id: number; name: string }[]>(`/api/v1/catalog/products/${mapping.productId}/designs`);
                            const saved = await jsonFetch<{ id: number; name: string }[]>(`/api/v1/catalog/products/${mapping.productId}/designs`, {
                              method: "PUT", headers: { "Content-Type": "application/json" },
                              body: JSON.stringify([...cur, { id: null, name, assignments: [], overrideSets: [] }]),
                            });
                            const nd = saved.find((d) => d.name === name);
                            if (nd) setAxis(i, (a) => ({ ...a, values: a.values.map((x, xi) => (xi === vi ? { ...x, resolution: "design", materialId: null, designId: nd.id, variantId: null } : x)) }));
                            designs.refetch();
                          })();
                          return;
                        }
                        setAxis(i, (a) => ({
                          ...a,
                          values: a.values.map((x, xi) => {
                            if (xi !== vi) return x;
                            if (val === "review" || val === "ignore" || val === "unmapped")
                              return { ...x, resolution: val, materialId: null, designId: null, variantId: null };
                            if (val.startsWith("d:"))
                              return { ...x, resolution: "design", materialId: null, designId: Number(val.slice(2)), variantId: null };
                            if (val.startsWith("v:"))
                              return { ...x, resolution: "variant", materialId: null, designId: null, variantId: Number(val.slice(2)) };
                            return { ...x, resolution: "material", materialId: Number(val), designId: null, variantId: null };
                          }),
                        }));
                      }}
                      className={`min-w-0 flex-1 rounded border bg-panel px-1.5 py-0.5 text-xs outline-none ${v.resolution === "unmapped" ? "border-warn" : "border-line"}`}
                    >
                      {axisMode(ax) === "designs" && (
                        <>
                          <option value="unmapped">— pick a design…</option>
                          {(designs.data ?? []).map((d) => <option key={`d${d.id}`} value={`d:${d.id}`}>🎨 {d.name}</option>)}
                          <option value={`create:${v.value}`}>+ create design “{v.value}” on this product…</option>
                        </>
                      )}
                      {axisMode(ax) === "variants" && (
                        <>
                          <option value="unmapped">— pick a variant…</option>
                          {(variants.data ?? []).map((d) => <option key={`v${d.id}`} value={`v:${d.id}`}>{d.name}</option>)}
                        </>
                      )}
                      {axisMode(ax) === "materials" && (
                        <>
                          <option value="unmapped">— pick a material…</option>
                          {materials.filter((m) => !m.archived).map((m) => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </>
                      )}
                      <option value="review">review per order (human picks at build time)</option>
                      <option value="ignore">no material impact</option>
                    </select>
                    <span
                      className="h-2.5 w-2.5 flex-none rounded-full border border-line"
                      style={{ background: (v.materialId && matById.get(v.materialId)?.attributes?.color) || "transparent" }}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {totalCount === 0 && <p className="text-xs text-mut italic">Assign at least one axis to a recipe slot above.</p>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-xs text-ink2">{resolvedCount}/{totalCount} resolved</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel2">
          <div className="h-full bg-good transition-all" style={{ width: totalCount ? `${(resolvedCount / totalCount) * 100}%` : "0%" }} />
        </div>
        <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-lg border border-line bg-panel px-4 py-1.5 text-xs font-semibold text-ink2 hover:text-ink">
          {save.isPending ? "Saving…" : "Save mapping draft"}
        </button>
        <button
          onClick={() => activate.mutate()}
          disabled={!complete || activate.isPending || activated != null}
          title={complete ? "listing becomes canonical; waiting orders retro-match" : "link a product and resolve every value first"}
          className="rounded-lg bg-good px-5 py-1.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {activate.isPending ? "Activating…" : activated != null ? "Activated ✓" : "Activate listing"}
        </button>
        {error && <span className="text-xs font-medium text-crit">{error}</span>}
      </div>
    </div>
  );
}
