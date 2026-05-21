#!/usr/bin/env node
// figma-ui-mcp — MCP server entry point
// Bidirectional Figma bridge: write UI from Claude, read design back to code.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import { BridgeServer, CONFIG } from "./bridge-server.js";
import { executeCode } from "./code-executor.js";
import { TOOLS } from "./tool-definitions.js";
import { DOCS } from "./api-docs.js";

// ── Bridge connection strategy ─────────────────────────────────────────────
// Try to start own bridge server. If port is already taken (another instance
// or standalone bridge running), connect to the existing one via HTTP client.

let bridge;
let useHttpProxy = false;

// HTTP proxy: forwards operations to existing bridge via /exec endpoint
const REMOTE_HOST = process.env.FIGMA_BRIDGE_HOST || "127.0.0.1";
const REMOTE_TOKEN = process.env.FIGMA_BRIDGE_TOKEN || null;

function proxyHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (REMOTE_TOKEN) h["X-Bridge-Token"] = REMOTE_TOKEN;
  return h;
}

const httpProxy = {
  isPluginConnected() { return true; }, // delegate health check to actual call
  get queueLength()  { return 0; },
  get lastPollAt()   { return Date.now(); },
  async sendOperation(operation, params = {}) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ operation, params });
      const req = http.request({
        hostname: REMOTE_HOST, port: CONFIG.PORT,
        path: "/exec", method: "POST",
        headers: proxyHeaders({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
      }, res => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.success) resolve(parsed.data);
            else reject(new Error(parsed.error || "Bridge error"));
          } catch { reject(new Error("Invalid bridge response")); }
        });
      });
      req.on("error", e => reject(new Error(`Bridge connection failed: ${e.message}`)));
      req.setTimeout(CONFIG.OP_TIMEOUT_MS, () => { req.destroy(); reject(new Error("Bridge timeout")); });
      req.end(payload);
    });
  },
  // Health check via HTTP
  async checkHealth() {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: REMOTE_HOST, port: CONFIG.PORT,
        path: "/health", method: "GET",
      }, res => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ pluginConnected: false }); }
        });
      });
      req.on("error", () => resolve({ pluginConnected: false }));
      req.setTimeout(2000, () => { req.destroy(); resolve({ pluginConnected: false }); });
      req.end();
    });
  },
};

// ── Bridge connection strategy ─────────────────────────────────────────────
// Remote mode: If FIGMA_BRIDGE_HOST is set, skip local bridge entirely.
// Local mode: Try to start own bridge. If port taken, connect via HTTP proxy.

const log = (msg) => process.stderr.write(`[figma-ui-mcp] ${msg}\n`);

log(`Startup diagnostics: FIGMA_BRIDGE_HOST=${process.env.FIGMA_BRIDGE_HOST || "(not set)"}, PORT=${CONFIG.PORT}`);

if (process.env.FIGMA_BRIDGE_HOST) {
  // Remote mode — bridge runs on the Figma machine
  useHttpProxy = true;
  bridge = httpProxy;
  log(`Remote bridge mode: ${REMOTE_HOST}:${CONFIG.PORT}`);

  // Startup ping — verify remote bridge is reachable
  const t0 = Date.now();
  const health = await httpProxy.checkHealth();
  const latency = Date.now() - t0;
  if (health.pluginConnected) {
    log(`✓ Remote bridge reachable (${latency}ms), plugin connected`);
  } else {
    log(`✗ Remote bridge ping result (${latency}ms): pluginConnected=${health.pluginConnected}`);
    if (latency >= 1900) {
      log(`  → Bridge may be unreachable (timeout). Check FIGMA_BRIDGE_HOST=${REMOTE_HOST} and port ${CONFIG.PORT}`);
    } else {
      log(`  → Bridge reachable but Figma plugin not running. Start plugin in Figma Desktop.`);
    }
  }
} else {
  // Local mode — try starting bridge in same process
  log("No FIGMA_BRIDGE_HOST set, trying local bridge...");
  try {
    bridge = await new BridgeServer().start();
    log("Bridge started on port " + bridge.port);
  } catch (e) {
    useHttpProxy = true;
    bridge = httpProxy;
    log("Bridge failed (" + e.message + "), connecting to existing bridge on port " + CONFIG.PORT);
  }

  // Also check: if bridge started but the "error" event fired (EADDRINUSE), switch to proxy
  if (!useHttpProxy) {
    const health = await httpProxy.checkHealth();
    if (health.pluginConnected && !bridge.isPluginConnected()) {
      useHttpProxy = true;
      bridge = httpProxy;
      log("Existing bridge detected with plugin connected, using HTTP proxy");
    }
  }
}

