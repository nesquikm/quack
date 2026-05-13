import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readCompose(): string {
  return readFileSync(join(REPO_ROOT, "compose.yml"), "utf8");
}

describe("compose.yml shape", () => {
  test("port mapping is 127.0.0.1-prefixed (no 0.0.0.0 default)", () => {
    const yaml = readCompose();
    expect(yaml).toContain("127.0.0.1:7474:7474");
    expect(yaml).not.toMatch(/^\s*-\s*"?0\.0\.0\.0:7474:7474/m);
  });

  test("declares quack service", () => {
    const yaml = readCompose();
    expect(yaml).toMatch(/^\s{2}quack:/m);
  });

  test("graphdb service is required (no profile gate); uses neo4j:5-community", () => {
    const yaml = readCompose();
    expect(yaml).toMatch(/^\s{2}graphdb:/m);
    expect(yaml).toContain("neo4j:5-community");
    expect(yaml).not.toContain("profiles: [daemon-graph]");
  });

  test("quack service depends_on graphdb with service_healthy condition", () => {
    const yaml = readCompose();
    expect(yaml).toMatch(/depends_on:\s*\n\s+graphdb:\s*\n\s+condition: service_healthy/);
  });

  test("graphdb healthcheck uses cypher-shell with $$ password escape", () => {
    const yaml = readCompose();
    expect(yaml).toContain("cypher-shell");
    expect(yaml).toContain("$$QUACK_NEO4J_PASSWORD");
  });

  test("quack-graph-data named volume is declared", () => {
    const yaml = readCompose();
    expect(yaml).toMatch(/^\s{2}quack-graph-data:/m);
    expect(yaml).toContain("quack-graph-data:/data");
  });

  test("compose requires QUACK_NEO4J_PASSWORD via :? syntax", () => {
    const yaml = readCompose();
    expect(yaml).toContain("${QUACK_NEO4J_PASSWORD:?");
  });

  test("declares quack-data named volume mounted at /data", () => {
    const yaml = readCompose();
    expect(yaml).toMatch(/^\s{2}quack-data:/m);
    expect(yaml).toContain("quack-data:/data");
  });

  test("healthcheck pings /health via wget --spider", () => {
    const yaml = readCompose();
    expect(yaml).toContain("wget");
    expect(yaml).toContain("/health");
  });

  test("restart policy is unless-stopped", () => {
    const yaml = readCompose();
    expect(yaml).toContain("restart: unless-stopped");
  });
});

describe(".env.example contract", () => {
  test("mentions every env var from src/shared/env.ts", () => {
    const env = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    for (const v of [
      "PORT",
      "QUACK_BOOTSTRAP_TOKEN",
      "QUACK_DATA_DIR",
      "QUACK_MODEL_API_KEY",
      "QUACK_MODEL_BASE_URL",
      "QUACK_NEO4J_URL",
      "QUACK_NEO4J_USER",
      "QUACK_NEO4J_PASSWORD",
    ]) {
      expect(env).toContain(v);
    }
  });

  test("QUACK_MODEL_BASE_URL lists three example endpoints", () => {
    const env = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    expect(env).toContain("https://api.anthropic.com/v1");
    expect(env).toContain("https://api.openai.com/v1");
    expect(env).toContain("http://localhost:11434/v1");
  });
});

describe(".dockerignore excludes", () => {
  test("excludes specs/, *.md, .env, tests/, node_modules/, .git/", () => {
    const di = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8");
    for (const pat of ["specs/", "*.md", ".env", "tests/", "node_modules/", ".git/"]) {
      expect(di).toContain(pat);
    }
  });
});

describe("Dockerfile shape", () => {
  test("uses oven/bun:1.3-alpine base + non-root + EXPOSE 7474 + CMD bun run", () => {
    const df = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
    expect(df).toContain("oven/bun:1.3-alpine");
    expect(df).toContain("AS builder");
    expect(df).toContain("EXPOSE 7474");
    expect(df).toContain('CMD ["bun", "run", "src/index.ts"]');
    expect(df).toContain("WORKDIR /app");
    // Non-root user: the oven/bun:alpine base ships a `bun` user at uid 1000;
    // the Dockerfile reuses it instead of creating a duplicate.
    expect(df).toContain("USER bun");
  });
});

describe("README deployment section", () => {
  test("contains quickstart + idempotent markers", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toContain("<!-- BEGIN: quack-deployment-section -->");
    expect(readme).toContain("<!-- END: quack-deployment-section -->");
    expect(readme).toContain("docker compose up");
    expect(readme).toContain("openssl rand -base64 32");
    expect(readme).toContain("Neo4j");
  });

  test("BEGIN/END deployment markers appear at most once each", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const beginCount = (readme.match(/<!-- BEGIN: quack-deployment-section -->/g) ?? []).length;
    const endCount = (readme.match(/<!-- END: quack-deployment-section -->/g) ?? []).length;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
  });
});
