import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
import { Card, NavTabs, Wordmark } from "../ui";

type Variation = { propertyId: number; name: string; value: string };
type OrderLine = {
  id: number;
  title: string;
  rawSku: string | null;
  quantity: number;
  priceMinor: number;
  matchedSku: string | null;
  variations: Variation[];
  personalization: Variation[];
};
type Order = {
  id: number;
  platformOrderId: string;
  category: string;
  buyerName: string;
  buyerMessage: string | null;
  totalMinor: number;
  currency: string;
  placedAt: string | null;
  lines: OrderLine[];
};

const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;

/** Read-only ingest viewer — the queue BOARD is a Phase 4 concept-round surface. */
export function OrdersPage() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login" });
  }, [me.error, navigate]);

  const orders = useQuery({
    queryKey: ["orders"],
    queryFn: async () => {
      const r = await fetch("/api/v1/orders");
      if (!r.ok) throw new ApiError(r.status, r.statusText);
      return (await r.json()) as Order[];
    },
    enabled: !!me.data,
    refetchInterval: 30_000,
  });

  if (!me.data) return <main className="flex min-h-screen items-center justify-center text-mut">Loading…</main>;

  return (
    <div className="mx-auto max-w-4xl px-6 pb-16">
      <header className="mb-6 flex flex-wrap items-center gap-5 border-b border-line py-5">
        <Wordmark />
        <NavTabs active="Orders" />
        <span className="ml-auto text-sm text-ink2">{me.data.displayName}</span>
      </header>

      {(orders.data ?? []).length === 0 && !orders.isLoading && (
        <Card className="text-center">
          <h2 className="text-lg font-semibold">No orders yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink2">
            Orders ingest automatically from connected shops every few minutes (or via Sync now on a connection).
            The processing queue board arrives with Phase 4.
          </p>
        </Card>
      )}

      {(orders.data ?? []).map((o) => (
        <Card key={o.id} className="mb-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="text-[15px] font-semibold">{o.buyerName || "Unknown buyer"}</h2>
            <span className="font-mono text-xs text-mut">#{o.platformOrderId}</span>
            <span className="rounded-full bg-panel2 px-2 py-0.5 text-[10px] font-extrabold tracking-wider text-ink2 uppercase">
              {o.category}
            </span>
            <span className="ml-auto font-mono text-sm font-semibold">{money(o.totalMinor)}</span>
          </div>
          {o.buyerMessage && (
            <p className="mt-1.5 rounded-md bg-panel2 px-3 py-1.5 text-xs text-ink2 italic">“{o.buyerMessage}”</p>
          )}
          <div className="mt-2 divide-y divide-line/60">
            {o.lines.map((l) => (
              <div key={l.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <span className="font-mono text-xs text-mut">{l.quantity}×</span>
                  <span className="min-w-0 flex-1 font-medium">{l.title}</span>
                  {l.matchedSku ? (
                    <span className="font-mono text-xs font-semibold text-good" title={`raw: ${l.rawSku ?? "—"}`}>
                      {l.matchedSku}
                    </span>
                  ) : (
                    <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[10px] font-extrabold tracking-wider text-warn">
                      UNMATCHED · {l.rawSku ?? "no sku"}
                    </span>
                  )}
                  <span className="font-mono text-xs text-ink2">{money(l.priceMinor * l.quantity)}</span>
                </div>
                {(l.variations.length > 0 || l.personalization.length > 0) && (
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 pl-7 text-xs text-ink2">
                    {l.variations.map((v, i) => (
                      <span key={i}>
                        {v.name}: <b>{v.value}</b>
                      </span>
                    ))}
                    {l.personalization.map((p, i) => (
                      <span key={i} className="text-accent">
                        ✎ {p.name}: <b>{p.value}</b>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
