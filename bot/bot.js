require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const BOT_PORT = parseInt(process.env.BOT_PORT || '3001');
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:8000';
const SESSION_DIR = path.join(__dirname, '..', 'data', 'whatsapp-session');

fs.mkdirSync(SESSION_DIR, { recursive: true });

// --- State ---
let currentQR = null;
let isConnected = false;
let phoneInfo = null;
let allGroups = [];
let allChats = [];
let sock = null;

// --- Settings cache (avoids a DB round-trip on every incoming message) ---
let _cachedSettings = null;
let _settingsCacheTs = 0;
const SETTINGS_TTL_MS = 30_000;

async function getSettings() {
  const now = Date.now();
  if (_cachedSettings && now - _settingsCacheTs < SETTINGS_TTL_MS) {
    return _cachedSettings;
  }
  const res = await axios.get(`${PYTHON_API_URL}/api/settings`, { timeout: 5000 });
  _cachedSettings = res.data;
  _settingsCacheTs = now;
  return _cachedSettings;
}

// --- Media history stores: groupId -> Map<msgId, msg> ---
const imageHistory = new Map();
const videoHistory = new Map();
const MAX_PER_GROUP = 3000;
const MAX_VIDEOS_PER_GROUP = 500;

// --- Text history: groupId -> Array<{id, timestamp, sender, text}> ---
const textHistory = new Map();
const MAX_TEXT_PER_GROUP = 200;

// Oldest message cursor per group (used for fetchMessageHistory requests)
const groupCursors = new Map(); // groupId -> { key, timestampMs }

function isImageMsg(msg) {
  const msgType = Object.keys(msg.message || {})[0];
  return msgType === 'imageMessage' ||
    (msgType === 'documentMessage' && (msg.message?.documentMessage?.mimetype || '').startsWith('image/'));
}

function isVideoMsg(msg) {
  const msgType = Object.keys(msg.message || {})[0];
  return msgType === 'videoMessage' ||
    (msgType === 'documentMessage' && (msg.message?.documentMessage?.mimetype || '').startsWith('video/'));
}

function getSender(msg) {
  const jid = msg.key.participant || msg.key.remoteJid || '';
  return msg.pushName || jid.split('@')[0];
}

function updateCursor(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us')) return;
  const ts = ((msg.messageTimestamp || 0) * 1000);
  const cur = groupCursors.get(jid);
  if (!cur || ts < cur.timestampMs) {
    groupCursors.set(jid, { key: msg.key, timestampMs: ts });
  }
}

function storeMediaMsg(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us')) return;
  updateCursor(msg);
  if (isImageMsg(msg)) {
    if (!imageHistory.has(jid)) imageHistory.set(jid, new Map());
    const byJid = imageHistory.get(jid);
    byJid.set(msg.key.id, msg);
    if (byJid.size > MAX_PER_GROUP) byJid.delete(byJid.keys().next().value);
  } else if (isVideoMsg(msg)) {
    if (!videoHistory.has(jid)) videoHistory.set(jid, new Map());
    const byJid = videoHistory.get(jid);
    byJid.set(msg.key.id, msg);
    if (byJid.size > MAX_VIDEOS_PER_GROUP) byJid.delete(byJid.keys().next().value);
  }
}

function storeTextMsg(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid?.endsWith('@g.us')) return;
  const msgType = Object.keys(msg.message || {})[0];
  let text = '';
  if (msgType === 'conversation') {
    text = msg.message.conversation;
  } else if (msgType === 'extendedTextMessage') {
    text = msg.message.extendedTextMessage?.text || '';
  }
  if (!text) return;
  if (!textHistory.has(jid)) textHistory.set(jid, []);
  const arr = textHistory.get(jid);
  arr.push({
    id: msg.key.id,
    timestamp: (msg.messageTimestamp || 0) * 1000,
    sender: getSender(msg),
    text,
  });
  if (arr.length > MAX_TEXT_PER_GROUP) arr.splice(0, arr.length - MAX_TEXT_PER_GROUP);
}

