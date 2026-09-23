import { Hono } from "hono";
import { serverStatus } from "./status";

export type AppConfig = {
  root: string;
  version: string;
};

export function createApp(config: AppConfig): Hono {
  const app = new Hono();

  app.get("/status", async (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(await serverStatus(config.root, origin, config.version));
  });

  return app;
}
