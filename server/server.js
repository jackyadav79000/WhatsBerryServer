console.log("TEST: The script is starting...");
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const http = require('http');
const { Server } = require("socket.io");
const qrcode = require('qrcode-terminal');

const server = http.createServer((req, res) => { res.end('WhatsBerry Running'); });
const io = new Server(server, { 
    cors: { origin: "*" }, 
    allowEIO3: true, 
    maxHttpBufferSize: 1e8 
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
    }
});

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('\n✅ WhatsBerry Bridge is Ready!'));

// --- HELPER: DOWNLOAD MEDIA ---
async function processMessageMedia(msg) {
    if (msg.hasMedia && (msg.type === 'image' || msg.type === 'ptt' || msg.type === 'audio')) {
        try {
            const media = await msg.downloadMedia();
            if (media) return { type: msg.type, data: media.data, mimetype: media.mimetype };
        } catch (e) { console.log("Media download failed"); }
    }
    return null;
}

// --- HELPER: FIND TEXT (THE AI FIX) ---
function getMessageText(msg) {
    // 1. Standard Text
    let text = msg.body;

    // 2. If empty, look inside hidden data (Common for Bots/AI)
    if (!text || text.trim() === "") {
        if (msg._data) {
            if (msg._data.body) text = msg._data.body;
            else if (msg._data.caption) text = msg._data.caption; // Sometimes text is a caption
            else if (msg._data.title) text = msg._data.title;
        }
    }

    // 3. If STILL empty, use descriptive labels
    if (!text || text.trim() === "") {
        if (msg.type === 'interactive') text = "🤖 [Interactive/Menu]";
        else if (msg.type === 'list') text = "📋 [List Options]";
        else if (msg.type === 'image') text = "📷 Photo";
        else if (msg.type === 'video') text = "🎥 Video";
        else if (msg.type === 'ptt' || msg.type === 'audio') text = "🎤 Voice Note";
        else if (msg.type === 'sticker') text = "👾 Sticker";
        else text = `[Content: ${msg.type}]`;
    }
    return text;
}

// --- MESSAGE HANDLER ---
client.on('message', async msg => {
    try {
        let senderName = "Unknown";
        if(msg._data.notifyName) senderName = msg._data.notifyName;
        else if(msg.from) senderName = msg.from.split('@')[0];

        // USE THE NEW TEXT FINDER
        let bodyText = getMessageText(msg);

        let mediaData = await processMessageMedia(msg);

        io.emit('new_message_alert', {
            chatId: msg.from,
            chatName: senderName,
            body: bodyText,
            media: mediaData,
            timestamp: Date.now() / 1000,
            unread: true
        });

    } catch (e) { console.log("Error handling msg:", e.message); }
});

io.on('connection', (socket) => {
    console.log('📱 BlackBerry Connected');

    // 1. Get Chat List
    socket.on('get_chats', async () => {
        try {
            const chats = await client.getChats();
            const topChats = chats.slice(0, 15);
            const enrichedChats = await Promise.all(topChats.map(async (c) => {
                let finalName = c.name || c.id.user;
                if(!finalName && c.id._serialized.includes('-')) finalName = "Group Chat";
                let picUrl = '';
                try { if (c.id) picUrl = await client.getProfilePicUrl(c.id._serialized); } catch(e) {}
                
                return { 
                    name: finalName, 
                    id: c.id._serialized, 
                    lastMessage: c.lastMessage ? getMessageText(c.lastMessage) : '', // Use Helper Here Too
                    timestamp: c.timestamp || Date.now()/1000, 
                    pic: picUrl || '', 
                    unreadCount: c.unreadCount 
                };
            }));
            socket.emit('chat_list', enrichedChats);
        } catch (e) { socket.emit('chat_list', []); }
    });

    // 2. Get Messages (History)
    socket.on('get_messages', async (chatId) => {
        try {
            const chat = await client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: 20 });
            const data = await Promise.all(messages.map(async m => {
                
                // USE THE NEW TEXT FINDER
                let content = getMessageText(m);

                let mediaData = await processMessageMedia(m);
                return { 
                    fromMe: m.fromMe, 
                    body: content, 
                    media: mediaData, 
                    type: m.type, 
                    ack: m.ack 
                };
            }));
            socket.emit('message_history', data);
        } catch (e) {}
    });

    socket.on('send_image', async (data) => {
        try {
            const media = new MessageMedia('image/jpeg', data.imageParams, 'photo.jpg');
            await client.sendMessage(data.chatId, media);
        } catch(e) {}
    });

    socket.on('send_message', async (data) => {
        try { client.sendMessage(data.chatId, data.message); } catch(e) {}
    });
    
    socket.on('mark_read', async (chatId) => {
        try { (await client.getChatById(chatId)).sendSeen(); } catch(e) {}
    });
});

client.initialize();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server Started on Port ${PORT}`));