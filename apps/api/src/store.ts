import { randomUUID } from "node:crypto";
import type { BuildInput, SessionInput } from "./schema";

export interface Build extends BuildInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface TuneSession extends SessionInput {
  id: string;
  buildId: string;
  createdAt: string;
}

/** Сховище даних. Усі операції обмежені власником (ownerId). */
export interface Store {
  readonly kind: "memory" | "postgres";
  listBuilds(ownerId: string): Promise<Build[]>;
  getBuild(ownerId: string, id: string): Promise<Build | null>;
  createBuild(ownerId: string, input: BuildInput): Promise<Build>;
  updateBuild(ownerId: string, id: string, input: BuildInput): Promise<Build | null>;
  deleteBuild(ownerId: string, id: string): Promise<boolean>;
  listSessions(ownerId: string, buildId: string): Promise<TuneSession[] | null>;
  addSession(ownerId: string, buildId: string, input: SessionInput): Promise<TuneSession | null>;
  close(): Promise<void>;
}

/** Сховище в пам'яті: для тестів і запуску без бази даних. */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private builds = new Map<string, Build & { ownerId: string }>();
  private sessions: Array<TuneSession & { ownerId: string }> = [];

  async listBuilds(ownerId: string) {
    return [...this.builds.values()]
      .filter((b) => b.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(strip);
  }
  async getBuild(ownerId: string, id: string) {
    const b = this.builds.get(id);
    return b && b.ownerId === ownerId ? strip(b) : null;
  }
  async createBuild(ownerId: string, input: BuildInput) {
    const now = new Date().toISOString();
    const b = { ...structuredClone(input), id: randomUUID(), ownerId, createdAt: now, updatedAt: now };
    this.builds.set(b.id, b);
    return strip(b);
  }
  async updateBuild(ownerId: string, id: string, input: BuildInput) {
    const b = this.builds.get(id);
    if (!b || b.ownerId !== ownerId) return null;
    Object.assign(b, structuredClone(input), { updatedAt: new Date().toISOString() });
    return strip(b);
  }
  async deleteBuild(ownerId: string, id: string) {
    const b = this.builds.get(id);
    if (!b || b.ownerId !== ownerId) return false;
    this.builds.delete(id);
    this.sessions = this.sessions.filter((s) => s.buildId !== id);
    return true;
  }
  async listSessions(ownerId: string, buildId: string) {
    if (!(await this.getBuild(ownerId, buildId))) return null;
    return this.sessions
      .filter((s) => s.buildId === buildId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(strip);
  }
  async addSession(ownerId: string, buildId: string, input: SessionInput) {
    if (!(await this.getBuild(ownerId, buildId))) return null;
    const s = { ...structuredClone(input), id: randomUUID(), buildId, ownerId, createdAt: new Date().toISOString() };
    this.sessions.push(s);
    return strip(s);
  }
  async close() {}
}

function strip<T extends { ownerId: string }>(o: T): Omit<T, "ownerId"> {
  const { ownerId: _owner, ...rest } = o;
  return structuredClone(rest);
}
