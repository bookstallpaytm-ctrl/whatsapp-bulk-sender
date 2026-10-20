const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const app = express();
// ફાઈલની સાઈઝ મોટી હોવાથી limit વધારીને 50mb કરી છે
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

let sock;
let currentQR = null;
let isConnected = false;

async function connectToWhatsApp () {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    // WhatsApp નું લેટેસ્ટ વર્ઝન ઓટોમેટિક લાવશે (જેથી કનેક્શન તૂટે નહીં)
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = qr;
            qrcode.generate(qr, { small: true });
            console.log('QR Code Link: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr));
            console.log('ઉપરની લિંક ખોલો અથવા /qr પેજ પર જઈને WhatsApp થી સ્કેન કરો!');
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log('કનેક્શન તૂટી ગયું છે. Status Code:', statusCode);

            // જો 401 (Logged Out) અથવા 405/500 આવે તો જૂનો સેશન ફોલ્ડર ડિલીટ કરીને નવો QR બનાવશે
            if (statusCode === 401 || statusCode === 405) {
                console.log('જૂનું સેશન ડિલીટ કરીને નવો QR કોડ જનરેટ થઈ રહ્યો છે...');
                fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
            }

            // 3 સેકન્ડ પછી ફરીથી કનેક્ટ કરશે (જેથી ક્રેશ ન થાય)
            setTimeout(() => {
                connectToWhatsApp();
            }, 3000);

        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log('✅ તમારું WhatsApp સફળતાપૂર્વક કનેક્ટ થઈ ગયું છે!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// --- સર્વરને જાગતું રાખવા માટે (Cron-job માટે) ---
app.get('/', (req, res) => {
    res.send('Server is awake! WhatsApp API is running 100% fine. <br><br> <a href="/qr">👉 Click here to Scan QR Code</a>');
});

// --- બ્રાઉઝરમાં સીધો QR કોડ સ્કેન કરવા માટેનો Route ---
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="color:green; text-align:center; margin-top:50px;">✅ તમારું WhatsApp સફળતાપૂર્વક કનેક્ટ થયેલું છે!</h2>');
    }
    if (!currentQR) {
        return res.send(`
            <div style="text-align:center; margin-top:50px; font-family:sans-serif;">
                <h2>⏳ QR કોડ બની રહ્યો છે... કૃપા કરીને રાહ જુઓ.</h2>
                <p>આ પેજ દર 5 સેકન્ડે ઓટોમેટિક Refresh થશે.</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    }
    const qrImageUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(currentQR);
    res.send(`
        <div style="text-align:center; margin-top:50px; font-family:sans-serif;">
            <h2>તમારા WhatsApp થી નીચેનો QR કોડ સ્કેન કરો</h2>
            <img src="${qrImageUrl}" alt="WhatsApp QR Code" style="border: 2px solid #25D366; padding: 10px; border-radius: 10px;" />
            <p>QR કોડ દર 15 સેકન્ડે ઓટોમેટિક અપડેટ થશે.</p>
            <script>setTimeout(() => location.reload(), 15000);</script>
        </div>
    `);
});

// મેસેજ અને ફાઈલ મોકલવા માટેની API
app.post('/api/send', async (req, res) => {
    try {
        if (!isConnected) {
            return res.json({ success: false, msg: "WhatsApp is not connected! Please scan QR code first." });
        }

        const { number, message, mediaBase64, mediaName, mediaMime } = req.body;
        
        let formattedNumber = number.toString().replace(/\D/g, '');
        if (!formattedNumber.startsWith("91") && formattedNumber.length === 10) {
            formattedNumber = "91" + formattedNumber;
        }
        const jid = formattedNumber + "@s.whatsapp.net"; 
        
        // જો ફાઈલ મોકલી હોય તો
        if (mediaBase64 && mediaMime) {
            const buffer = Buffer.from(mediaBase64, 'base64');
            const captionText = message || "";

            if (mediaMime.startsWith('image/')) {
                await sock.sendMessage(jid, { image: buffer, caption: captionText });
            } 
            else if (mediaMime.startsWith('video/')) {
                await sock.sendMessage(jid, { video: buffer, caption: captionText });
            } 
            else {
                await sock.sendMessage(jid, { 
                    document: buffer, 
                    mimetype: mediaMime,
                    fileName: mediaName || 'file',
                    caption: captionText 
                });
            }
            console.log(`ફાઈલ સાથે મેસેજ મોકલાયો: ${formattedNumber}`);
            
        } else {
            await sock.sendMessage(jid, { text: message || "" });
            console.log(`માત્ર ટેક્સ્ટ મેસેજ મોકલાયો: ${formattedNumber}`);
        }
        
        res.json({ success: true, msg: "Message Sent Successfully!" });
    } catch (err) {
        console.error("મેસેજ મોકલવામાં ભૂલ:", err);
        res.json({ success: false, msg: "Message Failed!" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
    console.log('🚀 API સર્વર ચાલુ થઈ ગયું છે. QR કોડની રાહ જુઓ...');
});
