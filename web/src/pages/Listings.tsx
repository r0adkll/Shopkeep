import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
import { Card, Wordmark } from "../ui";
import { inventoryApi } from "../inventory/api";
import { catalogApi, type Product } from "../catalog/api";
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

  const listings = useQuery({ queryKey: ["listings"], queryFn: listingsApi.list, enabled: !!me.data });
  const products = useQuery({ queryKey: ["products"], queryFn: catalogApi.products, enabled: !!me.data });
  useQuery({ queryKey: ["materials"], queryFn: inventoryApi.materials, enabled: !!me.data });

  const [editing, setEditing] = useState<{ listing?: Listing; product: Product } | null>(null);
  const [picking, setPicking] = useState(false);

  const productById = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);

  const open = useMutation({
    mutationFn: async (l: Listing) => ({ listing: l, product: await catalogApi.product(l.input.productId) }),
    onSuccess: (r) => setEditing(r),
  });
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
        <nav className="flex gap-4 text-sm">
          <Link to="/" className="text-ink2 hover:text-ink">Inventory</Link>
          <Link to="/products" className="text-ink2 hover:text-ink">Products</Link>
          <span className="font-semibold">Listings</span>
        </nav>
        <nav className="ml-auto flex items-center gap-4 text-sm">
          {!editing && (
            <button type="button" onClick={() => setPicking(true)} className="rounded-md bg-accent px-3.5 py-1.5 font-semibold text-white hover:opacity-90">
              + Listing
            </button>
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
            {(listings.data ?? []).map((l) => (
              <button key={l.id} type="button" onClick={() => open.mutate(l)} className="rounded-xl border border-line bg-panel p-5 text-left shadow-sm hover:border-accent">
                <div className="flex items-center gap-2.5">
                  <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{l.input.title}</h2>
                  <span className={`rounded-full px-2 py-0.5 text-[9.5px] font-extrabold tracking-wider ${STATE_STYLE[l.input.state] ?? ""}`}>
                    {l.input.state.toUpperCase()}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink2">
                  <span>{productById.get(l.input.productId)?.name ?? `product ${l.input.productId}`}</span>
                  <span><b className="font-mono">{l.configurations.filter((c) => c.enabled).length}</b> SKUs</span>
                  <span className="font-mono">${(l.input.basePriceMinor / 100).toFixed(2)}</span>
                  <span className="tracking-wider text-mut uppercase">{l.syncState.replace("_", " ")}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
