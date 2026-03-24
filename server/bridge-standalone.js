#!/usr/bin/env node
// Standalone bridge server — run this on the machine with Figma Desktop.
// The MCP server runs separately on the Ubuntu server and connects to this bridge.
//
// Usage:
//   node server/bridge-standalone.js
//
// Environment variables:
//   FIGMA_BRIDGE_HOST   — Bind address (default: null = all interfaces)
//                         Set to your Tailscale IP to restrict access.
//   FIGMA_MCP_PORT      — Port number (default: 38451)
//   FIGMA_BRIDGE_TOKEN  — Optional auth token for extra security (Tailscale already encrypts)
//
// Example (bind to Tailscale IP only):
//   FIGMA_BRIDGE_HOST=100.x.x.2 node server/bridge-standalone.js

import { BridgeServer, CONFIG } from "./bridge-server.js";

const bridge = await new BridgeServer().start();

const host = CONFIG.HOST || "0.0.0.0";
const port = bridge.port;
const auth = CONFIG.AUTH_TOKEN ? "enabled" : "disabled";

process.stderr.write(`
╔══════════════════════════════════════════════╗
║   Figma UI MCP — Standalone Bridge Server    ║
╠══════════════════════════════════════════════╣
║  Host:  ${host.padEnd(36)}║
║  Port:  ${String(port).padEnd(36)}║
║  Auth:  ${auth.padEnd(36)}║
╠══════════════════════════════════════════════╣
║  Waiting for Figma plugin to connect...      ║
║  Open Figma Desktop → Plugins → Development  ║
║  → Import plugin from manifest...            ║
║  → Run "Figma UI MCP Bridge"                 ║
╚══════════════════════════════════════════════╝
`);

// Keep process alive
process.on("SIGINT", () => {
  process.stderr.write("\n[bridge] Shutting down...\n");
  bridge.stop();
  process.exit(0);
});
