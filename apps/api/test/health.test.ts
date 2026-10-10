import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/bootstrap";
import { TEST_DATABASE_URL } from "./support/env";

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  app = await createApp();
  await app.listen(0);
  baseUrl = await app.getUrl();
});
afterAll(() => app.close());

describe("GET /health", () => {
  it("reports the API and database as up", async () => {
    const res = await fetch(`${baseUrl.replace("[::1]", "127.0.0.1")}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "up" });
  });
});
