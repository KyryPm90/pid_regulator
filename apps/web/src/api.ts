import type { BuildParams, Change, Tune } from "@pid/core";

/** Клієнт бекенду. Адреса з VITE_API_URL, інакше той самий домен (/api). Без бекенду застосунок працює як раніше. */
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const CLIENT_KEY = "fpv-pid-tuner:client-id";

export interface SavedBuild {
  id: string;
  name: string;
  params: BuildParams;
  createdAt: string;
  updatedAt: string;
}

export interface TuneSession {
  id: string;
  buildId: string;
  kind: "start" | "log";
  cli: string;
  tune: Tune;
  changes: Change[];
  findings: string[];
  summary: Record<string, number | string | null>;
  note?: string;
  createdAt: string;
}

export class ApiError extends Error {}

/** Тимчасовий ідентифікатор браузера, поки немає акаунтів. Дані прив'язані до нього. */
function clientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch {
    return (memoryId ??= crypto.randomUUID());
  }
}
let memoryId: string | undefined;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "x-client-id": clientId(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Сервер недоступний. Перевірте з'єднання.");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Помилка сервера (${res.status})`);
  return data as T;
}

/** Чи доступний бекенд. Короткий таймаут, щоб офлайн не чекати. */
export async function apiAvailable(): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: ctrl.signal });
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export const api = {
  listBuilds: () => call<{ builds: SavedBuild[] }>("GET", "/api/builds").then((r) => r.builds),
  createBuild: (name: string, params: BuildParams) => call<SavedBuild>("POST", "/api/builds", { name, params }),
  updateBuild: (id: string, name: string, params: BuildParams) => call<SavedBuild>("PUT", `/api/builds/${id}`, { name, params }),
  deleteBuild: (id: string) => call<void>("DELETE", `/api/builds/${id}`),
  listSessions: (id: string) => call<{ sessions: TuneSession[] }>("GET", `/api/builds/${id}/sessions`).then((r) => r.sessions),
  addSession: (id: string, s: Omit<TuneSession, "id" | "buildId" | "createdAt">) => call<TuneSession>("POST", `/api/builds/${id}/sessions`, s),
};
