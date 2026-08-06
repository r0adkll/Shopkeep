import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
import { AppShell, Card } from "../ui";

/* Phase 6 Stats page — built to the locked concept (vault: Stats.md §
 * Dashboard Concept): single scrolling page, profit-first tiles, cashflow
 * with cumulative/by-month views + bar/line styles, shop-wide color demand,
 * dwell distribution + average, dead stock. One $ scale, never dual axes. */

type Totals = { revenueMinor: number; profitMinor: number; orders: number; materialsMinor: number; feesMinor: number; laborMinor: number };
type StatsResponse = {
  days: number;
  current: Totals;
  prior: Totals;
  daily: { date: string; revenueMinor: number; profitMinor: number; orders: number }[];
  ordersPerWeek: number[];
  spendWeekly: { weekStart: string; spendMinor: number }[];
  variations: { name: string; colorHex: string | null; units: number; revenueMinor: number }[];
  margins: { listing: string; units: number; revenueMinor: number; materialsMinor: number; feesMinor: number; laborMinor: number }[];
  lanes: { name: string; avgHours: number; samplesHours: number[] }[];
  cycleAvgHours: number;
  cycleMedianHours: number;
  backlog: { name: string; count: number }[];
  deadStock: { name: string; colorHex: string | null; idleDays: number; available: number; unit: string; worthMinor: number }[];
};

const $ = (minor: number) => "$" + Math.round(minor / 100).toLocaleString();
const pct = (s: string) => (s.startsWith("-") ? "text-crit" : s.startsWith("+") ? "text-good" : "text-mut");
const delta = (cur: number, prior: number) => {
  if (prior === 0) return cur > 0 ? "new" : "—";
  const p = Math.round(((cur - prior) / Math.abs(prior)) * 100);
  return `${p >= 0 ? "+" : ""}${p}%`;
};

function SectionH({ title, note }: { title: string; note?: string }) {
  return (
    <h2 className="mt-7 mb-2 text-[11.5px] font-extrabold tracking-widest uppercase text-ink2">
      {title}
      {note && <span className="ml-2 font-normal normal-case tracking-normal text-mut">{note}</span>}
    </h2>
  );
}

