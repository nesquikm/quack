import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../auth/sqlite/schema";
import { generateToken, hashToken } from "../../auth/tokens";
import { serverStatus } from "./server_status";

const adminCtx = { user_id: 1, project_id: 1, role: "admin" as const };

function seedDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  db.transaction(() => {
    for (let u = 1; u <= 100; u++) {
      db.run("INSERT INTO users(username, role) VALUES (?, 'member')", [`u${u}`]);
    }
    for (let p = 1; p <= 10; p++) {
      db.run("INSERT INTO projects(slug, display_name) VALUES (?, ?)", [`proj${p}`, `Proj ${p}`]);
    }
    for (let t = 1; t <= 50; t++) {
      const userId = ((t - 1) % 100) + 1;
      const projectId = ((t - 1) % 10) + 1;
      db.run(
        "INSERT INTO project_members(user_id, project_id, role) VALUES (?, ?, 'member')",
        [userId, projectId],
      );
      db.run(
        "INSERT INTO tokens(token_hash, user_id, project_id) VALUES (?, ?, ?)",
        [hashToken(generateToken()), userId, projectId],
      );
    }
  })();
  return db;
}

test("server_status p95 < 50 ms on seeded DB", () => {
  if (process.env.CI) {
    console.warn("CI=set — skipping timing-sensitive server_status benchmark");
    return;
  }
  const db = seedDb();
  for (let i = 0; i < 20; i++) serverStatus({}, adminCtx, db);
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    serverStatus({}, adminCtx, db);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  expect(p95).toBeLessThan(50);
});
