import { describe, test, expect } from "bun:test";
import { generateToken, hashToken, verifyToken, constantTimeEqual, BASE64URL_TOKEN_PATTERN } from "./tokens";

describe("generateToken", () => {
  test("returns 43-character base64url string", () => {
    const token = generateToken();
    expect(token.length).toBe(43);
    expect(BASE64URL_TOKEN_PATTERN.test(token)).toBe(true);
  });

  test("entropy: 100 tokens are all distinct", () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(generateToken());
    expect(set.size).toBe(100);
  });
});

describe("hashToken", () => {
  test("returns 32-byte digest", () => {
    const hash = hashToken("hello");
    expect(hash.length).toBe(32);
  });

  test("deterministic: same input → same hash", () => {
    const a = hashToken("token-abc");
    const b = hashToken("token-abc");
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  test("distinct: different input → different hash", () => {
    const a = hashToken("token-abc");
    const b = hashToken("token-xyz");
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});

describe("verifyToken", () => {
  test("round-trip: generated token verifies against its hash", () => {
    const plaintext = generateToken();
    const hash = hashToken(plaintext);
    expect(verifyToken(plaintext, hash)).toBe(true);
  });

  test("wrong plaintext rejects", () => {
    const hash = hashToken("real-token");
    expect(verifyToken("fake-token", hash)).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  test("equal buffers return true", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  test("different content returns false", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  test("different length returns false", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
