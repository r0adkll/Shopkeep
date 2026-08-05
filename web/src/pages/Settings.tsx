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
            <span className="text-[15px] font-semibold capitalize">{c.platform}</span>
            {c.shopName && <span className="text-sm text-ink2">{c.shopName}</span>}
            {c.label && <span className="text-xs text-mut">({c.label})</span>}
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
                  className={`rounded-lg border px-4 py-2 text-sm font-semibold capitalize ${addPlatform === p ? "border-accent text-accent" : "border-line text-ink2 hover:border-accent"}`}>
                  {p === "etsy" ? "Etsy shop" : "USPS (shipping)"}
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
  const [zip, setZip] = useState(c.config?.originZip ?? "");
  const [mailClass, setMailClass] = useState(c.config?.mailClass ?? "USPS_GROUND_ADVANTAGE");
  const dirty = zip !== (c.config?.originZip ?? "") || mailClass !== (c.config?.mailClass ?? "USPS_GROUND_ADVANTAGE");
  const save = useMutation({
    mutationFn: () => req(`/usps/${c.id}/config`, { method: "PUT", body: JSON.stringify({ originZip: zip, mailClass }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });
  return (
    <span className="flex flex-wrap items-center gap-2">
      origin ZIP
      <input value={zip} onChange={(e) => setZip(e.target.value)} className="w-20 rounded border border-line bg-panel2 px-2 py-0.5 font-mono text-xs" />
      <select value={mailClass} onChange={(e) => setMailClass(e.target.value)} className="rounded border border-line bg-panel2 px-1.5 py-0.5 text-xs">
        {MAIL_CLASSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {dirty && (
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending}
          className="rounded border border-accent/40 px-2 py-0.5 text-[11px] font-semibold text-accent hover:bg-accent/5 disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save"}
        </button>
      )}
      <span className="text-mut">quotes use commercial pricing — what Etsy labels charge</span>
    </span>
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
