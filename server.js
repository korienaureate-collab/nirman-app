const express = require('express');
const path = require('path');
const { makeStore } = require('./lib/store');
const { handleMcp } = require('./lib/http');

const app = express();
const PORT = process.env.PORT || 3000;
const MCP_TOKEN = process.env.MCP_TOKEN || '';
const store = makeStore(process.env);

app.use(express.json({ limit: '25mb' }));

/* ── Claude connector (claude.ai → Customize → Connectors → Add custom connector):
      https://<this site>/mcp/<MCP_TOKEN>   — Claude sends lines into the AI Inbox; nothing is saved until approved in the app ── */
app.all('/mcp/:tok', async (req, res) => {
  if (!MCP_TOKEN || req.params.tok !== MCP_TOKEN) return res.status(404).send('Not found');
  try { await handleMcp(req, res, store); }
  catch (e) { console.error('mcp', e); if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }); }
});

/* ── AI Inbox for the app (key = the same MCP_TOKEN, typed once in the app) ── */
const key = (req, res) => { if (!MCP_TOKEN || req.get('x-inbox-key') !== MCP_TOKEN) { res.status(401).json({ error: 'Wrong inbox key' }); return false; } return true; };
app.get('/api/inbox/ping', (req, res) => res.json({ ok: true, configured: !!MCP_TOKEN, storage: store.kind }));
app.get('/api/inbox', async (req, res) => {
  if (!key(req, res)) return;
  try { res.json({ items: await store.listInbox(150), snapshotAt: await store.snapshotAt() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/inbox/:id', async (req, res) => {
  if (!key(req, res)) return;
  try { res.json({ ok: await store.updateInbox(req.params.id, req.body || {}) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/snapshot', async (req, res) => {
  if (!key(req, res)) return;
  const items = (req.body && req.body.items) || {};
  try { await store.saveSnapshot({ at: new Date().toISOString(), items }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => /\.[a-z0-9]+$/i.test(req.path) ? res.status(404).send('Not found') : res.sendFile(path.join(__dirname, 'public', 'index.html')));   // a missing file (e.g. cloud-config.js) is a 404, not the app

app.listen(PORT, () => console.log(`🟢 Nirman Ledger → http://localhost:${PORT} · inbox storage: ${store.kind}${MCP_TOKEN ? '' : ' · MCP_TOKEN not set (connector off)'}`));
