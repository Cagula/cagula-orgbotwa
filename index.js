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
        
        // === PAIRING CODE CONFIG ===
        const phoneNumber = process.env.WHATSAPP_NUMBER; // ex: 40786112559
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Chrome (Linux)', '', ''],
            defaultQueryTimeoutMs: undefined,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            syncFullHistory: false,
            // Pentru pairing code:
            pairingCode: phoneNumber ? true : false,
            phoneNumber: phoneNumber || undefined,
        });
        
        // === PAIRING CODE HANDLER ===
        if (phoneNumber && !state.creds.registered) {
            setTimeout(async () => {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log('\n╔══════════════════════════════════════╗');
                console.log('║     🔢 PAIRING CODE GENERAT          ║');
                console.log('╚══════════════════════════════════════╝');
                console.log(`\n📱 Codul tău: ${code}`);
                console.log('\n👉 WhatsApp → Setări → Dispozitive asociate');
                console.log('👉 Apasă "Asociază un dispozitiv" → "Asociază cu număr de telefon"');
                console.log(`👉 Introdu codul: ${code}\n`);
            }, 3000);
        }

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Fallback QR dacă pairing code nu e configurat
            if (qr && !qrGenerated && !phoneNumber) {
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
