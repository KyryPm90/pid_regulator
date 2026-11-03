import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { buildCli, computeTune } from "@pid/core";
import { buildInputSchema, buildParamsSchema, clientIdSchema, sessionInputSchema } from "./schema";
import type { Store } from "./store";

export interface AppOptions {
  store: Store;
  /** Дозволені джерела для CORS; true = будь-яке (для розробки) */
  corsOrigin?: string | string[] | boolean;
  logger?: boolean;
}

const idParam = z.object({ id: z.string().uuid() });

/** Створює Fastify-застосунок API. Сховище передається ззовні, щоб тести працювали без бази. */
export function buildApp({ store, corsOrigin = true, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  void app.register(cors, { origin: corsOrigin });

  const bad = (reply: FastifyReply, error: z.ZodError | string) =>
    reply.code(400).send({ error: typeof error === "string" ? error : "Некоректні дані", details: typeof error === "string" ? undefined : error.flatten() });

  /** Власник даних. Поки немає акаунтів, це UUID, який браузер генерує і зберігає локально. */
  const owner = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const parsed = clientIdSchema.safeParse(req.headers["x-client-id"]);
    if (!parsed.success) {
      void reply.code(401).send({ error: "Потрібен заголовок X-Client-Id з UUID клієнта" });
      return null;
    }
    return parsed.data;
  };

  app.get("/api/health", async () => ({ ok: true, storage: store.kind }));

  // Розрахунок стартового тюну на сервері тим самим ядром, що й у браузері.
  app.post("/api/tune", async (req, reply) => {
    const p = buildParamsSchema.safeParse(req.body);
    if (!p.success) return bad(reply, p.error);
    const tune = computeTune(p.data);
    return { tune, cli: buildCli(p.data, tune) };
  });

  app.get("/api/builds", async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return;
    return { builds: await store.listBuilds(o) };
  });

  app.post("/api/builds", async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return;
    const input = buildInputSchema.safeParse(req.body);
    if (!input.success) return bad(reply, input.error);
    return reply.code(201).send(await store.createBuild(o, input.data));
  });

  app.get("/api/builds/:id", async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return;
    const p = idParam.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const b = await store.getBuild(o, p.data.id);
    return b ?? reply.code(404).send({ error: "Борт не знайдено" });
  });

  app.put("/api/builds/:id", async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return;
    const p = idParam.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const input = buildInputSchema.safeParse(req.body);
    if (!input.success) return bad(reply, input.error);
    const b = await store.updateBuild(o, p.data.id, input.data);
    return b ?? reply.code(404).send({ error: "Борт не знайдено" });
  });

  app.delete("/api/builds/:id", async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return;
    const p = idParam.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    return (await store.deleteBuild(o, p.data.id)) ? reply.code(204).send() : reply.code(404).send({ error: "Борт не знайдено" });
  });

  app.get("/api/builds/:id/sessions", async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return;
    const p = idParam.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const s = await store.listSessions(o, p.data.id);
    return s ? { sessions: s } : reply.code(404).send({ error: "Борт не знайдено" });
  });

  app.post("/api/builds/:id/sessions", async (req, reply) => {
    const o = owner(req, reply);
    if (!o) return;
    const p = idParam.safeParse(req.params);
    if (!p.success) return bad(reply, p.error);
    const input = sessionInputSchema.safeParse(req.body);
    if (!input.success) return bad(reply, input.error);
    const s = await store.addSession(o, p.data.id, input.data);
    return s ? reply.code(201).send(s) : reply.code(404).send({ error: "Борт не знайдено" });
  });

  return app;
}
