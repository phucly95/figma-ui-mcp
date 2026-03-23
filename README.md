# figma-ui-mcp (Remote Bridge)

Bidirectional Figma MCP — AI agents draw UI directly in Figma and read designs back as structured data.

Forked and customized for **remote control** via Tailscale: agents on a headless server control Figma Desktop on a separate machine.

```
Ubuntu Server (Jarvis)                    MacBook / PC
┌────────────────────────┐                ┌───────────────────────────┐
│ Agent ──► MCP Server   │── Tailscale ──▶│ Bridge Server (38451)     │
│   (FIGMA_BRIDGE_HOST)  │   encrypted    │   └── Figma Plugin ◄──►  │
└────────────────────────┘                │       Figma Desktop       │
                                          └───────────────────────────┘
```

---

## Setup

### 1. Máy Figma (MacBook / PC)

```bash
# Clone & install
git clone <repo-url> figma-ui-mcp
cd figma-ui-mcp && npm install

# Start standalone bridge
node server/bridge-standalone.js
```

Load plugin trong Figma Desktop:

1. Mở **Figma Desktop** (bắt buộc — web app không hỗ trợ)
2. **Plugins → Development → Import plugin from manifest...**
3. Chọn `plugin/manifest.json`
4. Chạy **Plugins → Development → Figma UI MCP Bridge**
5. Thấy **green dot** = connected

> Plugin UI cho phép click vào host/port để thay đổi nếu cần.

### 2. Ubuntu Server (Jarvis)

```bash
# Copy repo lên server
scp -r figma-ui-mcp user@server:/opt/figma-ui-mcp

# Set Tailscale IP của máy Figma
export FIGMA_BRIDGE_HOST=100.x.x.2
```

Thêm vào `fastagent.config.yaml`:

```yaml
figma-ui-mcp:
  command: "node"
  args: ["/opt/figma-ui-mcp/server/index.js"]
  env:
    FIGMA_BRIDGE_HOST: "${FIGMA_BRIDGE_HOST}"
```

---

## MCP Tools

| Tool | Mô tả |
|------|--------|
| `figma_status` | Kiểm tra kết nối plugin |
| `figma_write` | Vẽ / chỉnh sửa UI bằng JavaScript code |
| `figma_read` | Đọc design tree, colors, typography, screenshots |
| `figma_docs` | Xem API reference đầy đủ |

---

## Environment Variables

| Variable | Vị trí | Mô tả |
|----------|--------|--------|
| `FIGMA_BRIDGE_HOST` | Server (MCP) | Tailscale IP của máy chạy Figma Desktop |
| `FIGMA_MCP_PORT` | Cả hai | Port cho bridge (default: `38451`) |
| `FIGMA_BRIDGE_TOKEN` | Cả hai | Optional auth token (không cần nếu dùng Tailscale) |

---

## Architecture

```
figma-ui-mcp/
├── server/
│   ├── index.js              MCP server (stdio) — chạy trên Ubuntu
│   ├── bridge-server.js      HTTP bridge module
│   ├── bridge-standalone.js  Standalone bridge — chạy trên máy Figma
│   ├── code-executor.js      VM sandbox cho figma_write
│   ├── tool-definitions.js   MCP tool schemas
│   └── api-docs.js           API reference
└── plugin/
    ├── manifest.json          Figma plugin manifest
    ├── code.js                Plugin main — operation handlers
    └── ui.html                Plugin UI — HTTP polling + status
```

### Modes

- **Local mode** (default): MCP server + bridge chạy cùng process, plugin poll localhost
- **Remote mode** (`FIGMA_BRIDGE_HOST` set): MCP server proxy HTTP tới bridge trên máy khác

---

## License

MIT © [TranHoaiHung](https://github.com/TranHoaiHung)
