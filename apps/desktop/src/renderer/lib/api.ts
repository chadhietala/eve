/** A bot as the control server describes it. No credentials cross this line. */
export interface Bot {
  readonly color?: string;
  readonly description?: string;
  readonly group?: string;
  readonly hasToken: boolean;
  readonly id: string;
  readonly name: string;
  readonly pinned?: boolean;
  readonly title?: string;
  readonly url: string;
}

export interface DesktopState {
  readonly bots: readonly Bot[];
  readonly computer: { readonly backend: string };
}

export interface Screenshot {
  readonly base64: string;
  readonly height: number;
  readonly mediaType: string;
  readonly width: number;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof (body as { error?: unknown })?.error === "string"
        ? (body as { error: string }).error
        : `Request failed (${response.status}).`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export const api = {
  state: () => request<DesktopState>("/api/state"),

  createBot: (input: Partial<Bot> & { name: string; url: string; token?: string }) =>
    request<{ bot: Bot }>("/api/bots", { body: JSON.stringify(input), method: "POST" }),

  updateBot: (id: string, input: Partial<Bot> & { token?: string }) =>
    request<{ bot: Bot }>(`/api/bots/${id}`, { body: JSON.stringify(input), method: "PATCH" }),

  deleteBot: (id: string) => request<{ deleted: string }>(`/api/bots/${id}`, { method: "DELETE" }),

  screenshot: () => request<{ screenshot?: Screenshot }>("/api/computer/screenshot"),

  computerAction: (action: Record<string, unknown>) =>
    request<{ screenshot?: Screenshot }>("/api/computer/action", {
      body: JSON.stringify(action),
      method: "POST",
    }),

  pairing: () => request<{ token: string }>("/api/pairing"),
};
