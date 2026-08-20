/**
 * Tool bridge for pi-mcp.
 *
 * Converts MCP tools to Pi tools and manages their lifecycle:
 *   - Paginated tools/list (cursor loop per spec)
 *   - JSON Schema → TypeBox conversion (common types + Type.Any() fallback)
 *   - Tool name sanitization (Pi-compatible identifiers)
 *   - Tool annotations → description hints
 *   - AbortSignal → SDK's built-in cancellation (notifications/cancelled)
 *   - Protocol error vs tool execution error distinction
 *   - Activate/deactivate pattern (register once, toggle on server state change)
 *   - Image/audio/resource content → text description passthrough
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { McpError } from "./errors.js";
import { convertJsonSchemaToTypebox } from "./schema-conversion.js";
import type { Settings } from "./config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Subset of Pi's ExtensionAPI used by the bridge. */
export type PiExtensionAPI = Pick<ExtensionAPI, "registerTool" | "getActiveTools" | "setActiveTools">;


// ─── Tool Name Sanitization ───────────────────────────────────────────────────

const MAX_TOOL_NAME_LEN = 64;

/**
 * Build a Pi-compatible tool name.
 * Format: <prefix>_<server>_<tool>
 * Rules: [a-zA-Z0-9_], max 64 chars.
 * If truncation is needed, the last 8 chars are replaced with a hash to avoid collisions.
 */
export function buildToolName(prefix: string, serverName: string, toolName: string): string {
  const raw = `${prefix}_${serverName}_${toolName}`;
  const safe = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  if (safe.length <= MAX_TOOL_NAME_LEN) return safe;
  // Truncate with hash suffix to prevent collisions on long names
  const hash = Math.abs(
    safe.split("").reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0),
  )
    .toString(36)
    .slice(0, 8);
  return safe.slice(0, MAX_TOOL_NAME_LEN - 9) + "_" + hash;
}

// ─── Content Conversion ───────────────────────────────────────────────────────

type PiTextContent = { type: "text"; text: string };

function convertMcpContent(items: unknown[]): PiTextContent[] {
  return items.map((item: any) => {
    if (!item || typeof item !== "object") {
      return { type: "text", text: String(item) };
    }
    switch (item.type) {
      case "text":
        return { type: "text", text: String(item.text ?? "") };
      case "image":
        return {
          type: "text",
          text: `[Image: ${item.mimeType ?? "unknown"}, base64 encoded]`,
        };
      case "audio":
        return {
          type: "text",
          text: `[Audio: ${item.mimeType ?? "unknown"}, base64 encoded]`,
        };
      case "resource": {
        const r = item.resource;
        if (r?.text) return { type: "text", text: r.text };
        if (r?.blob) return { type: "text", text: `[Resource blob: ${r.uri}]` };
        return { type: "text", text: `[Resource: ${r?.uri ?? "unknown"}]` };
      }
      default:
        return { type: "text", text: JSON.stringify(item) };
    }
  });
}

// ─── Tool Listing ─────────────────────────────────────────────────────────────

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
}

/**
 * Fetch all tools from a server using cursor-based pagination.
 * The MCP spec mandates clients follow nextCursor until exhausted.
 * Includes a max-page guard to prevent infinite loops from broken servers.
 */
export async function listAllTools(
  client: Client,
  requestTimeoutMs: number,
): Promise<McpToolDefinition[]> {
  const tools: McpToolDefinition[] = [];
  let cursor: string | undefined;
  const MAX_PAGES = 100;
  let pageCount = 0;

  do {
    if (pageCount >= MAX_PAGES) {
      console.warn(
        `[pi-mcp] tools/list pagination exceeded ${MAX_PAGES} pages, stopping. The server may be malfunctioning.`,
      );
      break;
    }
    const result = await client.request(
      { method: "tools/list", params: cursor ? { cursor } : {} },
      ListToolsResultSchema,
      { timeout: requestTimeoutMs },
    );
    tools.push(...(result.tools as McpToolDefinition[]));
    cursor = result.nextCursor;
    pageCount++;
  } while (cursor);

  return tools;
}

// ─── Tool Bridge ──────────────────────────────────────────────────────────────

/**
 * Manages MCP tools as Pi tools for a set of servers.
 * Tools are registered once and activated/deactivated as servers connect/disconnect.
 */
export class ToolBridge {
  private readonly settings: Settings;
  private readonly pi: PiExtensionAPI;
  /** Tracks which Pi tool names belong to which MCP server. */
  private readonly serverToolNames = new Map<string, Set<string>>();

  constructor(settings: Settings, pi: PiExtensionAPI) {
    this.settings = settings;
    this.pi = pi;
  }

