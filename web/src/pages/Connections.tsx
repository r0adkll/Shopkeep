import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
import { Card, ErrorText, Field, Wordmark } from "../ui";

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

export function ConnectionsPage() {
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

  const verify = useMutation({
    mutationFn: (id: number) => req<Connection>(`/connections/${id}/verify`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });
  const disconnect = useMutation({
    mutationFn: (id: number) => req<void>(`/connections/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connections"] }),
  });

  const isAdmin = me.data?.role === "ADMIN";
  if (!me.data) return <main className="flex min-h-screen items-center justify-center text-mut">Loading…</main>;

  return (
    <div className="mx-auto max-w-4xl px-6 pb-16">
      <header className="mb-6 flex flex-wrap items-center gap-5 border-b border-line py-5">
        <Wordmark />
        <nav className="flex gap-4 text-sm">
          <Link to="/" className="text-ink2 hover:text-ink">Inventory</Link>
          <Link to="/products" className="text-ink2 hover:text-ink">Products</Link>
          <Link to="/listings" className="text-ink2 hover:text-ink">Listings</Link>
          <span className="font-semibold">Connections</span>
        </nav>
        <span className="ml-auto text-sm text-ink2">{me.data.displayName}</span>
      </header>

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
            <span>scopes <b className="font-mono">{c.scopes || "—"}</b></span>
            {c.lastVerifiedAt && <span className="text-mut">verified {new Date(c.lastVerifiedAt).toLocaleString()}</span>}
            {c.errorMessage && <span className="font-semibold text-crit">{c.errorMessage}</span>}
            <span className="text-mut">
              capabilities: {c.capabilities.maxPhotos} photos · {c.capabilities.maxVariationAxes} axes
              {c.capabilities.skuOnAllAxes ? " · per-combination SKUs" : ""}
            </span>
          </div>
        </Card>
      ))}

      {isAdmin ? <ConnectEtsy /> : (
        <p className="text-sm text-mut">Storefront connections are managed by admins.</p>
      )}
    </div>
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
