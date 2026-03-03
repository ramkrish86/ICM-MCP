#!/usr/bin/env node

/**
 * IcM MCP Proxy Server
 *
 * Acts as a local stdio MCP server that proxies all tool calls to the remote
 * IcM MCP server at https://icm-mcp-prod.azure-api.net/v1/.
 *
 * Auth: Uses AzureCliCredential (az login) to acquire tokens for the
 * api://icmmcpapi-prod resource, injected as Bearer header on each request.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { AzureCliCredential } from "@azure/identity";
import { ReadableStream } from "node:stream/web";

// ── Config ──────────────────────────────────────────────────────────────
const REMOTE_MCP_URL =
  process.env.ICM_MCP_REMOTE_URL || "https://icm-mcp-prod.azure-api.net/v1/";
const ICM_SCOPE = process.env.ICM_API_SCOPE || "api://icmmcpapi-prod/.default";

// ── Token management ────────────────────────────────────────────────────
const credential = new AzureCliCredential();
let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 60_000) return cachedToken;
  const t = await credential.getToken(ICM_SCOPE);
  if (!t) throw new Error("Failed to acquire token via Azure CLI. Run: az login");
  cachedToken = t.token;
  tokenExpiry = t.expiresOnTimestamp;
  return cachedToken;
}

// ── JSON-RPC helpers ────────────────────────────────────────────────────
let jsonRpcId = 1000;
let sessionId: string | undefined;

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: any;
  id?: number | string;
}

interface JsonRpcResponse {
  jsonrpc: string;
  result?: any;
  error?: any;
  id?: number | string;
}

/** Send a JSON-RPC request to the remote MCP server and parse SSE response */
async function remoteCall(method: string, params?: any): Promise<any> {
  const token = await getToken();
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    method,
    params: params || {},
    id: jsonRpcId++,
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "*/*",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const resp = await fetch(REMOTE_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // Capture session ID from response headers
  const sid = resp.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Remote MCP error ${resp.status}: ${errText}`);
  }

  const text = await resp.text();

  // Parse SSE: look for "data:" lines
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const parsed: JsonRpcResponse = JSON.parse(line.slice(6));
      if (parsed.error) {
        throw new Error(
          `Remote MCP error: ${parsed.error.message || JSON.stringify(parsed.error)}`
        );
      }
      return parsed.result;
    }
  }

  // Fallback: try parsing the whole body as JSON
  try {
    const parsed: JsonRpcResponse = JSON.parse(text);
    if (parsed.error)
      throw new Error(
        `Remote MCP error: ${parsed.error.message || JSON.stringify(parsed.error)}`
      );
    return parsed.result;
  } catch {
    throw new Error(`Unexpected remote response: ${text.substring(0, 500)}`);
  }
}

// ── Initialize remote session & discover tools ──────────────────────────
interface RemoteTool {
  name: string;
  description: string;
  inputSchema: any;
}

let remoteTools: RemoteTool[] = [];

async function initRemote(): Promise<void> {
  log("Initializing remote IcM MCP session...");
  await remoteCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "icm-mcp-proxy", version: "2.0.0" },
  });

  // Send initialized notification (no id = notification)
  const token = await getToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "*/*",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  await fetch(REMOTE_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const toolsResult = await remoteCall("tools/list", {});
  remoteTools = toolsResult.tools || [];
  log(`Discovered ${remoteTools.length} remote tools`);
}

// ── Local stdio JSON-RPC server ─────────────────────────────────────────
function log(msg: string) {
  process.stderr.write(`[icm-mcp-proxy] ${msg}\n`);
}

function sendResponse(id: number | string | undefined, result: any) {
  const resp: JsonRpcResponse = { jsonrpc: "2.0", result, id };
  const json = JSON.stringify(resp);
  process.stdout.write(json + "\n");
}

function sendError(id: number | string | undefined, code: number, message: string) {
  const resp = { jsonrpc: "2.0", error: { code, message }, id };
  process.stdout.write(JSON.stringify(resp) + "\n");
}

async function handleRequest(req: JsonRpcRequest) {
  try {
    switch (req.method) {
      case "initialize":
        // Ensure remote is initialized
        if (remoteTools.length === 0) await initRemote();
        sendResponse(req.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "icm-mcp-proxy", version: "2.0.0" },
        });
        break;

      case "notifications/initialized":
        // Notification, no response
        break;

      case "tools/list":
        if (remoteTools.length === 0) await initRemote();
        sendResponse(req.id, { tools: remoteTools });
        break;

      case "tools/call": {
        const toolName = req.params?.name;
        const toolArgs = req.params?.arguments || {};
        log(`Calling remote tool: ${toolName}`);
        const result = await remoteCall("tools/call", {
          name: toolName,
          arguments: toolArgs,
        });
        sendResponse(req.id, result);
        break;
      }

      case "ping":
        sendResponse(req.id, {});
        break;

      default:
        log(`Unknown method: ${req.method}`);
        sendError(req.id, -32601, `Method not found: ${req.method}`);
    }
  } catch (error: any) {
    log(`Error handling ${req.method}: ${error.message}`);
    if (req.id !== undefined) {
      // For tool calls, return as tool error content (not JSON-RPC error)
      if (req.method === "tools/call") {
        sendResponse(req.id, {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        });
      } else {
        sendError(req.id, -32603, error.message);
      }
    }
  }
}

// ── Main: read stdin line-by-line ───────────────────────────────────────
async function main() {
  log("IcM MCP Proxy Server starting...");
  log(`Remote: ${REMOTE_MCP_URL}`);
  log(`Scope: ${ICM_SCOPE}`);

  // Pre-initialize remote connection
  try {
    await initRemote();
  } catch (err: any) {
    log(`Warning: pre-init failed (will retry on first request): ${err.message}`);
  }

  let buffer = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const req: JsonRpcRequest = JSON.parse(trimmed);
        handleRequest(req);
      } catch (err: any) {
        log(`Failed to parse request: ${err.message}`);
      }
    }
  });

  process.stdin.on("end", () => {
    log("stdin closed, shutting down");
    process.exit(0);
  });
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
