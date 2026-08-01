import type { CSSProperties } from "react";

/**
 * Tiny hand-drawn stroke icons giving materials a physical identity
 * (vault: Inventory UX — physical metaphors per category). Matched by
 * type keywords first, then category fallback. All stroke/currentColor,
 * so they tint with the material's color where one exists.
 */
const PATHS: Record<string, string> = {
  spool: "M7 4v16M17 4v16M5.5 4h3M15.5 4h3M5.5 20h3M15.5 20h3M9 8h6M9 12h6M9 16h6",
  screw: "M8.5 5.5h7M12 3v2.5M10 5.5l1.2 13M14 5.5l-1.2 13M11.2 18.5L12 21l.8-2.5M9.3 9.2l5.4-1.7M9.8 13l4.4-1.5M10.3 16.6l3.4-1.2",
  nut: "M12 3l7 4v10l-7 4-7-4V7zM12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z",
  magnet: "M8.5 4v8a3.5 3.5 0 0 0 7 0V4M6.6 4h3.8M13.6 4h3.8M6.6 7.5h3.8M13.6 7.5h3.8",
  glue: "M12 3v2M10 5h4l1.2 3.5H8.8zM8.5 8.5h7V19a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2zM10.2 12h3.6",
  box: "M4 9h16v11H4zM4 9l3-4.5h10L20 9M12 9v11",
  tape: "M12 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM17.8 15.5L21 20h-6",
  mailer: "M4 6h16v12H4zM4 7.5l8 5.5 8-5.5",
  tag: "M4 12.5L12.5 4H20v7.5L11.5 20zM16.3 7.7h.01",
  card: "M5 5h14v14H5zM8 9.5h8M8 12.5h8M8 15.5h5",
  cylinder: "M8 5.5c0-1.4 1.8-2.5 4-2.5s4 1.1 4 2.5-1.8 2.5-4 2.5-4-1.1-4-2.5zM8 5.5v13c0 1.4 1.8 2.5 4 2.5s4-1.1 4-2.5v-13M10.5 9.5v9M13.5 9.5v9",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5M12 12v9",
};

const TYPE_MATCH: Array<[RegExp, string]> = [
  [/screw|bolt/, "screw"],
  [/nut|washer/, "nut"],
  [/magnet/, "magnet"],
  [/adhesive|glue/, "glue"],
  [/insert card|card/, "card"],
  [/heat insert|bearing|spring/, "cylinder"],
  [/tape/, "tape"],
  [/box/, "box"],
  [/mailer|envelope/, "mailer"],
  [/label|sticker/, "tag"],
  [/wrap|fill/, "cube"],
];

const CATEGORY_FALLBACK: Record<string, string> = {
  filament: "spool",
  hardware: "nut",
  packaging: "box",
};

export function iconKeyFor(category: string, type: string): string {
  if (category.toLowerCase() === "filament") return "spool";
  const t = type.toLowerCase();
  for (const [re, key] of TYPE_MATCH) if (re.test(t)) return key;
  return CATEGORY_FALLBACK[category.toLowerCase()] ?? "cube";
}

export function MaterialIcon({
  category,
  type = "",
  size = 15,
  className = "",
  style,
}: {
  category: string;
  type?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d={PATHS[iconKeyFor(category, type)]} />
    </svg>
  );
}
