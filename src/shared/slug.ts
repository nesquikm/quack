// Project / sub-project slug shape — shared across the `src/` tree.
//
// A slug is 1-63 chars: lowercase alphanumerics, underscores, and hyphens,
// with a leading char restricted to alphanumerics (a leading underscore is
// reserved). Used by the admin create_project tool, the extract writer's
// sub-project re-validation, the add_memory / read-tool sub-project schemas,
// and the X-Quack-Sub-Project header parser.
//
// NOTE: the plugin hook tree (plugins/quack/hooks/) keeps its own copy on
// purpose — that tree is shipped independently of `src/` and must not import
// across the boundary.

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

// Human-readable form for Zod `.regex()` error messages and tool descriptions.
export const SLUG_RE_DESCRIPTION = "/^[a-z0-9][a-z0-9_-]{0,62}$/";
