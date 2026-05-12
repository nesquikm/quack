# Testing Specification

## 1. Test Framework
- **Runner:** `bun test` (APIs auto-imported from `"bun:test"`)
- **Mocking:** `mock()` / `spyOn()` from `bun:test` (Vitest-like ergonomics)
- **Coverage:** `bun test --coverage` (lcov); target captured below

## 2. Test Structure

**Layout policy: `src/`-co-located** — tests live next to the source they exercise (toolkit default).

Each `src/<module>.ts` has a sibling `src/<module>.test.ts` next to it. No separate `tests/` mirror.

```
src/
├── ingest/
│   ├── server.ts
│   └── server.test.ts          # co-located unit test
├── extract/
│   ├── prompt.ts
│   └── prompt.test.ts
└── mcp/
    ├── search-memory.ts
    └── search-memory.test.ts
```

The `src/.placeholder.test.ts` file is a load-bearing scaffolding artifact (Bun zero-match workaround). Delete it the moment the first real test lands.

## 3. Conventions

### Naming
- Files: `*.test.ts`
- Names: Describe expected behavior (e.g., `"wraps recalled content in <memory> tags"`)

### What to Test
- **Boundary contracts** — auth (bearer token enforcement), `<memory>` wrapping at MCP boundary, hook handler fire-and-forget behavior. These are non-negotiable per `specs/requirements.md` §2.
- Happy path, error cases, edge cases (empty graph, missing entity, malformed payload)
- Redaction policy: deny-pattern matches drop the payload before the cheap-model call

### What NOT to Test
- The cheap model's actual extraction output (mocked at the API boundary)
- Graph-DB internals (mocked at the adapter boundary)
- Third-party SDK internals
- `src/.placeholder.test.ts` content (replaced as soon as a real test exists)

## 4. Coverage Targets

| Layer   | Target | Minimum |
|---------|--------|---------|
| Boundary modules (auth, redaction, `<memory>` wrap) | >=95% | 90% |
| Extraction + graph adapters | >=80% | 70% |
| Overall | >=80% | 70% |

## 5. Test Data
- **Fixtures:** sample hook payloads (SessionStart, PostToolUse, Stop) under `src/<module>/__fixtures__/` when they grow beyond inline literals.
- **Frozen time:** inject a clock argument and stub it in tests — `Bun.sleep` and `Date.now` are real-time.
- **Deterministic data:** seeded PRNG for any randomized extraction or ID generation.
