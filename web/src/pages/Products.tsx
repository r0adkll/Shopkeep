import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
import { Card, Wordmark } from "../ui";
import { catalogApi, type Product } from "../catalog/api";
import { ProductImage } from "../catalog/ProductImage";
import { RecipeEditor } from "../catalog/RecipeEditor";

const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;

export function ProductsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login" });
  }, [me.error, navigate]);

  const products = useQuery({ queryKey: ["products"], queryFn: catalogApi.products, enabled: !!me.data });
  const [editing, setEditing] = useState<Product | "new" | null>(null);

  const openProduct = useMutation({
    mutationFn: catalogApi.product,
    onSuccess: (p) => setEditing(p),
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
          <Link to="/" className="text-ink2 hover:text-ink">
            Inventory
          </Link>
          <span className="font-semibold">Products</span>
          <Link to="/listings" className="text-ink2 hover:text-ink">
            Listings
          </Link>
          <Link to="/connections" className="text-ink2 hover:text-ink">
            Connections
          </Link>
        </nav>
        <nav className="ml-auto flex items-center gap-4 text-sm">
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="rounded-md bg-accent px-3.5 py-1.5 font-semibold text-white hover:opacity-90"
            >
              + Product
            </button>
          )}
          <span className="text-ink2">{me.data.displayName}</span>
          <button type="button" onClick={() => logout.mutate()} className="text-accent hover:underline">
            Sign out
          </button>
        </nav>
      </header>

      {editing ? (
        <RecipeEditor existing={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />
      ) : (
        <>
          {(products.data ?? []).length === 0 && !products.isLoading && (
            <Card className="text-center">
              <h2 className="text-lg font-semibold">Define your first recipe</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-ink2">
                A product is a recipe: material slots plus rules. Its color palettes generate every sellable
                configuration — each with an exact bill of materials, cost, and SKU.
              </p>
              <button
                type="button"
                onClick={() => setEditing("new")}
                className="mt-4 rounded-md bg-accent px-4 py-2 font-semibold text-white hover:opacity-90"
              >
                New product
              </button>
            </Card>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {(products.data ?? []).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => openProduct.mutate(p.id)}
                className="flex gap-4 rounded-xl border border-line bg-panel p-5 text-left shadow-sm hover:border-accent"
              >
                <ProductImage imageDocumentId={p.imageDocumentId} size={64} />
                <div className="min-w-0">
                <div className="flex items-baseline gap-3">
                  <h2 className="text-[15px] font-semibold">{p.name}</h2>
                  <span className="font-mono text-xs text-mut">{p.skuPrefix}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink2">
                  <span>
                    <b className="font-mono">{p.configurationCount}</b> configurations
                  </span>
                  <span>
                    <b className="font-mono">{p.slotCount}</b> slots
                  </span>
                  {p.materialCostMinor != null && (
                    <span>
                      BOM <b className="font-mono">{money(p.materialCostMinor)}</b>
                    </span>
                  )}
                  {p.unresolvedCount > 0 && (
                    <span className="font-bold text-warn">▲ {p.unresolvedCount} unresolved</span>
                  )}
                </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
