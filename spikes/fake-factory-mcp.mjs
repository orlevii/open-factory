#!/usr/bin/env node
import { appendFileSync } from "node:fs";
// Minimal Streamable-HTTP MCP server (JSON responses only) standing in for the factory MCP.
// Usage: node fake-factory-mcp.mjs <port> <log-file>
import { createServer } from "node:http";

const [port = "47123", logFile = "mcp-calls.log"] = process.argv.slice(2);
const tools = [
  {
    name: "send_message",
    description: "Send a markdown message to another agent or to @humans in the factory.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, body: { type: "string" } },
      required: ["to", "body"],
    },
  },
  {
    name: "create_task",
    description: "Create a factory task.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, description: { type: "string" } },
      required: ["title"],
    },
  },
];
const handle = (msg) => {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "open-factory", version: "0.0.0-spike" },
      };
    case "tools/list":
      return { tools };
    case "tools/call":
      appendFileSync(
        logFile,
        `${JSON.stringify({ at: new Date().toISOString(), ...msg.params })}\n`,
      );
      return { content: [{ type: "text", text: `ok: ${msg.params.name} delivered` }] };
    case "ping":
      return {};
    default:
      return undefined;
  }
};
createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.on("data", (d) => {
    body += d;
  });
  req.on("end", () => {
    const msg = JSON.parse(body);
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result = handle(msg);
    const out =
      result === undefined
        ? { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }
        : { jsonrpc: "2.0", id: msg.id, result };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
}).listen(Number(port), "0.0.0.0", () => console.log(`fake factory MCP on :${port}`));
