// Process-local cache for the graphdb status block in server_status.
// startServer (and integration tests) call `setGraphdbStatus({...})` so
// the admin tool reads structured data, not a snapshot of a private driver
// reference.

let current: { status: "ok" | "down"; indexes: number } = { status: "down", indexes: 0 };

export function setGraphdbStatus(s: { status: "ok" | "down"; indexes: number }): void {
  current = s;
}

export function getGraphdbStatus(): { status: "ok" | "down"; indexes: number } {
  return current;
}

export function resetGraphdbStatusForTests(): void {
  current = { status: "down", indexes: 0 };
}