log(`Mode: ${useHttpProxy ? "http-proxy" : "direct"}, bridge ready`);

// ── Export-to-disk helper ──────────────────────────────────────────────────
// Resolves a directory the agent's filesystem MCP can read: TEAM_WORKSPACE
// (set by fast-agent isolated_spawner) takes precedence over cwd, because cwd
// may drift after chdir. Always returns an absolute path. Sanitizes node ID
// so Windows-style paths don't break on `:`.
function saveExportToDisk({ ext, buf, nodeId, save_dir, save_filename }) {
  const base = save_dir && String(save_dir).trim()
    ? String(save_dir).trim()
    : path.join(process.env.TEAM_WORKSPACE || process.cwd(), "figma-exports");
  fs.mkdirSync(base, { recursive: true });

  let fileName = save_filename && String(save_filename).trim()
    ? String(save_filename).trim()
    : null;
  if (!fileName) {
    const safeId = String(nodeId || "node").replace(/[^A-Za-z0-9_-]+/g, "-");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fileName = `${safeId}-${ts}.${ext}`;
  } else if (!fileName.toLowerCase().endsWith(`.${ext}`)) {
    fileName = `${fileName}.${ext}`;
  }

  const absPath = path.isAbsolute(fileName) ? fileName : path.join(base, fileName);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, buf);
  return { absPath, fileName: path.basename(absPath), byteSize: buf.length };
}

