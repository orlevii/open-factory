#!/usr/bin/env node
// Scrub a stream-json trace for committing as a fixture.
// Usage: node scrub.mjs <in.jsonl> <out.jsonl> <scratch-root>
// - replaces the scratch root with /spike and $HOME with /home/user
// - replaces macOS per-user temp dirs, emails, OAuth/API-token-looking strings and thinking signatures
// - drops account-level claude.ai MCP connectors from system/init
// - truncates very long strings (filler used to force compaction)
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const [inPath, outPath, scratch] = process.argv.slice(2);
const home = homedir();
const user = home.split("/").pop();
const MAX = 2000;

const scrubString = (s) => {
  let out = s;
  if (scratch) out = out.split(scratch).join("/spike");
  out = out.split(home).join("/home/user");
  out = out
    .replace(/\/private\/tmp\/claude-\d+/g, "/tmp/claude-uid")
    .replace(/\/tmp\/claude-\d+\//g, "/tmp/claude-uid/");
  out = out.replace(/-Users-[A-Za-z0-9_-]*?-claude-jobs-[a-z0-9]+-tmp-/g, "-spike-");
  out = out.replace(new RegExp(`-Users-${user}-`, "g"), "-home-user-");
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.invalid");
  out = out.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-REDACTED");
  if (user && user.length > 2) out = out.replace(new RegExp(`\\b${user}\\b`, "g"), "user");
  if (out.length > MAX) out = `${out.slice(0, MAX)}… [truncated ${out.length - MAX} chars]`;
  return out;
};
const walk = (v, key) => {
  if (typeof v === "string") return key === "signature" ? "<signature>" : scrubString(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, key));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, k);
    return o;
  }
  return v;
};
const lines = readFileSync(inPath, "utf8").split("\n").filter(Boolean);
const out = lines.map((l) => {
  const ev = JSON.parse(l);
  if (ev.type === "system" && ev.subtype === "init" && Array.isArray(ev.mcp_servers)) {
    ev.mcp_servers = ev.mcp_servers.filter((m) => m.source !== "claudeai");
  }
  return JSON.stringify(walk(ev));
});
writeFileSync(outPath, `${out.join("\n")}\n`);
