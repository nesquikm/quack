// Hook stdin reader — shared by the three _lib/entry/<name>.ts files.
// Bun.stdin.text() can throw (closed FD, encoding errors); the entry's
// silent-disable invariant requires us to swallow that into an empty
// string so parseHookPayload's `{ data: null }` branch fires cleanly
// and the entry script exits 0 without surfacing the error to the
// Claude Code session.

export async function readHookStdin(): Promise<string> {
  try {
    return await Bun.stdin.text();
  } catch {
    return "";
  }
}