// --- WhatsApp connection ---
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['ParentTool', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messaging-history.set', ({ messages }) => {
    for (const msg of (messages || [])) {
      updateCursor(msg);  // track oldest for all message types
      storeMediaMsg(msg); // store images and videos
    }
    if (messages?.length) console.log(`[bot] History sync: processed ${messages.length} messages`);
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log('[bot] QR code ready — open the Settings page to scan.');
    }

    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      const me = sock.user;
      phoneInfo = { number: me.id.split(':')[0], name: me.name || 'Unknown' };
      console.log(`[bot] Connected as ${phoneInfo.name} (+${phoneInfo.number})`);
      await refreshGroupsAndChats();
    }

    if (connection === 'close') {
      isConnected = false;
      phoneInfo = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[bot] Disconnected (code ${code}). Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connect, 5000);
      } else {
        // Logged out — clear session so QR is shown again
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        setTimeout(connect, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      updateCursor(msg);
      if (!msg.key.fromMe) {
        storeMediaMsg(msg);
        storeTextMsg(msg);
      }

      // ── Enroll-from-DM: image in a direct chat with caption "enroll <name>" ──
      if (isImageMsg(msg)) {
        const remoteJid = msg.key.remoteJid || '';
        const isDM = !remoteJid.endsWith('@g.us');
        const msgType = Object.keys(msg.message || {})[0];
        const caption = (
          msg.message?.imageMessage?.caption ||
          msg.message?.documentMessage?.caption || ''
        ).trim();
        if (isDM && /^enroll\s+\S/i.test(caption)) {
          const kidName = caption.replace(/^enroll\s+/i, '').trim();
          console.log(`[bot] Enroll-from-DM: "${kidName}" from ${remoteJid}`);
          try {
            let buffer;
            try {
              buffer = await downloadMediaMessage(msg, 'buffer', {});
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ Could not download photo: ${e.message}` });
              continue;
            }
            // Find or create kid
            const kidsRes = await axios.get(`${PYTHON_API_URL}/api/enrollment/kids`, { timeout: 5000 });
            let kid = (kidsRes.data.kids || []).find(k => k.name.toLowerCase() === kidName.toLowerCase());
            if (!kid) {
              const createRes = await axios.post(`${PYTHON_API_URL}/api/enrollment/kids`,
                { name: kidName }, { timeout: 5000 });
              kid = createRes.data;
            }
            // Upload photo
            const form = new FormData();
            form.append('file', buffer, { filename: 'enroll.jpg', contentType: 'image/jpeg' });
            const uploadRes = await axios.post(
              `${PYTHON_API_URL}/api/enrollment/kids/${kid.id}/upload`,
              form, { headers: form.getHeaders(), timeout: 30000 }
            );
            const { photo_id } = uploadRes.data;
            // Confirm enrollment
            const confirmRes = await axios.post(
              `${PYTHON_API_URL}/api/enrollment/kids/${kid.id}/confirm/${photo_id}`,
              {}, { timeout: 10000 }
            );
            const count = confirmRes.data.enrolled_count || 1;
            await sock.sendMessage(remoteJid, {
              text: `✅ Photo enrolled for ${kid.name}! They now have ${count} enrolled photo${count !== 1 ? 's' : ''}.`
            });
          } catch (e) {
            const reason = e.response?.data?.detail || e.message;
            await sock.sendMessage(remoteJid, { text: `❌ Enrollment failed: ${reason}. Try a clearer photo with a visible face.` });
          }
          continue;
        }
      }

      if (msg.key.fromMe) continue;

      const isImage = isImageMsg(msg);
      const isVideo = isVideoMsg(msg);
      if (!isImage && !isVideo) continue;

      const groupId = msg.key.remoteJid;
      if (!groupId?.endsWith('@g.us')) continue;

      let settings;
      try {
        settings = await getSettings();
      } catch (e) {
        console.error('[bot] Could not fetch settings:', e.message);
        continue;
      }

      let watchGroups = [];
      try { watchGroups = JSON.parse(settings.watch_groups || '[]'); } catch (_) {}
      const groupConfig = watchGroups.find(g => g.id === groupId);
      if (!groupConfig) continue;

      const forwardToId = settings.forward_to_id;
      if (!forwardToId) { console.log('[bot] No forward target configured.'); continue; }

      const groupName = groupConfig.name || groupId;
      const mediaType = isVideo ? 'Video' : 'Image';
      console.log(`[bot] ${mediaType} received from "${groupName}", downloading...`);

      let buffer;
      try {
        buffer = await downloadMediaMessage(msg, 'buffer', {});
      } catch (e) {
        console.error('[bot] Failed to download media:', e.message);
        continue;
      }

      const senderName = getSender(msg);

      try {
        const form = new FormData();
        if (isVideo) {
          form.append('file', buffer, { filename: 'video.mp4', contentType: 'video/mp4' });
        } else {
          form.append('file', buffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
        }

        const endpoint = isVideo ? 'analyze-video' : 'analyze';
        const timeout = isVideo ? 90000 : 30000;
        const res = await axios.post(
          `${PYTHON_API_URL}/api/${endpoint}?group_id=${encodeURIComponent(groupId)}&group_name=${encodeURIComponent(groupName)}&sender=${encodeURIComponent(senderName)}`,
          form,
          { headers: { ...form.getHeaders() }, timeout }
        );

        const result = res.data;
        const matchedKids = (result.matches || []).filter(m => m.matched);
        const extra = isVideo ? ` frames_sampled=${result.frames_sampled}` : '';
        console.log(`[bot] matched=${result.matched}, faces=${result.faces_detected}${extra}, kids=${matchedKids.map(m => m.kid_name || m.kid_id).join(', ') || 'none'}`);

        if (result.matched) {
          const names = matchedKids.map(m => m.kid_name || 'your kid').join(' & ');
          const bestConf = Math.max(...matchedKids.map(m => m.confidence));
          const verb = matchedKids.length > 1 ? 'are' : 'is';
          const medium = isVideo ? 'video' : 'photo';
          // Forward original message (preserves group name, sender, and media)
          await sock.sendMessage(forwardToId, { forward: msg });
          // Follow-up text with match details
          await sock.sendMessage(forwardToId, {
            text: `${names} ${verb} in this ${medium}! (${(bestConf * 100).toFixed(0)}% confidence) — from "${groupName}"`,
          });
          console.log(`[bot] Forwarded to ${forwardToId}`);
        }
      } catch (e) {
        console.error('[bot] Analysis/forward failed:', e.message);
      }
    }
  });
}

async function refreshGroupsAndChats() {
  try {
    const chats = await sock.groupFetchAllParticipating();
    allGroups = Object.values(chats).map(g => ({ id: g.id, name: g.subject }));

    // Also get DM chats from store isn't available without a store,
    // so expose groups as both monitor options and forward options
    // plus build DM list from known contacts
    allChats = allGroups.map(g => ({ ...g, isGroup: true }));
    console.log(`[bot] Loaded ${allGroups.length} groups`);
  } catch (e) {
    console.error('[bot] Failed to load chats:', e.message);
  }
}

// --- Express API ---
const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/status', (req, res) => {
  res.json({ connected: isConnected, phone: phoneInfo });
});

app.get('/qr', async (req, res) => {
  if (!currentQR) return res.json({ qr: null });
  try {
    const dataUrl = await QRCode.toDataURL(currentQR);
    res.json({ qr: dataUrl });
  } catch (e) {
    res.json({ qr: null, error: e.message });
  }
});

app.post('/send-text', express.json(), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { to, text } = req.body;
  if (!text || !to) return res.status(400).json({ error: 'Missing to or text' });
  try {
    await sock.sendMessage(to, { text });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/history-text', (req, res) => {
  const { groupId, since = '0' } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const sinceTs = parseInt(since);
  const arr = textHistory.get(groupId) || [];
  const filtered = sinceTs > 0 ? arr.filter(m => m.timestamp >= sinceTs) : arr;
  res.json({ messages: filtered });
});

app.post('/send', express.json({ limit: '20mb' }), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { to, caption, image_b64 } = req.body;
  if (!image_b64 || !to) return res.status(400).json({ error: 'Missing to or image_b64' });
  try {
    const buffer = Buffer.from(image_b64, 'base64');
    await sock.sendMessage(to, { image: buffer, caption: caption || '' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/send-video', express.json({ limit: '200mb' }), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { to, caption, video_b64 } = req.body;
  if (!video_b64 || !to) return res.status(400).json({ error: 'Missing to or video_b64' });
  try {
    const buffer = Buffer.from(video_b64, 'base64');
    await sock.sendMessage(to, { video: buffer, caption: caption || '' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/groups', async (req, res) => {
  if (isConnected && (allGroups.length === 0 || req.query.refresh)) await refreshGroupsAndChats();
  res.json({ groups: allGroups });
});

app.get('/chats', async (req, res) => {
  if (isConnected && (allChats.length === 0 || req.query.refresh)) await refreshGroupsAndChats();
  res.json({ chats: allChats });
});

app.post('/fetch-history', express.json(), async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const { groupId } = req.body;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });

  const cursor = groupCursors.get(groupId);
  if (!cursor) {
    // No messages known for this group yet — request from beginning
    return res.status(404).json({ error: 'No messages seen for this group yet. Make sure the bot is connected and the group is monitored.' });
  }

  try {
    await sock.fetchMessageHistory(200, cursor.key, cursor.timestampMs);
    console.log(`[bot] Requested history for ${groupId} before ${new Date(cursor.timestampMs).toISOString()}`);
    res.json({ ok: true, oldest_known: new Date(cursor.timestampMs).toISOString() });
  } catch (e) {
    console.error('[bot] fetchMessageHistory error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/history-images', (req, res) => {
  const { groupId, since = '0' } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const sinceTs = parseInt(since); // 0 = all history
  const byJid = imageHistory.get(groupId);
  if (!byJid) return res.json({ images: [], note: 'No history yet — messages are stored as they arrive after bot starts' });
  const images = [];
  for (const [id, msg] of byJid) {
    const ts = (msg.messageTimestamp || 0) * 1000;
    if (sinceTs > 0 && ts < sinceTs) continue;
    images.push({
      id,
      timestamp: ts,
      sender: getSender(msg),
    });
  }
  images.sort((a, b) => a.timestamp - b.timestamp);
  res.json({ images });
});

app.get('/download-image/:msgId', async (req, res) => {
  const { groupId } = req.query;
  const { msgId } = req.params;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const byJid = imageHistory.get(groupId);
  const msg = byJid?.get(msgId);
  if (!msg) return res.status(404).json({ error: 'Message not found in history' });
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    res.json({ image_b64: buffer.toString('base64') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/history-videos', (req, res) => {
  const { groupId, since = '0' } = req.query;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const sinceTs = parseInt(since);
  const byJid = videoHistory.get(groupId);
  if (!byJid) return res.json({ videos: [] });
  const videos = [];
  for (const [id, msg] of byJid) {
    const ts = (msg.messageTimestamp || 0) * 1000;
    if (sinceTs > 0 && ts < sinceTs) continue;
    videos.push({ id, timestamp: ts, sender: getSender(msg) });
  }
  videos.sort((a, b) => a.timestamp - b.timestamp);
  res.json({ videos });
});

app.get('/download-video/:msgId', async (req, res) => {
  const { groupId } = req.query;
  const { msgId } = req.params;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const byJid = videoHistory.get(groupId);
  const msg = byJid?.get(msgId);
  if (!msg) return res.status(404).json({ error: 'Message not found in history' });
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    res.json({ video_b64: buffer.toString('base64') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(BOT_PORT, () => {
  console.log(`[bot] API listening on http://localhost:${BOT_PORT}`);
});

// --- Start ---
console.log('[bot] Starting Parent Tool bot (Baileys)...');
connect().catch(err => console.error('[bot] Fatal:', err));
