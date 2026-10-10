import type { INestApplication } from "@nestjs/common";
import { createApp } from "../../src/bootstrap";
import { TEST_DATABASE_URL } from "./env";

export interface TestServer {
  app: INestApplication;
  request: (method: string, path: string, opts?: { token?: string; body?: unknown; key?: string }) => Promise<{
    status: number;
    body: any;
  }>;
}

/** Boots the real API on a random port against the test database. */
export async function startServer(): Promise<TestServer> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const app = await createApp();
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  return {
    app,
    async request(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      if (opts.key) headers["idempotency-key"] = opts.key;
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
}
