# Nirman Ledger — website (Render)

`server.js` serves the app in `public/index.html` and the **Claude connector**:
from any claude.ai chat, Claude reads a register photo and sends the lines to the
website's **📥 AI Inbox**; you approve them in the app and only then are they saved.
The books stay in your browser (download a backup every day).

## Render → your service → Environment (one time)

| Key | Value |
|---|---|
| `MCP_TOKEN` | a long password you make up (30+ letters/numbers). It is the connector password **and** the inbox key in the app. |
| `GITHUB_TOKEN` | a fine-grained GitHub token for **this repo only** with *Contents: read & write* — keeps the inbox on the `nirman-inbox` branch so a Render restart does not wipe it |
| `GITHUB_REPO` | `korienaureate-collab/nirman-app` |

Save → Render redeploys. Without `GITHUB_TOKEN` the inbox still works but is lost whenever Render restarts.

## claude.ai (one time)
Customize → Connectors → **+** → Add custom connector → name `Nirman Ledger`,
URL `https://nirman.korienaureate.online/mcp/<MCP_TOKEN>` → Add.

## In the app (once per computer)
📥 AI Inbox → type the same `MCP_TOKEN` → Connect.

## Daily use
claude.ai chat (connector on) → attach a register photo → “Add this page to Nirman Ledger”
→ app → 📥 AI Inbox → **Review & approve**.

Tests: `npm install && npm test` and `node test/ghstore.test.js`.
