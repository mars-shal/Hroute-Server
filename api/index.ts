import { connectDatabase } from "../model/database.js";
import { createApp } from "../app.js";

const port = parseInt(process.env.PORT || "8082", 10);

let dbPromise: ReturnType<typeof connectDatabase> | null = null;

function getDatabase() {
  dbPromise ??= connectDatabase();
  return dbPromise;
}

const lazyDb = new Proxy({} as Awaited<ReturnType<typeof connectDatabase>>, {
  get(_target, prop) {
    if (prop === "then" || typeof prop !== "string") {
      return undefined;
    }

    return async (...args: unknown[]) => {
      const db = await getDatabase();
      const value = (db as unknown as Record<string, unknown>)[prop];

      if (typeof value !== "function") {
        throw new Error(`Database method ${prop} is not available`);
      }

      return Reflect.apply(value as (...inner: unknown[]) => unknown, db, args);
    };
  },
}) as Awaited<ReturnType<typeof connectDatabase>>;

const app = createApp(lazyDb);

export default app;
