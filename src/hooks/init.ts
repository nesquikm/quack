import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// `quack-hook init <slug>` subcommand:
//  (a) creates ~/.quack/projects/<slug>.env with placeholder lines;
//      refuses to overwrite (exit 1).
//  (b) prints a Claude Code hooks-config YAML snippet referencing the
//      env file. Stdout content lets the user paste straight into Claude
//      Code's hooks config.

export interface InitOptions {
  home?: string;
  // Test seam — defaults to console.log / process.stderr.write.
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface InitResult {
  exitCode: number;
  envFilePath: string;
}

const ENV_FILE_TEMPLATE = (slug: string) =>
  `# Quack hook config for project '${slug}'.
# QUACK_TOKEN — issued by an admin via the 'add_member' or 'register_user'
# MCP tool. Paste the one-time plaintext token below.
QUACK_TOKEN=…

# QUACK_SERVER_URL — where the Quack server is listening. Defaults to
# loopback if unset.
QUACK_SERVER_URL=http://127.0.0.1:7474

# QUACK_PROJECT_SLUG — must match the project this token is bound to;
# the server refuses (403 project_mismatch) if the slugs disagree.
QUACK_PROJECT_SLUG=${slug}
`;

const SNIPPET_TEMPLATE = (slug: string, envFile: string) =>
  `# Paste into Claude Code's hooks config (per-project):
#   ~/.config/claude-code/hooks.yml  OR  ~/.claude/hooks.yml
hooks:
  session_start:
    - command: quack-hook session_start
      env_file: ${envFile}
  stop:
    - command: quack-hook stop
      env_file: ${envFile}
  post_tool_use:
    - command: quack-hook post_tool_use
      env_file: ${envFile}

# Verify the install with:
#   quack-hook session_start <<< '{}'
# then tail the Quack server logs to confirm a 202 from /ingest for slug '${slug}'.
`;

export function initSubcommand(slug: string, opts: InitOptions = {}): InitResult {
  const home = opts.home ?? homedir();
  const outFn = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const errFn = opts.stderr ?? ((s: string) => process.stderr.write(s));

  const dir = join(home, ".quack", "projects");
  mkdirSync(dir, { recursive: true });
  const envFile = join(dir, `${slug}.env`);
  if (existsSync(envFile)) {
    errFn(`[quack-hook] init: ${slug}.env already exists\n`);
    return { exitCode: 1, envFilePath: envFile };
  }
  writeFileSync(envFile, ENV_FILE_TEMPLATE(slug), "utf8");
  outFn(SNIPPET_TEMPLATE(slug, envFile));
  return { exitCode: 0, envFilePath: envFile };
}
