#!/usr/bin/env node
#!/usr/bin/env node

// server/index.js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http3 from "node:http";

// server/bridge-server.js
import http from "node:http";
var CONFIG = {
  PORT: parseInt(process.env.FIGMA_MCP_PORT || "38451", 10),
  PORT_RANGE: 10,
  // try up to 10 ports (38451-38460)
  HOST: process.env.FIGMA_BRIDGE_HOST || null,
  // null = Node.js binds :: (dual-stack). Set to Tailscale IP for remote.
  OP_TIMEOUT_MS: 3e4,
  // per-operation timeout (was 10s, too short for first-run font loading + large exports)
  MAX_BODY_BYTES: 5e6,
  // 5MB to support image payloads
  MAX_QUEUE: 50,
  HEALTH_TTL_MS: 6e4,
  // plugin considered offline after 60s without poll (was 30s, plugin may be busy processing)
  AUTH_TOKEN: process.env.FIGMA_BRIDGE_TOKEN || null
  // shared secret for remote auth (null = no auth)
};
var BridgeServer = class {
  #requestQueue = [];
  #pending = /* @__PURE__ */ new Map();
  // id → { resolve, reject, timer }
  #lastPollAt = 0;
  #server = null;
  get lastPollAt() {
    return this.#lastPollAt;
  }
  get queueLength() {
    return this.#requestQueue.length;
  }
  get pendingCount() {
    return this.#pending.size;
  }
  isPluginConnected() {
    return this.#lastPollAt > 0 && Date.now() - this.#lastPollAt < CONFIG.HEALTH_TTL_MS;
  }
  async sendOperation(operation, params = {}) {
    if (this.#requestQueue.length >= CONFIG.MAX_QUEUE) {
      throw new Error("Queue full \u2014 is the Figma plugin running?");
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.#requestQueue.push({ id, operation, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#requestQueue = this.#requestQueue.filter((r) => r.id !== id);
        reject(new Error(`Operation "${operation}" timed out after ${CONFIG.OP_TIMEOUT_MS}ms`));
      }, CONFIG.OP_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
    });
  }
  // Clear all queued and pending operations (unstick the queue)
  clearQueue() {
    const cleared = this.#requestQueue.length + this.#pending.size;
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Queue cleared manually"));
    }
    this.#pending.clear();
    this.#requestQueue.length = 0;
    return cleared;
  }
  #settle(response) {
    const p = this.#pending.get(response.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(response.id);
    response.success ? p.resolve(response.data) : p.reject(new Error(response.error || "Plugin error"));
  }
  async #readJson(req) {
    return new Promise((resolve, reject) => {
      let raw = "";
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > CONFIG.MAX_BODY_BYTES) {
          req.destroy();
          return reject(new Error("Body too large"));
        }
        raw += chunk;
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  }
  #headers(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  // Auth check — returns false (and sends 401) if token is required but missing/wrong
  #checkAuth(req, res) {
    if (!CONFIG.AUTH_TOKEN) return true;
    const token = req.headers["x-bridge-token"];
    if (token === CONFIG.AUTH_TOKEN) return true;
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized \u2014 X-Bridge-Token header missing or invalid" }));
    return false;
  }
  #route(req, res) {
    this.#headers(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const path = new URL(req.url, `http://localhost:${CONFIG.PORT}`).pathname;
    if (path === "/" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({
        server: "figma-ui-mcp",
        version: "1.8.3",
        port: this.#actualPort,
        pluginConnected: this.isPluginConnected(),
        lastPollAgoMs: this.#lastPollAt ? Date.now() - this.#lastPollAt : null,
        queueLength: this.queueLength,
        endpoints: ["/health", "/poll", "/response", "/exec", "/clear"]
      }));
      return;
    }
    if (path === "/poll" && req.method === "GET") {
      if (!this.#checkAuth(req, res)) return;
      this.#lastPollAt = Date.now();
      const alive = this.#requestQueue.filter((r) => this.#pending.has(r.id));
      this.#requestQueue.length = 0;
      res.writeHead(200);
      res.end(JSON.stringify({ requests: alive, mode: "ready" }));
      return;
    }
    if (path === "/response" && req.method === "POST") {
      if (!this.#checkAuth(req, res)) return;
      this.#readJson(req).then((body) => {
        this.#settle(body);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      }).catch((err2) => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err2.message }));
      });
      return;
    }
    if (path === "/exec" && req.method === "POST") {
      if (!this.#checkAuth(req, res)) return;
      this.#readJson(req).then(async (body) => {
        if (!this.isPluginConnected()) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: "Plugin not connected" }));
          return;
        }
        try {
          const data = await this.sendOperation(body.operation, body.params || {});
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, data }));
        } catch (e) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      }).catch((err2) => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err2.message }));
      });
      return;
    }
    if (path === "/health" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({
        pluginConnected: this.isPluginConnected(),
        queueLength: this.queueLength,
        pendingCount: this.pendingCount,
        lastPollAgoMs: this.#lastPollAt ? Date.now() - this.#lastPollAt : null
      }));
      return;
    }
    if (path === "/clear" && (req.method === "POST" || req.method === "GET")) {
      if (!this.#checkAuth(req, res)) return;
      const cleared = this.clearQueue();
      res.writeHead(200);
      res.end(JSON.stringify({ cleared, queueLength: 0, pendingCount: 0 }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }
  get port() {
    return this.#actualPort;
  }
  #actualPort = CONFIG.PORT;
  start() {
    return new Promise((resolve) => {
      const tryPort = (port, attempt) => {
        if (attempt >= CONFIG.PORT_RANGE) {
          process.stderr.write(`[figma-ui-mcp] All ports ${CONFIG.PORT}-${CONFIG.PORT + CONFIG.PORT_RANGE - 1} in use.
`);
          resolve(this);
          return;
        }
        this.#server = http.createServer((req, res) => this.#route(req, res));
        this.#server.once("error", (err2) => {
          if (err2.code === "EADDRINUSE") {
            process.stderr.write(`[figma-ui-mcp] Port ${port} in use \u2014 trying ${port + 1}...
`);
            tryPort(port + 1, attempt + 1);
          } else {
            process.stderr.write(`[figma-ui-mcp bridge] ${err2.message}
`);
            resolve(this);
          }
        });
        this.#server.once("listening", () => {
          this.#actualPort = port;
          resolve(this);
        });
        this.#server.listen(port, CONFIG.HOST);
      };
      tryPort(CONFIG.PORT, 0);
    });
  }
  stop() {
    if (this.#server) {
      this.#server.close();
      this.#server = null;
    }
    for (var [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Bridge shutting down"));
    }
    this.#pending.clear();
    this.#requestQueue.length = 0;
  }
};

