import { startServer } from "./server/index";
import { createMcpHandler } from "./mcp/server";

// startServer constructs the graphDriver + GraphAdapter and threads the latter
// into the MCP handler factory so memory-plane tools have a live adapter.
const { server } = startServer({
  mcpHandlerFactory: (graph) => createMcpHandler(graph ? { graph } : {}),
});

console.log(`quack listening on http://${server.hostname}:${server.port}`);
