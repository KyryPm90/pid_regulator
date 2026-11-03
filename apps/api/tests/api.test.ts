import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { MemoryStore } from "../src/store";

const params = {
  prop: 10, pitch: 5, blades: 3, frame: "open", stator: "3115", kv: 900, cells: 6, auw: 2600,
  style: "longrange", motorPoles: 14, profile: 0, rateProfile: 0, rpmFilter: true,
};

let app: FastifyInstance;
const alice = randomUUID();
const bob = randomUUID();
const h = (id: string) => ({ "x-client-id": id });

beforeEach(() => {
  app = buildApp({ store: new MemoryStore() });
});
afterEach(async () => {
  await app.close();
});

describe("API", () => {
  it("health", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.json()).toEqual({ ok: true, storage: "memory" });
  });

  it("рахує тюн тим самим ядром", async () => {
    const r = await app.inject({ method: "POST", url: "/api/tune", payload: params });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.tune.pid.roll.p).toBeGreaterThan(0);
    expect(body.cli).toContain("rateprofile 0");
  });

  it("відхиляє параметри поза діапазоном", async () => {
    const r = await app.inject({ method: "POST", url: "/api/tune", payload: { ...params, prop: 3 } });
    expect(r.statusCode).toBe(400);
  });

  it("гараж: створення, список, оновлення, видалення", async () => {
    const c = await app.inject({ method: "POST", url: "/api/builds", headers: h(alice), payload: { name: "10\" LR", params } });
    expect(c.statusCode).toBe(201);
    const id = c.json().id;
    const list = await app.inject({ method: "GET", url: "/api/builds", headers: h(alice) });
    expect(list.json().builds).toHaveLength(1);
    const u = await app.inject({ method: "PUT", url: `/api/builds/${id}`, headers: h(alice), payload: { name: "10\" важкий", params: { ...params, auw: 3000 } } });
    expect(u.json().params.auw).toBe(3000);
    const d = await app.inject({ method: "DELETE", url: `/api/builds/${id}`, headers: h(alice) });
    expect(d.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/builds", headers: h(alice) })).json().builds).toHaveLength(0);
  });

  it("історія тюнів прив'язана до борта", async () => {
    const id = (await app.inject({ method: "POST", url: "/api/builds", headers: h(alice), payload: { name: "13\"", params } })).json().id;
    const s = await app.inject({
      method: "POST",
      url: `/api/builds/${id}/sessions`,
      headers: h(alice),
      payload: { kind: "log", cli: "set p_roll = 30\nsave", tune: { pid: {} }, changes: [{ group: "PID", param: "d_roll", from: 30, to: 33, reason: "тест" }], summary: { peak: 1.2 } },
    });
    expect(s.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `/api/builds/${id}/sessions`, headers: h(alice) });
    expect(list.json().sessions[0].changes[0].param).toBe("d_roll");
  });

  it("не показує і не змінює чужі борти", async () => {
    const id = (await app.inject({ method: "POST", url: "/api/builds", headers: h(alice), payload: { name: "мій", params } })).json().id;
    expect((await app.inject({ method: "GET", url: `/api/builds/${id}`, headers: h(bob) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/builds/${id}`, headers: h(bob) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/builds/${id}/sessions`, headers: h(bob), payload: { kind: "start", cli: "save", tune: {} } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/builds", headers: h(bob) })).json().builds).toHaveLength(0);
  });

  it("без X-Client-Id повертає 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/builds" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/builds", headers: { "x-client-id": "abc" } })).statusCode).toBe(401);
  });
});
