import { formatQty, gaugeFraction, materialColor, type Material } from "./api";
import { MaterialIcon } from "./MaterialIcon";

/** Ring gauge per the locked Inventory UX concept: fill tinted the material's
 *  actual color, reserved rendered as a faded tail, center = available qty.
 *  Status never rides on color alone — the badge text carries it. */
export function MaterialGauge({ m, onClick }: { m: Material; onClick: () => void }) {
  const size = 104;
  const r = 40;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;

  const frac = gaugeFraction(m);
  const availFrac = m.stock.onHand > 0 ? frac * (m.stock.available / m.stock.onHand) : frac;
  const resFrac = frac - availFrac;
  const color = materialColor(m) ?? "var(--color-accent)";

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center rounded-xl border border-transparent px-2 py-3 text-center hover:border-line hover:bg-panel2 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {m.status === "CRITICAL" && (
          <circle cx={cx} cy={cy} r={r + 7.5} fill="none" stroke="var(--color-crit)" strokeWidth="1.5" opacity="0.6" />
        )}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--color-line)" strokeWidth="11" />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="11"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(availFrac * c, 0.001)} ${c}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        {resFrac > 0.005 && (
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="11"
            strokeLinecap="round"
            opacity="0.32"
            strokeDasharray={`${resFrac * c} ${c}`}
            transform={`rotate(${availFrac * 360 - 90} ${cx} ${cy})`}
          />
        )}
        <text
          x={cx}
          y={cy - 1}
          textAnchor="middle"
          fontSize="17"
          fontWeight="650"
          fill="var(--color-ink)"
          fontFamily="var(--font-mono)"
        >
          {formatQty(m.stock.available)}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize="9" fill="var(--color-mut)" letterSpacing="1">
          {m.unit.toUpperCase()}
        </text>
      </svg>
      <span className="mt-1.5 text-[13px] leading-tight font-semibold">{m.name}</span>
      {m.brand && <span className="text-[10px] leading-tight text-mut">{m.brand}</span>}
      <span className="flex items-center gap-1 text-[11.5px] text-mut">
        <MaterialIcon category={m.category} type={m.type} size={12} />
        {m.type}
      </span>
      {m.status !== "OK" && (
        <span
          className={`mt-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-bold tracking-wider ${
            m.status === "CRITICAL" ? "bg-crit/10 text-crit" : "bg-warn/10 text-warn"
          }`}
        >
          {m.status === "CRITICAL" ? "▲ ORDER" : "● LOW"}
        </span>
      )}
    </button>
  );
}
