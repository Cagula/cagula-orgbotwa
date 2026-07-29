const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const http = require('http');
const { PostgresAuthState } = require('./auth-pg');

// ===================== HTTP SERVER (for Render) =====================
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Cagula-orgBOTwa is running! ✅\nScan QR in logs to connect WhatsApp.');
}).listen(PORT, () => {
    console.log(`🌐 HTTP server running on port ${PORT}`);
});

// ===================== KEEP-ALIVE (Render Free Tier) =====================
if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
        http.get(process.env.RENDER_EXTERNAL_URL, (res) => {
            console.log(`[KEEP-ALIVE] Ping OK — ${res.statusCode}`);
        }).on('error', (e) => {
            console.log(`[KEEP-ALIVE] Ping error: ${e.message}`);
        });
    }, 10 * 60 * 1000); // la fiecare 10 minute
    console.log('⏰ Keep-alive activat (previne spin-down pe Render Free)');
}

// ===================== AUTO-UPDATE =====================
function autoUpdate() {
    try {
        console.log('🔄 Verificare actualizari...');
        execSync('npm update baileys @hapi/boom pino pino-pretty qrcode pg', { stdio: 'inherit' });
        console.log('✅ Dependinte actualizate!');
    } catch (e) {
        console.log('⚠️ Nu s-au putut actualiza dependintele:', e.message);
    }
}

// ===================== CONFIG =====================
const OWNER_NUMBERS = [
    '40786112559@s.whatsapp.net',
];
const VALID_INTERVALS = [1, 5, 60, 120, 240, 360];
const TEXT_FILE = process.env.TEXT_FILE || './text.txt';
const STICKER_FILE = process.env.STICKER_FILE || './spam.txt';
const STICKERS_DIR = './stickers';
const PHOTOS_DIR = './photos';

// ===================== LOGGER =====================
const pino = require('pino');
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined
});

// ===================== STATE =====================
const activeSpams = new Map();
let spamTexts = [];
let spamStickers = [];
let spamPhotos = [];
let chatStickers = new Map();
let chatPhotos = new Map();
let sock = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 999999;
let qrGenerated = false;
let isShuttingDown = false;
let CONNECTED_USER_ID = null;

