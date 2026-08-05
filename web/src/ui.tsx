import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, ClipboardList, Hammer, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Plug, Tags, X } from "lucide-react";
import { api } from "./api";

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

/** shadcn/ui-style skeleton: loading states mirror the final layout
 *  (never a lone spinner or bare "Loading…" for content-shaped regions). */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton-shimmer rounded-md ${className}`} />;
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


/* ---------- App shell: left sidebar + content header (desktop-first,
 * dashboard-01 style; drawer on mobile). Pages pass their header actions. */

const NAV = [
  { label: "Inventory", to: "/", Icon: Boxes },
  { label: "Products", to: "/products", Icon: Hammer },
  { label: "Listings", to: "/listings", Icon: Tags },
  { label: "Orders", to: "/orders", Icon: ClipboardList },
  { label: "Connections", to: "/connections", Icon: Plug },
] as const;
export type NavLabel = (typeof NAV)[number]["label"];

export function AppShell({ active, title, actions, children }: {
  active: NavLabel;
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("shell.sidebar") === "collapsed");
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("shell.sidebar", next ? "collapsed" : "open");
  };
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.removeQueries();
      navigate({ to: "/login" });
    },
  });

  const sidebarInner = (mini: boolean) => (
    <>
      <div className={`flex items-center gap-2.5 py-5 ${mini ? "justify-center px-0" : "px-5"}`}>
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent font-display text-[15px] font-bold text-white">S</span>
        {!mini && <span className="font-display text-[15px] font-bold tracking-widest uppercase">Shopkeep</span>}
      </div>
      <nav className={`flex-1 space-y-0.5 ${mini ? "px-2" : "px-3"}`}>
        {NAV.map(({ label, to, Icon }) => (
          <Link
            key={to}
            to={to}
            onClick={() => setDrawer(false)}
            title={mini ? label : undefined}
            aria-current={active === label ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded-lg py-2 text-sm transition-colors ${mini ? "justify-center px-0" : "px-3"} ${
              active === label ? "bg-panel2 font-semibold text-ink" : "text-ink2 hover:bg-panel2/60 hover:text-ink"
            }`}
          >
            <Icon size={17} className={`flex-none ${active === label ? "text-accent" : "text-mut"}`} />
            {!mini && label}
          </Link>
        ))}
      </nav>
      <div className={`border-t border-line py-4 text-sm ${mini ? "px-2" : "px-5"}`}>
        {mini ? (
          <button type="button" onClick={() => logout.mutate()} title="Sign out"
            className="flex w-full justify-center rounded-lg py-2 text-ink2 hover:bg-panel2/60 hover:text-ink">
            <LogOut size={16} />
          </button>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-ink2">{me.data?.displayName ?? ""}</span>
              {me.data && (
                <span className="rounded-full border border-line px-2 py-0.5 text-[10px] tracking-wider text-mut uppercase">
                  {me.data.role.toLowerCase()}
                </span>
              )}
            </div>
            <button type="button" onClick={() => logout.mutate()} className="mt-1.5 text-xs text-accent hover:underline">
              Sign out
            </button>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen">
      {/* desktop sidebar */}
      <aside className={`sticky top-0 hidden h-screen flex-none flex-col border-r border-line bg-panel transition-[width] duration-150 lg:flex ${collapsed ? "w-[60px]" : "w-60"}`}>
        {sidebarInner(collapsed)}
      </aside>

      {/* mobile drawer */}
      {drawer && (
        <>
          <div className="fixed inset-0 z-40 bg-black/35 lg:hidden" onClick={() => setDrawer(false)} />
          <aside className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-panel shadow-2xl lg:hidden">
            <button type="button" onClick={() => setDrawer(false)}
              className="absolute top-4 right-3 rounded-md border border-line p-1 text-ink2"><X size={15} /></button>
            {sidebarInner(false)}
          </aside>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur lg:px-8">
          <button type="button" onClick={() => setDrawer(true)}
            className="rounded-md border border-line p-1.5 text-ink2 lg:hidden"><Menu size={17} /></button>
          <button type="button" onClick={toggleCollapsed} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden rounded-md border border-line p-1.5 text-ink2 hover:border-accent hover:text-accent lg:block">
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <h1 className="text-[15px] font-bold">{title ?? active}</h1>
          <div className="ml-auto flex flex-wrap items-center gap-3">{actions}</div>
        </header>
        <main className="flex-1 px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
