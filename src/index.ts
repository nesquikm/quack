import { startServer } from "./server/index";
import { createMcpHandler } from "./mcp/server";

// startServer constructs the graphDriver + GraphAdapter and the BoundedQueue,
// then threads both into the MCP handler factory so memory-plane tools have a
// live adapter and add_memory (FR-41NXTZ) has access to the ingest queue.
const { server } = startServer({
  mcpHandlerFactory: (graph, ingestQueue) =>
    createMcpHandler({
      ...(graph ? { graph } : {}),
      ...(ingestQueue ? { ingestQueue } : {}),
    }),
});

console.log(`quack listening on http://${server.hostname}:${server.port}`);