// ===================== UTILS =====================
function ask(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(r => rl.question(q, a => { rl.close(); r(a); }));
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}z ${h % 24}h ${m % 60}m`;
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

function parseMentions(args) {
    const mentions = [];
    const cleanArgs = [];
    for (const arg of args) {
        if (arg.startsWith('@')) {
            const number = arg.slice(1).replace(/\D/g, '');
            if (number) mentions.push(number + '@s.whatsapp.net');
        } else {
            cleanArgs.push(arg);
        }
    }
    return { mentions, cleanArgs };
}

function formatMentions(mentions) {
    if (!mentions || mentions.length === 0) return '';
    return mentions.map(m => {
        const num = m.split('@')[0];
        return '@' + num;
    }).join(' ');
}

function loadTexts(fp) {
    try {
        if (!fs.existsSync(fp)) { logger.error(`❌ text.txt negasit: ${fp}`); return []; }
        const lines = fs.readFileSync(fp, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
        logger.info(`📝 ${lines.length} texte din ${fp}`);
        return lines;
    } catch (e) { logger.error('Eroare texte:', e.message); return []; }
}

function loadStickers(fp) {
    try {
        if (!fs.existsSync(fp)) { logger.error(`❌ spam.txt negasit: ${fp}`); return []; }
        const lines = fs.readFileSync(fp, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
        const valid = [];
        for (const line of lines) {
            const full = path.resolve(line);
            if (fs.existsSync(full)) valid.push(full);
            else logger.warn(`⚠️ Sticker negasit: ${line}`);
        }
        logger.info(`🎨 ${valid.length} stickere din ${fp}`);
        return valid;
    } catch (e) { logger.error('Eroare stickere:', e.message); return []; }
}

function loadPhotos(fp) {
    try {
        if (!fs.existsSync(fp)) { logger.error(`❌ photos.txt negasit: ${fp}`); return []; }
        const lines = fs.readFileSync(fp, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
        const valid = [];
        for (const line of lines) {
            const full = path.resolve(line);
            if (fs.existsSync(full)) valid.push(full);
            else logger.warn(`⚠️ Foto negasita: ${line}`);
        }
        logger.info(`📷 ${valid.length} poze din ${fp}`);
        return valid;
    } catch (e) { logger.error('Eroare poze:', e.message); return []; }
}

function getRandom(arr) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }
function getKey(jid, type) { return `${jid}:${type}`; }

function isOwner(sender, fromMe) {
    if (fromMe === true) return true;
    const normalized = sender.split(':')[0];
    const checks = [
        sender,
        normalized + '@s.whatsapp.net',
        normalized + '@lid',
        normalized,
    ];
    for (const check of checks) {
        if (OWNER_NUMBERS.includes(check)) return true;
    }
    return false;
}

// ===================== STICKER SAVE =====================
async function saveSticker(msg, jid, sender) {
    try {
        if (!msg.message) return false;
        const stickerMsg = msg.message?.stickerMessage;
        if (!stickerMsg) return false;
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        if (!buffer) {
            console.log('[STICKER] Nu s-a putut descarca stickerul');
            return false;
        }
        if (!fs.existsSync(STICKERS_DIR)) fs.mkdirSync(STICKERS_DIR, { recursive: true });
        const filename = `sticker_${Date.now()}_${Math.floor(Math.random()*10000)}.webp`;
        const filepath = path.join(STICKERS_DIR, filename);
        fs.writeFileSync(filepath, buffer);
        if (!chatStickers.has(jid)) chatStickers.set(jid, []);
        chatStickers.get(jid).push(filepath);
        console.log(`[STICKER] Salvat: ${filename} in ${jid}`);
        return true;
    } catch (e) { 
        console.error('[STICKER] Eroare salvare:', e.message); 
        return false; 
    }
}

// ===================== PHOTO SAVE =====================
async function savePhoto(msg, jid, sender) {
    try {
        if (!msg.message) return false;
        const imgMsg = msg.message?.imageMessage;
        if (!imgMsg) return false;
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        if (!buffer) {
            console.log('[PHOTO] Nu s-a putut descarca poza');
            return false;
        }
        if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
        const filename = `photo_${Date.now()}_${Math.floor(Math.random()*10000)}.jpg`;
        const filepath = path.join(PHOTOS_DIR, filename);
        fs.writeFileSync(filepath, buffer);
        if (!chatPhotos.has(jid)) chatPhotos.set(jid, []);
        chatPhotos.get(jid).push(filepath);
        console.log(`[PHOTO] Salvata: ${filename} in ${jid}`);
        return true;
    } catch (e) { 
        console.error('[PHOTO] Eroare salvare:', e.message); 
        return false; 
    }
}

// ===================== VIEW-VIEW (VV) =====================
async function vvReply(msg, jid, sender) {
    try {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg) return false;
        const imgMsg = quotedMsg?.imageMessage;
        if (!imgMsg) return false;
        const quotedKey = msg.message.extendedTextMessage.contextInfo.stanzaId;
        const quotedParticipant = msg.message.extendedTextMessage.contextInfo.participant;
        const fakeMsg = {
            key: {
                remoteJid: jid,
                fromMe: false,
                id: quotedKey,
                participant: quotedParticipant
            },
            message: quotedMsg
        };
        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {});
        if (!buffer) return false;
        const caption = imgMsg.caption || '';
        await sock.sendMessage(jid, { 
            image: buffer, 
            caption: caption ? `[VV] ${caption}` : '📷 [VV] Poza retrimisa'
        });
        console.log(`[VV] Poza retrimisa in ${jid}`);
        return true;
    } catch (e) { 
        console.error('[VV] Eroare:', e.message); 
        return false; 
    }
}

// ===================== SPAM ENGINE =====================
async function sendItem(jid, type, mentions = []) {
    try {
        if (type === 'text') {
            const t = getRandom(spamTexts);
            if (!t) return false;
            const mentionText = mentions.length > 0 ? formatMentions(mentions) + '\n' + t : t;
            await sock.sendMessage(jid, { text: mentionText, mentions: mentions.length > 0 ? mentions : undefined });
        } else if (type === 'sticker') {
            const chatStks = chatStickers.get(jid) || [];
            const allStickers = [...chatStks, ...spamStickers];
            const sp = getRandom(allStickers);
            if (!sp) return false;
            const buffer = fs.readFileSync(sp);
            await sock.sendMessage(jid, { sticker: buffer });
        } else if (type === 'photo') {
            const chatPhts = chatPhotos.get(jid) || [];
            const allPhotos = [...chatPhts, ...spamPhotos];
            const ph = getRandom(allPhotos);
            if (!ph) return false;
            const buffer = fs.readFileSync(ph);
            await sock.sendMessage(jid, { image: buffer });
        }
        return true;
    } catch (e) { logger.error(`Eroare ${type}:`, e.message); return false; }
}

function startSpam(jid, type, sec, mentions = []) {
    const key = getKey(jid, type);
    if (activeSpams.has(key)) clearInterval(activeSpams.get(key).intervalId);
    const ms = sec * 1000;
    sendItem(jid, type, mentions);
    const id = setInterval(() => { sendItem(jid, type, mentions); const s = activeSpams.get(key); if (s) s.nextSend = Date.now() + ms; }, ms);
    activeSpams.set(key, { type, intervalId: id, intervalSec: sec, startTime: Date.now(), nextSend: Date.now() + ms, mentions });
    logger.info(`▶️ ${type.toUpperCase()} spam in ${jid} la ${sec}sec`);
}

function stopSpam(jid, type) {
    const key = getKey(jid, type);
    const s = activeSpams.get(key);
    if (s) { clearInterval(s.intervalId); activeSpams.delete(key); return true; }
    return false;
}

function stopAll(jid) { let c = 0; for (const t of ['text', 'sticker', 'photo']) if (stopSpam(jid, t)) c++; return c; }
function stopAllGlobal() { for (const s of activeSpams.values()) clearInterval(s.intervalId); activeSpams.clear(); }

// ===================== COMMANDS =====================
const cmds = {
    start: {
        h: 'Porneste spam TEXT (ex: /start 5 @user @user2)',
        run: async (jid, a) => {
            const { mentions, cleanArgs } = parseMentions(a);
            const sec = parseInt(cleanArgs[0]);
            if (!VALID_INTERVALS.includes(sec)) return;
            if (!spamTexts.length) return;
            startSpam(jid, 'text', sec, mentions);
        }
    },
    spamsticker: {
        h: 'Porneste spam STICKERE',
        run: async (jid, a, msg) => {
            const { mentions, cleanArgs } = parseMentions(a);
            const sec = parseInt(cleanArgs[0]);
            if (!VALID_INTERVALS.includes(sec)) return;
            const quotedMsg = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quotedMsg?.stickerMessage) {
                const fakeMsg = {
                    key: {
                        remoteJid: jid,
                        fromMe: false,
                        id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                        participant: msg.message.extendedTextMessage.contextInfo.participant
                    },
                    message: quotedMsg
                };
                await saveSticker(fakeMsg, jid, msg.message.extendedTextMessage.contextInfo.participant || jid);
            }
            const chatStks = chatStickers.get(jid) || [];
            if (!chatStks.length) return;
            startSpam(jid, 'sticker', sec, mentions);
        }
    },
    spamphoto: {
        h: 'Porneste spam POZE',
        run: async (jid, a, msg) => {
            const { mentions, cleanArgs } = parseMentions(a);
            const sec = parseInt(cleanArgs[0]);
            if (!VALID_INTERVALS.includes(sec)) return;
            const quotedMsg = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quotedMsg?.imageMessage) {
                const fakeMsg = {
                    key: {
                        remoteJid: jid,
                        fromMe: false,
                        id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                        participant: msg.message.extendedTextMessage.contextInfo.participant
                    },
                    message: quotedMsg
                };
                await savePhoto(fakeMsg, jid, msg.message.extendedTextMessage.contextInfo.participant || jid);
            }
            const chatPhts = chatPhotos.get(jid) || [];
            if (!chatPhts.length) return;
            startSpam(jid, 'photo', sec, mentions);
        }
    },
    stop: { h: 'Opreste tot spam-ul', run: async (jid, a) => { stopAll(jid); } },
    stoptext: { h: 'Opreste spam text', run: async (jid, a) => { stopSpam(jid, 'text'); } },
    stopsticker: { h: 'Opreste spam stickere', run: async (jid, a) => { stopSpam(jid, 'sticker'); } },
    stopphoto: { h: 'Opreste spam poze', run: async (jid, a) => { stopSpam(jid, 'photo'); } },
    help: { h: 'Lista comenzi', run: async (jid, a) => { 
        let t = '*🤖 Cagula-orgBOTwa* v4.0\n\n'; 
        for (const [k, v] of Object.entries(cmds)) t += `*/${k}* — ${v.h}\n`; 
        t += '\n💡 Trimite un sticker in chat si apoi /spamsticker pentru a-l folosi!\n💡 Privat & grupuri'; 
        await sock.sendMessage(jid, { text: t }); 
    } },
    status: { h: 'Status spam', run: async (jid, a) => { 
        const ts = activeSpams.get(getKey(jid, 'text')), ss = activeSpams.get(getKey(jid, 'sticker')), ps = activeSpams.get(getKey(jid, 'photo')); 
        const chatStks = chatStickers.get(jid) || []; 
        const chatPhts = chatPhotos.get(jid) || []; 
        let t = '*Status*\n\n'; 
        t += ts ? `📝 TEXT: ${ts.intervalSec}sec | ⏳ ${formatTime(Date.now() - ts.startTime)}${ts.mentions && ts.mentions.length > 0 ? ' | 👥 ' + formatMentions(ts.mentions) : ''}\n` : `📝 TEXT: oprit\n`; 
        t += ss ? `🎨 STICKER: ${ss.intervalSec}sec | ⏳ ${formatTime(Date.now() - ss.startTime)}${ss.mentions && ss.mentions.length > 0 ? ' | 👥 ' + formatMentions(ss.mentions) : ''}\n` : `🎨 STICKER: oprit\n`; 
        t += ps ? `📷 PHOTO: ${ps.intervalSec}sec | ⏳ ${formatTime(Date.now() - ps.startTime)}${ps.mentions && ps.mentions.length > 0 ? ' | 👥 ' + formatMentions(ps.mentions) : ''}\n` : `📷 PHOTO: oprit\n`; 
        t += `\n📝 ${spamTexts.length} texte\n🎨 ${chatStks.length} stickere in acest chat\n📷 ${chatPhts.length} poze in acest chat`; 
        await sock.sendMessage(jid, { text: t }); 
    } },
    info: { h: 'Info bot', run: async (jid, a) => { 
        const c = new Set([...activeSpams.keys()].map(k => k.split(':')[0])).size; 
        const totalSavedStickers = [...chatStickers.values()].reduce((a, b) => a + b.length, 0); 
        const totalSavedPhotos = [...chatPhotos.values()].reduce((a, b) => a + b.length, 0); 
        await sock.sendMessage(jid, { text: `*🤖 Cagula-orgBOTwa* v4.0\n📅 ${new Date().toLocaleString('ro-RO')}\n💬 Chats: ${c}\n📝 ${spamTexts.length} texte\n🎨 ${totalSavedStickers} stickere salvate total\n📷 ${totalSavedPhotos} poze salvate total\n⏱️ Uptime: ${formatTime(process.uptime() * 1000)}` }); 
    } },
    tag: { h: 'Trimite toate textele', run: async (jid, a) => { 
        const { mentions } = parseMentions(a);
        if (!spamTexts.length) return; 
        for (const t of spamTexts) { 
            const mentionText = mentions.length > 0 ? formatMentions(mentions) + '\n' + t : t;
            await sock.sendMessage(jid, { text: mentionText, mentions: mentions.length > 0 ? mentions : undefined }); 
            await delay(400); 
        } 
    } },
    spam: { h: 'Trimite toate stickerele salvate', run: async (jid, a) => { 
        const chatStks = chatStickers.get(jid) || []; 
        const all = [...chatStks, ...spamStickers]; 
        if (!all.length) return; 
        for (const s of all) { 
            await sock.sendMessage(jid, { sticker: fs.readFileSync(s) }); 
            await delay(600); 
        } 
    } },
    photo: { h: 'Trimite toate pozele salvate', run: async (jid, a) => { 
        const chatPhts = chatPhotos.get(jid) || []; 
        const all = [...chatPhts, ...spamPhotos]; 
        if (!all.length) return; 
        for (const p of all) { 
            await sock.sendMessage(jid, { image: fs.readFileSync(p) }); 
            await delay(600); 
        } 
    } },
    clearstickers: {
        h: 'Sterge stickerele salvate din acest chat',
        run: async (jid, a) => {
            const chatStks = chatStickers.get(jid) || [];
            for (const s of chatStks) { try { fs.unlinkSync(s); } catch(e) {} }
            chatStickers.delete(jid);
        }
    },
    clearphotos: {
        h: 'Sterge pozele salvate din acest chat',
        run: async (jid, a) => {
            const chatPhts = chatPhotos.get(jid) || [];
            for (const p of chatPhts) { try { fs.unlinkSync(p); } catch(e) {} }
            chatPhotos.delete(jid);
        }
    },
    update: {
        h: 'Actualizeaza manual dependintele',
        run: async (jid, a) => {
            autoUpdate();
        }
    }
};

cmds['.vv'] = { h: 'Versiune & status complet', run: async (jid, a) => { 
    const chatStks = chatStickers.get(jid) || [];
    const chatPhts = chatPhotos.get(jid) || [];
    const totalSavedStickers = [...chatStickers.values()].reduce((a, b) => a + b.length, 0);
    const totalSavedPhotos = [...chatPhotos.values()].reduce((a, b) => a + b.length, 0);
    const c = new Set([...activeSpams.keys()].map(k => k.split(':')[0])).size;
    const ts = activeSpams.get(getKey(jid, 'text')), ss = activeSpams.get(getKey(jid, 'sticker')), ps = activeSpams.get(getKey(jid, 'photo'));
    let t = `*🤖 Cagula-orgBOTwa* v4.0\n`;
    t += `⏱️ Uptime: ${formatTime(process.uptime() * 1000)}\n`;
    t += `📦 Node: ${process.version}\n`;
    t += `💬 Chats active: ${c}\n\n`;
    t += `*📁 In acest chat:*\n`;
    t += `📝 ${spamTexts.length} texte\n`;
    t += `🎨 ${chatStks.length} stickere\n`;
    t += `📷 ${chatPhts.length} poze\n\n`;
    t += `*📁 Total salvate:*\n`;
    t += `🎨 ${totalSavedStickers} stickere\n`;
    t += `📷 ${totalSavedPhotos} poze\n\n`;
    t += `*▶️ Spam activ:*\n`;
    t += ts ? `📝 TEXT: ${ts.intervalSec}sec | ⏳ ${formatTime(Date.now() - ts.startTime)}${ts.mentions && ts.mentions.length > 0 ? '\n👥 Tag: ' + formatMentions(ts.mentions) : ''}\n` : `📝 TEXT: oprit\n`;
    t += ss ? `🎨 STICKER: ${ss.intervalSec}sec | ⏳ ${formatTime(Date.now() - ss.startTime)}${ss.mentions && ss.mentions.length > 0 ? '\n👥 Tag: ' + formatMentions(ss.mentions) : ''}\n` : `🎨 STICKER: oprit\n`;
    t += ps ? `📷 PHOTO: ${ps.intervalSec}sec | ⏳ ${formatTime(Date.now() - ps.startTime)}${ps.mentions && ps.mentions.length > 0 ? '\n👥 Tag: ' + formatMentions(ps.mentions) : ''}\n` : `📷 PHOTO: oprit\n`;
    t += `\n🔄 Auto-update activat`;
    await sock.sendMessage(jid, { text: t }); 
} };

// ===================== MESSAGE HANDLER =====================
async function handleMsg(msg) {
    try {
        if (!msg.message) return;
        const jid = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        console.log(`[DEBUG] Chat: ${isGroup ? 'GRUP' : 'PRIVAT'} | Sender: ${sender} | JID: ${jid}`);
        const fromMe = msg.key.fromMe === true;
        const ownerCheck = isOwner(sender, fromMe);
        console.log(`[DEBUG] fromMe = ${fromMe} | sender = ${sender}`);
        console.log(`[DEBUG] isOwner = ${ownerCheck}`);
        if (!ownerCheck) {
            console.log(`[DEBUG] NOT OWNER - ignoring`);
            return;
        }
        console.log(`[DEBUG] IS OWNER! Processing...`);
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
        const t = text.trim();
        if (t === '.vv') {
            await vvReply(msg, jid, sender);
            return;
        }
        if (!t.startsWith('/')) return;
        const parts = t.slice(1).split(/\s+/);
        const name = parts[0].toLowerCase();
        const args = parts.slice(1);
        if (t.startsWith('.vv')) { await cmds['.vv'].run(jid, args); return; }
        const cmd = cmds[name];
        if (cmd) { logger.info(`[CMD] /${name}`); await cmd.run(jid, args, msg); }
    } catch (e) { logger.error('Eroare msg:', e.message); }
}

// ===================== STARTUP =====================
async function startup() {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║     🤖 Baileys WhatsApp Cagula-orgBOTwa      ║');
    console.log('║           v4.0 - Auto-Update         ║');
    console.log('╚══════════════════════════════════════╝\n');
    autoUpdate();
    spamTexts = loadTexts(TEXT_FILE);
    spamStickers = [];
    spamPhotos = [];
    console.log('\n🚀 Conectare...');
    console.log('📱 Se va genera un QR Code salvat ca imagine (qr.png)');
    console.log('   Descarca qr.png si scaneaza-l cu WhatsApp!\n');
    await connectBot();
}

// ===================== BAILEYS =====================
async function connectBot() {
    try {
        let authState;
        if (process.env.DATABASE_URL) {
            console.log('🔐 Folosesc PostgreSQL pentru sesiune persistenta...');
            const pgAuth = new PostgresAuthState(process.env.DATABASE_URL);
            authState = await pgAuth.getState();
            console.log('✅ Sesiune incarcata din PostgreSQL');
        } else {
            console.log('⚠️  DATABASE_URL negasit — folosesc auth local (se va pierde la restart!)');
            authState = await useMultiFileAuthState('./auth_info');
        }

        const { state, saveCreds } = authState;
        const { version } = await fetchLatestBaileysVersion();
        logger.info(`Baileys v${version.join('.')}`);
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Cagula-orgBOTwa', 'Chrome', '1.0.0'],
            defaultQueryTimeoutMs: undefined,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            syncFullHistory: false
        });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr && !qrGenerated) {
                qrGenerated = true;
                try {
                    await QRCode.toFile('./qr.png', qr, { width: 500, margin: 2 });
                    console.log('\n📱 QR CODE SALVAT!');
                    console.log('   Fisier: qr.png');
                    console.log('\n╔══════════════════════════════════════╗');
                    console.log('║     📱 SCANEAZA QR-UL DE MAI JOS     ║');
                    console.log('╚══════════════════════════════════════╝\n');
                    const asciiQR = await QRCode.toString(qr, { type: 'terminal', small: true });
                    console.log(asciiQR);
                    console.log('\n📲 WhatsApp → Setari → Dispozitive → Conecteaza\n');
                } catch (e) {
                    console.error('Eroare salvare QR:', e.message);
                }
            }
            if (connection === 'close') {
                const sc = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : null;
                const reconnect = sc !== DisconnectReason.loggedOut;
                logger.warn(`Conexiune inchisa. Status: ${sc}`);
                if (reconnect && !isShuttingDown) {
                    reconnectAttempts++;
                    const d = Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 10)), 60000);
                    logger.info(`Reconectare in ${d / 1000}s... (incercarea ${reconnectAttempts})`);
                    setTimeout(() => connectBot(), d);
                } else {
                    logger.error('Logged out sau oprire manuala. Se reincearca in 60s...');
                    setTimeout(() => connectBot(), 60000);
                }
            } else if (connection === 'open') {
                reconnectAttempts = 0;
                qrGenerated = false;
                if (sock && sock.user && sock.user.id) {
                    CONNECTED_USER_ID = sock.user.id;
                    console.log(`[DEBUG] Connected user ID: ${CONNECTED_USER_ID}`);
                }
                console.log('\n✅ BOT ONLINE!');
                console.log('💬 /start [sec]  /spamsticker [sec]  /spamphoto [sec]  /stop  /status  /help  /tag  /spam  /photo  .vv');
                console.log('🎨 Reply la un sticker cu /spamsticker pentru a-l folosi!');
                console.log('📷 Reply la o poza cu /spamphoto pentru a o folosi!');
                console.log('🔄 Auto-update la pornire activat');
                console.log(`📝 ${spamTexts.length} texte\n`);
            }
        });
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) await handleMsg(msg);
        });
        sock.ev.on('error', (e) => logger.error('Socket:', e.message));
    } catch (e) {
        logger.error('Eroare start:', e.message);
        setTimeout(() => connectBot(), 10000);
    }
}

// ===================== SHUTDOWN =====================
process.on('SIGINT', async () => { 
    isShuttingDown = true;
    console.log('\n🛑 Oprire...'); 
    stopAllGlobal(); 
    if (sock) await sock.logout(); 
    process.exit(0); 
});
process.on('SIGTERM', async () => { 
    isShuttingDown = true;
    console.log('\n🛑 Oprire...'); 
    stopAllGlobal(); 
    if (sock) await sock.logout(); 
    process.exit(0); 
});

// ===================== CRASH PROTECTION =====================
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
    console.log('🔄 Se reincearca in 10s...');
    setTimeout(() => connectBot(), 10000);
});
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err.message || err);
    console.log('🔄 Se reincearca in 10s...');
    setTimeout(() => connectBot(), 10000);
});

// ===================== RUN =====================
startup();