// server/code-executor.js
import { createRequire } from "node:module";
import https from "node:https";
import http2 from "node:http";
var vm = createRequire(import.meta.url)("vm");
var TIMEOUT_MS = 3e4;
var WRITE_OPS = [
  "status",
  "listPages",
  "setPage",
  "createPage",
  "query",
  "create",
  "modify",
  "delete",
  "append",
  "listComponents",
  "instantiate",
  "ensure_library",
  "get_library_tokens",
  // Design token operations (v1.7.0)
  "createVariableCollection",
  "createVariable",
  "applyVariable",
  "modifyVariable",
  "setupDesignTokens",
  "createPaintStyle",
  "createTextStyle",
  "createComponent",
  // Node operations
  "clone",
  "group",
  "ungroup",
  "flatten",
  "resize",
  "set_selection",
  "set_viewport",
  "batch"
];
var READ_OPS = [
  "get_selection",
  "get_design",
  "get_page_nodes",
  "screenshot",
  "export_svg",
  "get_styles",
  "get_local_components",
  "get_viewport",
  "get_variables",
  "get_node_detail",
  "export_image",
  "search_nodes",
  "scan_design"
];
var ALL_OPS = [...WRITE_OPS, ...READ_OPS];
var ICON_LIBRARIES = [
  { name: "fluent", urlFn: (n) => `https://unpkg.com/@fluentui/svg-icons/icons/${n.replace(/-/g, "_")}_24_filled.svg`, fillType: "fill" },
  { name: "bootstrap", urlFn: (n) => `https://unpkg.com/bootstrap-icons@1.11.3/icons/${n}-fill.svg`, fillType: "fill" },
  { name: "phosphor", urlFn: (n) => `https://unpkg.com/@phosphor-icons/core@latest/assets/fill/${n}-fill.svg`, fillType: "fill" },
  { name: "lucide", urlFn: (n) => `https://unpkg.com/lucide-static@0.577.0/icons/${n}.svg`, fillType: "stroke" }
];
function httpFetch(url, maxBytes = 1e7) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http2;
    const req = client.get(url, { timeout: 15e3 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpFetch(res.headers.location, maxBytes).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error("Response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}
function buildFigmaProxy(bridge2) {
  const proxy = { notify: (msg) => Promise.resolve(msg) };
  for (const op of ALL_OPS) {
    proxy[op] = (params = {}) => bridge2.sendOperation(op, params);
  }
  proxy.loadImage = async (url, opts = {}) => {
    const buf = await httpFetch(url, 5e6);
    const b64 = buf.toString("base64");
    return bridge2.sendOperation("create", {
      type: "IMAGE",
      name: opts.name || "image",
      parentId: opts.parentId,
      x: opts.x || 0,
      y: opts.y || 0,
      width: opts.width || 100,
      height: opts.height || 100,
      imageData: b64,
      scaleMode: opts.scaleMode || "FILL",
      cornerRadius: opts.cornerRadius
    });
  };
  proxy.loadIcon = async (iconName, opts = {}) => {
    const size = opts.size || 24;
    const fill = opts.fill || "#1E3150";
    let svg = null;
    let usedLib = null;
    for (const lib of ICON_LIBRARIES) {
      try {
        const url = lib.urlFn(iconName);
        const buf = await httpFetch(url, 1e5);
        const text = buf.toString("utf-8");
        if (text.includes("<svg")) {
          svg = text.replace(/<!--[\s\S]*?-->/g, "").replace(/class="[^"]*"/g, "").replace(/fill="currentColor"/g, `fill="${fill}"`).replace(/stroke="currentColor"/g, `stroke="${fill}"`);
          usedLib = lib.name;
          break;
        }
      } catch {
      }
    }
    if (!svg) throw new Error(`Icon "${iconName}" not found in any library`);
    return bridge2.sendOperation("create", {
      type: "SVG",
      name: opts.name || `icon/${iconName}`,
      parentId: opts.parentId,
      x: opts.x || 0,
      y: opts.y || 0,
      width: size,
      height: size,
      svg,
      fill
    });
  };
  proxy.loadIconIn = async (iconName, opts = {}) => {
    const cSize = opts.containerSize || 40;
    const fill = opts.fill || "#6C5CE7";
    const bgOpacity = opts.bgOpacity || 0.1;
    const iSize = Math.floor(cSize / 2);
    const container = await bridge2.sendOperation("create", {
      type: "FRAME",
      name: opts.name || `icon-${iconName}-wrap`,
      parentId: opts.parentId,
      x: opts.x || 0,
      y: opts.y || 0,
      width: cSize,
      height: cSize,
      fill,
      fillOpacity: bgOpacity,
      cornerRadius: Math.floor(cSize / 2),
      layoutMode: "HORIZONTAL",
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "CENTER"
    });
    await proxy.loadIcon(iconName, {
      parentId: container.id,
      size: iSize,
      fill
    });
    return container;
  };
  return proxy;
}
function buildConsole(logs) {
  const fmt = (args) => args.map((x) => typeof x === "object" ? JSON.stringify(x, null, 2) : String(x)).join(" ");
  return {
    log: (...a) => logs.push(fmt(a)),
    error: (...a) => logs.push("[error] " + fmt(a)),
    warn: (...a) => logs.push("[warn] " + fmt(a)),
    info: (...a) => logs.push("[info] " + fmt(a))
  };
}
async function executeCode(code, bridge2) {
  const logs = [];
  const ctx = vm.createContext({
    figma: buildFigmaProxy(bridge2),
    console: buildConsole(logs),
    // Safe builtins
    Promise,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    // Blocked
    require: void 0,
    process: void 0,
    fetch: void 0,
    setTimeout: void 0,
    setInterval: void 0,
    queueMicrotask: void 0,
    XMLHttpRequest: void 0
  });
  try {
    const result = await vm.runInContext(`(async()=>{ ${code} })()`, ctx, {
      timeout: TIMEOUT_MS,
      filename: "figma-code.js"
    });
    return { success: true, result: result ?? null, logs };
  } catch (err2) {
    return { success: false, error: err2.message, logs };
  }
}

// server/tool-definitions.js
var TOOLS = [
  {
    name: "figma_status",
    description: "Check whether the Figma plugin bridge is connected. Always call this first to confirm the plugin is running before any other tool.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "figma_write",
    description: "Execute JavaScript code to CREATE or MODIFY designs in Figma. Use the `figma` proxy object \u2014 all methods return Promises, use async/await. Operations: create, modify, delete, clone, group, ungroup, flatten, resize, set_selection, set_viewport, batch (multiple ops in one call). Design Tokens: createVariableCollection, createVariable, applyVariable, createPaintStyle, createTextStyle, createComponent. Call figma_docs first to see all available operations and examples. The code runs in a sandboxed VM: no access to require, process, fs, fetch, or network.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript using figma.create(), figma.modify(), figma.setPage(), etc."
        }
      },
      required: ["code"]
    }
  },
  {
    name: "figma_read",
    description: "READ design data from Figma \u2014 extract node trees, colors, typography, spacing, and screenshots. Use to understand an existing design before generating code, or to inspect what's on the canvas.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "get_selection",
            "get_design",
            "get_page_nodes",
            "screenshot",
            "export_svg",
            "get_styles",
            "get_local_components",
            "get_viewport",
            "get_variables",
            "get_node_detail",
            "export_image",
            "search_nodes",
            "scan_design"
          ],
          description: "get_selection: data for currently selected node(s). get_design: full node tree for a frame/page (use depth param to control, default 10, or 'full'). get_page_nodes: top-level frames on the current page. screenshot: PNG of a node as base64. export_svg: SVG markup of a node. get_styles: all local paint, text, effect, grid styles. get_local_components: enhanced component listing with properties. get_viewport: current viewport position and zoom. get_variables: read Figma local variables (Design Tokens). get_node_detail: CSS-like properties for a single node (fill, stroke, padding, shadow, font \u2014 no tree traversal). export_image: export node as base64 PNG/JPG for saving to disk (use scale param for resolution). search_nodes: find nodes by properties \u2014 type, namePattern (wildcard), fill (hex), fontFamily, fontSize, hasImage, hasIcon. scan_design: progressive scan for large/complex designs \u2014 returns structured summary with all text, colors, fonts, images, icons, sections. No token overflow."
        },
        nodeId: { type: "string", description: "Target node ID (optional \u2014 omit to use current selection)." },
        nodeName: { type: "string", description: "Target node name (alternative to nodeId)." },
        scale: { type: "number", description: "Export scale for screenshot (default 1)." },
        depth: { type: "string", description: "Tree depth for get_design/get_selection. Number (default 10) or 'full' for unlimited. Higher = more detail but larger output." },
        format: { type: "string", description: "Image format for export_image: 'png' (default) or 'jpg'." },
        detail: { type: "string", description: "Detail level for get_design/get_selection: 'minimal' (~5% tokens), 'compact' (~30%), 'full' (default, 100%). Use minimal for large files." }
      },
      required: ["operation"]
    }
  },
  {
    name: "figma_docs",
    description: "Get the full API reference for figma_write \u2014 all operations, parameters, and code examples. Always call this before writing non-trivial draw code.",
    inputSchema: { type: "object", properties: {}, required: [] }
  }
];

