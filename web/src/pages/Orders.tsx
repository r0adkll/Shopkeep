import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
import { ChevronLeft, ChevronRight, Copy, ExternalLink, Gift, Link2, Paperclip, RefreshCw, Settings2, X } from "lucide-react";
import { documentUrl, uploadImage } from "../catalog/api";
import { NavTabs, Wordmark } from "../ui";

/* Queue board per the locked concept (vault: Order Management / Design Process):
 * lanes are data with intake/done roles, arrival-only sentence rules,
 * product-prominent cards (one row per color, flush-left), chips never
 * color-alone, drag writes order_events. */

type Variation = { property_id: number; formatted_name: string; formatted_value: string };
type LineColor = { hex: string | null; name: string };
type OrderLine = {
  id: number;
  title: string;
  rawSku: string | null;
  quantity: number;
  priceMinor: number;
  matchedSku: string | null;
  matchedListing: boolean;
  matchedListingId: number | null;
  needsReview: boolean;
  reviewReasons: string[];
  productName: string | null;
  colors: LineColor[];
  variations: Variation[];
  personalization: Variation[];
};
type Order = {
  id: number;
  platformOrderId: string;
  buyerName: string;
  buyerMessage: string | null;
  totalMinor: number;
  currency: string;
  placedAt: string | null;
  laneId: number | null;
  flagShort: boolean;
  flagAdhoc: boolean;
  platformStatus: string;
  lines: OrderLine[];
};

const DEAD_STATUSES = ["canceled", "fully refunded"];
type LaneRule = { condition: string; value: string | null };
type Lane = { id: number | null; name: string; role: string | null; rules: LaneRule[] };
type OrderMaterial = {
  materialId: number;
  name: string;
  colorHex: string | null;
  quantity: number;
  unit: string;
  packaging: boolean;
  status: "reserved" | "short" | "consumed";
  availableNow: number | null;
};
type OrderEvent = { from: string | null; to: string; author: string | null; at: string | null };
type OrderNote = { id: number; author: string; body: string; documentIds: number[]; at: string | null };
type OrderDetail = {
  order: Order;
  shipFeesMinor: number | null;
  shipEstimateMinor: number | null;
  shipEstimateSource: "usps" | "profile" | null;
  shipName: string | null;
  shipLine1: string | null;
  shipLine2: string | null;
  shipCity: string | null;
  shipState: string | null;
  shipZip: string | null;
  shipCountry: string | null;
  paymentMethod: string | null;
  isGift: boolean;
  giftMessage: string | null;
  giftSender: string | null;
  subtotalMinor: number | null;
  shippingMinor: number | null;
  taxMinor: number | null;
  discountMinor: number | null;
  feesMinor: number | null;
  platformPaid: boolean;
  platformShipped: boolean;
  completedAt: string | null;
  materialsCostMinor: number | null;
  laborMinor: number | null;
  materials: OrderMaterial[];
  events: OrderEvent[];
  notes: OrderNote[];
};

const RULE_OPTIONS: { condition: string; label: string; needsValue?: "text" | "number" }[] = [
  { condition: "personalized", label: "personalized" },
  { condition: "shortfall", label: "material shortfall" },
  { condition: "unmatched", label: "unmatched line" },
  { condition: "adhoc_packaging", label: "ad-hoc packaging" },
  { condition: "platform", label: "platform =", needsValue: "text" },
  { condition: "units_gte", label: "units ≥", needsValue: "number" },
];
const ruleLabel = (r: LaneRule) => {
  const opt = RULE_OPTIONS.find((o) => o.condition === r.condition);
  return `${opt?.label ?? r.condition}${r.value ? ` ${r.value}` : ""}`;
};

