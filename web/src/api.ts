export type User = {
  id: number;
  email: string;
  displayName: string;
  role: "ADMIN" | "MANAGER";
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { message: string }).message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  setupStatus: () => request<{ needsSetup: boolean }>("/setup/status"),
  setup: (body: { email: string; displayName: string; password: string }) =>
    request<User>("/setup", { method: "POST", body: JSON.stringify(body) }),
  login: (body: { email: string; password: string }) =>
    request<User>("/auth/login", { method: "POST", body: JSON.stringify(body) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: () => request<User>("/auth/me"),
  providers: () => request<{ oidcEnabled: boolean }>("/auth/providers"),
  health: () => request<{ status: string; version: string }>("/health"),
};
