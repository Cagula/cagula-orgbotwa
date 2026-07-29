const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const qrcode_terminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// ===================== CONFIG =====================
const OWNER_NUMBERS = ['40786112559@s.whatsapp.net'];
const VALID_INTERVALS = [1, 5, 60, 120, 240, 360];
const TEXT_FILE = './text.txt';
const STICKERS_DIR = './stickers';
const PHOTOS_DIR = './photos';

// ===================== STATE =====================
const activeSpams = new Map();
let spamTexts = [];
let chatStickers = new Map();
let chatPhotos = new Map();
let sock = null;
let reconnectAttempts = 0;
let qrGenerated = false;
let isShuttingDown = false;

// ===================== UTILS =====================
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}z ${h%24}h ${m%60}m`;
    if (h > 0) return `${h}h ${m%60}m ${s%60}s`;
    if (m > 0) return `${m}m ${s%60}s`;
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
    return mentions.map(m => '@' + m.split('@')[0]).join(' ');
}

function loadTexts(fp) {
    try {
        if (!fs.existsSync(fp)) return [];
        return fs.readFileSync(fp, 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
    } catch (e) { return []; }
}

function getRandom(arr) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }
function getKey(jid, type) { return `${jid}:${type}`; }

function isOwner(sender, fromMe) {
    if (fromMe === true) return true;
    const normalized = sender.split(':')[0];
    const checks = [sender, normalized + '@s.whatsapp.net', normalized + '@lid', normalized];
    for (const check of checks) {
        if (OWNER_NUMBERS.includes(check)) return true;
    }
    return false;
}

// ===================== SAVE MEDIA =====================
async function saveSticker(msg, jid) {
    try {
        const stickerMsg = msg.message?.stickerMessage;
        if (!stickerMsg) return false;
        // Baileys v5 uses downloadContentFromMessage
        const stream = await downloadContentFromMessage(msg.message.stickerMessage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        if (!buffer.length) return false;
        if (!fs.existsSync(STICKERS_DIR)) fs.mkdirSync(STICKERS_DIR, { recursive: true });
        const filename = `sticker_${Date.now()}_${Math.floor(Math.random()*10000)}.webp`;
        const filepath = path.join(STICKERS_DIR, filename);
        fs.writeFileSync(filepath, buffer);
        if (!chatStickers.has(jid)) chatStickers.set(jid, []);
        chatStickers.get(jid).push(filepath);
        console.log(`[STICKER] Salvat: ${filename}`);
        return true;
    } catch (e) { console.error('[STICKER] Eroare:', e.message); return false; }
}

async function savePhoto(msg, jid) {
    try {
        const imgMsg = msg.message?.imageMessage;
        if (!imgMsg) return false;
        const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        if (!buffer.length) return false;
        if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
        const filename = `photo_${Date.now()}_${Math.floor(Math.random()*10000)}.jpg`;
        const filepath = path.join(PHOTOS_DIR, filename);
        fs.writeFileSync(filepath, buffer);
        if (!chatPhotos.has(jid)) chatPhotos.set(jid, []);
        chatPhotos.get(jid).push(filepath);
        console.log(`[PHOTO] Salvata: ${filename}`);
        return true;
    } catch (e) { console.error('[PHOTO] Eroare:', e.message); return false; }
}

// ===================== VV =====================
async function vvReply(msg, jid) {
    try {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quotedMsg?.imageMessage) return false;
        const stream = await downloadContentFromMessage(quotedMsg.imageMessage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        if (!buffer.length) return false;
        const caption = quotedMsg.imageMessage.caption || '';
        await sock.sendMessage(jid, { image: buffer, caption: caption ? `[VV] ${caption}` : '📷 [VV] Poza retrimisa' });
        console.log(`[VV] Poza retrimisa in ${jid}`);
        return true;
    } catch (e) { console.error('[VV] Eroare:', e.message); return false; }
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
            const sp = getRandom(chatStks);
            if (!sp) return false;
            const buffer = fs.readFileSync(sp);
            await sock.sendMessage(jid, { sticker: buffer });
        } else if (type === 'photo') {
            const chatPhts = chatPhotos.get(jid) || [];
            const ph = getRandom(chatPhts);
            if (!ph) return false;
            const buffer = fs.readFileSync(ph);
            await sock.sendMessage(jid, { image: buffer });
        }
        return true;
    } catch (e) { console.error(`Eroare ${type}:`, e.message); return false; }
}

function startSpam(jid, type, sec, mentions = []) {
    const key = getKey(jid, type);
    if (activeSpams.has(key)) clearInterval(activeSpams.get(key).intervalId);
    const ms = sec * 1000;
    sendItem(jid, type, mentions);
    const id = setInterval(() => sendItem(jid, type, mentions), ms);
    activeSpams.set(key, { type, intervalId: id, intervalSec: sec, startTime: Date.now(), mentions });
    console.log(`▶️ ${type.toUpperCase()} spam in ${jid} la ${sec}sec`);
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
        h: 'Porneste spam TEXT (ex: /start 5 @user)',
        run: async (jid, a) => {
            const { mentions, cleanArgs } = parseMentions(a);
            const sec = parseInt(cleanArgs[0]);
            if (!VALID_INTERVALS.includes(sec)) { await sock.sendMessage(jid, { text: `⚠️ Foloseste: ${VALID_INTERVALS.join(', ')} sec` }); return; }
            if (!spamTexts.length) { await sock.sendMessage(jid, { text: '❌ text.txt gol!' }); return; }
            startSpam(jid, 'text', sec, mentions);
            const mentionInfo = mentions.length > 0 ? `\n👥 Tag: ${formatMentions(mentions)}` : '';
            await sock.sendMessage(jid, { text: `▶️ TEXT spam ${sec}sec | 📝 ${spamTexts.length}${mentionInfo}` });
        }
    },
    spamsticker: {
        h: 'Reply la sticker + /spamsticker 5 @user',
        run: async (jid, a, msg) => {
            const { mentions, cleanArgs } = parseMentions(a);
            const sec = parseInt(cleanArgs[0]);
            if (!VALID_INTERVALS.includes(sec)) { await sock.sendMessage(jid, { text: `⚠️ Foloseste: ${VALID_INTERVALS.join(', ')} sec` }); return; }
            const quotedMsg = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quotedMsg?.stickerMessage) {
                const fakeMsg = { message: { stickerMessage: quotedMsg.stickerMessage } };
                await saveSticker(fakeMsg, jid);
            }
            const chatStks = chatStickers.get(jid) || [];
            if (!chatStks.length) { await sock.sendMessage(jid, { text: '❌ Da reply la un sticker mai intai!' }); return; }
            startSpam(jid, 'sticker', sec, mentions);
            const mentionInfo = mentions.length > 0 ? `\n👥 Tag: ${formatMentions(mentions)}` : '';
            await sock.sendMessage(jid, { text: `▶️ STICKER spam ${sec}sec | 🎨 ${chatStks.length}${mentionInfo}` });
        }
    },
    spamphoto: {
        h: 'Reply la poza + /spamphoto 5 @user',
        run: async (jid, a, msg) => {
            const { mentions, cleanArgs } = parseMentions(a);
            const sec = parseInt(cleanArgs[0]);
            if (!VALID_INTERVALS.includes(sec)) { await sock.sendMessage(jid, { text: `⚠️ Foloseste: ${VALID_INTERVALS.join(', ')} sec` }); return; }
            const quotedMsg = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quotedMsg?.imageMessage) {
                const fakeMsg = { message: { imageMessage: quotedMsg.imageMessage } };
                await savePhoto(fakeMsg, jid);
            }
            const chatPhts = chatPhotos.get(jid) || [];
            if (!chatPhts.length) { await sock.sendMessage(jid, { text: '❌ Da reply la o poza mai intai!' }); return; }
            startSpam(jid, 'photo', sec, mentions);
            const mentionInfo = mentions.length > 0 ? `\n👥 Tag: ${formatMentions(mentions)}` : '';
            await sock.sendMessage(jid, { text: `▶️ PHOTO spam ${sec}sec | 📷 ${chatPhts.length}${mentionInfo}` });
        }
    },
    stop: { h: 'Opreste tot spam-ul', run: async (jid, a) => { const c = stopAll(jid); await sock.sendMessage(jid, { text: c ? `⏹️ Oprit (${c})` : 'ℹ️ Nimic activ' }); } },
    stoptext: { h: 'Opreste spam text', run: async (jid, a) => { await sock.sendMessage(jid, { text: stopSpam(jid, 'text') ? '⏹️ TEXT oprit' : 'ℹ️ TEXT oprit deja' }); } },
    stopsticker: { h: 'Opreste spam stickere', run: async (jid, a) => { await sock.sendMessage(jid, { text: stopSpam(jid, 'sticker') ? '⏹️ STICKER oprit' : 'ℹ️ STICKER oprit deja' }); } },
    stopphoto: { h: 'Opreste spam poze', run: async (jid, a) => { await sock.sendMessage(jid, { text: stopSpam(jid, 'photo') ? '⏹️ PHOTO oprit' : 'ℹ️ PHOTO oprit deja' }); } },
    help: { h: 'Lista comenzi', run: async (jid, a) => { let t = '*🤖 Cagula-orgBOTwa* v4.0\n\n'; for (const [k, v] of Object.entries(cmds)) t += `*/${k}* — ${v.h}\n`; t += '\n💡 Reply la sticker/poza + comanda pentru a le folosi!\n💡 .vv = reply la poza pentru a o retrimite'; await sock.sendMessage(jid, { text: t }); } },
    comenzi: { h: 'Alias pentru /help', run: async (jid, a) => { await cmds['help'].run(jid, a); } },
    status: { h: 'Status spam', run: async (jid, a) => { const ts = activeSpams.get(getKey(jid, 'text')), ss = activeSpams.get(getKey(jid, 'sticker')), ps = activeSpams.get(getKey(jid, 'photo')); const chatStks = chatStickers.get(jid) || []; const chatPhts = chatPhotos.get(jid) || []; let t = '*Status*\n\n'; t += ts ? `📝 TEXT: ${ts.intervalSec}sec | ⏳ ${formatTime(Date.now() - ts.startTime)}${ts.mentions && ts.mentions.length > 0 ? ' | 👥 ' + formatMentions(ts.mentions) : ''}\n` : `📝 TEXT: oprit\n`; t += ss ? `🎨 STICKER: ${ss.intervalSec}sec | ⏳ ${formatTime(Date.now() - ss.startTime)}${ss.mentions && ss.mentions.length > 0 ? ' | 👥 ' + formatMentions(ss.mentions) : ''}\n` : `🎨 STICKER: oprit\n`; t += ps ? `📷 PHOTO: ${ps.intervalSec}sec | ⏳ ${formatTime(Date.now() - ps.startTime)}${ps.mentions && ps.mentions.length > 0 ? ' | 👥 ' + formatMentions(ps.mentions) : ''}\n` : `📷 PHOTO: oprit\n`; t += `\n📝 ${spamTexts.length} texte\n🎨 ${chatStks.length} stickere\n📷 ${chatPhts.length} poze`; await sock.sendMessage(jid, { text: t }); } },
    info: { h: 'Info bot', run: async (jid, a) => { const c = new Set([...activeSpams.keys()].map(k => k.split(':')[0])).size; const totalSavedStickers = [...chatStickers.values()].reduce((a, b) => a + b.length, 0); const totalSavedPhotos = [...chatPhotos.values()].reduce((a, b) => a + b.length, 0); await sock.sendMessage(jid, { text: `*🤖 Cagula-orgBOTwa* v4.0\n📅 ${new Date().toLocaleString('ro-RO')}\n💬 Chats: ${c}\n📝 ${spamTexts.length} texte\n🎨 ${totalSavedStickers} stickere total\n📷 ${totalSavedPhotos} poze total\n⏱️ Uptime: ${formatTime(process.uptime() * 1000)}` }); } },
    tag: { h: 'Trimite toate textele (ex: /tag @user)', run: async (jid, a) => { const { mentions } = parseMentions(a); if (!spamTexts.length) { await sock.sendMessage(jid, { text: '❌ Gol!' }); return; } for (const t of spamTexts) { const mentionText = mentions.length > 0 ? formatMentions(mentions) + '\n' + t : t; await sock.sendMessage(jid, { text: mentionText, mentions: mentions.length > 0 ? mentions : undefined }); await delay(400); } } },
    spam: { h: 'Trimite toate stickerele salvate', run: async (jid, a) => { const chatStks = chatStickers.get(jid) || []; if (!chatStks.length) { await sock.sendMessage(jid, { text: '❌ Gol!' }); return; } for (const s of chatStks) { await sock.sendMessage(jid, { sticker: fs.readFileSync(s) }); await delay(600); } } },
    photo: { h: 'Trimite toate pozele salvate', run: async (jid, a) => { const chatPhts = chatPhotos.get(jid) || []; if (!chatPhts.length) { await sock.sendMessage(jid, { text: '❌ Gol!' }); return; } for (const p of chatPhts) { await sock.sendMessage(jid, { image: fs.readFileSync(p) }); await delay(600); } } },
    clearstickers: { h: 'Sterge stickerele din acest chat', run: async (jid, a) => { const chatStks = chatStickers.get(jid) || []; for (const s of chatStks) { try { fs.unlinkSync(s); } catch(e) {} } chatStickers.delete(jid); await sock.sendMessage(jid, { text: '🗑️ Stickere sterse!' }); } },
    clearphotos: { h: 'Sterge pozele din acest chat', run: async (jid, a) => { const chatPhts = chatPhotos.get(jid) || []; for (const p of chatPhts) { try { fs.unlinkSync(p); } catch(e) {} } chatPhotos.delete(jid); await sock.sendMessage(jid, { text: '🗑️ Poze sterse!' }); } },
    qr: { h: 'Sterge sesiunea si regenereaza QR', run: async (jid, a) => { try { fs.rmSync('./auth_info', { recursive: true, force: true }); await sock.sendMessage(jid, { text: '🗑️ Sesiune stearsa! Restartez...' }); setTimeout(() => process.exit(0), 2000); } catch(e) { await sock.sendMessage(jid, { text: '❌ Eroare: ' + e.message }); } } }
};

cmds['.vv'] = { h: 'Versiune & status', run: async (jid, a) => { await cmds['info'].run(jid, a); } };

// ===================== MESSAGE HANDLER =====================
async function handleMsg(msg) {
    try {
        if (!msg.message) return;
        const jid = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const fromMe = msg.key.fromMe === true;
        const ownerCheck = isOwner(sender, fromMe);
        console.log(`[DEBUG] Chat: ${jid.endsWith('@g.us') ? 'GRUP' : 'PRIVAT'} | Sender: ${sender} | isOwner: ${ownerCheck}`);
        if (!ownerCheck) { console.log('[DEBUG] NOT OWNER'); return; }
        console.log('[DEBUG] IS OWNER!');

        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
        const t = text.trim();

        if (t === '.vv') { await vvReply(msg, jid); return; }
        if (!t.startsWith('/')) return;
        const parts = t.slice(1).split(/\s+/);
        const name = parts[0].toLowerCase();
        const args = parts.slice(1);

        const cmd = cmds[name];
        if (cmd) { console.log(`[CMD] /${name}`); await cmd.run(jid, args, msg); }
        else await sock.sendMessage(jid, { text: `❌ */${name}* nu exista. */help*` });
    } catch (e) { console.error('Eroare msg:', e.message); }
}

// ===================== STARTUP =====================
async function startup() {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║     🤖 Cagula-orgBOTwa v4.0          ║');
    console.log('║     Baileys v5.0.0 Edition           ║');
    console.log('╚══════════════════════════════════════╝\n');

    spamTexts = loadTexts(TEXT_FILE);
    console.log(`📝 ${spamTexts.length} texte incarcate`);

    console.log('\n🚀 Pornire...');
    console.log('📱 Se va genera un QR Code (qr.png)');
    console.log('   Scaneaza-l cu WhatsApp!\n');

    await connectBot();
}

// ===================== BAILEYS =====================
async function connectBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
        const { version } = await fetchLatestBaileysVersion();
        console.log(`Baileys v${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['Cagula-orgBOTwa', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 250
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
                    console.log('   Scaneaza-l cu WhatsApp!\n');
                    // Also print QR in terminal for easy scanning
                    console.log('\n=== SCANEAZA QR-UL DE MAI JOS ===\n');
                    qrcode_terminal.generate(qr, { small: true });
                    console.log('\n=================================\n');
                } catch (e) { console.error('Eroare QR:', e.message); }
            }

            if (connection === 'close') {
                const sc = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : null;
                const shouldReconnect = sc !== DisconnectReason.loggedOut && sc !== DisconnectReason.forbidden;
                console.warn(`Conexiune inchisa. Status: ${sc}`);

                if (sc === 405 || sc === 428 || sc === 440) {
                    console.error('Eroare ' + sc + ': Versiune Baileys incompatibila cu WhatsApp!');
                }

                if (shouldReconnect && !isShuttingDown) {
                    reconnectAttempts++;
                    const d = Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 10)), 60000);
                    console.log(`Reconectare in ${d/1000}s... (incercarea ${reconnectAttempts})`);
                    setTimeout(() => connectBot(), d);
                } else if (sc === DisconnectReason.loggedOut) {
                    console.error('Logged out! Sterge auth_info.json si scaneaza QR din nou.');
                    try { fs.rmSync('./auth_info', { recursive: true, force: true }); } catch(e) {}
                    qrGenerated = false;
                    setTimeout(() => connectBot(), 5000);
                } else {
                    setTimeout(() => connectBot(), 30000);
                }
            } else if (connection === 'open') {
                reconnectAttempts = 0;
                qrGenerated = false;
                console.log('\n✅ BOT ONLINE!');
                console.log('💬 /start [1,5,60,120,240,360]  /spamsticker  /spamphoto  /stop  /status  /help');
                console.log('🎨 Reply la sticker + /spamsticker');
                console.log('📷 Reply la poza + /spamphoto');
                console.log('📷 .vv = reply la poza pentru a o retrimite');
                console.log(`📝 ${spamTexts.length} texte\n`);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) await handleMsg(msg);
        });

        sock.ev.on('error', (e) => console.error('Socket:', e.message));

    } catch (e) {
        console.error('Eroare start:', e.message);
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

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
    setTimeout(() => connectBot(), 10000);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err.message || err);
    setTimeout(() => connectBot(), 10000);
});

// ===================== RUN =====================
startup();