// server/api-docs.js
var DOCS = `
# figma-ui-mcp \u2014 Complete API Reference & Design Rules

---

## \u2691 MANDATORY DESIGN SYSTEM RULES (read before every design task)

### Rule 0 \u2014 Token-First Workflow (HIGHEST PRIORITY \u2014 NON-NEGOTIABLE)
**NEVER hardcode hex colors in \`fill\` or \`stroke\`.** Always use Figma Variables (Design Tokens).

**Before ANY design work, run this bootstrap sequence:**
\`\`\`js
// 1. Bootstrap all tokens in one call (idempotent \u2014 safe to call every time)
var tokens = await figma.setupDesignTokens({
  collectionName: "Design Tokens",
  colors: {
    "accent":         "#3B82F6",
    "accent-dim":     "#1D4ED8",
    "bg-base":        "#08090E",
    "bg-surface":     "#0F1117",
    "bg-card":        "#111318",
    "bg-elevated":    "#0D0F14",
    "border":         "#1E2030",
    "text-primary":   "#F0F2F5",
    "text-secondary": "#8B8FA3",
    "text-muted":     "#555872",
    "positive":       "#00DC82",
    "negative":       "#FF4757",
    "warning":        "#FFB547",
  },
  numbers: {
    "radius-sm": 8, "radius-md": 12, "radius-lg": 16,
    "spacing-xs": 4, "spacing-sm": 8, "spacing-md": 16, "spacing-lg": 24,
  }
});
// Returns { collectionId, created: [...], updated: [...], totalVariables }

// 2. Read variable IDs for use in applyVariable
var vars = await figma.get_variables();
// Build a lookup map: name \u2192 variableId
var varMap = {};
for (var ci = 0; ci < vars.collections.length; ci++) {
  for (var vi = 0; vi < vars.collections[ci].variables.length; vi++) {
    var v = vars.collections[ci].variables[vi];
    varMap[v.name] = v.id;
  }
}
// Now varMap["accent"] = "VariableID:xx:yy"
\`\`\`

**Then for EVERY node you create:**
\`\`\`js
// WRONG \u2014 hardcoded hex
await figma.create({ type: "FRAME", fill: "#3B82F6", ... });

// CORRECT \u2014 create with hex, then bind variable
var node = await figma.create({ type: "FRAME", fill: "#3B82F6", ... });
await figma.applyVariable({ nodeId: node.id, field: "fill", variableId: varMap["accent"] });
\`\`\`

**To change a color globally (all bound nodes update instantly):**
\`\`\`js
await figma.modifyVariable({ variableName: "accent", value: "#0EA5E9" });
// \u2192 ALL nodes bound to "accent" update to #0EA5E9 automatically!
\`\`\`

### Rule 0b \u2014 Component-First Workflow (MANDATORY for repeated elements)
**NEVER draw the same element twice.** Create a Component, then instantiate it.

**Workflow:**
\`\`\`js
// 1. Check if component exists
var components = await figma.listComponents();
var btnExists = components.some(function(c) { return c.name === "btn/primary"; });

// 2. If not \u2192 create frame, convert to component
if (!btnExists) {
  var btnFrame = await figma.create({
    type: "FRAME", name: "btn/primary",
    width: 120, height: 40, fill: "#3B82F6", cornerRadius: 10,
    layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER"
  });
  await figma.create({ type: "TEXT", parentId: btnFrame.id, content: "Button", fontSize: 14, fontWeight: "SemiBold", fill: "#FFFFFF" });
  await figma.applyVariable({ nodeId: btnFrame.id, field: "fill", variableId: varMap["accent"] });
  var comp = await figma.createComponent({ nodeId: btnFrame.id, name: "btn/primary" });
  // comp.id is now a reusable component
}

// 3. Use instances everywhere (changes to component \u2192 all instances update)
await figma.instantiate({ componentName: "btn/primary", parentId: screen.id, x: 100, y: 200 });
await figma.instantiate({ componentName: "btn/primary", parentId: screen.id, x: 300, y: 200 });
\`\`\`

**Must create as Components:** buttons, badges (LONG/SHORT/status), nav items, stat cards, table headers, pagination.
**Must use Variables:** ALL colors, ALL spacing, ALL border radius.

### Rule 1 \u2014 Design Library Frame
Before drawing any new design, ALWAYS:
1. Run \`setupDesignTokens\` (Rule 0) to bootstrap variables
2. Call \`figma.get_page_nodes()\` to check if "\u{1F3A8} Design Library" frame exists
3. If not \u2192 \`figma.ensure_library()\` to create visual reference
4. The Design Library frame is a **visual reference only** \u2014 actual tokens live in Figma Variables
5. When adding new colors \u2192 add to \`setupDesignTokens\` colors param AND to library frame

### Rule 2 \u2014 Library Frame Structure
The "\u{1F3A8} Design Library" frame lives at x: -2000, y: 0 (off-canvas, never on-screen).
It contains labeled sections:
- **Colors** \u2014 rectangles named "color/{name}" with the hex fill (visual reference)
- **Text Styles** \u2014 text nodes named "text/{role}" (e.g. text/heading-xl, text/body-sm)
- **Components** \u2014 component instances showing all reusable elements
- **Variables** \u2014 the REAL tokens live in Figma Variables panel, NOT in this frame

### Rule 3 \u2014 Read selection when user refers to a frame
When user says "this frame", "the selected one", "b\u1EA1n th\u1EA5y kh\xF4ng", "c\xE1i \u0111ang ch\u1ECDn":
\u2192 Immediately call figma_read with operation "get_selection" to read what the user has selected in Figma.
Never assume which frame the user means \u2014 always read it first.

### Rule 4 \u2014 Naming convention
- Frame names: PascalCase (e.g. "Trading Dashboard", "Signal Card")
- Component names: kebab-case with type prefix (e.g. "btn/primary-lg", "badge/success")
- Color names: descriptive (e.g. "color/bg-surface", "color/accent-purple", "color/positive-green")

### Rule 5 \u2014 Visual QA after every design (self-check loop)
After finishing any design section, perform a self-QA pass:
1. Call \`figma_read\` with \`operation: "screenshot"\` on the root frame (scale: 0.4)
2. The base64 PNG is returned \u2014 Claude views it directly as an image
3. Analyze visually: check for overlapping elements, misaligned nodes, text overflow, off-canvas items
4. Cross-check coordinates via \`get_page_nodes\` \u2014 compare x/y/width/height of each node
5. If overlap found \u2192 call \`figma.modify({ id, x, y, width, height })\` to fix
6. Re-screenshot to confirm \u2014 repeat until clean
This loop runs automatically after every major draw step.

### Rule 6 \u2014 Layer Order (CRITICAL)
In Figma, the LAST child drawn renders ON TOP. When building screens:
1. **Draw background/hero image FIRST** (bottom layer)
2. Then overlays, content, buttons on top
3. **NEVER** add a full-size image after other elements \u2014 it covers everything

\`\`\`
CORRECT:  image \u2192 overlay \u2192 back btn \u2192 title \u2192 content
WRONG:    back btn \u2192 title \u2192 content \u2192 image (image covers all!)
\`\`\`

### Rule 7 \u2014 TEXT vs BACKGROUND COLOR (CRITICAL)
**NEVER** create a container where fill color equals text color inside it. Text will be invisible.

**Pattern to AVOID:**
\`\`\`
frame(fill: "#6C5CE7") \u2192 text(fill: "#6C5CE7")  \u2190 INVISIBLE!
\`\`\`

**Correct patterns for tinted/accent containers:**

| Style | Container | Text | When to use |
|-------|-----------|------|-------------|
| Filled active | \`fill: "#6C5CE7"\` | \`fill: "#FFFFFF"\` | Active tabs, primary buttons |
| Outlined accent | \`fill: "#FFFFFF", stroke: "#6C5CE7"\` | \`fill: "#6C5CE7"\` | Filter pills, level badges |
| Ghost/subtle | \`fill: "#F5F6FA"\` | \`fill: "#1E3150"\` | Inactive tabs, secondary |
| Tinted (safe) | \`fill: "#FFFFFF", stroke: color\` | \`fill: color\` | Tags, badges with border |

**Rule: If container and text need the same accent color, use white bg + colored border + colored text.**

### Rule 8 \u2014 Container Height Must Fit Content
When creating auto-layout containers (cards, banners, panels):
- Set height **generously** to fit all children with padding + spacing
- If unsure, add 20-30px buffer \u2014 too tall is better than content being clipped
- After creating, verify with \`get_design\` or \`screenshot\` that no content overflows
- Formula: height = paddingTop + paddingBottom + (childCount * avgChildHeight) + ((childCount-1) * itemSpacing)

### Rule 9 \u2014 NO EMOJI AS ICONS (CRITICAL \u2014 NON-NEGOTIABLE)
**NEVER** use emoji characters (\u{1F514} \u{1F4CB} \u{1F464} \u{1F310} \u{1F512} etc.) as icons in designs. Emoji look unprofessional and inconsistent across platforms.

**ALWAYS use SVG icons** from the icon library via \`figma.loadIcon()\` or \`figma.loadIconIn()\`:
\`\`\`js
// WRONG \u2014 unprofessional emoji
await figma.create({ type: "TEXT", content: "\u{1F514}", fontSize: 16 });

// CORRECT \u2014 proper SVG icon from library
await figma.loadIcon("bell", { parentId: iconBg.id, size: 18, fill: "#0e7c3a" });

// CORRECT \u2014 icon inside colored circle
await figma.loadIconIn("bell", { parentId: row.id, containerSize: 36, fill: "#0e7c3a", bgOpacity: 0.1 });
\`\`\`

**This rule applies to ALL icons:** navigation, menu items, buttons, badges, status indicators.
Use \`figma.loadIcon()\` for bare icons, \`figma.loadIconIn()\` for icons inside circle backgrounds.

### Rule 10 \u2014 Layout Quality Standards (MANDATORY for professional design)
Every design must meet these quality standards:

**Padding & Spacing:**
- Cards: minimum 16px padding on all sides, 20px recommended
- List items: minimum 12px vertical padding, 16-20px horizontal
- Buttons: minimum 12px vertical, 24px horizontal padding
- Between sections: minimum 16px gap, 20-24px recommended
- Never place elements flush against container edges

**Text Centering & Alignment:**
- Button text: ALWAYS centered both horizontally and vertically (use auto-layout CENTER/CENTER)
- Card titles: left-aligned with consistent left padding
- Badges/pills: text ALWAYS centered inside (use auto-layout)
- Numbers/stats: center-aligned within their containers

**Text Wrapping & Overflow:**
- Long text labels: set \`textAutoResize: "HEIGHT"\` with fixed width to allow wrapping
- Single-line labels: use \`textAutoResize: "WIDTH_AND_HEIGHT"\` for auto-sizing
- Truncation: if text may overflow, ensure container has \`clipsContent: true\`
- Multi-line text: use appropriate \`lineHeight\` (1.4-1.6x fontSize)

**Borders & Strokes:**
- Card borders: use subtle \`stroke\` color (e.g. "#E0E0E0" or "#EEEEEE"), \`strokeWeight: 1\`
- Dividers between list items: use LINE type, full width, \`strokeWeight: 1\`, color "#EEEEEE"
- Active/selected states: use colored border (e.g. \`stroke: "#0e7c3a", strokeWeight: 2\`)
- Input fields: \`stroke: "#B5B5B5", strokeWeight: 1\`, focused: \`stroke: "#0e7c3a", strokeWeight: 2\`

**Shadows & Elevation:**
- Cards: use subtle shadow via slightly darker background or offset technique
- For elevated cards, create a shadow rectangle behind the card:
\`\`\`js
// Shadow layer (draw BEFORE the card \u2014 layer order rule)
await figma.create({
  type: "RECTANGLE", name: "Card Shadow",
  parentId: root.id, x: cardX + 2, y: cardY + 4,
  width: cardWidth, height: cardHeight,
  fill: "#000000", cornerRadius: cardRadius,
  opacity: 0.08,
});
// Then draw the actual card on top
await figma.create({
  type: "FRAME", name: "Card",
  parentId: root.id, x: cardX, y: cardY,
  width: cardWidth, height: cardHeight,
  fill: "#FFFFFF", cornerRadius: cardRadius,
});
\`\`\`

**Corner Radius Consistency:**
- Cards: 16-20px (use one value consistently across all cards)
- Buttons: 12-16px
- Input fields: 12px
- Badges/pills: height/2 (fully rounded)
- Avatar circles: width/2 (perfect circle)
- Bottom nav: 0 (flush with screen edge)

### Rule 11 \u2014 Centered Profile Layouts (CRITICAL for detail/profile screens)
When creating a profile/detail screen with avatar + name + subtitle stacked vertically:

**Text MUST be center-aligned relative to the full frame width:**
\`\`\`js
// CORRECT: use textAlign "CENTER" with full-width text
await figma.create({
  type: "TEXT", parentId: rootId,
  x: 0, y: 202, width: frameWidth,  // FULL width of parent
  content: "Ph\u1EA1m V\u0103n An",
  fontSize: 22, fontWeight: "Bold", fill: TEXT1,
  textAlign: "CENTER",              // CENTER aligned
});
\`\`\`
**WRONG:** Using \`x: 120\` with auto-width text \u2014 this won't center properly.

**For centered badge/status below name:** Calculate \`x = (frameWidth - badgeWidth) / 2\`

### Rule 12 \u2014 Key-Value Info Rows Must Have Spacing (CRITICAL)
When displaying label:value pairs (e.g. "H\u1ECD v\xE0 t\xEAn: Ph\u1EA1m V\u0103n An"):

**NEVER place label and value as a single text string.** Always use separate text nodes in a horizontal auto-layout:
\`\`\`js
// CORRECT: separate text nodes with auto-layout spacing
var row = await figma.create({
  type: "FRAME", parentId: parentId,
  width: 305, height: 36,  // height 36px minimum for readable rows
  fill: CARD, fillOpacity: 0,
  layoutMode: "HORIZONTAL",
  primaryAxisAlignItems: "MIN",
  counterAxisAlignItems: "CENTER",
  itemSpacing: 8,           // MINIMUM 8px gap between label and value
  layoutAlign: "STRETCH",
});
// Label (fixed width for alignment)
await figma.create({
  type: "TEXT", parentId: row.id,
  content: "H\u1ECD v\xE0 t\xEAn:", fontSize: 13,
  fontWeight: "Regular", fill: TEXT3,
  width: 110,              // Fixed width so values align vertically
});
// Value (flexible)
await figma.create({
  type: "TEXT", parentId: row.id,
  content: "Ph\u1EA1m V\u0103n An", fontSize: 13,
  fontWeight: "Medium", fill: TEXT1,
  layoutGrow: 1,
});
\`\`\`
**Row height rules:**
- Simple key-value: minimum 36px height (not 32px)
- With icon prefix: minimum 40px height
- Between rows: use divider (1px) OR minimum 4px itemSpacing in parent

### Rule 13 \u2014 Container Height Must Accommodate All Children (CRITICAL)
**Always calculate container height BEFORE creating:**
\`\`\`
containerHeight = paddingTop + paddingBottom
                + (numberOfChildren \xD7 childHeight)
                + ((numberOfChildren - 1) \xD7 itemSpacing)
                + dividerCount \xD7 1  // if using dividers
\`\`\`
**Use \`primaryAxisSizingMode: "AUTO"\` when possible** to let the container grow:
\`\`\`js
var card = await figma.create({
  type: "FRAME",
  width: 353,
  height: 500,  // generous initial height
  primaryAxisSizingMode: "AUTO",  // auto-grow to fit content
  layoutMode: "VERTICAL",
  paddingTop: 24, paddingBottom: 24,
  itemSpacing: 12,
});
\`\`\`
**After drawing, ALWAYS verify** with screenshot that no content is clipped or overflowing.
If content is clipped \u2192 increase height or use \`primaryAxisSizingMode: "AUTO"\`.

### Rule 14 \u2014 Score/Match Result Cards Must Have Inner Padding (MANDATORY)
When displaying match results (Team A vs Team B with score):
\`\`\`js
// CORRECT: teams row with proper padding
var scoreRow = await figma.create({
  type: "FRAME",
  width: 317, height: 32,
  layoutMode: "HORIZONTAL",
  primaryAxisAlignItems: "SPACE_BETWEEN",
  counterAxisAlignItems: "CENTER",
  paddingLeft: 8,   // inner padding so text doesn't touch edges
  paddingRight: 8,
  layoutAlign: "STRETCH",
});
\`\`\`
**WRONG:** No paddingLeft/Right on score rows \u2014 team names touch the card edges.

### Rule 15 \u2014 Button Variants System (MANDATORY)
Every button must use one of these variant patterns. Never create random button styles.

| Variant | Fill | Text | Border | When to use |
|---------|------|------|--------|-------------|
| **Solid** | brand color | white | none | Primary CTA |
| **Flat** | brand color 10% opacity | brand color | none | Secondary actions |
| **Bordered** | transparent | brand color | 1px brand | Tertiary, filters |
| **Ghost** | transparent | brand color | none | Minimal, inline |
| **Light** | #F5F6FA | #1E3150 | none | Neutral, cancel |
| **Shadow** | brand color | white | none + shadow | Elevated CTA |

**Size scale (apply to ALL interactive elements):**
| Size | Height | paddingX | fontSize | cornerRadius |
|------|--------|----------|----------|--------------|
| sm | 32px | 12px | 12px | 8px |
| md | 40px | 16px | 14px | 12px |
| lg | 48px | 24px | 16px | 14px |

### Rule 16 \u2014 Consistent Spacing Scale (MANDATORY)
Use ONLY these spacing values. Never use random pixel values.
\`\`\`
4px   \u2014 tight: icon-to-text gap, badge padding
8px   \u2014 compact: between related items, small card padding
12px  \u2014 default: standard item spacing, input padding
16px  \u2014 comfortable: section padding, card content padding
20px  \u2014 relaxed: between card sections
24px  \u2014 spacious: page padding, major section gaps
32px  \u2014 large: between major page sections
48px  \u2014 hero: top/bottom of hero sections, major breaks
\`\`\`

### Rule 17 \u2014 Border Radius Consistency (MANDATORY)
Match radius to element size. NEVER use random radius values.
| Element type | cornerRadius | Example |
|-------------|-------------|---------|
| Small chips/tags | 4-6px | Status badge, tag pill |
| Input fields | 8px | Text input, select |
| Buttons | 8-12px | All button variants |
| Cards | 12-16px | Content cards, modals |
| Large panels | 16-24px | Side panels, bottom sheets |
| Full round | 9999px | Avatar, circular icon bg, pills |

**Nested radius rule:** Inner element radius = outer radius - padding.
Example: Card radius 16px, padding 8px \u2192 inner element radius = 8px.

### Rule 18 \u2014 Shadow/Elevation System (MANDATORY)
Use consistent shadows for depth hierarchy. Never mix random shadow values.
| Level | Effect | Usage |
|-------|--------|-------|
| **flat** | No shadow | Inline elements, flat cards |
| **sm** | 0 1px 2px rgba(0,0,0,0.05) | Subtle lift: inputs, chips |
| **md** | 0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.06) | Cards, dropdowns |
| **lg** | 0 10px 15px rgba(0,0,0,0.1), 0 4px 6px rgba(0,0,0,0.05) | Modals, popovers, floating |

For dark themes: use border (1px #2A2B45) instead of shadows \u2014 shadows are invisible on dark bg.

### Rule 19 \u2014 Semantic Color Usage (MANDATORY)
Colors must carry meaning. Never pick colors randomly.
| Role | Light theme | Dark theme | When to use |
|------|------------|------------|-------------|
| **Primary** | #006FEE | #338EF7 | Main CTA, active states, links |
| **Success** | #17C964 | #45D483 | Confirmations, positive values, online |
| **Warning** | #F5A524 | #F7B750 | Caution, pending, attention |
| **Danger** | #F31260 | #F54180 | Errors, destructive actions, offline |
| **Default** | #71717A | #A1A1AA | Neutral, secondary text, disabled |

**Foreground contrast rule:** Every semantic color must pair with white text (#FFFFFF) for WCAG AA (4.5:1 minimum contrast ratio).

### Rule 20 \u2014 Component State Indicators (MANDATORY)
All interactive elements must visually indicate their state:
| State | Visual change | How to implement |
|-------|--------------|-----------------|
| **Default** | Base appearance | Normal fills/colors |
| **Hover** | Slight darken or lighten (opacity 0.8-0.9) | Fill opacity change |
| **Pressed** | Scale down slightly + darken | Smaller size in Figma |
| **Focused** | 2px ring around element | Stroke with focus color |
| **Disabled** | 50% opacity, no interaction | opacity: 0.5 |
| **Loading** | Spinner replaces content/icon | Spinner SVG inside |

When designing in Figma: create one frame per state for interactive components.

---

## Design Library Tokens (defaults)

### Colors
| Token               | Hex       | Usage                    |
|---------------------|-----------|--------------------------|
| bg-base             | #0F1117   | Page/canvas background   |
| bg-surface          | #191C24   | Cards, side panels       |
| bg-elevated         | #1E2233   | Dividers, hover states   |
| accent-purple       | #6366F1   | Primary CTA, active nav  |
| positive-green      | #00C896   | Profit, success, LONG    |
| negative-red        | #FF4560   | Loss, error, SHORT       |
| text-primary        | #E8ECF4   | Headings, values         |
| text-secondary      | #6B7280   | Labels, captions         |
| border              | #1E2233   | Separators               |

### Text Styles
| Token        | Size | Weight   |
|--------------|------|----------|
| heading-2xl  | 32px | Bold     |
| heading-xl   | 24px | Bold     |
| heading-lg   | 20px | Bold     |
| heading-md   | 16px | SemiBold |
| body-md      | 14px | Regular  |
| body-sm      | 12px | Regular  |
| caption      | 11px | Regular  |
| label        | 11px | Medium   |

---

## ensure_library \u2014 Bootstrap the Design Library frame

\`\`\`js
// Creates "\u{1F3A8} Design Library" frame if it doesn't exist.
// Returns { id, existed } \u2014 use .id to add components to it.
const lib = await figma.ensure_library();
\`\`\`

## get_library_tokens \u2014 Read all tokens from the library

\`\`\`js
// Returns { colors: [{name, hex}], textStyles: [{name, fontSize, fontWeight, fill}] }
const tokens = await figma.get_library_tokens();
\`\`\`

## setupDesignTokens \u2014 Bootstrap complete token system (idempotent)

\`\`\`js
// Creates collection + variables. Skips existing, updates values if name matches.
const result = await figma.setupDesignTokens({
  collectionName: "Design Tokens",     // name of variable collection
  colors: {                            // COLOR variables
    "accent": "#3B82F6",
    "bg-base": "#08090E",
    "positive": "#00DC82",
  },
  numbers: {                           // FLOAT variables (spacing, radius)
    "spacing-md": 16,
    "radius-md": 12,
  }
});
// \u2192 { collectionId, collectionName, created: [{name, id, type}], updated: [...], totalVariables }
\`\`\`

## modifyVariable \u2014 Change variable value (propagates to all bound nodes)

\`\`\`js
// By name (searches all collections)
await figma.modifyVariable({ variableName: "accent", value: "#0EA5E9" });

// By ID (faster, no search)
await figma.modifyVariable({ variableId: "VariableID:57:671", value: "#FF6B35" });

// Works for all types: COLOR (hex), FLOAT (number), STRING, BOOLEAN
await figma.modifyVariable({ variableName: "spacing-md", value: 20 });
// \u2192 { id, name, resolvedType, newValue }
\`\`\`

## applyVariable \u2014 Bind a variable to a node property

\`\`\`js
// Bind accent color to a frame's fill
await figma.applyVariable({ nodeId: "49:115", field: "fill", variableId: "VariableID:57:671" });

// Bind by variable name (slower, searches all collections)
await figma.applyVariable({ nodeId: "49:115", field: "fill", variableName: "accent" });

// Supported fields: fill, stroke, opacity, cornerRadius, width, height
// \u2192 { nodeId, nodeName, field, variableId, variableName }
\`\`\`

## createComponent \u2014 Convert frame to reusable component

\`\`\`js
var comp = await figma.createComponent({ nodeId: "49:200", name: "btn/primary" });
// \u2192 { id, name, key, width, height }

// Then instantiate anywhere:
await figma.instantiate({ componentId: comp.id, parentId: screen.id, x: 100, y: 200 });
// Or by name:
await figma.instantiate({ componentName: "btn/primary", parentId: screen.id, x: 100, y: 200 });
\`\`\`

## export_image \u2014 Export node as base64 PNG/JPG (for saving to disk)

\`\`\`js
// Export avatar at 2x scale as PNG
figma_read({ operation: "export_image", nodeId: "89:209", scale: 2, format: "png" })
// \u2192 { base64: "iVBORw0KGgo...", format: "png", width: 128, height: 128, nodeId: "89:209", sizeBytes: 4521 }

// Save to file: echo "<base64>" | base64 -d > avatar.png

// Export as JPG
figma_read({ operation: "export_image", nodeId: "89:209", format: "jpg", scale: 1 })
\`\`\`

**screenshot vs export_image:**
| | screenshot | export_image |
|---|-----------|-------------|
| **Purpose** | Visual preview in chat | Save asset to disk |
| **Output** | Inline image in Claude Code | base64 text string |
| **Format** | PNG only | PNG or JPG |
| **Scale** | default 1x | default 2x |
| **Use case** | "Show me the frame" | "Extract this avatar/icon/thumbnail" |

## get_node_detail \u2014 CSS-like properties for a single node

Query one node by ID or name. Returns CSS-mapped properties without tree traversal.
Much faster than parsing full \`get_design\` output to find one node.

\`\`\`js
figma_read({ operation: "get_node_detail", nodeId: "89:393" })
// \u2192 {
//   id: "89:393", name: "Header", type: "FRAME",
//   x: 0, y: 0, width: 440, height: 56,
//   fills: [{ type: "SOLID", color: "#FFFFFF" }],
//   stroke: "#E7EAF0", strokeWeight: 1, strokeAlign: "INSIDE",
//   borderRadius: "0px",
//   opacity: 1,
//   boxShadow: "0px 1px 3px 0px rgba(0,0,0,0.1)",
//   css: {
//     display: "flex", flexDirection: "row",
//     gap: "8px", alignItems: "center", justifyContent: "space-between",
//     padding: "8px 16px 8px 16px"
//   },
//   childCount: 3,
//   boundVariables: { fills: "VariableID:57:671" }
// }
\`\`\`

**TEXT node returns additional properties:**
\`\`\`js
figma_read({ operation: "get_node_detail", nodeId: "89:348" })
// \u2192 {
//   content: "8 \u0111 83 token",
//   color: "#1E3150",
//   fontSize: "14px", fontFamily: "Inter", fontWeight: "Semi Bold",
//   lineHeight: "20px", letterSpacing: "-0.2px",
//   textAlign: "left"
// }
\`\`\`

## Mixed Text Segments

TEXT nodes with multiple styles return a \`segments\` array:
\`\`\`js
// Input: "8 \u0111 83 token" where "8 \u0111" is bold and "83 token" is regular
// Output in get_design / get_selection:
{
  "type": "TEXT",
  "content": "8 \u0111 83 token",
  "mixedStyles": true,
  "segments": [
    { "text": "8 \u0111", "fill": "#1E3150", "fontWeight": "Bold", "fontSize": 14 },
    { "text": "83 token", "fill": "#8E9AAD", "fontWeight": "Regular", "fontSize": 14 }
  ]
}
\`\`\`

---

## AUTO LAYOUT (PREFERRED for centering \u2014 NON-NEGOTIABLE for complex containers)

Use Auto Layout instead of manual x/y math whenever a container has children that need centering.

### Creating an Auto Layout Frame
\`\`\`js
// Horizontal row: icon + text side by side, vertically centered
await figma.create({
  type: "FRAME", name: "Button",
  parentId: root.id,
  x: 24, y: 100, width: 392, height: 52,
  fill: "#6C5CE7", cornerRadius: 12,
  layoutMode: "HORIZONTAL",           // "HORIZONTAL" | "VERTICAL"
  primaryAxisAlignItems: "CENTER",     // main axis: "MIN"|"CENTER"|"MAX"|"SPACE_BETWEEN"
  counterAxisAlignItems: "CENTER",     // cross axis: "MIN"|"CENTER"|"MAX"
  padding: 16,                        // uniform, or use paddingTop/Bottom/Left/Right
  itemSpacing: 8,                     // gap between children
})
// \u2192 Children added to this frame will auto-center!
\`\`\`

### Common patterns:
\`\`\`
// Button with centered text:
layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER"

// Card with icon left + text right, vertically centered:
layoutMode: "HORIZONTAL", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER", paddingLeft: 16, itemSpacing: 12

// Vertical stack (title + subtitle + button):
layoutMode: "VERTICAL", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "STRETCH", itemSpacing: 8

// Centered icon in a circle/square:
layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER"
\`\`\`

### Child properties:
\`\`\`js
// Make child fill parent width in vertical layout:
await figma.create({ ..., layoutAlign: "STRETCH" })

// Make child grow to fill available space:
await figma.create({ ..., layoutGrow: 1 })
\`\`\`

### Modify existing frame to auto-layout:
\`\`\`js
await figma.modify({ id: frameId, layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER" })
\`\`\`

### RULE: Always use Auto Layout for:
- Buttons (text must be centered)
- Cards with icon + text rows
- Tab bar items
- List items
- Any container where children must be centered
- Badge pills with text

### FALLBACK: Manual math (only when Auto Layout is inappropriate)
\`\`\`
icon_x = container_x + (container_w - icon_size) / 2
text_x = button_x + (button_w - text_w_estimate) / 2
\`\`\`

---

## DOT + TEXT / ICON + TEXT ROW ALIGNMENT RULE (MANDATORY)
When placing a small element (dot, icon, bullet) next to text in a horizontal row:

**ALWAYS use \`counterAxisAlignItems: "CENTER"\`** so items are vertically centered with each other.

\`\`\`
CORRECT:
layoutMode: "HORIZONTAL", counterAxisAlignItems: "CENTER", itemSpacing: 12
\u2192 dot (8px) and text (22px line-height) are vertically aligned

WRONG:
counterAxisAlignItems: "MIN"
\u2192 dot sits at top, text at top \u2014 dot appears higher than text center
\`\`\`

| Pattern | Layout | Cross Axis | When to use |
|---------|--------|------------|-------------|
| Dot + single-line text | HORIZONTAL | CENTER | Bullet points, list items |
| Icon + single-line text | HORIZONTAL | CENTER | Menu items, labels |
| Icon + multi-line text | HORIZONTAL | MIN + paddingTop on icon | Descriptions, cards |
| Badge + text | HORIZONTAL | CENTER | Tags, status indicators |

**Multi-line exception:** If text wraps to 2+ lines and dot/icon should align with the FIRST line only:
\`\`\`
counterAxisAlignItems: "MIN"
icon paddingTop = (textLineHeight - iconSize) / 2
Example: text 22px line-height, dot 8px \u2192 paddingTop = (22 - 8) / 2 = 7
\`\`\`

---

## PROGRESS BAR RULE (MANDATORY \u2014 CRITICAL)
Progress bars require TWO rectangles overlapping: track (full width bg) + fill (partial width foreground).
**Auto-layout frames stack children sequentially**, so placing both rectangles inside auto-layout will show them SIDE BY SIDE, not overlapping.

**ALWAYS wrap progress bars in a non-auto-layout frame:**
\`\`\`js
// CORRECT: wrapper frame WITHOUT layoutMode \u2192 children overlap via absolute x,y
var pbWrap = await figma.create({
  type: "FRAME", name: "progress-bar", parentId: autoLayoutParent.id,
  width: 352, height: 6
  // NO layoutMode here!
});
await figma.create({ type: "RECTANGLE", name: "progress-track", parentId: pbWrap.id, x: 0, y: 0, width: 352, height: 6, fill: "#E7EAF0", cornerRadius: 3 });
await figma.create({ type: "RECTANGLE", name: "progress-fill", parentId: pbWrap.id, x: 0, y: 0, width: 211, height: 6, fill: "#6C5CE7", cornerRadius: 3 });

// WRONG: both rectangles directly in auto-layout \u2192 they sit next to each other
await figma.create({ type: "RECTANGLE", parentId: autoLayoutFrame.id, width: 352, height: 6, fill: "#E7EAF0" });
await figma.create({ type: "RECTANGLE", parentId: autoLayoutFrame.id, width: 211, height: 6, fill: "#6C5CE7" });
// \u2191 These will NOT overlap \u2014 they'll be placed 352px + 211px = 563px total width!
\`\`\`

**This rule applies to ANY overlapping elements inside auto-layout:** score rings, slider tracks, overlay badges, etc.
Use a non-auto-layout wrapper frame whenever children must overlap.

---

## BADGE / PILL / TAG RULE (MANDATORY \u2014 TWO CONCERNS)
Badges have TWO separate concerns: (1) text centering INSIDE badge, (2) badge POSITION on parent.

**Concern 1 \u2014 Text inside badge: ALWAYS use auto-layout CENTER/CENTER**
\`\`\`js
// CORRECT: Auto-layout frame \u2192 text auto-centers inside badge
var badge = await figma.create({
  type: "FRAME", name: "badge", parentId: parent.id,
  x: 100, y: 10, width: 64, height: 20,
  fill: "#E8FBF5", cornerRadius: 10,
  layoutMode: "HORIZONTAL",
  primaryAxisAlignItems: "CENTER",   // centers text horizontally
  counterAxisAlignItems: "CENTER"    // centers text vertically
});
await figma.create({ type: "TEXT", parentId: badge.id, content: "Free", fontSize: 10, fontWeight: "SemiBold", fill: "#00B894" });

// WRONG: Separate rectangle + text \u2192 text never properly centered
\`\`\`

**Concern 2 \u2014 Badge position on card: use absolute x,y on PARENT (not inside card auto-layout)**
\`\`\`js
// Badge at top-right corner of a card:
// badgeX = cardX + cardWidth - badgeWidth - margin (e.g. 6px)
// badgeY = cardY + margin (e.g. 6px)
var badge = await figma.create({
  ..., parentId: rootFrame.id,    // parent is ROOT, not the card!
  x: cardX + cardWidth - 64 - 6, // top-right corner
  y: cardY + 6,
  ...
});
// Badge is a sibling of the card, overlapping its top-right corner via absolute positioning.
// Do NOT put badge inside the card's auto-layout \u2014 it will be stacked with other children!
\`\`\`

**This applies to:** badges, pills, tags, labels, small buttons, notification dots with numbers, level indicators.

---

## Images & Icons (Server-side helpers \u2014 NO bash/curl needed)

### figma.loadImage(url, opts) \u2014 Download image and place on canvas
\`\`\`js
// Thumbnail image
await figma.loadImage("https://images.unsplash.com/photo-xxx?w=440&h=248&fit=crop", {
  parentId: frame.id, x: 0, y: 0, width: 440, height: 248,
  name: "hero-image", scaleMode: "FILL"
});

// Circular avatar
await figma.loadImage("https://images.unsplash.com/photo-xxx?w=48&h=48&fit=crop", {
  parentId: row.id, width: 32, height: 32,
  name: "avatar", cornerRadius: 16, scaleMode: "FILL"
});
\`\`\`

### figma.loadIcon(name, opts) \u2014 Fetch SVG icon (auto fallback: Fluent \u2192 Bootstrap \u2192 Phosphor \u2192 Lucide)
\`\`\`js
await figma.loadIcon("chevron-left", { parentId: header.id, x: 16, y: 16, size: 22, fill: "#FFFFFF" });
await figma.loadIcon("bookmark",     { parentId: header.id, x: 398, y: 16, size: 22, fill: "#1E3150" });
await figma.loadIcon("play",         { parentId: btn.id, size: 24, fill: "#FFFFFF" });
\`\`\`

### figma.loadIconIn(name, opts) \u2014 Icon inside centered circle background
\`\`\`js
// 40px circle with jade bg at 10% opacity, 20px icon inside centered
await figma.loadIconIn("check", {
  parentId: card.id, containerSize: 40, fill: "#00B894", bgOpacity: 0.1
});
\`\`\`

### Legacy (still works but prefer helpers above)
\`type: "IMAGE"\` with \`imageData\` (base64) \u2014 use only when you already have base64 data.
\`type: "SVG"\` with \`svg\` string \u2014 use only when you have custom SVG markup.

---

## SVG Icons

Use \`type: "SVG"\` with \`svg\` param containing SVG markup string.
Replace \`fill="currentColor"\` or \`stroke="currentColor"\` with desired color before sending.

### ICON LIBRARY PRIORITY (MANDATORY)
Always try libraries in this order. If icon not found in first, fallback to next:

| Priority | Library | Style | URL Pattern | Fill Type |
|----------|---------|-------|-------------|-----------|
| 1st | **Fluent UI** | Win11 Filled | \`https://unpkg.com/@fluentui/svg-icons/icons/{name}_24_filled.svg\` | \`fill\` |
| 2nd | **Bootstrap** | Filled | \`https://unpkg.com/bootstrap-icons@1.11.3/icons/{name}-fill.svg\` | \`fill\` |
| 3rd | **Phosphor** | Filled | \`https://unpkg.com/@phosphor-icons/core@latest/assets/fill/{name}-fill.svg\` | \`fill\` |
| 4th | **Lucide** | Outline | \`https://unpkg.com/lucide-static@0.577.0/icons/{name}.svg\` | \`stroke\` |

**Naming differences between libraries:**
| Concept | Fluent UI | Bootstrap | Phosphor | Lucide |
|---------|-----------|-----------|----------|--------|
| Home | \`home_24_filled\` | \`house-fill\` | \`house-fill\` | \`home\` |
| Bell | \`alert_24_filled\` | \`bell-fill\` | \`bell-fill\` | \`bell\` |
| User | \`person_24_filled\` | \`person-fill\` | \`user-fill\` | \`user\` |
| Star | \`star_24_filled\` | \`star-fill\` | \`star-fill\` | \`star\` |
| Book | \`book_24_filled\` | \`book-fill\` | \`book-open-fill\` | \`book-open\` |
| Search | \`search_24_filled\` | \`search\` | \`magnifying-glass-fill\` | \`search\` |
| Settings | \`settings_24_filled\` | \`gear-fill\` | \`gear-fill\` | \`settings\` |
| Check | \`checkmark_24_filled\` | \`check-circle-fill\` | \`check-circle-fill\` | \`check\` |
| Close | \`dismiss_24_filled\` | \`x-circle-fill\` | \`x-circle-fill\` | \`x\` |
| Arrow L | \`arrow_left_24_filled\` | \`arrow-left\` | \`arrow-left-fill\` | \`arrow-left\` |
| Arrow R | \`arrow_right_24_filled\` | \`arrow-right\` | \`arrow-right-fill\` | \`arrow-right\` |
| Fire | \`fire_24_filled\` | \`fire\` | \`fire-fill\` | \`flame\` |
| Trophy | \`trophy_24_filled\` | \`trophy-fill\` | \`trophy-fill\` | \`trophy\` |
| Clock | \`clock_24_filled\` | \`clock-fill\` | \`clock-fill\` | \`clock\` |
| Share | \`share_24_filled\` | \`share-fill\` | \`share-fill\` | \`share-2\` |
| Lock | \`lock_closed_24_filled\` | \`lock-fill\` | \`lock-fill\` | \`lock\` |
| Gift | \`gift_24_filled\` | \`gift-fill\` | \`gift-fill\` | \`gift\` |
| Heart | \`heart_24_filled\` | \`heart-fill\` | \`heart-fill\` | \`heart\` |
| Compass | \`compass_northwest_24_filled\` | \`compass-fill\` | \`compass-fill\` | \`compass\` |
| Grid | \`grid_24_filled\` | \`grid-fill\` | \`grid-four-fill\` | \`grid-2x2\` |
| Eye | \`eye_24_filled\` | \`eye-fill\` | \`eye-fill\` | \`eye\` |
| Bookmark | \`bookmark_24_filled\` | \`bookmark-fill\` | \`bookmark-simple-fill\` | \`bookmark\` |
| Play | \`play_24_filled\` | \`play-fill\` | \`play-fill\` | \`play\` |
| Chat | \`chat_24_filled\` | \`chat-fill\` | \`chat-circle-fill\` | \`message-circle\` |
| Lightning | \`flash_24_filled\` | \`lightning-fill\` | \`lightning-fill\` | \`zap\` |

### ICON COLORING RULE (MANDATORY)
Always pass \`fill\` param when creating SVG icons. Different libraries handle color differently:
- **Fluent UI**: No default fill attr \u2192 MUST pass \`fill\` param to color vectors
- **Bootstrap**: Uses \`fill="currentColor"\` \u2192 sed replacement + \`fill\` param
- **Phosphor**: Uses \`fill="currentColor"\` \u2192 sed replacement + \`fill\` param
- **Lucide**: Uses \`stroke="currentColor"\` \u2192 sed replacement + \`stroke\` via SVG markup

The plugin's SVG handler applies \`fill\` to ALL vector children, so always include it:
\`\`\`js
figma.create({ type: "SVG", svg: "...", fill: "#6C5CE7", ... })
\`\`\`

Icon color must match its context:
| Context | Icon Color | Example |
|---------|-----------|---------|
| On white/light bg | Brand color or \`#1E3150\` | Card icons, tab bar |
| On colored bg (button) | \`#FFFFFF\` | Button icons |
| On colored circle bg | Same as circle color | \`figma_icon_in\` |
| Inactive/disabled | \`#8E9AAD\` | Inactive tab, muted |
| Accent/CTA | \`#6C5CE7\` (purple) | Active state |
| Success | \`#00B894\` (jade) | Check marks |
| Warning/gold | \`#F0B429\` | Stars, rewards |
| Danger/alert | \`#FF6B6B\` (coral) | Notifications |

### ICON SIZING RULE (MANDATORY)
Icon must ALWAYS be smaller than its container. Use this ratio:
\`\`\`
icon_size = container_size * 0.5    (50% of container)
\`\`\`
| Container | Icon | Example |
|-----------|------|---------|
| 24px      | 12px | Small badge dot |
| 32px      | 16px | Letter circle in quiz |
| 36px      | 18px | Header action circle |
| 40px      | 20px | Card icon circle |
| 44px      | 22px | Standard icon bg |
| 48px      | 24px | Large icon bg |
| 56px      | 28px | Hero icon |
| 64px      | 32px | Featured icon |
| 80px      | 40px | Splash/celebration |

**NEVER** set icon_size >= container_size. If icon overflows container, it looks broken.
When using \`figma_center\` wrapper for icon, calculate: \`figma_center(..., container_size, ...)\` then \`figma_icon(..., container_size * 0.5, ...)\`.

---

All figma operations are async. Always use \`await\`.

---

## Pages

\`\`\`js
await figma.listPages()
// \u2192 [{ id, name }, ...]

await figma.setPage({ name: "Dashboard" })     // switch to existing page
await figma.createPage({ name: "Signals" })    // create new page (no-op if exists)
\`\`\`

---

## Query nodes

\`\`\`js
await figma.query({ type: "FRAME" })           // all frames on current page
await figma.query({ name: "Sidebar" })         // by name
await figma.query({ id: "123:456" })           // by id
// \u2192 [{ id, name, type, x, y, width, height, parentId }]
\`\`\`

---

## Create \u2014 returns { id, name, type, x, y, width, height }

### FRAME  (artboard / container)
\`\`\`js
const f = await figma.create({
  type: "FRAME", name: "Screen",
  x: 0, y: 0, width: 1440, height: 900,
  fill: "#ffffff",            // hex color (optional)
  cornerRadius: 0,            // (optional)
  stroke: "#e2e8f0",          // border color (optional)
  strokeWeight: 1,
})
\`\`\`

### RECTANGLE  (card, badge, divider)
\`\`\`js
await figma.create({
  type: "RECTANGLE", name: "Card",
  parentId: f.id,
  x: 24, y: 80, width: 280, height: 120,
  fill: "#1e293b", cornerRadius: 12,
  stroke: "#334155", strokeWeight: 1,
})
\`\`\`

### ELLIPSE  (avatar, dot, chart node)
\`\`\`js
await figma.create({
  type: "ELLIPSE", name: "Status Dot",
  parentId: f.id,
  x: 12, y: 12, width: 8, height: 8,
  fill: "#22c55e",
})
\`\`\`

### LINE  (horizontal/vertical divider)
\`\`\`js
await figma.create({
  type: "LINE", name: "Divider",
  parentId: f.id,
  x: 0, y: 64, width: 240, height: 0,
  stroke: "#1e293b", strokeWeight: 1,
})
\`\`\`

### TEXT
\`\`\`js
await figma.create({
  type: "TEXT", name: "Heading",
  parentId: f.id,
  x: 24, y: 24,
  content: "Total Balance",
  fontSize: 14,
  fontWeight: "SemiBold",     // Regular | Medium | SemiBold | Bold | Light
  fill: "#f8fafc",
  lineHeight: 20,             // pixels (optional)
})
\`\`\`

### VECTOR  (diagonal lines, curves, bezier paths, arcs, custom shapes)
Use SVG path data syntax (\`d\` attribute) to draw any shape: diagonal lines, curves, arcs, polygons, waves.
\`\`\`js
// Diagonal line from top-left to bottom-right
await figma.create({
  type: "VECTOR", name: "Diagonal",
  parentId: f.id,
  x: 0, y: 0, width: 200, height: 100,
  d: "M 0 0 L 200 100",       // SVG path data
  stroke: "#ff0000", strokeWeight: 2,
})

// Smooth bezier curve (cubic)
await figma.create({
  type: "VECTOR", name: "Smooth Curve",
  parentId: f.id,
  x: 0, y: 0, width: 300, height: 150,
  d: "M 0 150 C 75 0, 225 0, 300 150",
  stroke: "#0e7c3a", strokeWeight: 3,
  strokeCap: "ROUND",         // NONE | ROUND | SQUARE | ARROW_LINES | ARROW_EQUILATERAL
  strokeJoin: "ROUND",        // MITER | BEVEL | ROUND
})

// Quadratic bezier curve
await figma.create({
  type: "VECTOR", name: "Quad Curve",
  parentId: f.id,
  x: 0, y: 0, width: 200, height: 100,
  d: "M 0 100 Q 100 0 200 100",
  stroke: "#6366F1", strokeWeight: 2,
})

// Filled wave / decorative shape
await figma.create({
  type: "VECTOR", name: "Wave",
  parentId: f.id,
  x: 0, y: 0, width: 440, height: 80,
  d: "M 0 40 C 110 0, 220 80, 330 40 C 385 20, 420 30, 440 40 L 440 80 L 0 80 Z",
  fill: "#0e7c3a",
})

// Arc (partial ellipse)
await figma.create({
  type: "VECTOR", name: "Arc",
  parentId: f.id,
  x: 0, y: 0, width: 200, height: 100,
  d: "M 0 100 A 100 100 0 0 1 200 100",
  stroke: "#FF4560", strokeWeight: 3,
  strokeCap: "ROUND",
})

// Multiple paths in one vector
await figma.create({
  type: "VECTOR", name: "Multi Path",
  parentId: f.id,
  x: 0, y: 0, width: 100, height: 100,
  paths: [
    { d: "M 0 0 L 100 100", windingRule: "NONZERO" },
    { d: "M 100 0 L 0 100", windingRule: "NONZERO" },
  ],
  stroke: "#000000", strokeWeight: 2,
})
\`\`\`

**SVG Path Data cheatsheet:**
| Command | Meaning | Example |
|---------|---------|---------|
| \`M x y\` | Move to point | \`M 0 0\` \u2014 start at origin |
| \`L x y\` | Line to point | \`L 100 50\` \u2014 diagonal line |
| \`H x\` | Horizontal line | \`H 200\` \u2014 horizontal to x=200 |
| \`V y\` | Vertical line | \`V 100\` \u2014 vertical to y=100 |
| \`C x1 y1 x2 y2 x y\` | Cubic bezier | \`C 50 0, 150 100, 200 50\` \u2014 S-curve |
| \`Q x1 y1 x y\` | Quadratic bezier | \`Q 100 0 200 100\` \u2014 simple curve |
| \`A rx ry rot large-arc sweep x y\` | Arc | \`A 50 50 0 0 1 100 0\` \u2014 half circle |
| \`Z\` | Close path | Connect back to start point |

**Lowercase** = relative coordinates (e.g. \`l 100 50\` = line 100px right, 50px down from current point).

---

## Modify

\`\`\`js
await figma.modify({ id: f.id, fill: "#0f172a" })
await figma.modify({ name: "Card", width: 300, cornerRadius: 16 })
await figma.modify({ id: "123:456", content: "New text", fontSize: 16 })
await figma.modify({ id: "123:456", fontFamily: "SF Pro", fontWeight: "Bold" })
\`\`\`

---

## Delete

\`\`\`js
await figma.delete({ id: "123:456" })
await figma.delete({ name: "Old Frame" })
\`\`\`

---

## Components

\`\`\`js
await figma.listComponents()
// \u2192 [{ id, name, key }]

await figma.instantiate({ componentId: "c:123", parentId: f.id, x: 0, y: 0 })
\`\`\`

---

## Read operations (also available in figma_write for chaining)

\`\`\`js
// Get selected node design data
const { nodes } = await figma.get_selection();
console.log(JSON.stringify(nodes[0], null, 2));

// Screenshot a frame
const { dataUrl } = await figma.screenshot({ id: f.id, scale: 2 });

// Top-level frames on current page
const { nodes: frames } = await figma.get_page_nodes();

// Get all local styles (paint, text, effect, grid)
const styles = await figma.get_styles();
// \u2192 { paintStyles: [{id, name, hex}], textStyles: [{id, name, fontSize, fontFamily, fontWeight}], effectStyles, gridStyles }

// Get enhanced component listing with properties
const comps = await figma.get_local_components();
// \u2192 { components: [{id, name, key, description, width, height, properties}], componentSets, total }

// Get current viewport position and zoom
const vp = await figma.get_viewport();
// \u2192 { center: {x, y}, zoom, bounds: {x, y, width, height} }

// Read Figma local variables (Design Tokens)
const vars = await figma.get_variables();
// \u2192 { collections: [{id, name, modes, variables: [{id, name, resolvedType, values, description}]}] }
\`\`\`

---

## New write operations

### Clone \u2014 duplicate a node
\`\`\`js
const copy = await figma.clone({ id: "123:456", x: 500, y: 0, name: "Card Copy" });
// Optionally move to different parent:
await figma.clone({ id: "123:456", parentId: otherFrame.id });
\`\`\`

### Group / Ungroup
\`\`\`js
// Group multiple nodes
const group = await figma.group({ nodeIds: ["1:2", "1:3", "1:4"], name: "Header Group" });

// Ungroup \u2014 children moved to parent, group removed
const { ungrouped } = await figma.ungroup({ id: group.id });
\`\`\`

### Flatten \u2014 merge vectors
\`\`\`js
const flat = await figma.flatten({ id: "1:2" });
\`\`\`

### Resize
\`\`\`js
await figma.resize({ id: "1:2", width: 500, height: 300 });
\`\`\`

### Set Selection \u2014 programmatically select nodes
\`\`\`js
await figma.set_selection({ nodeIds: ["1:2", "1:3"] });
\`\`\`

### Set Viewport \u2014 navigate to specific area
\`\`\`js
// Zoom to fit a specific node
await figma.set_viewport({ nodeId: "1:2" });
await figma.set_viewport({ nodeName: "Dashboard" });

// Manual position + zoom
await figma.set_viewport({ center: { x: 500, y: 300 }, zoom: 0.5 });
\`\`\`

### Batch \u2014 execute multiple operations in one call
\`\`\`js
// Up to 50 operations per batch \u2014 much faster than individual calls
const result = await figma.batch({
  operations: [
    { operation: "create", params: { type: "RECTANGLE", parentId: f.id, x: 0, y: 0, width: 100, height: 100, fill: "#ff0000" } },
    { operation: "create", params: { type: "TEXT", parentId: f.id, x: 10, y: 10, content: "Hello", fontSize: 14, fill: "#ffffff" } },
    { operation: "modify", params: { id: "1:5", fill: "#00ff00" } },
  ]
});
// \u2192 { results: [{index, operation, success, data}], total: 3, succeeded: 3 }
\`\`\`

### Design Tokens \u2014 Variables, Styles, Components (v1.7.0)

#### createVariableCollection \u2014 create a named collection
\`\`\`js
// Create collections to organize variables
var colors = await figma.createVariableCollection({ name: "Colors" });
var spacing = await figma.createVariableCollection({ name: "Spacing" });
// \u2192 { id: "VariableCollectionId:123", name: "Colors", modes: [{ id: "...", name: "Mode 1" }] }
\`\`\`

#### createVariable \u2014 create a variable in a collection
\`\`\`js
// COLOR variable \u2014 pass hex string, auto-converts to RGBA
var bgBase = await figma.createVariable({
  name: "bg-base",
  collectionId: colors.id,    // or collection name: "Colors"
  resolvedType: "COLOR",      // COLOR | FLOAT | STRING | BOOLEAN
  value: "#08090E"
});

// FLOAT variable for spacing
var spaceMd = await figma.createVariable({
  name: "space-md",
  collectionId: spacing.id,
  resolvedType: "FLOAT",
  value: 16
});
// \u2192 { id: "VariableID:456", name: "bg-base", resolvedType: "COLOR", collectionId: "..." }
\`\`\`

#### applyVariable \u2014 bind variable to a node property
\`\`\`js
// Bind fill color to variable \u2014 change variable later \u2192 all bound nodes update
await figma.applyVariable({
  nodeId: card.id,
  field: "fill",           // fill | stroke | opacity | cornerRadius | width | height
  variableName: "bg-base"  // or variableId: bgBase.id
});

// Bind stroke to variable
await figma.applyVariable({
  nodeId: card.id,
  field: "stroke",
  variableName: "border-color"
});
\`\`\`

#### createPaintStyle \u2014 create reusable paint style
\`\`\`js
var primaryStyle = await figma.createPaintStyle({
  name: "color/primary",     // use slash naming for organization
  color: "#006FEE",
  description: "Primary brand color"
});
// \u2192 { id: "S:...", name: "color/primary", key: "...", color: "#006FEE" }
\`\`\`

#### createTextStyle \u2014 create reusable text style
\`\`\`js
var headingStyle = await figma.createTextStyle({
  name: "text/heading-xl",
  fontFamily: "Inter",
  fontWeight: "Bold",        // Regular | Medium | SemiBold | Bold | Heavy
  fontSize: 24,
  lineHeight: 32,            // px number, "auto", or "150%"
  letterSpacing: -0.5,       // px
  description: "Page headings"
});
// \u2192 { id: "S:...", name: "text/heading-xl", key: "...", fontSize: 24 }
\`\`\`

#### createComponent \u2014 convert frame to reusable component
\`\`\`js
// First create a frame with desired design
var btnFrame = await figma.create({
  type: "FRAME", name: "btn/primary",
  width: 120, height: 40, fill: "#006FEE", cornerRadius: 12,
  layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER",
});
await figma.create({ type: "TEXT", parentId: btnFrame.id, content: "Button", fontSize: 14, fontWeight: "SemiBold", fill: "#FFFFFF" });

// Convert to component \u2014 now reusable via instantiate()
var btnComp = await figma.createComponent({ nodeId: btnFrame.id, name: "btn/primary" });
// \u2192 { id: "...", name: "btn/primary", key: "...", width: 120, height: 40 }

// Use it everywhere
var btn1 = await figma.instantiate({ componentId: btnComp.id, parentId: form.id, x: 0, y: 100 });
var btn2 = await figma.instantiate({ componentId: btnComp.id, parentId: card.id, x: 16, y: 200 });
// Edit original component \u2192 all instances update automatically
\`\`\`

#### Full Design Token Workflow
\`\`\`js
// 1. Create variable collections
var colors = await figma.createVariableCollection({ name: "Brand Colors" });
var spacing = await figma.createVariableCollection({ name: "Spacing" });

// 2. Define variables
await figma.createVariable({ name: "primary", collectionId: colors.id, resolvedType: "COLOR", value: "#006FEE" });
await figma.createVariable({ name: "bg-card", collectionId: colors.id, resolvedType: "COLOR", value: "#FFFFFF" });
await figma.createVariable({ name: "text-primary", collectionId: colors.id, resolvedType: "COLOR", value: "#1E3150" });
await figma.createVariable({ name: "md", collectionId: spacing.id, resolvedType: "FLOAT", value: 16 });

// 3. Create paint + text styles
await figma.createPaintStyle({ name: "color/primary", color: "#006FEE" });
await figma.createTextStyle({ name: "text/body", fontFamily: "Inter", fontWeight: "Regular", fontSize: 14, lineHeight: 22 });

// 4. Build UI and bind variables
var card = await figma.create({ type: "FRAME", width: 300, height: 200, fill: "#FFFFFF", cornerRadius: 12 });
await figma.applyVariable({ nodeId: card.id, field: "fill", variableName: "bg-card" });

// 5. Rebrand later? Just change the variable \u2014 everything updates!
\`\`\`

---

## Workflow example \u2014 Draw a full screen

\`\`\`js
// 1. Switch page
await figma.createPage({ name: "Dashboard" });
await figma.setPage({ name: "Dashboard" });

// 2. Root frame
const root = await figma.create({
  type: "FRAME", name: "Dashboard",
  x: 0, y: 0, width: 1440, height: 900, fill: "#0f172a",
});

// 3. Sidebar
const sidebar = await figma.create({
  type: "FRAME", name: "Sidebar",
  parentId: root.id,
  x: 0, y: 0, width: 240, height: 900,
  fill: "#1e293b", stroke: "#334155", strokeWeight: 1,
});

// 4. Nav item
const navItem = await figma.create({
  type: "RECTANGLE", name: "Nav Active",
  parentId: sidebar.id,
  x: 8, y: 88, width: 224, height: 40,
  fill: "#3b82f6", cornerRadius: 8, opacity: 0.15,
});

await figma.create({
  type: "TEXT", name: "Nav Label",
  parentId: sidebar.id,
  x: 48, y: 100,
  content: "Dashboard",
  fontSize: 13, fontWeight: "Medium", fill: "#f8fafc",
});

// 5. Continue building sections\u2026
console.log("Root frame id:", root.id);
\`\`\`

---

## Figma Plugin Sandbox Limitations
The plugin JS sandbox does NOT support:
- Optional chaining \`?.\` \u2192 use \`x ? x.y : null\`
- Nullish coalescing \`??\` \u2192 use \`x !== undefined ? x : default\`
- Object spread \`{...obj}\` \u2192 use \`Object.assign({}, obj)\`
- \`require\`, \`fetch\`, \`setTimeout\`, \`process\`, \`fs\`

---

## Tips
- Build iteratively: one section at a time
- Use \`console.log(node.id)\` to inspect returned IDs
- Use \`figma.query()\` to find existing nodes before modifying
- Each \`figma.*\` call = one HTTP round-trip \u2014 keep code sequential
`;

