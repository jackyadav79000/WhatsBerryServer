console.log("TEST: The script is starting...");
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const http = require('http');
const { Server } = require("socket.io");
const qrcode = require('qrcode-terminal');

const server = http.createServer((req, res) => { res.end('WhatsBerry Running'); });
const io = new Server(server, { 
    cors: { origin: "*" }, 
    allowEIO3: true, 
    maxHttpBufferSize: 1e8 // 100MB limit
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ] 
    }
});

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('\n✅ WhatsBerry Bridge is Ready!'));

// --- HELPER: FIND TEXT ---
function getMessageText(msg) {
    let text = msg.body;
    if (!text || text.trim() === "") {
        if (msg._data) {
            if (msg._data.body) text = msg._data.body;
            else if (msg._data.caption) text = msg._data.caption;
        }
    }
    if (!text || text.trim() === "") {
        if (msg.type === 'interactive') text = "🤖 [Menu]";
        else if (msg.type === 'image') text = "📷 Photo";
        else if (msg.type === 'video') text = "🎥 Video";
        else if (msg.type === 'ptt') text = "🎤 Voice Note";
        else text = `[Media]`;
    }
    return text;
}

// --- MESSAGE HANDLER ---
client.on('message', async msg => {
    try {
        let senderName = msg._data.notifyName || msg.from.split('@')[0];
        let bodyText = getMessageText(msg);
        
        io.emit('new_message_alert', {
            chatId: msg.from,
            chatName: senderName,
            body: bodyText,
            timestamp: Date.now() / 1000,
            unread: true
        });
    } catch (e) {}
});

io.on('connection', (socket) => {
    console.log('📱 BlackBerry Connected');

    // 1. Send Media (FIXED FOR AUDIO ERROR)
    socket.on('send_image', async (data) => {
        try {
            console.log("📤 Sending Media...");
            let mimetype = 'image/jpeg';
            let filename = 'photo.jpg';
            let options = {};

            // FIX: If Audio, treat as Voice Note
            if (data.isAudio) {
                mimetype = 'audio/ogg; codecs=opus'; 
                filename = 'voice.ogg';
                options = { sendAudioAsVoice: true }; // <--- CRITICAL FIX
            } else {
                options = { caption: data.caption || '' };
            }

            const media = new MessageMedia(mimetype, data.imageParams, filename);
            await client.sendMessage(data.chatId, media, options);
            console.log("✅ Media Sent!");
        } catch(e) { 
            console.log("❌ Error sending media:", e.message); 
        }
    });

    // 2. Get Contacts (CRASH PROOF)
    socket.on('get_all_contacts', async () => {
        try {
            console.log("📲 Loading Contacts...");
            const chats = await client.getChats();
            
            // Extract contacts safely
            const contactsList = chats
                .filter(c => !c.isGroup && c.name) // Only real people with names
                .map(c => ({
                    name: c.name || c.pushname || c.id.user,
                    id: c.id._serialized
                }))
                .sort((a, b) => a.name.localeCompare(b.name));

            socket.emit('all_contacts_data', contactsList);
            console.log(`✅ Sent ${contactsList.length} contacts.`);
        } catch (e) {
            console.error("❌ Contact Error:", e.message);
            socket.emit('all_contacts_data', []); 
        }
    });

    // 3. Get Chats
    socket.on('get_chats', async () => {
        try {
            const chats = await client.getChats();
            const topChats = chats.slice(0, 15);
            const enrichedChats = await Promise.all(topChats.map(async (c) => {
                let picUrl = '';
                try { if (c.id) picUrl = await client.getProfilePicUrl(c.id._serialized); } catch(e) {}
                
                return {
                    name: c.name || c.id.user,
                    id: c.id._serialized,
                    lastMessage: c.lastMessage ? getMessageText(c.lastMessage) : '',
                    timestamp: c.timestamp || Date.now() / 1000,
                    pic: picUrl || '',
                    unreadCount: c.unreadCount
                };
            }));
            socket.emit('chat_list', enrichedChats);
        } catch (e) { socket.emit('chat_list', []); }
    });

    socket.on('get_messages', async (chatId) => {
        try {
            const chat = await client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: 20 });
            const data = await Promise.all(messages.map(async m => {
                let mediaData = null;
                if (m.hasMedia && (m.type === 'image' || m.type === 'ptt' || m.type === 'audio')) {
                    try {
                        const media = await m.downloadMedia();
                        if(media) mediaData = { type: m.type, data: media.data };
                    } catch(e){}
                }
                return { fromMe: m.fromMe, body: getMessageText(m), media: mediaData, type: m.type, ack: m.ack };
            }));
            socket.emit('message_history', data);
        } catch (e) {}
    });

    socket.on('send_message', async (data) => {
        try { client.sendMessage(data.chatId, data.message); } catch(e) {}
    });
});

client.initialize();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server Started on Port ${PORT}`));
