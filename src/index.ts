import { startServer } from "./server/index";
import { createMcpHandler } from "./mcp/server";

// startServer constructs the graphDriver + GraphAdapter, the BoundedQueue, and
// (when QUACK_MODEL_* is configured) the ask-loop model client, then threads
// them into the MCP handler factory so memory-plane tools have a live adapter,
// add_memory (FR-41NXTZ) has the ingest queue, and ask_memory (FR-WB3N9H) has a
// model client.
const { server } = startServer({
  mcpHandlerFactory: (graph, ingestQueue, askClient) =>
    createMcpHandler({
      ...(graph ? { graph } : {}),
      ...(ingestQueue ? { ingestQueue } : {}),
      ...(askClient ? { askClient } : {}),
    }),
});

console.log(`quack listening on http://${server.hostname}:${server.port}`);
