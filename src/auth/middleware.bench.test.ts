import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./sqlite/schema";
import { generateToken, hashToken } from "./tokens";
import { authenticate } from "./middleware";

function seedDb(): { db: Database; validToken: string } {
  const db = new Database(":memory:");
  runMigrations(db);

  let validToken = "";
  db.transaction(() => {
    for (let u = 1; u <= 100; u++) {
      db.run("INSERT INTO users(username, role) VALUES (?, 'member')", [`user${u}`]);
    }
    for (let p = 1; p <= 10; p++) {
      db.run("INSERT INTO projects(slug, display_name) VALUES (?, ?)", [`project${p}`, `Project ${p}`]);
    }
    for (let t = 1; t <= 50; t++) {
      const plaintext = generateToken();
      if (t === 1) validToken = plaintext;
      const userId = ((t - 1) % 100) + 1;
      const projectId = ((t - 1) % 10) + 1;
      db.run(
        "INSERT INTO project_members(user_id, project_id, role) VALUES (?, ?, 'member')",
        [userId, projectId],
      );
      db.run(
        "INSERT INTO tokens(token_hash, user_id, project_id) VALUES (?, ?, ?)",
        [hashToken(plaintext), userId, projectId],
      );
    }
  })();

  return { db, validToken };
}

test("auth check p95 < 5 ms over 1000 requests on seeded DB", () => {
  const { db, validToken } = seedDb();
  const req = new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${validToken}` },
  });

  for (let i = 0; i < 50; i++) authenticate(req, db);

  const samples: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const t0 = performance.now();
    const ctx = authenticate(req, db);
    const dt = performance.now() - t0;
    samples.push(dt);
    if (!ctx) throw new Error("auth unexpectedly failed");
  }

  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  expect(p95).toBeLessThan(5);
});
