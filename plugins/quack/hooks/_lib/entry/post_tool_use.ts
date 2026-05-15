// Thin entry — AC-44QGKH.2.
// Reads stdin → parseHookPayload → dispatchHook("post_tool_use") → exit 0.
// Errors swallowed to stderr; exit 0 preserves the silent-disable invariant.
import { parseHookPayload } from "../payload";
import { dispatchHook } from "../dispatch";
import { readHookStdin } from "../stdin";

async function main(): Promise<void> {
  try {
    const { data } = parseHookPayload(await readHookStdin());
    if (data === null) return;
    await dispatchHook({ kind: "post_tool_use", payload: data });
  } catch (err) {
    try {
      process.stderr.write(`[quack-hook plugin] post_tool_use error: ${String(err)}\n`);
    } catch {}
  }
}

await main();
process.exit(0);