export function StatsPage() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login" });
  }, [me.error, navigate]);

  const [days, setDays] = useState(90);
  const stats = useQuery({
    queryKey: ["stats", days],
    queryFn: () => fetch(`/api/v1/stats?days=${days}`).then((r) => r.json() as Promise<StatsResponse>),
    enabled: !!me.data,
  });
  const [mode, setMode] = useState<"cum" | "period">("cum");
  const [style, setStyle] = useState<"bar" | "line">("bar");

  const s = stats.data;
  const d = s?.current;

  if (!me.data) return <main className="flex min-h-screen items-center justify-center text-mut">Loading…</main>;

  return (
    <AppShell active="Stats" actions={
      <div className="flex gap-1.5">
        {[30, 90].map((n) => (
          <button key={n} type="button" onClick={() => setDays(n)} aria-pressed={days === n}
            className={`rounded-full border px-3 py-1 text-xs ${days === n ? "border-accent bg-accent font-semibold text-white" : "border-line text-ink2 hover:border-accent"}`}>
            {n} days
          </button>
        ))}
        <button disabled title="needs a year of history"
          className="rounded-full border border-line px-3 py-1 text-xs text-mut opacity-50">12 months</button>
      </div>
    }>
      {!s || !d ? (
        <div aria-busy="true" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl border border-line bg-panel" />)}
        </div>
      ) : (
        <>
          {/* profit-first tiles */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {([
              ["Net profit", $(d.profitMinor), delta(d.profitMinor, s.prior.profitMinor), "text-s-profit"],
              ["Revenue", $(d.revenueMinor), delta(d.revenueMinor, s.prior.revenueMinor), ""],
              ["Orders", String(d.orders), delta(d.orders, s.prior.orders), ""],
              ["Avg order", d.orders ? "$" + (d.revenueMinor / d.orders / 100).toFixed(2) : "—",
                d.orders && s.prior.orders ? delta(d.revenueMinor / d.orders, s.prior.revenueMinor / s.prior.orders) : "—", ""],
            ] as const).map(([label, value, dl]) => (
              <div key={label} className="rounded-xl border border-line bg-panel px-4 py-3.5">
                <div className="text-[10.5px] font-bold tracking-widest uppercase text-mut">{label}</div>
                <div className="mt-0.5 font-mono text-[25px] leading-tight font-semibold">{value}</div>
                <div className={`text-[11.5px] ${pct(dl)}`}>{dl === "—" || dl === "new" ? dl : `${dl.startsWith("+") ? "▴" : "▾"} ${dl} vs prior ${days} d`}</div>
              </div>
            ))}
          </div>

          <SectionH title="Cashflow" note="revenue & net profit · tax excluded (Etsy remits)" />
          <Card>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {(["cum", "period"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${mode === m ? "border-accent bg-accent/10 text-accent" : "border-line bg-panel2 text-ink2 hover:border-accent"}`}>
                  {m === "cum" ? "Cumulative" : days === 90 ? "By month" : "By day"}
                </button>
              ))}
              {mode === "period" && (
                <span className="ml-auto flex gap-1.5">
                  {(["bar", "line"] as const).map((st) => (
                    <button key={st} type="button" onClick={() => setStyle(st)} aria-pressed={style === st}
                      className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${style === st ? "border-accent bg-accent/10 text-accent" : "border-line bg-panel2 text-ink2 hover:border-accent"}`}>
                      {st === "bar" ? "▮ bars" : "◠ line"}
                    </button>
                  ))}
                </span>
              )}
            </div>
            <CashflowChart data={s} mode={mode} style={style} />
            <div className="mt-1.5 flex flex-wrap gap-4 text-[11.5px] text-ink2">
              <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-[3px] bg-accent" /> revenue</span>
              <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-[3px] bg-s-profit" /> net profit</span>
              {mode === "cum" && <span className="text-mut">ticks along the bottom = orders landing</span>}
            </div>
          </Card>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <SectionH title="Where a sale's dollar goes" note="period average" />
              <Card><DollarBar t={d} /></Card>
            </div>
            <div>
              <SectionH title="Material purchase spend" note="weekly, from purchase ledger entries" />
              <Card>
                <SpendChart weeks={s.spendWeekly} />
              </Card>
            </div>
          </div>

          <SectionH title="Margin by listing" note="labor at the global rate" />
          <Card className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead><tr>
                {["Listing", "Units", "Revenue", "Materials", "Fees", "Labor", "Margin"].map((h, i) => (
                  <th key={h} className={`px-2 py-1 text-[9.5px] font-bold tracking-widest uppercase text-mut ${i ? "text-right" : "text-left"}`}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {s.margins.map((m) => {
                  const margin = m.revenueMinor - m.materialsMinor - m.feesMinor - m.laborMinor;
                  const p = m.revenueMinor > 0 ? Math.round((margin / m.revenueMinor) * 100) : 0;
                  return (
                    <tr key={m.listing}>
                      <td className="border-t border-line px-2 py-1.5">{m.listing}</td>
                      {[m.units, $(m.revenueMinor), $(m.materialsMinor), $(m.feesMinor), $(m.laborMinor)].map((v, i) => (
                        <td key={i} className="border-t border-line px-2 py-1.5 text-right font-mono">{v}</td>
                      ))}
                      <td className="border-t border-line px-2 py-1.5 text-right font-mono">
                        <span className="mr-1.5 inline-block h-[7px] rounded-full bg-s-profit align-middle" style={{ width: Math.max(p, 0) * 0.6 }} />
                        {$(margin)} · {p}%
                      </td>
                    </tr>
                  );
                })}
                {s.margins.length === 0 && <tr><td colSpan={7} className="border-t border-line px-2 py-3 text-center text-mut">No matched orders in this window yet.</td></tr>}
              </tbody>
            </table>
          </Card>

          <SectionH title="What sells" note="shop-wide color demand — the spools to stock deeper" />
          <Card>
            {s.variations.length === 0 && <p className="py-2 text-center text-sm text-mut">No orders with color variations in this window.</p>}
            {s.variations.map((v) => {
              const maxU = s.variations[0].units;
              return (
                <div key={v.name} className="grid grid-cols-[120px_1fr_100px] items-center gap-2.5 py-1 text-[12.5px] hover:bg-accent/5">
                  <span className="truncate">{v.name}</span>
                  <div><div className="h-[15px] rounded border border-black/10" style={{ width: `${(v.units / maxU) * 100}%`, minWidth: 3, background: v.colorHex ?? "var(--color-panel2)" }} /></div>
                  <span className="text-right font-mono text-xs text-ink2">{v.units} · {$(v.revenueMinor)}</span>
                </div>
              );
            })}
            {s.variations.length > 0 && (
              <p className="mt-2 text-[11px] text-mut">every sold unit counted by its color, across all listings — bars wear the actual filament color</p>
            )}
          </Card>

          <SectionH title="Time in stage" note="every order's dwell · band = middle 50% · ◆ = average" />
          <Card>
            <StageChart lanes={s.lanes} />
            <div className="mt-1.5 flex flex-wrap justify-between gap-2 border-t border-dotted border-line pt-2 font-mono text-xs text-ink2">
              <span>cycle <b className="text-ink">{(s.cycleAvgHours / 24).toFixed(1)} d</b> avg · <b className="text-ink">{(s.cycleMedianHours / 24).toFixed(1)} d</b> median · new → done</span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <span className="rounded-full border border-dashed border-line px-2.5 py-0.5 text-[11.5px] text-ink2">backlog now:</span>
              {s.backlog.map((b) => (
                <span key={b.name} className="rounded-full border border-line px-2.5 py-0.5 text-[11.5px] text-ink2">{b.name} <b className="font-mono text-ink">{b.count}</b></span>
              ))}
              {s.backlog.length === 0 && <span className="text-[11.5px] text-mut">queue is clear 🎉</span>}
            </div>
          </Card>

          <SectionH title="Throughput" note="orders per week" />
          <Card><ThruChart weeks={s.ordersPerWeek} /></Card>

          <SectionH title="Dead stock" note="no consumption in 45+ days — not earning shelf space" />
          <Card>
            {s.deadStock.length === 0 && <p className="py-2 text-center text-sm text-mut">Nothing idle — every material moved in the last 45 days.</p>}
            {s.deadStock.map((m) => (
              <div key={m.name} className="flex items-center gap-2.5 border-b border-line py-1.5 text-[12.5px] last:border-b-0">
                <span className="h-3.5 w-3.5 flex-none rounded border border-line" style={{ background: m.colorHex ?? "var(--color-panel2)" }} />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                <span className="font-mono text-xs text-warn">{m.idleDays} d idle</span>
                <span className="font-mono text-xs text-mut">{Math.round(m.available)} {m.unit} · ~{$(m.worthMinor)} sitting</span>
              </div>
            ))}
            {s.deadStock.length > 0 && <p className="mt-2 text-[11px] text-mut">candidates for a sale colorway — or a listing that features them</p>}
          </Card>
        </>
      )}
    </AppShell>
  );
}