// server/index.js
var bridge;
var useHttpProxy = false;
var REMOTE_HOST = process.env.FIGMA_BRIDGE_HOST || "127.0.0.1";
var REMOTE_TOKEN = process.env.FIGMA_BRIDGE_TOKEN || null;
function proxyHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (REMOTE_TOKEN) h["X-Bridge-Token"] = REMOTE_TOKEN;
  return h;
}
var httpProxy = {
  isPluginConnected() {
    return true;
  },
  // delegate health check to actual call
  get queueLength() {
    return 0;
  },
  get lastPollAt() {
    return Date.now();
  },
  async sendOperation(operation, params = {}) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ operation, params });
      const req = http3.request({
        hostname: REMOTE_HOST,
        port: CONFIG.PORT,
        path: "/exec",
        method: "POST",
        headers: proxyHeaders({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) })
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.success) resolve(parsed.data);
            else reject(new Error(parsed.error || "Bridge error"));
          } catch {
            reject(new Error("Invalid bridge response"));
          }
        });
      });
      req.on("error", (e) => reject(new Error(`Bridge connection failed: ${e.message}`)));
      req.setTimeout(CONFIG.OP_TIMEOUT_MS, () => {
        req.destroy();
        reject(new Error("Bridge timeout"));
      });
      req.end(payload);
    });
  },
  // Health check via HTTP
  async checkHealth() {
    return new Promise((resolve) => {
      const req = http3.request({
        hostname: REMOTE_HOST,
        port: CONFIG.PORT,
        path: "/health",
        method: "GET"
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ pluginConnected: false });
          }
        });
      });
      req.on("error", () => resolve({ pluginConnected: false }));
      req.setTimeout(2e3, () => {
        req.destroy();
        resolve({ pluginConnected: false });
      });
      req.end();
    });
  }
};
var log = (msg) => process.stderr.write(`[figma-ui-mcp] ${msg}
`);
log(`Startup diagnostics: FIGMA_BRIDGE_HOST=${process.env.FIGMA_BRIDGE_HOST || "(not set)"}, PORT=${CONFIG.PORT}`);
if (process.env.FIGMA_BRIDGE_HOST) {
  useHttpProxy = true;
  bridge = httpProxy;
  log(`Remote bridge mode: ${REMOTE_HOST}:${CONFIG.PORT}`);
  const t0 = Date.now();
  const health = await httpProxy.checkHealth();
  const latency = Date.now() - t0;
  if (health.pluginConnected) {
    log(`\u2713 Remote bridge reachable (${latency}ms), plugin connected`);
  } else {
    log(`\u2717 Remote bridge ping result (${latency}ms): pluginConnected=${health.pluginConnected}`);
    if (latency >= 1900) {
      log(`  \u2192 Bridge may be unreachable (timeout). Check FIGMA_BRIDGE_HOST=${REMOTE_HOST} and port ${CONFIG.PORT}`);
    } else {
      log(`  \u2192 Bridge reachable but Figma plugin not running. Start plugin in Figma Desktop.`);
    }
  }
} else {
  log("No FIGMA_BRIDGE_HOST set, trying local bridge...");
  try {
    bridge = await new BridgeServer().start();
    log("Bridge started on port " + bridge.port);
  } catch (e) {
    useHttpProxy = true;
    bridge = httpProxy;
    log("Bridge failed (" + e.message + "), connecting to existing bridge on port " + CONFIG.PORT);
  }
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
var server = new Server(
  { name: "figma-ui-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args } }) => {
  if (name === "figma_status") {
    let connected, pluginInfo = null, healthData = {};
    if (useHttpProxy) {
      healthData = await httpProxy.checkHealth();
      connected = healthData.pluginConnected;
      if (connected) {
        try {
          pluginInfo = await bridge.sendOperation("status", {});
        } catch {
        }
      }
    } else {
      connected = bridge.isPluginConnected();
      if (connected) {
        try {
          pluginInfo = await bridge.sendOperation("status", {});
        } catch {
        }
      }
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          bridgePort: bridge.port || CONFIG.PORT,
          pluginConnected: connected,
          pluginInfo,
          mode: useHttpProxy ? "http-proxy" : "direct",
          queueLength: healthData.queueLength || bridge.queueLength,
          lastPollAgoMs: healthData.lastPollAgoMs || (bridge.lastPollAt ? Date.now() - bridge.lastPollAt : null),
          hint: connected ? "Ready. Use figma_write to draw or figma_read to extract design." : "Plugin not connected. In Figma Desktop: Plugins \u2192 Development \u2192 Figma UI MCP Bridge \u2192 Run"
        }, null, 2)
      }]
    };
  }
  if (name === "figma_write") {
    if (useHttpProxy) {
      const health = await httpProxy.checkHealth();
      if (!health.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();
    const code = args?.code;
    if (!code || typeof code !== "string") return err("'code' is required.");
    const { success, result, error, logs } = await executeCode(code, bridge);
    const parts = [];
    if (logs.length) parts.push(`Logs:
${logs.join("\n")}`);
    parts.push(success ? `Result: ${JSON.stringify(result, null, 2)}` : `Error: ${error}`);
    return { isError: !success, content: [{ type: "text", text: parts.join("\n\n") }] };
  }
  if (name === "figma_read") {
    if (useHttpProxy) {
      const health = await httpProxy.checkHealth();
      if (!health.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();
    const { operation, nodeId, nodeName, scale, depth, format, detail, ...searchParams } = args || {};
    if (!operation) return err("'operation' is required.");
    const params = {};
    if (nodeId) params.id = nodeId;
    if (nodeName) params.name = nodeName;
    if (scale) params.scale = scale;
    if (depth !== void 0) params.depth = depth;
    if (format) params.format = format;
    if (detail) params.detail = detail;
    if (operation === "search_nodes") Object.assign(params, searchParams);
    try {
      const data = await bridge.sendOperation(operation, params);
      if (operation === "screenshot" && data && data.dataUrl) {
        var b64 = data.dataUrl;
        if (b64.indexOf(",") !== -1) b64 = b64.split(",")[1];
        var meta = Object.assign({}, data);
        delete meta.dataUrl;
        var content = [{ type: "image", data: b64, mimeType: "image/png" }];
        if (Object.keys(meta).length > 0) {
          content.push({ type: "text", text: JSON.stringify(meta, null, 2) });
        }
        return { content };
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return err(e.message);
    }
  }
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
      text: "Figma plugin not connected. Run the 'Figma UI MCP Bridge' plugin in Figma Desktop first."
    }]
  };
}
function err(msg) {
  return { isError: true, content: [{ type: "text", text: msg }] };
}
await server.connect(new StdioServerTransport());
