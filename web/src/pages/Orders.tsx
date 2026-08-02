import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
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
  lines: OrderLine[];
};
type LaneRule = { condition: string; value: string | null };
type Lane = { id: number | null; name: string; role: string | null; rules: LaneRule[] };

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

  if (!me.data) return <main className="flex min-h-screen items-center justify-center text-mut">Loading…</main>;
  const isAdmin = me.data.role === "ADMIN";
  const laneList = lanes.data ?? [];
  const all = orders.data ?? [];
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
          <button
            onClick={() => setEditing((e) => !e)}
            className={`ml-auto rounded-lg border px-3.5 py-1.5 text-sm font-semibold transition-colors ${
              editing ? "border-accent text-accent" : "border-line text-ink2 hover:text-ink"
            }`}
          >
            ⚙ Customize lanes…
          </button>
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
                  if (dragId != null && lane.id != null) move.mutate({ orderId: dragId, laneId: lane.id });
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
                    onDragStart={() => setDragId(o.id)}
                    onDragEnd={() => setDragId(null)}
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
    </div>
  );
}

function OrderCard(props: {
  order: Order;
  laneRole: string | null;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const o = props.order;
  const anyUnmatched = o.lines.some((l) => !l.matchedSku);
  const pers = o.lines.flatMap((l) => l.personalization);
  const multi = o.lines.length > 1;
  const orderAge = age(o.placedAt);
  const old = orderAge.endsWith("d");

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text", String(o.id));
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}
      className={`mb-2 cursor-grab rounded-[10px] border border-line bg-panel px-3 py-2.5 shadow-sm active:cursor-grabbing ${
        props.dragging ? "opacity-40" : ""
      }`}
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

      {(pers.length > 0 || o.flagShort || o.flagAdhoc || anyUnmatched) && (
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
