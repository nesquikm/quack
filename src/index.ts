import { startServer } from "./server/index";
import { createMcpHandler } from "./mcp/server";

const { server } = startServer({ mcpHandler: createMcpHandler() });

console.log(`quack listening on http://${server.hostname}:${server.port}`);
