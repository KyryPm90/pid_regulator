import { buildApp } from "./app";
import { migrate } from "./migrate";
import { PgStore } from "./pgStore";
import { MemoryStore, type Store } from "./store";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()) : true;

let store: Store;
if (databaseUrl) {
  const applied = await migrate(databaseUrl);
  if (applied.length) console.log(`Міграції: ${applied.join(", ")}`);
  store = PgStore.fromUrl(databaseUrl);
} else {
  console.warn("DATABASE_URL не задано: дані зберігаються в пам'яті й зникнуть після перезапуску.");
  store = new MemoryStore();
}

const app = buildApp({ store, corsOrigin, logger: true });
const shutdown = async () => {
  await app.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await app.listen({ port, host });
