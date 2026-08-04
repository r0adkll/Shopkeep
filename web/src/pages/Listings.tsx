import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
import { Download, ExternalLink, ImageOff, Video } from "lucide-react";
import { Card, Wordmark, NavTabs } from "../ui";
import { inventoryApi } from "../inventory/api";
import { catalogApi, documentUrl, type Product } from "../catalog/api";
import { listingsApi, type Listing } from "./../listings/api";
import { ListingEditor } from "../listings/ListingEditor";

const STATE_STYLE: Record<string, string> = {
  active: "bg-good/10 text-good",
  draft: "bg-panel2 text-ink2 border border-line",
  inactive: "bg-warn/10 text-warn",
};

export function ListingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login" });
  }, [me.error, navigate]);

  const [showArchived, setShowArchived] = useState(false);
  const listings = useQuery({
    queryKey: ["listings", showArchived],
    queryFn: () => listingsApi.list(showArchived),
    enabled: !!me.data,
  });
  const products = useQuery({ queryKey: ["products"], queryFn: catalogApi.products, enabled: !!me.data });
  useQuery({ queryKey: ["materials"], queryFn: inventoryApi.materials, enabled: !!me.data });

  const [editing, setEditing] = useState<{ listing?: Listing; product: Product } | null>(null);
  const [picking, setPicking] = useState(false);

  const productById = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);

  const open = useMutation({
    mutationFn: async (l: Listing) => ({ listing: l, product: await catalogApi.product(l.input.productId) }),
    onSuccess: (r) => setEditing(r),
  });

  // ?listing=<id> deep link (order detail's matched-line cards) — open the
  // editor once the list lands, then clean the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("listing");
    if (!p || !listings.data || editing) return;
    const l = listings.data.find((x) => x.id === Number(p));
    window.history.replaceState({}, "", "/listings");
    if (l) open.mutate(l);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listings.data]);
  const startNew = useMutation({
    mutationFn: (productId: number) => catalogApi.product(productId),
    onSuccess: (product) => {
      setPicking(false);
      setEditing({ product });
    },
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.removeQueries();
      navigate({ to: "/login" });
    },
  });

  if (!me.data) return <main className="flex min-h-screen items-center justify-center text-mut">Loading…</main>;

  return (
    <div className="mx-auto max-w-6xl px-6 pb-16">
      <header className="mb-6 flex flex-wrap items-center gap-5 border-b border-line py-5">
        <Wordmark />
        <NavTabs active="Listings" />
        <nav className="ml-auto flex items-center gap-4 text-sm">
          {!editing && (
            <>
              <button type="button" onClick={() => setShowArchived(!showArchived)} aria-pressed={showArchived}
                className={`rounded-full border px-3 py-1 text-xs ${showArchived ? "border-accent text-accent" : "border-line text-mut hover:text-ink"}`}>
                archived
              </button>
              <a href="/listings/import" className="flex items-center gap-1.5 rounded-md border border-line px-3.5 py-1.5 text-xs font-semibold text-ink2 hover:border-accent hover:text-accent">
                <Download size={14} /> Import from Etsy…
              </a>
              <button type="button" onClick={() => setPicking(true)} className="rounded-md bg-accent px-3.5 py-1.5 font-semibold text-white hover:opacity-90">
                + Listing
              </button>
            </>
          )}
          <span className="text-ink2">{me.data.displayName}</span>
          <button type="button" onClick={() => logout.mutate()} className="text-accent hover:underline">Sign out</button>
        </nav>
      </header>

      {editing ? (
        <ListingEditor existing={editing.listing} product={editing.product} onClose={() => setEditing(null)} />
      ) : (
        <>
          {picking && (
            <Card className="mb-4">
              <h2 className="text-sm font-semibold">New listing — from which recipe?</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {(products.data ?? []).map((p) => (
                  <button key={p.id} type="button" onClick={() => startNew.mutate(p.id)} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent">
                    {p.name} <span className="font-mono text-xs text-mut">{p.skuPrefix}</span>
                  </button>
                ))}
                <button type="button" onClick={() => setPicking(false)} className="rounded-lg px-3 py-1.5 text-sm text-mut">cancel</button>
              </div>
            </Card>
          )}
          {(listings.data ?? []).length === 0 && !listings.isLoading && !picking && (
            <Card className="text-center">
              <h2 className="text-lg font-semibold">Your storefront, source-of-truthed</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-ink2">
                A listing pins a recipe's configurations into durable SKUs, adds packaging and extras, and — once
                Etsy connects in Phase 3 — pushes to your shop with review-before-push.
              </p>
              <button type="button" onClick={() => setPicking(true)} className="mt-4 rounded-md bg-accent px-4 py-2 font-semibold text-white hover:opacity-90">
                New listing
              </button>
            </Card>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {(listings.data ?? []).map((l) => {
              const SYNC: Record<string, [string, string]> = {
                in_sync: ["IN SYNC", "bg-good/10 text-good"],
                pending: ["CHANGES TO PUSH", "bg-warn/10 text-warn"],
                drifted: ["DRIFTED", "bg-warn/10 text-warn"],
                imported: ["NEEDS MAPPING", "bg-warn/10 text-warn"],
                not_published: ["NOT PUBLISHED", "bg-panel2 text-mut"],
              };
              const [syncLabel, syncTone] = SYNC[l.syncState] ?? [l.syncState.replace("_", " ").toUpperCase(), "bg-panel2 text-mut"];
              const thumbId = l.input.imageDocumentIds[0];
              return (
              // div, not button — the card holds a nested "open on Etsy" link
              <div key={l.id} role="button" tabIndex={0} onClick={() => open.mutate(l)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open.mutate(l); } }}
                className={`relative flex cursor-pointer gap-3.5 rounded-xl border border-line bg-panel p-4 text-left shadow-sm hover:border-accent ${l.archived ? "opacity-70" : ""}`}>
                {thumbId != null ? (
                  <div className="relative flex-none self-start">
                    <img src={documentUrl(thumbId)} alt="" loading="lazy"
                      className="h-20 w-20 rounded-lg border border-line object-cover" />
                    {l.input.imageDocumentIds.length > 1 && (
                      <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[9px] font-bold text-white">
                        {l.input.imageDocumentIds.length}
                      </span>
                    )}
                    {l.input.videoDocumentId != null && (
                      <span className="absolute top-1 right-1 rounded bg-black/60 p-0.5 text-white" title="has video">
                        <Video size={10} />
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex h-20 w-20 flex-none flex-col items-center justify-center gap-1 self-start rounded-lg border border-dashed border-line bg-panel2 text-mut"
                    title="No photos yet — Etsy listings need at least one">
                    <ImageOff size={18} />
                    <span className="text-[8.5px] font-bold tracking-wider uppercase">no photo</span>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h2 className={`line-clamp-2 text-[14px] leading-snug font-semibold ${l.etsyListingId ? "pr-20" : ""}`}>{l.input.title}</h2>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold tracking-wider ${STATE_STYLE[l.input.state] ?? ""}`}>
                      {l.input.state.toUpperCase()}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold tracking-wider ${syncTone}`} title={l.etsyListingId ? `etsy listing ${l.etsyListingId}` : "no platform link yet"}>
                      {syncLabel}{l.etsyListingId ? " · ETSY" : ""}
                    </span>
                    {l.archived && (
                      <span className="rounded-full bg-line/60 px-2 py-0.5 text-[9px] font-extrabold tracking-wider text-mut">ARCHIVED</span>
                    )}
                  </div>
                  {l.etsyListingId && (
                    <a
                      href={`https://www.etsy.com/your/shops/me/listing-editor/edit/${l.etsyListingId}`}
                      target="_blank" rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="Open in Etsy's listing editor"
                      className="absolute top-3.5 right-3.5 flex items-center gap-1.5 rounded-md border border-accent/40 px-2.5 py-1 text-[12.5px] font-semibold text-accent hover:bg-accent/5"
                    >
                      <ExternalLink size={14} /> Etsy
                    </a>
                  )}
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
                    <span className="font-mono text-[13px] font-semibold">${(l.input.basePriceMinor / 100).toFixed(2)}</span>
                    <span className={l.input.quantity === 0 ? "font-semibold text-warn" : "text-ink2"}>
                      {l.input.quantity === 0 ? "out of stock" : `${l.input.quantity} in stock`}
                    </span>
                    {l.input.skuMode === "listing_level" ? (
                      <span className="text-ink2">SKU <b className="font-mono">{l.input.listingSku ?? "—"}</b></span>
                    ) : (
                      <span className="text-ink2"><b className="font-mono">{l.configurations.filter((c) => c.enabled).length}</b> SKUs</span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-mut">
                    <span className="truncate">{productById.get(l.input.productId)?.name ?? `product ${l.input.productId}`}</span>
                    {l.etsyListingId && <span className="font-mono">etsy #{l.etsyListingId}</span>}
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
