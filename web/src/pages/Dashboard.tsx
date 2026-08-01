import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, api } from "../api";
import { Card, Wordmark } from "../ui";

/**
 * Phase 0 dashboard shell: proves auth + serving end-to-end.
 * The real landing view is the Inventory dashboard (vault: Inventory UX), Phase 1.
 */
export function DashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    enabled: setup.data?.needsSetup === false,
  });

  useEffect(() => {
    if (setup.data?.needsSetup) navigate({ to: "/setup" });
  }, [setup.data, navigate]);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login" });
  }, [me.error, navigate]);

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.removeQueries();
      navigate({ to: "/login" });
    },
  });

  if (!me.data) {
    return <main className="flex min-h-screen items-center justify-center text-mut">Loading…</main>;
  }

  return (
    <div className="mx-auto max-w-5xl px-6 pb-16">
      <header className="mb-8 flex flex-wrap items-center gap-5 border-b border-line py-5">
        <Wordmark />
        <nav className="ml-auto flex items-center gap-4 text-sm">
          <span className="text-ink2">
            {me.data.displayName}
            <span className="ml-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] tracking-wider text-mut uppercase">
              {me.data.role.toLowerCase()}
            </span>
          </span>
          <button
            type="button"
            onClick={() => logout.mutate()}
            className="text-accent hover:underline"
          >
            Sign out
          </button>
        </nav>
      </header>

      <Card>
        <h1 className="mb-1 text-lg font-semibold">Your shop is running</h1>
        <p className="text-sm text-ink2">
          Phase 0 foundations are in place. Inventory — the filament wall, stock health board, and
          purchasing queue — arrives in Phase 1.
        </p>
      </Card>
    </div>
  );
}