/* ---------- charts (SVG, design-system tokens, one $ scale) ---------- */

/** Instant hover tooltip — native SVG <title> is too slow/subtle to read values. */
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const show = (e: React.MouseEvent, lines: string[]) =>
    setTip({ x: Math.min(e.clientX + 14, window.innerWidth - 190), y: e.clientY - 14 - lines.length * 18, lines });
  const hide = () => setTip(null);
  const node = tip ? (
    <div className="pointer-events-none fixed z-50 rounded-lg bg-ink px-2.5 py-1.5 font-mono text-[11.5px] leading-[18px] whitespace-nowrap text-bg shadow-lg" style={{ left: tip.x, top: tip.y }}>
      {tip.lines.map((l) => <div key={l}>{l}</div>)}
    </div>
  ) : null;
  return { show, hide, node };
}

/** Mouse x → nearest series index, accounting for the responsive viewBox scale. */
function nearestIndex(e: React.MouseEvent<SVGSVGElement>, n: number, padL: number, iw: number, W: number) {
  const r = e.currentTarget.getBoundingClientRect();
  const mx = ((e.clientX - r.left) / r.width) * W;
  return Math.max(0, Math.min(n - 1, Math.round(((mx - padL) / iw) * (n - 1))));
}

function CashflowChart({ data, mode, style }: { data: StatsResponse; mode: "cum" | "period"; style: "bar" | "line" }) {
  const W = 640, H = 210, padL = 48, padB = 34, padT = 16, padR = 60;
  const iw = W - padL - padR, ih = H - padT - padB;
  const daily = data.daily;
  const { show, hide, node } = useTip();
  const [hi, setHi] = useState<number | null>(null);

  const months = useMemo(() => {
    const m = new Map<string, { label: string; rev: number; profit: number; orders: number; partial: boolean }>();
    const nowKey = daily[daily.length - 1]?.date.slice(0, 7);
    for (const dd of daily) {
      const key = dd.date.slice(0, 7);
      const cur = m.get(key) ?? { label: new Date(dd.date + "T12:00").toLocaleString(undefined, { month: "short" }), rev: 0, profit: 0, orders: 0, partial: key === nowKey };
      cur.rev += dd.revenueMinor; cur.profit += dd.profitMinor; cur.orders += dd.orders;
      m.set(key, cur);
    }
    return [...m.values()];
  }, [daily]);

  if (daily.length === 0) return <p className="py-4 text-center text-sm text-mut">No orders yet in this window.</p>;

  if (mode === "cum") {
    const cum = (f: (d: StatsResponse["daily"][number]) => number) =>
      daily.reduce<number[]>((a, dd) => (a.push((a[a.length - 1] ?? 0) + f(dd)), a), []);
    const cRev = cum((dd) => dd.revenueMinor), cProf = cum((dd) => dd.profitMinor);
    const max = Math.max(cRev[cRev.length - 1], 1) * 1.06;
    const x = (i: number) => padL + (i / (daily.length - 1)) * iw;
    const y = (v: number) => padT + ih - (v / max) * ih;
    const path = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"} ${x(i)} ${y(v)}`).join(" ");
    return (
      <>
        {node}
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cumulative revenue and profit"
          onMouseMove={(e) => {
            const i = nearestIndex(e, daily.length, padL, iw, W);
            setHi(i);
            show(e, [daily[i].date, `revenue so far  ${$(cRev[i])}`, `profit so far   ${$(cProf[i])}`, `${daily[i].orders} order${daily[i].orders === 1 ? "" : "s"} that day`]);
          }}
          onMouseLeave={() => { setHi(null); hide(); }}>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={padL} x2={W - padR} y1={y(max * f)} y2={y(max * f)} stroke="var(--color-line)" opacity=".55" />
              <text x={padL - 4} y={y(max * f) + 3} textAnchor="end" fontSize="9" fill="var(--color-mut)" fontFamily="var(--font-mono)">{$(max * f)}</text>
            </g>
          ))}
          <path d={`${path(cRev)} L ${x(daily.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`} fill="var(--color-accent)" opacity=".08" />
          <path d={path(cRev)} fill="none" stroke="var(--color-accent)" strokeWidth="2.4" strokeLinejoin="round" />
          <path d={path(cProf)} fill="none" stroke="var(--color-s-profit)" strokeWidth="2.4" strokeLinejoin="round" />
          {daily.map((dd, i) => dd.orders > 0 && (
            <line key={dd.date} x1={x(i)} x2={x(i)} y1={padT + ih + 2} y2={padT + ih + 2 + Math.min(dd.orders * 2.2, 9)} stroke="var(--color-mut)" strokeWidth="1.6" opacity=".7" />
          ))}
          {hi != null && (
            <g pointerEvents="none">
              <line x1={x(hi)} x2={x(hi)} y1={padT} y2={padT + ih} stroke="var(--color-mut)" strokeDasharray="3 3" />
              <circle cx={x(hi)} cy={y(cRev[hi])} r="4" fill="var(--color-accent)" stroke="var(--color-panel)" strokeWidth="1.5" />
              <circle cx={x(hi)} cy={y(cProf[hi])} r="4" fill="var(--color-s-profit)" stroke="var(--color-panel)" strokeWidth="1.5" />
            </g>
          )}
          <text x={W - padR + 4} y={y(cRev[cRev.length - 1]) + 3} fontSize="10" fontWeight="700" fill="var(--color-accent)" fontFamily="var(--font-mono)">{$(cRev[cRev.length - 1])}</text>
          <text x={W - padR + 4} y={y(cProf[cProf.length - 1]) + 3} fontSize="10" fontWeight="700" fill="var(--color-s-profit)" fontFamily="var(--font-mono)">{$(cProf[cProf.length - 1])}</text>
          <line x1={padL} x2={W - padR} y1={padT + ih} y2={padT + ih} stroke="var(--color-line)" />
          <text x={padL} y={H - 4} fontSize="9" fill="var(--color-mut)">{daily[0].date}</text>
          <text x={W - padR} y={H - 4} textAnchor="end" fontSize="9" fill="var(--color-mut)">today</text>
        </svg>
      </>
    );
  }

  // period view: months at 90 d, days at 30 d — every mark carries its number
  const buckets = data.days >= 60
    ? months
    : daily.map((dd) => ({ label: dd.date.slice(5), rev: dd.revenueMinor, profit: dd.profitMinor, orders: dd.orders, partial: false }));
  const isMonthly = data.days >= 60;
  const max = Math.max(...buckets.map((b) => b.rev), 1) * (isMonthly ? 1.15 : 1.3);
  const y = (v: number) => padT + ih - (v / max) * ih;
  const gw = iw / buckets.length;
  const tipFor = (b: (typeof buckets)[number]) => [
    `${b.label}${b.partial ? " (so far)" : ""}`,
    `revenue  ${$(b.rev)}`, `profit   ${$(b.profit)}`, `${b.orders} order${b.orders === 1 ? "" : "s"}`,
  ];
  return (
    <>
      {node}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Revenue and profit by period">
        <line x1={padL} x2={W - padR} y1={padT + ih} y2={padT + ih} stroke="var(--color-line)" />
        {style === "line" ? (
          ([["rev", "var(--color-accent)"], ["profit", "var(--color-s-profit)"]] as const).map(([k, color]) => (
            <g key={k}>
              <polyline points={buckets.map((b, i) => `${padL + i * gw + gw / 2},${y(k === "rev" ? b.rev : b.profit)}`).join(" ")}
                fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" />
              {buckets.map((b, i) => (
                <circle key={i} cx={padL + i * gw + gw / 2} cy={y(k === "rev" ? b.rev : b.profit)} r={isMonthly ? 4 : 2.6} fill={color}
                  onMouseMove={(e) => show(e, tipFor(b))} onMouseLeave={hide} />
              ))}
              {isMonthly && buckets.map((b, i) => (
                <text key={i} x={padL + i * gw + gw / 2} y={y(k === "rev" ? b.rev : b.profit) + (k === "rev" ? -8 : 15)} textAnchor="middle"
                  fontSize="10" fontWeight="700" fill={color} fontFamily="var(--font-mono)">{$(k === "rev" ? b.rev : b.profit)}</text>
              ))}
            </g>
          ))
        ) : (
          buckets.map((b, i) => {
            const cx = padL + i * gw + gw / 2;
            const bw = isMonthly ? Math.min(gw * 0.28, 46) : Math.max(gw - 2, 1.5);
            return (
              <g key={i}>
                {isMonthly ? (
                  <>
                    <rect x={cx - bw - 2} y={y(b.rev)} width={bw} height={padT + ih - y(b.rev)} rx="3.5" fill="var(--color-accent)" opacity=".82"
                      onMouseMove={(e) => show(e, tipFor(b))} onMouseLeave={hide} />
                    <rect x={cx + 2} y={y(b.profit)} width={bw} height={padT + ih - y(b.profit)} rx="3.5" fill="var(--color-s-profit)" opacity=".88"
                      onMouseMove={(e) => show(e, tipFor(b))} onMouseLeave={hide} />
                    <text x={cx - bw / 2 - 2} y={y(b.rev) - 5} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--color-ink)" fontFamily="var(--font-mono)">{$(b.rev)}</text>
                    <text x={cx + bw / 2 + 2} y={y(b.profit) - 5} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--color-s-profit)" fontFamily="var(--font-mono)">{$(b.profit)}</text>
                  </>
                ) : b.rev > 0 && (
                  <>
                    <rect x={cx - bw / 2} y={y(b.rev)} width={bw} height={padT + ih - y(b.rev)} rx="2" fill="var(--color-accent)" opacity=".82"
                      onMouseMove={(e) => show(e, tipFor(b))} onMouseLeave={hide} />
                    <text x={cx + 3} y={y(b.rev) - 6} fontSize="8.5" fontWeight="700" fill="var(--color-ink)" fontFamily="var(--font-mono)"
                      transform={`rotate(-55 ${cx + 3} ${y(b.rev) - 6})`}>{$(b.rev)}</text>
                  </>
                )}
              </g>
            );
          })
        )}
        {isMonthly ? buckets.map((b, i) => (
          <g key={b.label}>
            <text x={padL + i * gw + gw / 2} y={H - 16} textAnchor="middle" fontSize="10.5" fontWeight="700" fill="var(--color-mut)">{b.label}{b.partial ? "*" : ""}</text>
            <text x={padL + i * gw + gw / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="var(--color-mut)" fontFamily="var(--font-mono)">{b.orders} orders</text>
          </g>
        )) : (
          buckets.map((b, i) => (i % 5 === 0 || i === buckets.length - 1) && (
            <text key={i} x={padL + i * gw + gw / 2} y={H - 4} textAnchor="middle" fontSize="8.5" fill="var(--color-mut)" fontFamily="var(--font-mono)">{b.label}</text>
          ))
        )}
        {isMonthly && <text x={W - padR} y={padT - 6} textAnchor="end" fontSize="9" fill="var(--color-mut)">* current month, still filling</text>}
      </svg>
    </>
  );
}

