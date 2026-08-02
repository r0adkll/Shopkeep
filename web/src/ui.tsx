import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

/** Minimal primitives in the concept's visual language; the full shadcn/ui
 *  design-system pass lands with Phase 1 (vault: Design Process). */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-panel p-6 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold tracking-widest uppercase text-mut">
        {props.label}
      </span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        autoFocus={props.autoFocus}
        onChange={(e) => props.onChange(e.target.value)}
        className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      />
    </label>
  );
}

export function Button({
  children,
  disabled,
  type = "submit",
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  type?: "submit" | "button";
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="w-full rounded-md bg-accent px-4 py-2 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="font-display text-xl font-bold tracking-widest uppercase">Shopkeep</span>
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p className="text-sm font-medium text-crit">{children}</p> : null;
}

const TABS = [
  ["Inventory", "/"],
  ["Products", "/products"],
  ["Listings", "/listings"],
  ["Orders", "/orders"],
  ["Connections", "/connections"],
] as const;

/** Segmented nav per the locked concept header: padded targets, active pane. */
export function NavTabs({ active }: { active: (typeof TABS)[number][0] }) {
  return (
    <nav className="flex gap-0.5 rounded-lg border border-line bg-panel2 p-0.5">
      {TABS.map(([label, to]) => (
        <Link
          key={to}
          to={to}
          aria-current={active === label ? "page" : undefined}
          className={`rounded-md px-3.5 py-1.5 text-sm transition-colors ${
            active === label
              ? "bg-panel font-semibold text-ink shadow-sm"
              : "text-ink2 hover:bg-panel/60 hover:text-ink"
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
