import { describe, test, expect } from "bun:test";
import { canonicalizeName, dedupeAliases } from "./canonicalize";

describe("canonicalizeName", () => {
  test("lowercase", () => {
    expect(canonicalizeName("Auth-Middleware")).toBe("auth-middleware");
  });

  test("strips disallowed chars", () => {
    expect(canonicalizeName("foo!@#bar")).toBe("foo bar");
  });

  test("collapses whitespace", () => {
    expect(canonicalizeName("  hello   world  ")).toBe("hello world");
  });

  test("preserves underscore/dash/dot", () => {
    expect(canonicalizeName("a_b-c.d")).toBe("a_b-c.d");
  });

  test("empty after stripping", () => {
    expect(canonicalizeName("!!!")).toBe("");
  });
});

describe("dedupeAliases", () => {
  test("drops aliases equal to the canonical name", () => {
    expect(dedupeAliases("AuthMW", ["authmw", "auth-mw"])).toEqual(["auth-mw"]);
  });

  test("removes case-insensitive duplicates among aliases", () => {
    expect(dedupeAliases("foo", ["BAR", "bar", "Bar"])).toEqual(["bar"]);
  });

  test("drops empty after canonicalization", () => {
    expect(dedupeAliases("x", ["!!!", "y"])).toEqual(["y"]);
  });
});
