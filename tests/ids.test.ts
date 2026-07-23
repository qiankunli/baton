import { describe, expect, test } from "bun:test";

import { newId, ulid } from "../src/event/ids.ts";

describe("ids", () => {
  test("ulid is 26 chars of crockford base32", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("time prefix sorts across different milliseconds", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a < b).toBe(true);
  });

  test("newId carries prefix and ids are unique", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("bs")));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id.startsWith("bs_")).toBe(true);
  });

  test("Event and Interaction identities have distinct prefixes", () => {
    expect(newId("ev")).toMatch(/^ev_/);
    expect(newId("ix")).toMatch(/^ix_/);
  });
});