function DollarBar({ t }: { t: Totals }) {
  const margin = t.revenueMinor - t.materialsMinor - t.feesMinor - t.laborMinor;
  if (t.revenueMinor <= 0) return <p className="py-3 text-center text-sm text-mut">No revenue in this window yet.</p>;
  const c = (v: number) => Math.max(Math.round((v / t.revenueMinor) * 100), 0);
  const segs = [
    ["Profit", c(margin), "var(--color-s-profit)"],
    ["Labor", c(t.laborMinor), "var(--color-s-labor)"],
    ["Materials", c(t.materialsMinor), "var(--color-s-mat)"],
    ["Fees", c(t.feesMinor), "var(--color-s-fees)"],
  ] as const;
  return (
    <>
      <div className="flex h-[34px] gap-0.5 overflow-hidden rounded-lg">
        {segs.map(([label, v, color]) => v > 0 && (
          <div key={label} title={`${label}: ${v}¢ of every dollar`} style={{ flex: v, background: color }}
            className="flex min-w-0 items-center justify-center text-[11px] font-bold whitespace-nowrap text-white">
            {v >= 13 ? `${label} ${v}¢` : `${v}¢`}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-[11.5px] text-ink2">
        {segs.map(([label, v, color]) => (
          <span key={label}><i className="mr-1.5 inline-block h-[9px] w-[9px] rounded-[3px]" style={{ background: color }} />{label} {v}¢</span>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-mut">Fees are <b>real</b> — per order from Etsy's payments API at ingest, not fee-schedule math.</p>
    </>
  );
}

function SpendChart({ weeks }: { weeks: { weekStart: string; spendMinor: number }[] }) {
  const { show, hide, node } = useTip();
  if (weeks.length === 0 || weeks.every((w) => w.spendMinor === 0))
    return <p className="py-3 text-center text-sm text-mut">No material purchases recorded in this window.</p>;
  const W = 300, H = 116, padL = 6, padB = 16, padT = 24;
  const iw = W - padL * 2, ih = H - padT - padB;
  const max = Math.max(...weeks.map((w) => w.spendMinor)) * 1.25;
  const bw = iw / weeks.length;
  const total = weeks.reduce((a, w) => a + w.spendMinor, 0);
  return (
    <>
      {node}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Weekly purchase spend">
        <text x={padL} y={10} fontSize="9" fill="var(--color-mut)" fontFamily="var(--font-mono)">total {$(total)} this window</text>
        {weeks.map((w, i) => w.spendMinor > 0 && (
          <g key={w.weekStart}>
            <rect x={padL + i * bw + 2} y={padT + ih - (w.spendMinor / max) * ih} width={Math.max(bw - 4, 2)} height={(w.spendMinor / max) * ih} rx="2.5" fill="var(--color-s-mat)" opacity=".85"
              onMouseMove={(e) => show(e, [`wk of ${w.weekStart}`, `${$(w.spendMinor)} in materials`])} onMouseLeave={hide} />
            <text x={padL + i * bw + 2 + Math.max(bw - 4, 2) / 2} y={padT + ih - (w.spendMinor / max) * ih - 4} textAnchor="middle" fontSize="8.5" fontWeight="700" fill="var(--color-ink)" fontFamily="var(--font-mono)">{$(w.spendMinor)}</text>
          </g>
        ))}
        <line x1={padL} x2={W - padL} y1={padT + ih} y2={padT + ih} stroke="var(--color-line)" />
        <text x={padL} y={H - 3} fontSize="9" fill="var(--color-mut)">{weeks[0].weekStart}</text>
        <text x={W - padL} y={H - 3} textAnchor="end" fontSize="9" fill="var(--color-mut)">now</text>
      </svg>
    </>
  );
}

function StageChart({ lanes }: { lanes: StatsResponse["lanes"] }) {
  const { show, hide, node } = useTip();
  const rows = lanes.filter((l) => l.samplesHours.length > 0);
  if (rows.length === 0) return <p className="py-3 text-center text-sm text-mut">No stage history yet — dwell times appear as orders move lanes.</p>;
  const W = 640, rowH = 44, top = 14, padL = 118, padR = 20;
  const H = top + rowH * rows.length + 22;
  const maxD = Math.max(2, Math.ceil(Math.max(...rows.flatMap((l) => l.samplesHours)) / 24));
  const x = (h: number) => padL + (Math.min(h / 24, maxD) / maxD) * (W - padL - padR);
  const q = (s: number[], p: number) => s[Math.floor(p * (s.length - 1))];
  return (
    <>
      {node}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Dwell time distribution per lane">
        {Array.from({ length: maxD }, (_, i) => i + 1).map((dd) => (
          <g key={dd}>
            <line x1={x(dd * 24)} x2={x(dd * 24)} y1={top - 4} y2={top + rowH * rows.length} stroke="var(--color-line)" opacity=".6" />
            <text x={x(dd * 24)} y={top + rowH * rows.length + 13} textAnchor="middle" fontSize="9" fill="var(--color-mut)" fontFamily="var(--font-mono)">{dd} d</text>
          </g>
        ))}
        {rows.map((l, r) => {
          const cy = top + r * rowH + rowH / 2;
          const s = [...l.samplesHours].sort((a, b) => a - b);
          return (
            <g key={l.name}>
              <text x={padL - 10} y={cy + 4} textAnchor="end" fontSize="11.5" fontWeight="600" fill="var(--color-ink)">{l.name}</text>
              <rect x={x(q(s, 0.25))} y={cy - 8} width={Math.max(x(q(s, 0.75)) - x(q(s, 0.25)), 3)} height="16" rx="5" fill="var(--color-accent)" opacity=".16"
                onMouseMove={(e) => show(e, [`${l.name}: middle 50%`, `${(q(s, 0.25) / 24).toFixed(1)}–${(q(s, 0.75) / 24).toFixed(1)} days`])} onMouseLeave={hide} />
              {l.samplesHours.map((h, i) => (
                <circle key={i} cx={x(h)} cy={cy + ((i % 5) - 2) * 2.6} r="2.4" fill="var(--color-accent)" opacity=".5"
                  onMouseMove={(e) => show(e, [`one order — ${(h / 24).toFixed(1)} d in ${l.name}`])} onMouseLeave={hide} />
              ))}
              <path d={`M ${x(l.avgHours)} ${cy - 7} l 5.5 7 l -5.5 7 l -5.5 -7 Z`} fill="var(--color-ink)"
                onMouseMove={(e) => show(e, [`${l.name} average ${(l.avgHours / 24).toFixed(1)} d`])} onMouseLeave={hide} />
              <text x={x(l.avgHours) + 9} y={cy - 9} fontSize="10" fontWeight="700" fill="var(--color-ink)" fontFamily="var(--font-mono)">{(l.avgHours / 24).toFixed(1)} d avg</text>
            </g>
          );
        })}
      </svg>
    </>
  );
}

function ThruChart({ weeks }: { weeks: number[] }) {
  const { show, hide, node } = useTip();
  if (weeks.length < 2) return <p className="py-3 text-center text-sm text-mut">Not enough weeks yet.</p>;
  const W = 640, H = 104, padL = 30, padB = 16, padT = 14, padR = 44;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(...weeks, 1) * 1.25;
  const x = (i: number) => padL + (i / (weeks.length - 1)) * iw;
  const y = (v: number) => padT + ih - (v / max) * ih;
  return (
    <>
      {node}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Orders per week">
        <line x1={padL} x2={W - padR} y1={padT + ih} y2={padT + ih} stroke="var(--color-line)" />
        <polyline points={weeks.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke="var(--color-accent)" strokeWidth="2.2" strokeLinejoin="round" />
        {weeks.map((v, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(v)} r="3" fill="var(--color-accent)"
              onMouseMove={(e) => show(e, [`${v} orders that week`])} onMouseLeave={hide} />
            <text x={x(i)} y={y(v) - 7} textAnchor="middle" fontSize="9" fontWeight="700" fill="var(--color-ink)" fontFamily="var(--font-mono)">{v}</text>
          </g>
        ))}
      </svg>
    </>
  );
}
