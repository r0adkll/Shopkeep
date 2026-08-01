import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "../api";
import { Button, Card, ErrorText, Field, Wordmark } from "../ui";

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: api.login,
    onSuccess: (user) => {
      queryClient.setQueryData(["me"], user);
      navigate({ to: "/" });
    },
  });

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <Wordmark />
        <Card className="space-y-4">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate({ email, password });
            }}
          >
            <Field label="Email" type="email" value={email} onChange={setEmail} autoFocus />
            <Field label="Password" type="password" value={password} onChange={setPassword} />
            <ErrorText>{login.error?.message}</ErrorText>
            <Button disabled={login.isPending}>{login.isPending ? "Signing in…" : "Sign in"}</Button>
          </form>
        </Card>
      </div>
    </main>
  );
}
