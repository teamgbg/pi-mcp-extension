import { McpError } from "./errors.js";
import type { ServerConfig } from "./config.js";

/** Resolve HTTP headers without persisting credentials in mcp.json. */
export function resolveRequestHeaders(
  serverName: string,
  config: Pick<ServerConfig, "headers" | "headersFromEnv">,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const headers = { ...(config.headers ?? {}) };

  for (const [header, reference] of Object.entries(config.headersFromEnv ?? {})) {
    const value = environment[reference.env]?.trim();
    if (!value) {
      throw new McpError(
        `Environment variable "${reference.env}" is required for HTTP header "${header}"`,
        serverName,
        "config",
      );
    }
    headers[header] = `${reference.prefix ?? ""}${value}${reference.suffix ?? ""}`;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}