const server = new Server(
  { name: "figma-ui-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args } }) => {

  // ── figma_status ──────────────────────────────────────────────────────────
  if (name === "figma_status") {
    let connected, pluginInfo = null, healthData = {};

    if (useHttpProxy) {
      healthData = await httpProxy.checkHealth();
      connected = healthData.pluginConnected;
      if (connected) {
        try { pluginInfo = await bridge.sendOperation("status", {}); } catch { /* brief disconnect */ }
      }
    } else {
      connected = bridge.isPluginConnected();
      if (connected) {
        try { pluginInfo = await bridge.sendOperation("status", {}); } catch { /* brief disconnect */ }
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          bridgePort:      bridge.port || CONFIG.PORT,
          pluginConnected: connected,
          pluginInfo,
          mode:            useHttpProxy ? "http-proxy" : "direct",
          queueLength:     healthData.queueLength || bridge.queueLength,
          lastPollAgoMs:   healthData.lastPollAgoMs || (bridge.lastPollAt ? Date.now() - bridge.lastPollAt : null),
          hint: connected
            ? "Ready. Use figma_write to draw or figma_read to extract design."
            : "Plugin not connected. In Figma Desktop: Plugins → Development → Figma UI MCP Bridge → Run",
        }, null, 2),
      }],
    };
  }

  // ── figma_write ───────────────────────────────────────────────────────────
  if (name === "figma_write") {
    if (useHttpProxy) {
      const health = await httpProxy.checkHealth();
      if (!health.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();

    const code = args?.code;
    if (!code || typeof code !== "string") return err("'code' is required.");

    const { success, result, error, logs } = await executeCode(code, bridge);
    const parts = [];
    if (logs.length) parts.push(`Logs:\n${logs.join("\n")}`);
    parts.push(success ? `Result: ${JSON.stringify(result, null, 2)}` : `Error: ${error}`);

    return { isError: !success, content: [{ type: "text", text: parts.join("\n\n") }] };
  }

  // ── figma_read ────────────────────────────────────────────────────────────
  if (name === "figma_read") {
    if (useHttpProxy) {
      const health = await httpProxy.checkHealth();
      if (!health.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();

    const { operation, nodeId, nodeName, scale, depth, format, detail, save_dir, save_filename, ...searchParams } = args || {};
    if (!operation) return err("'operation' is required.");

    const params = {};
    if (nodeId)   params.id    = nodeId;
    if (nodeName) params.name  = nodeName;
    if (scale)    params.scale = scale;
    if (depth !== undefined) params.depth = depth;
    if (format) params.format = format;
    if (detail) params.detail = detail;
    // Pass search_nodes params (type, namePattern, fill, fontFamily, etc.)
    if (operation === "search_nodes") Object.assign(params, searchParams);

    try {
      const data = await bridge.sendOperation(operation, params);

      // Return screenshot as MCP image content (displays inline in Claude Code)
      if (operation === "screenshot" && data && data.dataUrl) {
        var b64 = data.dataUrl;
        if (b64.indexOf(",") !== -1) b64 = b64.split(",")[1];
        var meta = Object.assign({}, data);
        delete meta.dataUrl;
        var content = [{ type: "image", data: b64, mimeType: "image/png" }];
        if (Object.keys(meta).length > 0) {
          content.push({ type: "text", text: JSON.stringify(meta, null, 2) });
        }
        return { content: content };
      }

      // export_svg / export_image: NEVER return raw payload inline (a single
      // 777KB SVG exhausts the model context window — incident 2026-05-17
      // Designer "không thấy filesystem MCP"). Persist to disk under the
      // agent's workspace and return only the file path + minimal metadata.
      if (operation === "export_svg" && data && typeof data.svg === "string") {
        const saved = saveExportToDisk({
          ext: "svg",
          buf: Buffer.from(data.svg, "utf-8"),
          nodeId: data.nodeId || nodeId,
          save_dir,
          save_filename,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              file_path: saved.absPath,
              file_name: saved.fileName,
              byte_size: saved.byteSize,
              format: "svg",
              nodeId: data.nodeId,
              width: data.width,
              height: data.height,
              hint: "SVG saved to disk. Read with filesystem MCP, then attach via mcp-atlassian (jira_upload_attachment / confluence_upload_attachment).",
            }, null, 2),
          }],
        };
      }

      if (operation === "export_image" && data && typeof data.base64 === "string") {
        const ext = (data.format || format || "png").toLowerCase();
        const saved = saveExportToDisk({
          ext,
          buf: Buffer.from(data.base64, "base64"),
          nodeId: data.nodeId || nodeId,
          save_dir,
          save_filename,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              file_path: saved.absPath,
              file_name: saved.fileName,
              byte_size: saved.byteSize,
              format: ext,
              nodeId: data.nodeId,
              nodeName: data.nodeName,
              width: data.width,
              height: data.height,
              hint: "Image saved to disk. Read with filesystem MCP, then attach via mcp-atlassian.",
            }, null, 2),
          }],
        };
      }

      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return err(e.message);
    }
  }

  // ── figma_docs ────────────────────────────────────────────────────────────
  if (name === "figma_docs") {
    return { content: [{ type: "text", text: DOCS }] };
  }

  return err(`Unknown tool: ${name}`);
});

function notConnected() {
  return {
    isError: true,
    content: [{
      type: "text",
      text: "Figma plugin not connected. Run the 'Figma UI MCP Bridge' plugin in Figma Desktop first.",
    }],
  };
}

function err(msg) {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

await server.connect(new StdioServerTransport());
