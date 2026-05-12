import { describe, test, expect } from "bun:test";
import { createBufferLogger } from "./logger";

describe("Logger", () => {
  test("strips Authorization header (case-insensitive)", () => {
    const { logger, buffer } = createBufferLogger();
    logger.info("request", {
      headers: { Authorization: "Bearer abc123-secret-token" },
    });
    const joined = buffer.join("\n");
    expect(joined).not.toContain("abc123-secret-token");
    expect(joined).toContain("[REDACTED]");
  });

  test("strips authorization in lower-case key", () => {
    const { logger, buffer } = createBufferLogger();
    logger.info("request", {
      headers: { authorization: "Bearer plaintext-bearer-xyz" },
    });
    expect(buffer.join("\n")).not.toContain("plaintext-bearer-xyz");
  });

  test("strips nested Authorization in deep objects", () => {
    const { logger, buffer } = createBufferLogger();
    logger.info("nested", {
      req: { headers: { Authorization: "Bearer deep-secret" } },
    });
    expect(buffer.join("\n")).not.toContain("deep-secret");
  });

  test("redacts QUACK_MODEL_API_KEY value", () => {
    const apiKey = "sk-quack-secret-key-12345";
    const { logger, buffer } = createBufferLogger([apiKey]);
    logger.error("upstream call failed", { error: `failed with key ${apiKey}` });
    expect(buffer.join("\n")).not.toContain(apiKey);
    expect(buffer.join("\n")).toContain("[REDACTED]");
  });

  test("undefined redact values are ignored", () => {
    const { logger, buffer } = createBufferLogger([undefined, ""]);
    logger.info("ok");
    expect(buffer.length).toBe(1);
  });
});
