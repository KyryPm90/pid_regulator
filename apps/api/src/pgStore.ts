import pg from "pg";
import type { BuildInput, SessionInput } from "./schema";
import type { Build, Store, TuneSession } from "./store";

interface BuildRow {
  id: string;
  name: string;
  params: BuildInput["params"];
  created_at: Date;
  updated_at: Date;
}
interface SessionRow {
  id: string;
  build_id: string;
  kind: SessionInput["kind"];
  payload: Omit<SessionInput, "kind">;
  created_at: Date;
}

const toBuild = (r: BuildRow): Build => ({
  id: r.id,
  name: r.name,
  params: r.params,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
const toSession = (r: SessionRow): TuneSession => ({
  ...r.payload,
  kind: r.kind,
  id: r.id,
  buildId: r.build_id,
  createdAt: r.created_at.toISOString(),
});

/** Сховище в PostgreSQL. Схема створюється міграціями з apps/api/migrations. */
export class PgStore implements Store {
  readonly kind = "postgres" as const;
  constructor(private pool: pg.Pool) {}

  static fromUrl(url: string): PgStore {
    return new PgStore(new pg.Pool({ connectionString: url, max: 10 }));
  }

  async listBuilds(ownerId: string) {
    const r = await this.pool.query<BuildRow>(
      "SELECT id, name, params, created_at, updated_at FROM builds WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 500",
      [ownerId],
    );
    return r.rows.map(toBuild);
  }
  async getBuild(ownerId: string, id: string) {
    const r = await this.pool.query<BuildRow>(
      "SELECT id, name, params, created_at, updated_at FROM builds WHERE owner_id = $1 AND id = $2",
      [ownerId, id],
    );
    return r.rows[0] ? toBuild(r.rows[0]) : null;
  }
  async createBuild(ownerId: string, input: BuildInput) {
    const r = await this.pool.query<BuildRow>(
      "INSERT INTO builds (owner_id, name, params) VALUES ($1, $2, $3) RETURNING id, name, params, created_at, updated_at",
      [ownerId, input.name, input.params],
    );
    return toBuild(r.rows[0]!);
  }
  async updateBuild(ownerId: string, id: string, input: BuildInput) {
    const r = await this.pool.query<BuildRow>(
      `UPDATE builds SET name = $3, params = $4, updated_at = now()
       WHERE owner_id = $1 AND id = $2 RETURNING id, name, params, created_at, updated_at`,
      [ownerId, id, input.name, input.params],
    );
    return r.rows[0] ? toBuild(r.rows[0]) : null;
  }
  async deleteBuild(ownerId: string, id: string) {
    const r = await this.pool.query("DELETE FROM builds WHERE owner_id = $1 AND id = $2", [ownerId, id]);
    return (r.rowCount ?? 0) > 0;
  }
  async listSessions(ownerId: string, buildId: string) {
    if (!(await this.getBuild(ownerId, buildId))) return null;
    const r = await this.pool.query<SessionRow>(
      "SELECT id, build_id, kind, payload, created_at FROM tune_sessions WHERE build_id = $1 ORDER BY created_at DESC LIMIT 200",
      [buildId],
    );
    return r.rows.map(toSession);
  }
  async addSession(ownerId: string, buildId: string, input: SessionInput) {
    const { kind, ...payload } = input;
    // Перевірка власника і вставка одним запитом: чужий buildId не вставить нічого.
    const r = await this.pool.query<SessionRow>(
      `INSERT INTO tune_sessions (build_id, kind, payload)
       SELECT id, $3, $4 FROM builds WHERE owner_id = $1 AND id = $2
       RETURNING id, build_id, kind, payload, created_at`,
      [ownerId, buildId, kind, payload],
    );
    if (!r.rows[0]) return null;
    await this.pool.query("UPDATE builds SET updated_at = now() WHERE id = $1", [buildId]);
    return toSession(r.rows[0]);
  }
  async close() {
    await this.pool.end();
  }
}
