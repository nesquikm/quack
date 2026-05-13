import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import neo4j, { type Driver } from "neo4j-driver";
import { runMigrations, countIndexes, V1_INDEX_DDL } from "./migrations";
import { dockerAvailable, spawnNeo4j, type SpawnedNeo4j } from "./_neo4j_helper";

let spawned: SpawnedNeo4j | null = null;
let driver: Driver | null = null;
let dockerOk = false;

beforeAll(async () => {
  dockerOk = await dockerAvailable();
  if (!dockerOk) return;
  try {
    spawned = await spawnNeo4j();
  } catch (err) {
    console.warn(`neo4j spawn failed — runMigrations integration test will skip: ${String(err)}`);
    dockerOk = false;
    return;
  }
  driver = neo4j.driver(spawned.url, neo4j.auth.basic(spawned.user, spawned.password), {
    maxConnectionPoolSize: 5,
  });
}, 180_000);

afterAll(async () => {
  if (driver) await driver.close();
  if (spawned) await spawned.stop();
});

describe("runMigrations (integration)", () => {
  test("skips cleanly when docker is unreachable", () => {
    if (!dockerOk) {
      console.warn("docker daemon unreachable — runMigrations integration test skipped");
      expect(true).toBe(true);
      return;
    }
    expect(driver).not.toBeNull();
  });

  test("first run creates 11 v1 indexes; second run is a no-op", async () => {
    if (!dockerOk || !driver) return;
    const before = await countIndexes(driver);
    await runMigrations(driver);
    const afterFirst = await countIndexes(driver);
    expect(afterFirst).toBeGreaterThanOrEqual(before + V1_INDEX_DDL.length);
    await runMigrations(driver);
    const afterSecond = await countIndexes(driver);
    expect(afterSecond).toBe(afterFirst);
  });
});
