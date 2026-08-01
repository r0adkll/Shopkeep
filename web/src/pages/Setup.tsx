import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "../api";
import { Button, Card, ErrorText, Field, Wordmark } from "../ui";

/** First-run setup wizard (vault: D7) — creates the admin account. */
export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  const setup = useMutation({
    mutationFn: api.setup,
    onSuccess: (user) => {
      // Update caches before navigating, or the dashboard's stale
      // needsSetup=true immediately redirects back here.
      queryClient.setQueryData(["setup"], { needsSetup: false });
      queryClient.setQueryData(["me"], user);
      navigate({ to: "/" });
    },
  });

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <Wordmark />
        <Card className="space-y-4">
          <div>
            <h1 className="text-lg font-semibold">Welcome to your shop</h1>
            <p className="text-sm text-ink2">
              Create the administrator account to finish installation.
            </p>
          </div>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setup.mutate({ email, displayName, password });
            }}
          >
            <Field label="Name" value={displayName} onChange={setDisplayName} autoFocus />
            <Field label="Email" type="email" value={email} onChange={setEmail} />
            <Field label="Password" type="password" value={password} onChange={setPassword} />
            <ErrorText>{setup.error?.message}</ErrorText>
            <Button disabled={setup.isPending}>
              {setup.isPending ? "Creating…" : "Create admin account"}
            </Button>
          </form>
        </Card>
        <p className="text-xs text-mut">
          Passwords need at least 10 characters. This screen only appears while no users exist.
        </p>
      </div>
    </main>
  );
}
