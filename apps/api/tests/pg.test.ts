import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../src/migrate";
import { PgStore } from "../src/pgStore";

/** Інтеграційний тест PostgreSQL. Запускається, лише якщо задано TEST_DATABASE_URL. */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgStore", () => {
  let store: PgStore;
  const params = {
    prop: 15, pitch: 7, blades: 2 as const, frame: "open" as const, stator: "4215", kv: 400, cells: 12, auw: 7000,
    style: "cinematic" as const, motorPoles: 24, profile: 0, rateProfile: 0, rpmFilter: true,
  };

  beforeAll(async () => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query("DROP TABLE IF EXISTS tune_sessions, builds, schema_migrations");
    await c.end();
    expect(await migrate(url!)).toEqual(["001_init.sql"]);
    expect(await migrate(url!)).toEqual([]);
    store = PgStore.fromUrl(url!);
  });
  afterAll(async () => {
    await store?.close();
  });

  it("зберігає борти і сесії з ізоляцією за власником", async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const b = await store.createBuild(alice, { name: "15\" кіно", params });
    expect(b.params.kv).toBe(400);
    expect(await store.getBuild(bob, b.id)).toBeNull();
    const s = await store.addSession(alice, b.id, { kind: "start", cli: "save", tune: { a: 1 }, changes: [], findings: [], summary: {} });
    expect(s?.cli).toBe("save");
    expect(await store.addSession(bob, b.id, { kind: "start", cli: "save", tune: {}, changes: [], findings: [], summary: {} })).toBeNull();
    expect((await store.listSessions(alice, b.id))!.length).toBe(1);
    expect(await store.updateBuild(alice, b.id, { name: "15\"", params: { ...params, auw: 7500 } })).toMatchObject({ name: "15\"" });
    expect(await store.deleteBuild(bob, b.id)).toBe(false);
    expect(await store.deleteBuild(alice, b.id)).toBe(true);
    expect(await store.listBuilds(alice)).toEqual([]);
  });
});
