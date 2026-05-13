import { describe, test, expect } from "bun:test";
import { main } from "./quack-hook";

describe("quack-hook CLI argv routing", () => {
  test("no args ⇒ exit 0", async () => {
    const code = await main([]);
    expect(code).toBe(0);
  });

  test("init with no slug ⇒ exit 2 + stderr message", async () => {
    const code = await main(["init"]);
    expect(code).toBe(2);
  });
});