  /**
   * Refresh tools for a server — called on initial connect and on list_changed.
   * Always re-registers tools with the current client reference so that
   * tool execute closures capture the latest client after reconnection.
   * Deactivates tools that are no longer in the server's list.
   * Note: Pi's registerTool() overwrites by name (Map.set), so re-registration is safe.
   */
  async refreshTools(serverName: string, client: Client): Promise<void> {
    const timeoutMs = this.settings.requestTimeoutMs;

    let tools: McpToolDefinition[];
    try {
      tools = await listAllTools(client, timeoutMs);
    } catch (err) {
      throw new McpError(
        `Failed to list tools from ${serverName}: ${err instanceof Error ? err.message : String(err)}`,
        serverName,
        "protocol",
        err,
      );
    }

    const registeredForServer = this.serverToolNames.get(serverName) ?? new Set<string>();

    // Build the set of currently valid Pi tool names for this server
    const currentToolNames = new Set<string>();

    for (const tool of tools) {
      const piName = buildToolName(this.settings.toolPrefix, serverName, tool.name);
      // Detect collision: two different MCP tools mapping to the same Pi name
      // (e.g. "my-tool" and "my_tool" both sanitize to "my_tool")
      if (currentToolNames.has(piName)) {
        console.warn(
          `[pi-mcp] Tool name collision: "${tool.name}" maps to "${piName}" which is already taken. ` +
          `The later tool definition will overwrite the earlier one.`,
        );
      }
      currentToolNames.add(piName);
      // Always re-register — on reconnect the client reference changes and
      // Pi's registerTool overwrites by name, so this is idempotent.
      this._registerTool(piName, serverName, tool, client);
    }

    // Deactivate tools that were removed from the server (no longer in tools/list)
    for (const existingName of registeredForServer) {
      if (!currentToolNames.has(existingName)) {
        this._deactivateServerTool(existingName);
      }
    }

    this.serverToolNames.set(serverName, currentToolNames);

    // Activate all current tools for this server
    this._activateServerTools(serverName);
  }

  /** Deactivate all Pi tools belonging to a server (called on disconnect). */
  deactivateServer(serverName: string): void {
    this._deactivateServerTools(serverName);
  }

  /** Remove all tracking data for a server (called when config changes remove a server). */
  removeServer(serverName: string): void {
    this._deactivateServerTools(serverName);
    this.serverToolNames.delete(serverName);
  }

  /** Re-activate all Pi tools belonging to a server (called on reconnect). */
  activateServer(serverName: string): void {
    this._activateServerTools(serverName);
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private _registerTool(
    piName: string,
    serverName: string,
    tool: McpToolDefinition,
    client: Client,
  ): void {
    // Build description with annotation hints for LLM guidance
    let description = tool.description ?? `MCP tool: ${tool.name}`;
    const ann = tool.annotations;
    if (ann) {
      const hints: string[] = [];
      if (ann.readOnlyHint) hints.push("read-only");
      if (ann.destructiveHint) hints.push("⚠️ destructive");
      if (ann.idempotentHint) hints.push("idempotent");
      if (ann.openWorldHint) hints.push("may have side effects");
      if (hints.length > 0) description += ` [${hints.join(", ")}]`;
    }

    const schema = convertJsonSchemaToTypebox(tool.inputSchema);
    const timeoutMs = this.settings.requestTimeoutMs;

    this.pi.registerTool({
      name: piName,
      label: ann?.title ?? tool.name,
      description,
      promptSnippet: description.slice(0, 120),
      parameters: schema,

      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Cancelled" }], details: {} };
        }

        try {
          const result = await client.request(
            {
              method: "tools/call",
              params: { name: tool.name, arguments: params },
            },
            CallToolResultSchema,
            // Pass AbortSignal to SDK — it will automatically send
            // notifications/cancelled when the signal fires
            { timeout: timeoutMs, ...(signal ? { signal } : {}) },
          );

          const content = convertMcpContent(result.content as unknown[]);

          // Tool execution errors (isError: true) — distinct from protocol errors
          if (result.isError) {
            const errorText = content.map((c) => c.text).join("\n");
            throw new McpError(
              errorText || "Tool reported an error",
              serverName,
              "tool",
            );
          }

          return { content, details: {} };
        } catch (err) {
          if (err instanceof McpError) throw err;
          // Protocol-level errors (JSON-RPC error response, timeout, etc.)
          throw new McpError(
            err instanceof Error ? err.message : String(err),
            serverName,
            "protocol",
            err,
          );
        }
      },
    });
  }

  private _activateServerTools(serverName: string): void {
    const serverTools = this.serverToolNames.get(serverName);
    if (!serverTools || serverTools.size === 0) return;

    const currentActive = new Set(this.pi.getActiveTools());
    for (const name of serverTools) currentActive.add(name);
    this.pi.setActiveTools(Array.from(currentActive));
  }

  private _deactivateServerTools(serverName: string): void {
    const serverTools = this.serverToolNames.get(serverName);
    if (!serverTools || serverTools.size === 0) return;

    const currentActive = this.pi.getActiveTools();
    const remaining = currentActive.filter((n) => !serverTools.has(n));
    this.pi.setActiveTools(remaining);
  }

  /** Deactivate a single tool by Pi name (used when a tool is removed on list_changed). */
  private _deactivateServerTool(piName: string): void {
    const currentActive = this.pi.getActiveTools();
    const remaining = currentActive.filter((n) => n !== piName);
    this.pi.setActiveTools(remaining);
  }
}