const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const age = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / (60 * 24))}d`;
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new ApiError(r.status, (await r.text().catch(() => "")) || r.statusText);
  return (await r.json()) as T;
}

export function OrdersPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login" });
  }, [me.error, navigate]);

  const lanes = useQuery({
    queryKey: ["lanes"],
    queryFn: () => jsonFetch<Lane[]>("/api/v1/lanes"),
    enabled: !!me.data,
  });
  const orders = useQuery({
    queryKey: ["orders"],
    queryFn: () => jsonFetch<Order[]>("/api/v1/orders"),
    enabled: !!me.data,
    refetchInterval: 30_000,
  });

  const move = useMutation({
    mutationFn: ({ orderId, laneId }: { orderId: number; laneId: number }) =>
      jsonFetch(`/api/v1/orders/${orderId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ laneId }),
      }),
    onMutate: async ({ orderId, laneId }) => {
      await qc.cancelQueries({ queryKey: ["orders"] });
      const prev = qc.getQueryData<Order[]>(["orders"]);
      qc.setQueryData<Order[]>(["orders"], (os) =>
        (os ?? []).map((o) => (o.id === orderId ? { ...o, laneId } : o)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["orders"], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });

  const [dragId, setDragId] = useState<number | null>(null);
  const [overLane, setOverLane] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [rematchMsg, setRematchMsg] = useState<string | null>(null);
  const rematch = useMutation({
    mutationFn: () => jsonFetch<{ backfilled: number; matched: number }>("/api/v1/orders/rematch", { method: "POST" }),
    onSuccess: (r) => {
      setRematchMsg(`${r.backfilled} listing id${r.backfilled === 1 ? "" : "s"} backfilled · ${r.matched} line${r.matched === 1 ? "" : "s"} matched`);
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order"] });
    },
    onError: (e) => setRematchMsg(e instanceof Error ? e.message : "Re-run failed"),
  });

  if (!me.data) return <main className="flex min-h-screen items-center justify-center text-mut">Loading…</main>;
  const isAdmin = me.data.role === "ADMIN";
  const laneList = lanes.data ?? [];
  // Canceled/refunded on Etsy: reservations already released, hidden from the board.
  const all = (orders.data ?? []).filter((o) => !DEAD_STATUSES.includes(o.platformStatus));
  const doneLaneId = laneList.find((l) => l.role === "done")?.id ?? null;
  const open = all.filter((o) => o.laneId !== doneLaneId);
  const oldest = open.reduce<string | null>(
    (acc, o) => (o.placedAt && (!acc || o.placedAt < acc) ? o.placedAt : acc),
    null,
  );

  return (
    <div className="mx-auto max-w-[1400px] px-6 pb-16">
      <header className="mb-5 flex flex-wrap items-center gap-5 border-b border-line py-5">
        <Wordmark />
        <NavTabs active="Orders" />
        {isAdmin && (
          <span className="ml-auto flex items-center gap-2.5">
            {rematchMsg && <span className="text-xs text-ink2">{rematchMsg}</span>}
            <button
              onClick={() => rematch.mutate()}
              disabled={rematch.isPending}
              title="Backfill listing ids from Etsy receipts, then retro-match unmatched lines against activated listings and remembered matches"
              className="flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-1.5 text-sm font-semibold text-ink2 transition-colors hover:text-ink disabled:opacity-50"
            >
              <RefreshCw size={15} className={rematch.isPending ? "animate-spin" : ""} /> Re-run matching
            </button>
            <button
              onClick={() => setEditing((e) => !e)}
              className={`flex items-center gap-1.5 rounded-lg border px-3.5 py-1.5 text-sm font-semibold transition-colors ${
                editing ? "border-accent text-accent" : "border-line text-ink2 hover:text-ink"
              }`}
            >
              <Settings2 size={15} /> Customize lanes…
            </button>
          </span>
        )}
        <span className={`${isAdmin ? "" : "ml-auto "}text-sm text-ink2`}>{me.data.displayName}</span>
      </header>

      {/* Summary strip — segmented card, no sub-captions (design system) */}
      <div className="mb-4 grid grid-cols-2 divide-line rounded-xl border border-line bg-panel shadow-sm sm:grid-cols-4 sm:divide-x">
        {(
          [
            ["Open orders", String(open.length)],
            ["Units to build", String(open.reduce((a, o) => a + o.lines.reduce((s, l) => s + l.quantity, 0), 0))],
            ["Queue value", money(open.reduce((a, o) => a + o.totalMinor, 0))],
            ["Oldest open", oldest ? age(oldest) : "—"],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="px-5 py-3.5">
            <div className="text-[10px] font-extrabold tracking-widest text-mut uppercase">{label}</div>
            <div className="mt-0.5 font-mono text-xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      {editing && isAdmin && <LaneEditor lanes={laneList} onSaved={() => qc.invalidateQueries({ queryKey: ["lanes"] })} />}

      {lanes.isLoading || orders.isLoading ? (
        <p className="py-10 text-center text-sm text-mut">Loading queue…</p>
      ) : (
        <div
          className="grid gap-3 overflow-x-auto"
          style={{ gridTemplateColumns: `repeat(${Math.max(laneList.length, 1)}, minmax(215px, 1fr))` }}
        >
          {laneList.map((lane) => {
            const cards = all.filter((o) => o.laneId === lane.id);
            return (
              <div
                key={lane.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverLane(lane.id);
                }}
                onDragLeave={() => setOverLane((cur) => (cur === lane.id ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverLane(null);
                  // Clear here, not just in dragend: the optimistic move unmounts
                  // the dragged card, so its dragend never fires and it would
                  // stay dimmed in the new lane.
                  const dropped = dragId;
                  setDragId(null);
                  if (dropped != null && lane.id != null) move.mutate({ orderId: dropped, laneId: lane.id });
                }}
                className={`min-h-[340px] min-w-0 rounded-xl border bg-panel2 p-2 transition-colors ${
                  overLane === lane.id ? "border-accent" : "border-line"
                }`}
              >
                <div className="flex items-baseline gap-2 px-1.5 pt-1 pb-2">
                  <span className="text-[11px] font-extrabold tracking-widest text-ink2 uppercase">{lane.name}</span>
                  <span className="font-mono text-[11px] text-mut">{cards.length}</span>
                  {lane.rules.length > 0 && (
                    <span className="ml-auto truncate text-[9px] text-mut" title={lane.rules.map(ruleLabel).join(", ")}>
                      auto: {lane.rules.map(ruleLabel).join(", ")}
                    </span>
                  )}
                  {lane.role && (
                    <span className={`${lane.rules.length > 0 ? "" : "ml-auto "}text-[9px] font-extrabold text-accent`}>
                      {lane.role.toUpperCase()}
                    </span>
                  )}
                </div>
                {cards.map((o) => (
                  <OrderCard
                    key={o.id}
                    order={o}
                    laneRole={lane.role}
                    dragging={dragId === o.id}
                    selected={openId === o.id}
                    onDragStart={() => setDragId(o.id)}
                    onDragEnd={() => setDragId(null)}
                    onOpen={() => setOpenId(o.id)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {all.length === 0 && !orders.isLoading && (
        <p className="mt-6 text-center text-sm text-ink2">
          No orders yet — they ingest automatically from connected shops every few minutes.
        </p>
      )}

      {openId != null && (
        <OrderDetailPanel
          orderId={openId}
          lanes={laneList}
          boardOrder={laneList.flatMap((l) => all.filter((o) => o.laneId === l.id).map((o) => o.id))}
          onNavigate={setOpenId}
          onClose={() => setOpenId(null)}
          onMove={(orderId, laneId) => move.mutate({ orderId, laneId })}
        />
      )}
    </div>
  );
}

const SECTION_H = "mb-1.5 text-[10px] font-extrabold tracking-widest text-mut uppercase";

/** Slide-over order detail per the locked concept (2026-08-02, nine rounds). */
function OrderDetailPanel(props: {
  orderId: number;
  lanes: Lane[];
  boardOrder: number[];
  onNavigate: (id: number) => void;
  onClose: () => void;
  onMove: (orderId: number, laneId: number) => void;
}) {
  const { orderId, lanes, boardOrder, onNavigate, onClose, onMove } = props;
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => jsonFetch<OrderDetail>(`/api/v1/orders/${orderId}`),
  });
  const [matching, setMatching] = useState<OrderLine | null>(null);
  const [reresolveErr, setReresolveErr] = useState<string | null>(null);
  const reresolve = useMutation({
    mutationFn: (lineId: number) => jsonFetch(`/api/v1/orders/lines/${lineId}/reresolve`, { method: "POST" }),
    onSuccess: () => {
      setReresolveErr(null);
      qc.invalidateQueries({ queryKey: ["order", orderId] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (e) => setReresolveErr(e instanceof Error ? e.message : "Re-resolve failed."),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === "Escape") onClose();
      const ix = boardOrder.indexOf(orderId);
      if (e.key === "ArrowLeft" && boardOrder.length > 0)
        onNavigate(boardOrder[(ix - 1 + boardOrder.length) % boardOrder.length]);
      if (e.key === "ArrowRight" && boardOrder.length > 0) onNavigate(boardOrder[(ix + 1) % boardOrder.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orderId, boardOrder, onClose, onNavigate]);

  const d = detail.data;
  const o = d?.order;
  const step = (delta: number) => {
    const ix = boardOrder.indexOf(orderId);
    if (boardOrder.length > 0) onNavigate(boardOrder[(ix + delta + boardOrder.length) % boardOrder.length]);
  };
  const fmtWhen = (iso: string | null) => (iso ? age(iso) : "");
  const revenue = o && d ? o.totalMinor - (d.taxMinor ?? 0) : 0;
  const net =
    d?.materialsCostMinor != null
      ? revenue - (d.feesMinor ?? 0) - (d.shipFeesMinor ?? 0) - d.materialsCostMinor - (d.laborMinor ?? 0) - (d.shipEstimateMinor ?? 0)
      : null;

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/30" onClick={onClose} />
      {matching && (
        <MatchDialog
          line={matching}
          onClose={() => setMatching(null)}
          onMatched={() => {
            setMatching(null);
            qc.invalidateQueries({ queryKey: ["order", orderId] });
            qc.invalidateQueries({ queryKey: ["orders"] });
          }}
        />
      )}
      <aside className="fixed top-0 right-0 bottom-0 z-40 flex w-[min(480px,94vw)] flex-col border-l border-line bg-panel shadow-2xl">
        {/* header */}
        <div className="border-b border-line px-5 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <span className="rounded bg-[#F1641E] px-1.5 py-0.5 text-[8.5px] font-extrabold tracking-wider text-white">ETSY</span>
            <span className="min-w-0 truncate text-[16px] font-bold">{o?.buyerName ?? "…"}</span>
            <span className="ml-auto flex gap-1">
              <button onClick={() => step(-1)} title="previous (←)" className="flex h-6 w-6 items-center justify-center rounded-md border border-line bg-panel2 text-ink2 hover:border-accent hover:text-ink"><ChevronLeft size={14} /></button>
              <button onClick={() => step(1)} title="next (→)" className="flex h-6 w-6 items-center justify-center rounded-md border border-line bg-panel2 text-ink2 hover:border-accent hover:text-ink"><ChevronRight size={14} /></button>
              <button onClick={onClose} title="close (esc)" className="flex h-6 w-6 items-center justify-center rounded-md border border-line bg-panel2 text-ink2 hover:border-accent hover:text-ink"><X size={14} /></button>
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-xs text-ink2">
            <span className="font-mono">#{o?.platformOrderId}</span>
            {o && (
              <a
                href={`https://www.etsy.com/your/orders/sold?order_id=${o.platformOrderId}`}
                target="_blank" rel="noreferrer"
                title="Open in Etsy Shop Manager — buyer username & conversation live there (the API doesn't expose them)"
                className="flex items-center gap-1 rounded-md border border-accent/40 px-2 py-0.5 text-[11px] font-semibold text-accent hover:bg-accent/5"
              >
                <ExternalLink size={11} /> Etsy
              </a>
            )}
            {o?.placedAt && <span>placed {age(o.placedAt)} ago</span>}
            <span className="flex items-center gap-1.5">
              <span className="text-[10px] font-extrabold tracking-widest text-mut">LANE</span>
              <select
                value={o?.laneId ?? ""}
                onChange={(e) => {
                  const laneId = Number(e.target.value);
                  onMove(orderId, laneId);
                  setTimeout(() => qc.invalidateQueries({ queryKey: ["order", orderId] }), 300);
                }}
                className="rounded-full border border-line bg-panel2 px-2.5 py-0.5 text-[11.5px] font-bold outline-none focus:border-accent"
              >
                {lanes.map((l) => (
                  <option key={l.id} value={l.id ?? ""}>{l.name}</option>
                ))}
              </select>
            </span>
          </div>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {detail.isLoading && <p className="py-8 text-center text-sm text-mut">Loading…</p>}
          {d && o && (
            <>
              {o.buyerMessage && (
                <div className="mt-3 rounded-r-lg border-l-[3px] border-accent bg-panel2 px-3 py-2 text-xs text-ink2 italic">
                  “{o.buyerMessage}”
                </div>
              )}

              {(d.shipLine1 || d.shipCity) && (
                <div className="mt-4">
                  <div className={`${SECTION_H} flex items-center`}>
                    Ship to
                    <button
                      onClick={() => {
                        navigator.clipboard?.writeText(
                          [d.shipName, [d.shipLine1, d.shipLine2].filter(Boolean).join(", "),
                            `${d.shipCity ?? ""}, ${d.shipState ?? ""} ${d.shipZip ?? ""}`, d.shipCountry]
                            .filter(Boolean).join("\n"),
                        );
                      }}
                      className="ml-2 flex items-center gap-1 rounded-md border border-line bg-panel2 px-2 py-px text-[10px] font-bold text-ink2 normal-case hover:border-accent hover:text-accent"
                    >
                      <Copy size={11} /> copy
                    </button>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="text-xs leading-relaxed text-ink2">
                      <b className="text-ink">{d.shipName}</b>
                      <br />{d.shipLine1}{d.shipLine2 ? `, ${d.shipLine2}` : ""}
                      <br />{d.shipCity}, {d.shipState} {d.shipZip}
                      <br />{d.shipCountry}
                      {d.paymentMethod && <div className="mt-1 text-[11px] text-mut">{d.paymentMethod}</div>}
                    </div>
                    <span className="ml-auto flex flex-none flex-col items-end gap-1">
                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold tracking-wider ${d.platformPaid ? "bg-good/10 text-good" : "bg-panel2 text-ink2"}`}>
                        {d.platformPaid ? "✓ PAID" : "UNPAID"}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold tracking-wider ${d.platformShipped ? "bg-good/10 text-good" : "bg-panel2 text-ink2"}`}>
                        {d.platformShipped ? "✓ SHIPPED" : "NOT SHIPPED"}
                      </span>
                      {d.isGift && (
                        <span className="flex items-center gap-1 rounded-full border border-dashed border-accent bg-accent/10 px-2 py-0.5 text-[9px] font-extrabold tracking-wider text-accent">
                          <Gift size={10} /> GIFT
                        </span>
                      )}
                    </span>
                  </div>
                  {d.isGift && d.giftMessage && (
                    <div className="mt-2 rounded-r-lg border-l-[3px] border-accent bg-panel2 px-3 py-1.5 text-xs text-ink2 italic">
                      “{d.giftMessage}” {d.giftSender && <span className="text-mut not-italic">— from {d.giftSender}</span>}
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4">
                <div className={SECTION_H}>Items</div>
                {o.lines.map((l) => (
                  <div
                    key={l.id}
                    onClick={l.matchedListingId != null ? () => {
                      if (window.getSelection()?.toString()) return; // selecting text ≠ navigating
                      window.location.href = `/listings?listing=${l.matchedListingId}`;
                    } : undefined}
                    title={l.matchedListingId != null ? "open the matched listing" : undefined}
                    className={`mb-2 rounded-lg px-3 py-2.5 ${
                      l.matchedListingId != null
                        ? "group cursor-pointer border border-good/40 border-l-[3px] border-l-good hover:border-accent hover:border-l-accent"
                        : "border border-line/70"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="flex-none font-mono text-[10.5px] text-mut">{l.quantity}×</span>
                      <span className="min-w-0 truncate text-sm font-bold">{l.productName ?? l.title}</span>
                      <span className="ml-auto flex-none font-mono text-xs text-ink2">{money(l.priceMinor * l.quantity)}</span>
                    </div>
                    {l.colors.map((c, i) => (
                      <div key={i} className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink2">
                        <span className="h-2.5 w-2.5 flex-none rounded-full border border-line" style={{ background: c.hex ?? "var(--color-panel2)" }} />
                        <span className="min-w-0 truncate">{c.name}</span>
                      </div>
                    ))}
                    {l.variations.length > 0 && (
                      <div className="mt-1 text-[11px] text-mut">
                        {l.variations.map((v, i) => (
                          <span key={i}>{i > 0 && " · "}{v.formatted_name}: <b className="text-ink2">{v.formatted_value}</b></span>
                        ))}
                      </div>
                    )}
                    {l.personalization.length > 0 && (
                      <div className="mt-1.5 rounded-lg border border-accent bg-accent/5 px-2.5 py-1.5">
                        <div className="text-[9px] font-extrabold tracking-widest text-accent uppercase">✎ Personalization</div>
                        {l.personalization.map((p, i) => (
                          <div key={i} className="flex items-baseline gap-3 py-0.5 text-xs">
                            <span className="min-w-0 flex-1 text-ink2">{p.formatted_name}</span>
                            <span className="font-mono font-bold break-all">{p.formatted_value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-1.5 flex items-center gap-2 border-t border-dotted border-line/60 pt-1 text-[11px]">
                      {l.matchedSku ? (
                        <span className="font-mono font-semibold text-good">✓ {l.matchedSku}</span>
                      ) : l.matchedListing ? (
                        <>
                          <span className="font-mono font-semibold text-good">✓ via listing{l.needsReview ? <b className="text-warn"> · needs review</b> : ""}</span>
                          <button
                            type="button"
                            title="Release this line's reservations and resolve again from the listing's current mappings — use after fixing the listing"
                            disabled={reresolve.isPending}
                            onClick={(e) => { e.stopPropagation(); reresolve.mutate(l.id); }}
                            className="ml-auto flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[10px] font-semibold text-ink2 hover:border-accent hover:text-accent disabled:opacity-50"
                          >
                            <RefreshCw size={10} className={reresolve.isPending ? "animate-spin" : ""} /> re-resolve
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="font-mono text-mut">raw sku: {l.rawSku ?? "—"}</span>
                          <button
                            type="button"
                            onClick={() => setMatching(l)}
                            className="ml-auto flex items-center gap-1 rounded-md border border-accent/40 px-2 py-0.5 text-[10.5px] font-semibold text-accent hover:bg-accent/5"
                          >
                            <Link2 size={11} /> Match…
                          </button>
                        </>
                      )}
                    </div>
                    {l.needsReview && l.matchedListing && (
                      <div className="mt-1.5 rounded-lg border border-warn/50 bg-warn/5 px-2.5 py-1.5">
                        <div className="text-[9px] font-extrabold tracking-widest text-warn uppercase">Needs review — couldn't fully resolve</div>
                        {(l.reviewReasons.length > 0 ? l.reviewReasons : ["an option couldn't be resolved when this line was matched — re-resolve to see current details"]).map((r, i) => (
                          <div key={i} className="mt-0.5 text-[11px] leading-snug text-ink2">· {r}</div>
                        ))}
                        <div className="mt-1 text-[10px] text-mut">Fix the mapping on the listing (or its product's designs), then <b>re-resolve</b> — reservations are released and redone from the new answer.</div>
                      </div>
                    )}
                  </div>
                ))}
                {reresolveErr && <p className="mb-2 text-xs font-medium text-crit">{reresolveErr}</p>}
                <table className="w-full text-xs">
                  <tbody>
                    {d.subtotalMinor != null && (
                      <tr><td className="py-0.5 text-ink2">Subtotal</td><td className="py-0.5 text-right font-mono text-ink2">{money(d.subtotalMinor)}</td></tr>
                    )}
                    {d.shippingMinor != null && (
                      <tr><td className="py-0.5 text-ink2">Shipping</td><td className="py-0.5 text-right font-mono text-ink2">{d.shippingMinor ? money(d.shippingMinor) : "Free"}</td></tr>
                    )}
                    {d.taxMinor != null && (
                      <tr><td className="py-0.5 text-ink2">Tax <span className="text-[10px] text-mut">Etsy remits</span></td><td className="py-0.5 text-right font-mono text-ink2">{money(d.taxMinor)}</td></tr>
                    )}
                    {(d.discountMinor ?? 0) > 0 && (
                      <tr><td className="py-0.5 text-ink2">Discount</td><td className="py-0.5 text-right font-mono text-good">−{money(d.discountMinor!)}</td></tr>
                    )}
                    <tr className="border-t border-line/70 font-bold">
                      <td className="pt-1.5">Buyer paid</td><td className="pt-1.5 text-right font-mono">{money(o.totalMinor)}</td>
                    </tr>
                    {d.materialsCostMinor != null ? (
                      <>
                        {d.feesMinor != null && (
                          <tr><td className="border-t border-dashed border-line pt-1.5 text-ink2" title="amount_fees from the Etsy payments API">Etsy fees</td><td className="border-t border-dashed border-line pt-1.5 text-right font-mono text-ink2">−{money(d.feesMinor)}</td></tr>
                        )}
                        {d.shipFeesMinor != null && (
                          <tr><td className="py-0.5 text-ink2" title="receipt-linked shipping_transaction entries from Etsy's payment ledger — exact">Shipping fees</td><td className="py-0.5 text-right font-mono text-ink2">−{money(d.shipFeesMinor)}</td></tr>
                        )}
                        <tr><td className="py-0.5 text-ink2" title="this order's reserved bill of materials × material costs">Materials</td><td className="py-0.5 text-right font-mono text-ink2">−{money(d.materialsCostMinor)}</td></tr>
                        <tr><td className="py-0.5 text-ink2" title="per-product labor × global labor rate">Labor</td><td className="py-0.5 text-right font-mono text-ink2">−{money(d.laborMinor ?? 0)}</td></tr>
                        {d.shipEstimateMinor != null && (
                          <tr>
                            <td className="py-0.5 text-ink2" title={d.shipEstimateSource === "usps"
                              ? "live USPS commercial-rate quote from this order's weight, box, and destination ZIP"
                              : "expected postage from the packaging profile — connect USPS for live quotes"}>
                              Shipping label{" "}
                              {d.shipEstimateSource === "usps"
                                ? <span className="rounded bg-accent/10 px-1 text-[8.5px] font-extrabold tracking-wider text-accent">USPS EST</span>
                                : <span className="rounded bg-warn/10 px-1 text-[8.5px] font-extrabold tracking-wider text-warn">EST</span>}
                            </td>
                            <td className="py-0.5 text-right font-mono text-ink2">−{money(d.shipEstimateMinor)}</td>
                          </tr>
                        )}
                        {net != null && (
                          <tr className="border-t border-line/70 font-bold text-good">
                            <td className="pt-1.5">Net profit {revenue > 0 && <span className="text-[10px] font-semibold text-mut">{Math.round((net / revenue) * 100)}% margin</span>}</td>
                            <td className="pt-1.5 text-right font-mono">{money(net)}</td>
                          </tr>
                        )}
                      </>
                    ) : (
                      <tr><td className="border-t border-dashed border-line pt-1.5 text-ink2">Net profit</td><td className="border-t border-dashed border-line pt-1.5 text-right text-[11px] text-mut italic">match the line to compute</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-4">
                <div className={SECTION_H}>Materials <span className="ml-1 font-semibold tracking-normal normal-case">from the reservation ledger</span></div>
                {d.materials.length === 0 ? (
                  <p className="text-xs text-warn">Nothing reserved — line unmatched.</p>
                ) : (
                  <table className="w-full text-xs">
                    <tbody>
                      {d.materials.map((m) => (
                        <tr
                          key={`${m.materialId}-${m.packaging}`}
                          onClick={() => { window.location.href = `/?material=${m.materialId}`; }}
                          title="open in Inventory"
                          className="group cursor-pointer border-b border-line/50 last:border-0 hover:bg-accent/5"
                        >
                          <td className="py-1.5">
                            <span className="flex items-center gap-1.5">
                              <span className="h-2.5 w-2.5 flex-none rounded-full border border-line" style={{ background: m.colorHex ?? "var(--color-panel2)" }} />
                              <span className="min-w-0 truncate group-hover:text-accent group-hover:underline">{m.name}</span>
                              {m.packaging && <span className="rounded bg-panel2 px-1 text-[8.5px] font-extrabold tracking-wider text-mut">PKG</span>}
                              <span className="text-[10px] text-accent opacity-0 group-hover:opacity-100">↗</span>
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono whitespace-nowrap text-ink2">{+m.quantity.toFixed(2)} {m.unit}</td>
                          <td className={`py-1.5 text-right text-[11px] font-semibold whitespace-nowrap ${m.status === "short" ? "text-crit" : m.status === "consumed" ? "font-normal text-mut" : "text-good"}`}>
                            {m.status === "short" ? `SHORT — ${+(-(m.availableNow ?? 0)).toFixed(2)} ${m.unit} over` : m.status === "consumed" ? "consumed" : "✓ reserved"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <NotesSection orderId={orderId} notes={d.notes} onAdded={() => qc.invalidateQueries({ queryKey: ["order", orderId] })} />

              <div className="mt-4">
                <div className={SECTION_H}>Activity <span className="ml-1 font-semibold tracking-normal normal-case">every move is an order_event</span></div>
                <ul>
                  {d.events.map((e, i) => (
                    <li key={i} className="flex items-baseline gap-2 py-1 text-xs text-ink2">
                      <span className={`relative top-px h-1.5 w-1.5 flex-none rounded-full ${e.author ? "bg-good" : "bg-accent"}`} />
                      <span className="min-w-0">
                        {e.from ? <>Moved to <b className="text-ink">{e.to}</b></> : <>Arrived in <b className="text-ink">{e.to}</b></>}
                        {e.author ? <> by <b className="text-ink">{e.author}</b></> : <span className="text-mut"> · auto</span>}
                      </span>
                      <span className="ml-auto flex-none font-mono text-[10.5px] text-mut">{fmtWhen(e.at)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center gap-3 border-t border-line px-5 py-3">
          <span className="font-mono text-[15px] font-bold">{o ? money(o.totalMinor) : "…"} <span className="text-[10px] font-semibold text-mut">{o?.currency}</span></span>
          <button
            disabled
            title="Phase 5: buy label + print insert slip"
            className="ml-auto cursor-not-allowed rounded-lg bg-accent/40 px-4 py-1.5 text-sm font-bold text-white"
          >
            Ship…
          </button>
        </div>
      </aside>
    </>
  );
}

/** Shopkeep-native private notes — text + photos; nothing syncs to Etsy. */
/** Manual match: pick the canonical listing this line sells. Remembering
 *  stores platform-listing-id -> listing so future lines match on arrival. */
function MatchDialog({ line, onClose, onMatched }: { line: OrderLine; onClose: () => void; onMatched: () => void }) {
  const [q, setQ] = useState("");
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const listings = useQuery({
    queryKey: ["listings-for-match"],
    queryFn: () => jsonFetch<{ id: number; etsyListingId: string | null; archived: boolean; input: { title: string; state: string } }[]>("/api/v1/listings"),
  });
  const match = useMutation({
    mutationFn: (listingId: number) =>
      jsonFetch<{ ok: boolean; sweptSiblings: number }>(`/api/v1/orders/lines/${line.id}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId, remember }),
      }),
    onSuccess: () => onMatched(),
    onError: (e) => setErr(e instanceof Error ? e.message : "Match failed."),
  });
  const rows = (listings.data ?? []).filter((l) => !l.archived && l.input.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose} />
      <div className="fixed inset-x-0 top-16 z-50 mx-auto flex max-h-[70vh] w-[min(520px,94vw)] flex-col rounded-2xl border border-line bg-bg shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <span className="min-w-0 flex-1 truncate text-[14px] font-bold">Match “{line.title}”</span>
          <button onClick={onClose} className="rounded-md border border-line p-1 text-ink2 hover:text-ink"><X size={15} /></button>
        </div>
        <div className="border-b border-line px-5 py-3">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your listings…"
            className="w-full rounded-md border border-line bg-panel2 px-3 py-1.5 text-sm outline-none placeholder:text-mut focus:border-accent"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {listings.isLoading && <p className="px-2 py-4 text-sm text-mut">Loading listings…</p>}
          {!listings.isLoading && rows.length === 0 && <p className="px-2 py-4 text-center text-sm text-mut">No listings match.</p>}
          {rows.map((l, i) => (
            <button
              key={l.id}
              type="button"
              disabled={match.isPending}
              onClick={() => match.mutate(l.id)}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent/5 disabled:opacity-50 ${i % 2 ? "" : "bg-panel2/60"}`}
            >
              <span className="min-w-0 flex-1 truncate">{l.input.title}</span>
              <span className="flex-none text-[10px] font-bold tracking-wider text-mut uppercase">{l.input.state}</span>
              {l.etsyListingId && <span className="flex-none font-mono text-[10px] text-mut">#{l.etsyListingId}</span>}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <label className="flex items-center gap-1.5 text-xs text-ink2">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-accent" />
            remember — future orders from this Etsy listing match automatically
          </label>
          {match.isPending && <span className="ml-auto text-xs text-mut">Matching + reserving…</span>}
          {err && <span className="ml-auto text-xs text-crit">{err}</span>}
        </div>
      </div>
    </>
  );
}

function NotesSection({ orderId, notes, onAdded }: { orderId: number; notes: OrderNote[]; onAdded: () => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const post = async () => {
    if (!text.trim() && files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const ids = [];
      for (const f of files) ids.push(await uploadImage(f, "order-note"));
      await jsonFetch(`/api/v1/orders/${orderId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text.trim(), documentIds: ids }),
      });
      setText("");
      setFiles([]);
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to post note.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <div className={SECTION_H}>Notes <span className="ml-1 font-semibold tracking-normal normal-case">private to the shop — never leaves Shopkeep</span></div>
      {notes.length === 0 && <p className="py-1 text-xs text-mut italic">No notes yet — spool swaps, color checks, anything the next shift should see.</p>}
      {notes.map((n) => (
        <div key={n.id} className="flex gap-2 border-b border-line/50 py-2 last:border-0">
          <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-accent/15 text-[10px] font-extrabold text-accent">
            {n.author.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 text-[11px] text-mut">
              <b className="text-xs text-ink">{n.author}</b>
              {n.at && <span>{age(n.at)} ago</span>}
            </div>
            {n.body && <div className="mt-0.5 text-xs leading-relaxed text-ink2">{n.body}</div>}
            {n.documentIds.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {n.documentIds.map((id) => (
                  <a key={id} href={documentUrl(id)} target="_blank" rel="noreferrer" className="block h-16 w-20 overflow-hidden rounded-lg border border-line">
                    <img src={documentUrl(id)} alt="note attachment" className="h-full w-full object-cover" />
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
      <div className="mt-2 rounded-lg border border-line bg-panel2 p-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a private note… (supports photos)"
          rows={2}
          className="w-full resize-none bg-transparent text-xs text-ink outline-none"
        />
        <div className="mt-1 flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])}
          />
          <button
            onClick={() => fileInput.current?.click()}
            className={`flex items-center gap-1 rounded-md border border-dashed px-2 py-0.5 text-[11px] ${files.length ? "border-accent text-accent" : "border-line text-ink2"}`}
          >
            <Paperclip size={11} /> {files.length ? `${files.length} photo${files.length > 1 ? "s" : ""}` : "Attach photo"}
          </button>
          {files.length > 0 && (
            <button onClick={() => setFiles([])} className="text-[11px] text-mut hover:text-crit">clear</button>
          )}
          {error && <span className="text-[11px] text-crit">{error}</span>}
          <button
            onClick={post}
            disabled={busy || (!text.trim() && files.length === 0)}
            className="ml-auto rounded-md bg-accent px-3 py-1 text-xs font-bold text-white disabled:opacity-40"
          >
            {busy ? "Posting…" : "Post note"}
          </button>
        </div>
      </div>
    </div>
  );
}

function OrderCard(props: {
  order: Order;
  laneRole: string | null;
  dragging: boolean;
  selected: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const o = props.order;
  const anyUnmatched = o.lines.some((l) => !l.matchedSku && !l.matchedListing);
  const anyReview = o.lines.some((l) => l.needsReview);
  const pers = o.lines.flatMap((l) => l.personalization);
  const multi = o.lines.length > 1;
  const orderAge = age(o.placedAt);
  const old = orderAge.endsWith("d");
  const didDrag = useRef(false);

  return (
    <div
      draggable
      onDragStart={(e) => {
        didDrag.current = true;
        e.dataTransfer.setData("text", String(o.id));
        props.onDragStart();
      }}
      onDragEnd={() => {
        props.onDragEnd();
        setTimeout(() => (didDrag.current = false), 0);
      }}
      onClick={(e) => {
        if (didDrag.current) return;
        if ((e.target as HTMLElement).closest("summary")) return;
        props.onOpen();
      }}
      className={`mb-2 cursor-pointer rounded-[10px] border bg-panel px-3 py-2.5 shadow-sm transition-colors hover:border-accent ${
        props.selected ? "border-accent ring-1 ring-accent" : "border-line"
      } ${props.dragging ? "opacity-40" : ""}`}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="min-w-0 truncate text-[13px] font-[650]">{o.buyerName || "Unknown buyer"}</span>
        <span
          className={`ml-auto font-mono text-[10.5px] whitespace-nowrap ${old ? "font-bold text-warn" : "text-mut"}`}
        >
          {orderAge}
        </span>
      </div>

      <div className="mt-1.5 grid gap-1">
        {o.lines.map((l) => {
          const head = (
            <>
              <span className="flex-none font-mono text-[10.5px] text-mut">{l.quantity}×</span>
              <span className="min-w-0 truncate text-[13.5px] font-bold text-ink">{l.productName ?? l.title}</span>
            </>
          );
          const rows = (l.colors.length > 0 ? l.colors : !l.matchedSku ? [{ hex: null, name: `unknown — raw sku ${l.rawSku ?? "—"}` }] : []).map(
            (c, i) => (
              <div key={i} className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink2">
                <span
                  className="h-2.5 w-2.5 flex-none rounded-full border border-line"
                  style={{ background: c.hex ?? "var(--color-panel2)" }}
                />
                <span className="min-w-0 truncate">{c.name}</span>
              </div>
            ),
          );
          // Per locked concept: multi-item orders collapse each item by default.
          return multi ? (
            <details key={l.id} className="group min-w-0 text-xs text-ink2">
              <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
                <span className="flex-none text-[9px] text-mut transition-transform group-open:rotate-90">▶</span>
                {head}
              </summary>
              <div className="min-w-0 pl-0">{rows}</div>
            </details>
          ) : (
            <div key={l.id} className="min-w-0 text-xs text-ink2">
              <div className="flex min-w-0 items-center gap-1.5">{head}</div>
              {rows}
            </div>
          );
        })}
      </div>

      {(pers.length > 0 || o.flagShort || o.flagAdhoc || anyUnmatched || anyReview) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {pers.map((p, i) => (
            <span
              key={i}
              title={p.formatted_name}
              className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-white"
            >
              ✎ {p.formatted_value}
            </span>
          ))}
          {o.flagShort && (
            <span className="rounded-full bg-crit/10 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-crit">
              SHORT
            </span>
          )}
          {o.flagAdhoc && (
            <span className="rounded-full border border-dashed border-warn bg-warn/10 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-warn">
              PACK REVIEW
            </span>
          )}
          {anyUnmatched && (
            <span className="rounded-full bg-warn/10 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-warn">
              UNMATCHED
            </span>
          )}
          {anyReview && (
            <span className="rounded-full bg-warn/10 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wider text-warn">
              REVIEW
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 border-t border-dotted border-line/70 pt-1.5">
        <span className="font-mono text-xs font-[650]">{money(o.totalMinor)}</span>
        {o.buyerMessage && (
          <span className="min-w-0 truncate text-[10.5px] text-mut italic" title={o.buyerMessage}>
            “{o.buyerMessage}”
          </span>
        )}
        {props.laneRole !== "done" && !anyUnmatched && (
          <button
            title="Phase 5: buy label + print insert slip"
            disabled
            className="ml-auto cursor-not-allowed rounded-md bg-accent/40 px-2.5 py-1 text-[11px] font-bold text-white"
          >
            Ship…
          </button>
        )}
      </div>
    </div>
  );
}

/** Admin lane editor — full-replace save, mirrors the concept's panel. */
function LaneEditor({ lanes, onSaved }: { lanes: Lane[]; onSaved: () => void }) {
  const [draft, setDraft] = useState<Lane[]>(() => lanes.map((l) => ({ ...l, rules: [...l.rules] })));
  const [error, setError] = useState<string | null>(null);
  const [pendingRule, setPendingRule] = useState<{ lane: number; condition: string; value: string } | null>(null);

  const save = useMutation({
    mutationFn: () =>
      jsonFetch<Lane[]>("/api/v1/lanes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      }),
    onSuccess: (fresh) => {
      setDraft(fresh.map((l) => ({ ...l, rules: [...l.rules] })));
      setError(null);
      onSaved();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Save failed."),
  });

  const upd = (fn: (d: Lane[]) => Lane[]) => setDraft((d) => fn(d.map((l) => ({ ...l, rules: [...l.rules] }))));
  const swap = (i: number, j: number) =>
    upd((d) => {
      [d[i], d[j]] = [d[j], d[i]];
      return d;
    });

  return (
    <div className="mb-4 rounded-xl border-[1.5px] border-accent bg-panel p-4 shadow-sm">
      <div className="mb-2 text-[11px] font-extrabold tracking-widest text-accent">
        LANES ARE YOURS — ADD, RENAME, REORDER, AND WIRE AUTO-RULES. INTAKE AND DONE ROLES ARE THE ONLY FIXED SEMANTICS.
      </div>
      {draft.map((l, i) => (
        <div key={l.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2 border-b border-dotted border-line/70 py-1.5">
          <span className="flex gap-0.5">
            <button
              disabled={i === 0}
              onClick={() => swap(i, i - 1)}
              className="rounded border border-line bg-panel2 px-1.5 py-0.5 text-[10px] disabled:opacity-30"
            >
              ↑
            </button>
            <button
              disabled={i === draft.length - 1}
              onClick={() => swap(i, i + 1)}
              className="rounded border border-line bg-panel2 px-1.5 py-0.5 text-[10px] disabled:opacity-30"
            >
              ↓
            </button>
          </span>
          <input
            value={l.name}
            onChange={(e) => upd((d) => ((d[i].name = e.target.value), d))}
            className="w-44 border-b border-dashed border-line bg-transparent text-[13px] font-semibold outline-none focus:border-accent"
          />
          {l.role ? (
            <span className="rounded-full bg-accent px-2 py-0.5 text-[9px] font-extrabold tracking-wider text-white">
              {l.role.toUpperCase()}
            </span>
          ) : (
            <button
              onClick={() => upd((d) => d.filter((_, j) => j !== i))}
              className="text-[11px] text-crit hover:underline"
            >
              delete
            </button>
          )}
          <span className="ml-2 flex flex-wrap items-center gap-1">
            {l.rules.map((r, j) => (
              <span key={j} className="flex items-center gap-1 rounded-full bg-panel2 px-2 py-0.5 text-[9px] font-extrabold tracking-wider text-ink2">
                WHEN {ruleLabel(r).toUpperCase()}
                <button onClick={() => upd((d) => ((d[i].rules = d[i].rules.filter((_, k) => k !== j)), d))} className="text-mut">
                  ×
                </button>
              </span>
            ))}
            {pendingRule?.lane === i ? (
              <span className="flex items-center gap-1">
                <input
                  autoFocus
                  value={pendingRule.value}
                  type={RULE_OPTIONS.find((r) => r.condition === pendingRule.condition)?.needsValue === "number" ? "number" : "text"}
                  placeholder={pendingRule.condition === "platform" ? "etsy / shopify" : "N"}
                  onChange={(e) => setPendingRule({ ...pendingRule, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && pendingRule.value.trim()) {
                      upd((d) => ((d[i].rules = [...d[i].rules, { condition: pendingRule.condition, value: pendingRule.value.trim() }]), d));
                      setPendingRule(null);
                    }
                    if (e.key === "Escape") setPendingRule(null);
                  }}
                  className="w-24 rounded border border-accent bg-panel2 px-1.5 py-0.5 text-[10px] outline-none"
                />
                <span className="text-[9px] text-mut">↵</span>
              </span>
            ) : (
              <select
                value=""
                onChange={(e) => {
                  const opt = RULE_OPTIONS.find((r) => r.condition === e.target.value);
                  if (!opt) return;
                  if (opt.needsValue) setPendingRule({ lane: i, condition: opt.condition, value: "" });
                  else upd((d) => ((d[i].rules = [...d[i].rules, { condition: opt.condition, value: null }]), d));
                }}
                className="rounded-full border border-dashed border-line bg-transparent px-1.5 py-0.5 text-[10px] text-accent outline-none"
              >
                <option value="">+ rule…</option>
                {RULE_OPTIONS.map((r) => (
                  <option key={r.condition} value={r.condition}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
          </span>
        </div>
      ))}
      <button
        onClick={() => upd((d) => [...d, { id: null, name: "New lane", role: null, rules: [] }])}
        className="mt-2 w-full rounded-lg border border-dashed border-line py-1.5 text-xs text-accent hover:border-accent"
      >
        + Add lane
      </button>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save lanes"}
        </button>
        {error && <span className="text-xs font-medium text-crit">{error}</span>}
        <span className="ml-auto text-[11px] text-mut">
          Rules run <b>on arrival only</b> — first match wins, otherwise INTAKE. They never re-route a card later.
        </span>
      </div>
    </div>
  );
}
