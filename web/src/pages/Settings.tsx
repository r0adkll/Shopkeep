import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
import { AppShell, Card, ErrorText, Field } from "../ui";

type Capabilities = { maxPhotos: number; maxVariationAxes: number; skuOnAllAxes: boolean };
type Connection = {
  id: number;
  platform: string;
  label: string;
  shopId: string | null;
  shopName: string | null;
  scopes: string;
  status: "pending" | "connected" | "error" | "disconnected";
  lastVerifiedAt: string | null;
  errorMessage: string | null;
  capabilities: Capabilities;
  lastSyncedAt: string | null;
  orderCount: number;
  config: Record<string, string> | null;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/integrations${path}`, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { message: string }).message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Brand color only — used sparingly (platform name, dialog selection). */
const BRAND: Record<string, { color: string; name: string }> = {
  etsy: { color: "#F1641E", name: "Etsy" },
  usps: { color: "#004B87", name: "USPS" },
};

const STATUS_STYLE: Record<Connection["status"], string> = {
  connected: "bg-good/10 text-good",
  pending: "bg-panel2 text-ink2 border border-line",
  error: "bg-crit/10 text-crit",
  disconnected: "bg-line/60 text-mut",
};

export function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login" });
  }, [me.error, navigate]);

  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => req<Connection[]>("/connections"),
    enabled: !!me.data,
  });

  const params = new URLSearchParams(window.location.search);
  const justConnected = params.get("connected");
  const oauthError = params.get("error");

  const syncNow = useMutation({
    mutationFn: (id: number) => req<{ fetched: number; created: number }>(`/connections/${id}/sync`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });
  const verify = useMutation({
    mutationFn: (id: number) => req<Connection>(`/connections/${id}/verify`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });
  const disconnect = useMutation({
    mutationFn: (id: number) => req<void>(`/connections/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });

  const isAdmin = me.data?.role === "ADMIN";
  const [adding, setAdding] = useState(false);
  const [addPlatform, setAddPlatform] = useState<"etsy" | "usps">("etsy");
  if (!me.data) return <main className="flex min-h-screen items-center justify-center text-mut">Loading…</main>;

  return (
    <AppShell active="Settings">
      <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-bold tracking-widest text-ink2 uppercase">Connections</h2>
        {isAdmin && (
          <button type="button" onClick={() => setAdding(true)}
            className="rounded-md bg-accent px-3.5 py-1.5 text-sm font-semibold text-white hover:opacity-90">
            + Add connection
          </button>
        )}
      </div>

      {justConnected && (
        <div className="mb-4 rounded-lg border border-good bg-good/10 px-4 py-2.5 text-sm font-semibold text-good">
          Connected to {justConnected === "etsy" ? "Etsy" : justConnected} — run Verify to confirm what your key grants.
        </div>
      )}
      {oauthError && (
        <div className="mb-4 rounded-lg border border-crit bg-crit/10 px-4 py-2.5 text-sm font-semibold text-crit">
          Connection failed ({oauthError}). Check the keystring and that the callback URL below is registered on your Etsy app.
        </div>
      )}

      {(connections.data ?? []).map((c) => (
        <Card key={c.id} className="mb-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[15px] font-bold" style={{ color: BRAND[c.platform]?.color }}>
              {BRAND[c.platform]?.name ?? c.platform}
            </span>
            {c.shopName && <span className="text-sm font-medium text-ink">{c.shopName}</span>}
            {c.label && c.label.toLowerCase() !== c.platform && <span className="text-xs text-mut">({c.label})</span>}
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold tracking-wider uppercase ${STATUS_STYLE[c.status]}`}>
              {c.status}
            </span>
            {isAdmin && (
              <span className="ml-auto flex gap-2">
                <button type="button" onClick={() => syncNow.mutate(c.id)} disabled={syncNow.isPending}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                  {syncNow.isPending ? "Syncing…" : "Sync now"}
                </button>
                <button type="button" onClick={() => verify.mutate(c.id)} disabled={verify.isPending}
                  className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink2 hover:border-accent hover:text-ink">
                  {verify.isPending ? "Verifying…" : "Verify"}
                </button>
                <button type="button" onClick={() => disconnect.mutate(c.id)}
                  className="rounded-md border border-crit/40 px-3 py-1.5 text-xs font-semibold text-crit hover:border-crit">
                  Disconnect
                </button>
              </span>
            )}
          </div>
          <div className="mt-2 grid gap-1 text-xs text-ink2">
            {c.shopId && <span>shop id <b className="font-mono">{c.shopId}</b></span>}
            {c.platform !== "usps" && <span>scopes <b className="font-mono">{c.scopes || "—"}</b></span>}
            {c.platform !== "usps" && c.status === "connected" && (
              <span>
                {c.lastSyncedAt
                  ? <>last synced <b>{new Date(c.lastSyncedAt).toLocaleString()}</b> · <b className="font-mono">{c.orderCount}</b> orders ingested</>
                  : "not synced yet — first sync pulls open orders only"}
              </span>
            )}
            {c.platform === "usps" && <UspsConfig c={c} />}
            {c.lastVerifiedAt && <span className="text-mut">verified {new Date(c.lastVerifiedAt).toLocaleString()}</span>}
            {c.errorMessage && <span className="font-semibold text-crit">{c.errorMessage}</span>}
            {c.platform !== "usps" && (
              <span className="text-mut">
                capabilities: {c.capabilities.maxPhotos} photos · {c.capabilities.maxVariationAxes} axes
                {c.capabilities.skuOnAllAxes ? " · per-combination SKUs" : ""}
              </span>
            )}
          </div>
        </Card>
      ))}

      {(connections.data ?? []).length === 0 && !connections.isLoading && (
        <p className="mb-3 text-sm text-mut">No connections yet — add your Etsy shop to start syncing.</p>
      )}
      {!isAdmin && <p className="text-sm text-mut">Settings are managed by admins.</p>}

      {isAdmin && (
        <>
          <h2 className="mt-8 mb-3 text-[13px] font-bold tracking-widest text-ink2 uppercase">Users</h2>
          <UsersSection selfId={me.data.id} />
          <h2 className="mt-8 mb-3 text-[13px] font-bold tracking-widest text-ink2 uppercase">Fulfillment</h2>
          <SlipSettings />
          <h2 className="mt-8 mb-3 text-[13px] font-bold tracking-widest text-ink2 uppercase">Costs</h2>
          <LaborRateSettings />
        </>
      )}

      {adding && isAdmin && (
        <>
          <div className="fixed inset-0 z-40 bg-black/35" onClick={() => setAdding(false)} />
          <div className="fixed inset-x-0 top-10 z-50 mx-auto max-h-[85vh] w-[min(640px,94vw)] overflow-y-auto rounded-2xl border border-line bg-bg p-5 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <b className="text-[15px]">Add a connection</b>
              <button onClick={() => setAdding(false)} className="rounded-md border border-line px-2 py-0.5 text-xs text-ink2 hover:text-ink">✕</button>
            </div>
            <div className="mb-4 flex gap-2">
              {(["etsy", "usps"] as const).map((p) => (
                <button key={p} type="button" onClick={() => setAddPlatform(p)}
                  className={`rounded-lg border px-4 py-2 text-sm font-semibold ${addPlatform === p ? "" : "border-line text-ink2 hover:text-ink"}`}
                  style={addPlatform === p ? { borderColor: BRAND[p].color, color: BRAND[p].color, boxShadow: `inset 0 0 0 1px ${BRAND[p].color}` } : undefined}>
                  {p === "etsy" ? "Etsy shop" : "USPS shipping"}
                </button>
              ))}
            </div>
            {addPlatform === "etsy" && <ConnectEtsy />}
            {addPlatform === "usps" && (
              (connections.data ?? []).some((c) => c.platform === "usps" && c.status !== "disconnected")
                ? <p className="text-sm text-mut">A USPS connection already exists — configure it on its card.</p>
                : <ConnectUsps onDone={() => setAdding(false)} />
            )}
          </div>
        </>
      )}
      </div>
    </AppShell>
  );
}

type ManagedUser = { id: number; email: string; displayName: string; role: "ADMIN" | "MANAGER"; disabled: boolean; authVia: "local" | "oidc" | "both" };

const genPassword = () => {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint32Array(14)), (n) => chars[n % chars.length]).join("");
};

/** Admin user management (Users & Auth): create locals, promote/demote,
 *  set a new password by hand (self-hosted — no SMTP assumed), soft-disable. */
function UsersSection({ selfId }: { selfId: number }) {
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => fetch("/api/v1/users").then((r) => r.json() as Promise<ManagedUser[]>),
  });
  const [err, setErr] = useState<string | null>(null);
  const [pwFor, setPwFor] = useState<ManagedUser | null>(null);
  const [newPw, setNewPw] = useState("");
  const [creating, setCreating] = useState(false);
  const [nu, setNu] = useState({ email: "", displayName: "", password: genPassword(), role: "MANAGER" as "ADMIN" | "MANAGER" });

  const act = async (path: string, body: unknown) => {
    setErr(null);
    const r = await fetch(`/api/v1${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) setErr(((await r.json().catch(() => null)) as { message?: string } | null)?.message ?? r.statusText);
    qc.invalidateQueries({ queryKey: ["users"] });
    return r.ok;
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">People with access</h2>
        <button type="button" onClick={() => { setCreating(true); setNu({ email: "", displayName: "", password: genPassword(), role: "MANAGER" }); }}
          className="rounded-md border border-accent/40 px-3 py-1 text-xs font-semibold text-accent hover:bg-accent/5">
          + Add user
        </button>
      </div>
      <ErrorText>{err}</ErrorText>
      <div className="mt-2 divide-y divide-line/60">
        {(users.data ?? []).map((u) => (
          <div key={u.id} className={`flex flex-wrap items-center gap-3 py-2.5 ${u.disabled ? "opacity-60" : ""}`}>
            <span className="min-w-0">
              <b className="text-sm">{u.displayName}</b>
              {u.id === selfId && <span className="ml-1.5 text-[10px] text-mut">(you)</span>}
              <span className="block text-xs text-ink2">{u.email}</span>
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold tracking-wider uppercase ${u.authVia === "local" ? "bg-panel2 text-mut" : "bg-accent/10 text-accent"}`}>
              {u.authVia === "both" ? "PASSWORD + SSO" : u.authVia === "oidc" ? "SSO" : "PASSWORD"}
            </span>
            {u.disabled && <span className="rounded-full bg-crit/10 px-2 py-0.5 text-[9px] font-extrabold tracking-wider text-crit">DISABLED</span>}
            <span className="ml-auto flex items-center gap-2">
              <select
                value={u.role}
                disabled={u.id === selfId}
                onChange={(e) => act(`/users/${u.id}/role`, { role: e.target.value })}
                title={u.id === selfId ? "another admin changes your role" : "role"}
                className="rounded-md border border-line bg-panel2 px-2 py-1 text-xs disabled:opacity-50"
              >
                <option value="ADMIN">admin</option>
                <option value="MANAGER">manager</option>
              </select>
              <button type="button" onClick={() => { setPwFor(u); setNewPw(genPassword()); }}
                className="rounded-md border border-line px-2 py-1 text-xs font-semibold text-ink2 hover:border-accent hover:text-accent">
                reset password
              </button>
              {u.id !== selfId && (
                <button type="button" onClick={() => act(`/users/${u.id}/disabled`, { disabled: !u.disabled })}
                  className={`rounded-md border px-2 py-1 text-xs font-semibold ${u.disabled ? "border-line text-ink2 hover:border-accent hover:text-accent" : "border-crit/40 text-crit hover:border-crit"}`}>
                  {u.disabled ? "enable" : "disable"}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-mut">
        SSO users appear here after their first sign-in (provisioned as managers). Disabling ends their sessions immediately; users are never deleted — notes and activity keep their author.
      </p>

      {pwFor && (
        <>
          <div className="fixed inset-0 z-40 bg-black/35" onClick={() => setPwFor(null)} />
          <div className="fixed inset-x-0 top-24 z-50 mx-auto w-[min(440px,94vw)] rounded-2xl border border-line bg-bg p-5 shadow-2xl">
            <b className="text-[15px]">Reset password — {pwFor.displayName}</b>
            <p className="mt-1 text-xs text-mut">Set a temporary password and hand it over — there's no email server to send links (self-hosted).</p>
            <div className="mt-3 flex items-center gap-2">
              <input value={newPw} onChange={(e) => setNewPw(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-line bg-panel2 px-3 py-1.5 font-mono text-sm outline-none focus:border-accent" />
              <button type="button" onClick={() => setNewPw(genPassword())} className="rounded-md border border-line px-2 py-1.5 text-xs text-ink2 hover:border-accent">↻</button>
              <button type="button" onClick={() => navigator.clipboard?.writeText(newPw)} className="rounded-md border border-line px-2 py-1.5 text-xs text-ink2 hover:border-accent">copy</button>
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={newPw.length < 8}
                onClick={async () => { if (await act(`/users/${pwFor.id}/password`, { password: newPw })) setPwFor(null); }}
                className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                Set password
              </button>
              <button type="button" onClick={() => setPwFor(null)} className="rounded-md border border-line px-3 py-1.5 text-xs text-ink2">cancel</button>
            </div>
          </div>
        </>
      )}

      {creating && (
        <>
          <div className="fixed inset-0 z-40 bg-black/35" onClick={() => setCreating(false)} />
          <div className="fixed inset-x-0 top-16 z-50 mx-auto w-[min(480px,94vw)] rounded-2xl border border-line bg-bg p-5 shadow-2xl">
            <b className="text-[15px]">Add a user</b>
            <div className="mt-3 grid gap-3">
              <Field label="Name" value={nu.displayName} onChange={(v) => setNu({ ...nu, displayName: v })} autoFocus />
              <Field label="Email" value={nu.email} onChange={(v) => setNu({ ...nu, email: v })} />
              <label className="block text-xs">
                <span className="mb-1 block font-semibold tracking-widest uppercase text-mut">Role</span>
                <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as "ADMIN" | "MANAGER" })}
                  className="rounded-md border border-line bg-panel2 px-2 py-2 text-sm">
                  <option value="MANAGER">manager</option>
                  <option value="ADMIN">admin</option>
                </select>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-semibold tracking-widest uppercase text-mut">Temporary password</span>
                <span className="flex items-center gap-2">
                  <input value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-line bg-panel2 px-3 py-1.5 font-mono text-sm outline-none focus:border-accent" />
                  <button type="button" onClick={() => setNu({ ...nu, password: genPassword() })} className="rounded-md border border-line px-2 py-1.5 text-xs text-ink2 hover:border-accent">↻</button>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(nu.password)} className="rounded-md border border-line px-2 py-1.5 text-xs text-ink2 hover:border-accent">copy</button>
                </span>
              </label>
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" disabled={!nu.email.trim() || !nu.displayName.trim() || nu.password.length < 8}
                onClick={async () => { if (await act("/users", nu)) setCreating(false); }}
                className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                Create user
              </button>
              <button type="button" onClick={() => setCreating(false)} className="rounded-md border border-line px-3 py-1.5 text-xs text-ink2">cancel</button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

/** Global labor rate ($/hr) — drives recipe costs and order labor lines. */
function LaborRateSettings() {
  const [rate, setRate] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    fetch("/api/v1/catalog/labor-rate").then((r) => r.json())
      .then((r) => setRate((r.rateMinor / 100).toFixed(2))).catch(() => setRate(""));
  }, []);
  const save = useMutation({
    mutationFn: () =>
      fetch("/api/v1/catalog/labor-rate", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rateMinor: Math.round(parseFloat(rate || "0") * 100) }),
      }).then((r) => { if (!r.ok) throw new Error(r.statusText); }),
    onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); },
  });
  if (rate === null) return null;
  return (
    <Card>
      <h2 className="text-sm font-semibold">Labor rate</h2>
      <p className="mt-1 text-xs text-mut">Per hour — drives recipe costs and each order's labor line.</p>
      <div className="mt-2 flex items-center gap-2">
        $<input value={rate} onChange={(e) => setRate(e.target.value)}
          className="w-24 rounded-md border border-line bg-panel2 px-3 py-1.5 text-right font-mono text-sm outline-none focus:border-accent" />
        <span className="text-xs text-mut">/ hr</span>
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending}
          className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-good">Saved.</span>}
      </div>
    </Card>
  );
}

/** Fulfillment settings (locked ship concept): the slip's footer message. */
function SlipSettings() {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    fetch("/api/v1/fulfillment/slip-footer").then((r) => r.json()).then((r) => setText(r.text)).catch(() => setText(""));
  }, []);
  const save = useMutation({
    mutationFn: () =>
      fetch("/api/v1/fulfillment/slip-footer", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      }).then((r) => { if (!r.ok) throw new Error(r.statusText); }),
    onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); },
  });
  if (text === null) return null;
  return (
    <Card>
      <h2 className="text-sm font-semibold">Packing slip footer</h2>
      <p className="mt-1 text-xs text-mut">Printed at the bottom of every packing slip.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
        className="mt-2 w-full rounded-md border border-line bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent" />
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending}
          className="rounded-md bg-accent px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-good">Saved.</span>}
      </div>
    </Card>
  );
}

const MAIL_CLASSES = [
  ["USPS_GROUND_ADVANTAGE", "Ground Advantage"],
  ["PRIORITY_MAIL", "Priority Mail"],
  ["FIRST-CLASS_PACKAGE_SERVICE", "First-Class Package"],
] as const;

/** Origin ZIP + mail class live on the connection (D22). */
function UspsConfig({ c }: { c: Connection }) {
  const queryClient = useQueryClient();
  const cfg = (k: string) => c.config?.[k] ?? "";
  const [f, setF] = useState({
    originZip: cfg("originZip"), mailClass: cfg("mailClass") || "USPS_GROUND_ADVANTAGE",
    crid: cfg("crid"), mid: cfg("mid"), manifestMid: cfg("manifestMid"), accountNumber: cfg("accountNumber"),
    fromName: cfg("fromName"), fromStreet: cfg("fromStreet"), fromCity: cfg("fromCity"), fromState: cfg("fromState"),
    labelPurchase: cfg("labelPurchase") === "true",
    environment: cfg("environment") === "test" ? "test" : "production",
  });
  const set = (k: string, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));
  const save = useMutation({
    mutationFn: () => req(`/usps/${c.id}/config`, { method: "PUT", body: JSON.stringify(f) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });
  const labelReady = !!(f.crid && f.mid && f.accountNumber && f.fromName && f.fromStreet && f.fromCity && f.fromState && f.originZip);
  const inp = "rounded border border-line bg-panel2 px-2 py-0.5 font-mono text-xs";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex flex-wrap items-center gap-2">
        origin ZIP
        <input value={f.originZip} onChange={(e) => set("originZip", e.target.value)} className={`w-20 ${inp}`} />
        <select value={f.mailClass} onChange={(e) => set("mailClass", e.target.value)} className="rounded border border-line bg-panel2 px-1.5 py-0.5 text-xs">
          {MAIL_CLASSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="text-mut">quotes use commercial pricing — what Etsy labels charge</span>
      </span>
      {/* Path B: label purchase — Ship-API enrollment + EPS payment account */}
      <span className="flex flex-wrap items-center gap-2">
        <label className={`flex items-center gap-1.5 text-xs font-semibold ${labelReady ? "text-ink" : "text-mut"}`} title={labelReady ? "" : "fill the Ship-API fields below first"}>
          <input type="checkbox" checked={f.labelPurchase} disabled={!labelReady} onChange={(e) => set("labelPurchase", e.target.checked)} className="accent-accent" />
          Label purchase
        </label>
        <select value={f.environment} onChange={(e) => set("environment", e.target.value)}
          className={`rounded border px-1.5 py-0.5 text-xs ${f.environment === "test" ? "border-warn bg-warn/10 font-semibold text-warn" : "border-line bg-panel2"}`}>
          <option value="production">production</option>
          <option value="test">TEM sandbox</option>
        </select>
        <span className="text-[10.5px] text-mut">
          {f.environment === "test"
            ? "sandbox (apis-tem) — buys are fake, nothing is recorded or sent to Etsy; use your TEM app credentials"
            : "buying charges your EPS account — needs USPS Ship-API enrollment (CRID + MID + payment account)"}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-2 text-[11px]">
        CRID <input value={f.crid} onChange={(e) => set("crid", e.target.value)} className={`w-20 ${inp}`} />
        MID <input value={f.mid} onChange={(e) => set("mid", e.target.value)} className={`w-20 ${inp}`} />
        manifest MID <input value={f.manifestMid} onChange={(e) => set("manifestMid", e.target.value)} placeholder="= MID" className={`w-20 ${inp}`} />
        EPS acct <input value={f.accountNumber} onChange={(e) => set("accountNumber", e.target.value)} className={`w-24 ${inp}`} />
      </span>
      <span className="flex flex-wrap items-center gap-2 text-[11px]">
        ship from
        <input value={f.fromName} onChange={(e) => set("fromName", e.target.value)} placeholder="name" className={`w-28 ${inp}`} />
        <input value={f.fromStreet} onChange={(e) => set("fromStreet", e.target.value)} placeholder="street" className={`w-40 ${inp}`} />
        <input value={f.fromCity} onChange={(e) => set("fromCity", e.target.value)} placeholder="city" className={`w-24 ${inp}`} />
        <input value={f.fromState} onChange={(e) => set("fromState", e.target.value)} placeholder="ST" className={`w-10 ${inp}`} />
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending}
          className="rounded border border-accent/40 px-2 py-0.5 text-[11px] font-semibold text-accent hover:bg-accent/5 disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </span>
    </div>
  );
}

function ConnectUsps({ onDone }: { onDone?: () => void }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [zip, setZip] = useState("");
  const [mailClass, setMailClass] = useState("USPS_GROUND_ADVANTAGE");
  const connect = useMutation({
    mutationFn: () =>
      req<Connection>("/usps/connect", {
        method: "POST",
        body: JSON.stringify({ consumerKey: key, consumerSecret: secret, originZip: zip, mailClass }),
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connections"] }); onDone?.(); },
  });
  return (
    <Card className="mt-3">
      <h2 className="text-sm font-semibold">Connect USPS <span className="ml-1 text-xs font-normal text-mut">shipping cost estimates (D22)</span></h2>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs text-ink2">
        <li>Sign up (free) at <b>developer.usps.com</b> and create an app — this issues a <b>consumer key</b> and <b>consumer secret</b>.</li>
        <li>Add the <b>Prices</b> API to the app (default access is fine — quotes only, no labels).</li>
        <li>Paste the credentials below with the ZIP you ship from. Connect verifies by fetching a token.</li>
      </ol>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Consumer key" value={key} onChange={setKey} />
        <Field label="Consumer secret" value={secret} onChange={setSecret} />
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="w-32"><Field label="Origin ZIP" value={zip} onChange={setZip} /></div>
        <label className="block text-xs">
          <span className="mb-1 block font-semibold tracking-widest uppercase text-mut">Mail class</span>
          <select value={mailClass} onChange={(e) => setMailClass(e.target.value)} className="rounded-md border border-line bg-panel2 px-2 py-2 text-sm">
            {MAIL_CLASSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <ErrorText>{connect.error?.message}</ErrorText>
      <button
        type="button"
        disabled={!key.trim() || !secret.trim() || !zip.trim() || connect.isPending}
        onClick={() => connect.mutate()}
        className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {connect.isPending ? "Connecting…" : "Connect USPS"}
      </button>
      <p className="mt-2 text-[11px] text-mut">
        Credentials are encrypted at rest like storefront tokens. Order estimates need box dimensions on your packaging
        materials and weights (derived from each product's BOM, or set per product).
      </p>
    </Card>
  );
}

function ConnectEtsy() {
  const [keystring, setKeystring] = useState("");
  const [sharedSecret, setSharedSecret] = useState("");
  const [label, setLabel] = useState("");
  const redirectUri = `${window.location.origin}/api/v1/integrations/etsy/callback`;

  const start = useMutation({
    mutationFn: () =>
      req<{ authUrl: string }>("/etsy/start", {
        method: "POST",
        body: JSON.stringify({ keystring, sharedSecret, label }),
      }),
    onSuccess: (r) => {
      window.location.href = r.authUrl;
    },
  });

  return (
    <Card className="mt-2">
      <h2 className="text-sm font-semibold">Connect an Etsy shop</h2>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs text-ink2">
        <li>
          Create (or open) your app at <b>etsy.com/developers</b> — provisional keys work for your own shop before
          full approval.
        </li>
        <li>
          Add this callback URL to the app:
          <code className="mt-1 block w-fit rounded bg-panel2 px-2 py-1 font-mono text-[11px] select-all">{redirectUri}</code>
        </li>
        <li>
          Paste the app's <b>keystring</b> and <b>shared secret</b> below (both shown in Your Apps — Etsy requires
          both on every API call since Feb 2026), then connect. Etsy will ask you to grant access to your shop.
        </li>
      </ol>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Keystring" value={keystring} onChange={setKeystring} />
        <Field label="Shared secret" value={sharedSecret} onChange={setSharedSecret} />
      </div>
      <div className="mt-3 max-w-60">
        <Field label="Label (optional)" value={label} onChange={setLabel} />
      </div>
      <ErrorText>{start.error?.message}</ErrorText>
      <button
        type="button"
        disabled={!keystring.trim() || !sharedSecret.trim() || start.isPending}
        onClick={() => start.mutate()}
        className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {start.isPending ? "Starting…" : "Connect to Etsy →"}
      </button>
      <p className="mt-2 text-[11px] text-mut">
        Requested scopes: transactions_r/w · listings_r/w. The shared secret and tokens are encrypted at rest; verification shows exactly
        what your current key grants.
      </p>
    </Card>
  );
}
