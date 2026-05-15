// Server-side redactor — thin re-export of the canonical deep-walk redactor
// that lives in the plugin tree (post-AC-44QGKH.10 the writer owns the wire
// format, including redaction). The default pattern list and walker both
// originate under `plugins/quack/hooks/_lib/shared/`.
//
// The `redaction_patterns` mention below is load-bearing for the bundled-
// hooks-shared-fence contract test (AC-44QGKH.10), which scans this file for
// a plugin-shared import path.

export { createRedactor, type Redactor } from "../../plugins/quack/hooks/_lib/shared/redactor";
// Re-exported so the patterns-import contract (see plugins/quack/hooks/_lib/shared/redaction_patterns.ts)
// remains visible from this module's surface — consumers don't have to know
// the shared module split.
export {
  DEFAULT_REDACTION_PATTERNS,
  REDACTION_REPLACEMENT,
} from "../../plugins/quack/hooks/_lib/shared/redaction_patterns";
