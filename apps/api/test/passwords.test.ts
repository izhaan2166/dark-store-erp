import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/passwords";

describe("password hashing", () => {
  it("verifies the right password and rejects others", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
  });

  it("salts each hash", async () => {
    expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
  });

  it("rejects a malformed stored value instead of throwing", async () => {
    expect(await verifyPassword("anything", "plaintext")).toBe(false);
  });
});
