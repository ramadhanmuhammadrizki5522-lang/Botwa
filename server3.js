require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Database
let pool;

async function initDB() {
    pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'whatsapp_bot',
        waitForConnections: true,
        connectionLimit: 10
    });
    
    // Create tables
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100),
            email VARCHAR(100) UNIQUE,
            username VARCHAR(50) UNIQUE,
            password VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS bot_settings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT,
            anti_spam BOOLEAN DEFAULT TRUE,
            anti_link BOOLEAN DEFAULT TRUE,
            anti_toxic BOOLEAN DEFAULT TRUE,
            auto_reply BOOLEAN DEFAULT TRUE,
            welcome_msg BOOLEAN DEFAULT TRUE,
            max_messages_per_minute INT DEFAULT 5,
            allowed_domains TEXT,
            banned_words TEXT,
            auto_replies TEXT,
            welcome_message TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
    
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS bot_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT,
            type VARCHAR(50),
            message TEXT,
            details TEXT,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);
    
    console.log('✅ Database initialized');
}

// WhatsApp Client
let whatsappClient = null;
let qrCodeData = null;
let botStatus = 'disconnected';

function initWhatsAppClient(userId) {
    whatsappClient = new Client({
        authStrategy: new LocalAuth({ clientId: `user_${userId}` }),
        puppeteer: { headless: true, args: ['--no-sandbox'] }
    });
    
    whatsappClient.on('qr', async (qr) => {
        qrCodeData = await QRCode.toDataURL(qr);
        botStatus = 'waiting_qr';
        console.log('QR Code generated');
    });
    
    whatsappClient.on('ready', () => {
        botStatus = 'connected';
        qrCodeData = null;
        console.log('WhatsApp Bot is ready!');
    });
    
    whatsappClient.on('message', async (message) => {
        await processMessage(message, userId);
    });
    
    whatsappClient.initialize();
}

async function processMessage(message, userId) {
    const chat = await message.getChat();
    if (!chat.isGroup) return;
    
    // Get settings
    const [settings] = await pool.execute('SELECT * FROM bot_settings WHERE user_id = ?', [userId]);
    const setting = settings[0] || {};
    
    const body = message.body.toLowerCase();
    let blocked = false;
    let logType = null;
    let logMessage = null;
    
    // Anti Spam
    if (setting.anti_spam) {
        const recentMessages = await chat.fetchMessages({ limit: 10 });
        const sameUserMessages = recentMessages.filter(m => m.author === message.author && m.body === message.body);
        if (sameUserMessages.length > (setting.max_messages_per_minute || 5)) {
            await message.delete();
            blocked = true;
            logType = 'spam';
            logMessage = `Pesan spam dari ${message.author} dihapus`;
        }
    }
    
    // Anti Link
    if (setting.anti_link && !blocked) {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = body.match(urlRegex);
        if (urls && urls.length > 0) {
            const allowedDomains = (setting.allowed_domains || '').split(',');
            const hasBlockedUrl = urls.some(url => {
                return !allowedDomains.some(domain => url.includes(domain));
            });
            if (hasBlockedUrl) {
                await message.delete();
                blocked = true;
                logType = 'link';
                logMessage = `Link terblokir dari ${message.author}`;
            }
        }
    }
    
    // Anti Toxic
    if (setting.anti_toxic && !blocked) {
        const bannedWords = (setting.banned_words || '').split(',');
        const hasBannedWord = bannedWords.some(word => body.includes(word.trim()));
        if (hasBannedWord) {
            await message.delete();
            blocked = true;
            logType = 'toxic';
            logMessage = `Kata toxic dari ${message.author} difilter`;
        }
    }
    
    // Auto Reply
    if (setting.auto_reply && !blocked) {
        const autoReplies = JSON.parse(setting.auto_replies || '[]');
        for (const reply of autoReplies) {
            if (body.includes(reply.keyword.toLowerCase())) {
                await message.reply(reply.response);
                break;
            }
        }
    }
    
    // Log if blocked
    if (blocked) {
        await pool.execute(
            'INSERT INTO bot_logs (user_id, type, message, details) VALUES (?, ?, ?, ?)',
            [userId, logType, logMessage, `Group: ${chat.name}, Author: ${message.author}`]
        );
    }
}

// API Routes
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.execute(
            'INSERT INTO users (name, email, username, password) VALUES (?, ?, ?, ?)',
            [name, email, username, hashedPassword]
        );
        res.json({ success: true, message: 'Registrasi berhasil' });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const [users] = await pool.execute('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
        if (users.length === 0) {
            return res.json({ success: false, message: 'User tidak ditemukan' });
        }
        const valid = await bcrypt.compare(password, users[0].password);
        if (!valid) {
            return res.json({ success: false, message: 'Password salah' });
        }
        const token = jwt.sign({ id: users[0].id, username: users[0].username }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
        res.json({ success: true, token, user: { id: users[0].id, name: users[0].name, username: users[0].username } });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        req.userId = decoded.id;
        next();
    } catch {
        res.status(401).json({ success: false, message: 'Invalid token' });
    }
}

app.get('/api/bot/status', authMiddleware, async (req, res) => {
    res.json({ success: true, status: botStatus, qrCode: qrCodeData });
});

app.post('/api/bot/connect', authMiddleware, async (req, res) => {
    if (!whatsappClient || botStatus === 'disconnected') {
        initWhatsAppClient(req.userId);
        res.json({ success: true, message: 'Bot starting...' });
    } else {
        res.json({ success: false, message: 'Bot already running' });
    }
});

app.get('/api/bot/settings', authMiddleware, async (req, res) => {
    const [settings] = await pool.execute('SELECT * FROM bot_settings WHERE user_id = ?', [req.userId]);
    if (settings.length === 0) {
        res.json({ success: true, settings: {} });
    } else {
        res.json({ success: true, settings: settings[0] });
    }
});

app.post('/api/bot/settings', authMiddleware, async (req, res) => {
    const { antiSpam, antiLink, antiToxic, autoReply, welcomeMsg, maxMessagesPerMinute, allowedDomains, bannedWords, autoReplies, welcomeMessage } = req.body;
    await pool.execute(`
        INSERT INTO bot_settings (user_id, anti_spam, anti_link, anti_toxic, auto_reply, welcome_msg, max_messages_per_minute, allowed_domains, banned_words, auto_replies, welcome_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        anti_spam = VALUES(anti_spam), anti_link = VALUES(anti_link), anti_toxic = VALUES(anti_toxic),
        auto_reply = VALUES(auto_reply), welcome_msg = VALUES(welcome_msg), max_messages_per_minute = VALUES(max_messages_per_minute),
        allowed_domains = VALUES(allowed_domains), banned_words = VALUES(banned_words), auto_replies = VALUES(auto_replies),
        welcome_message = VALUES(welcome_message)
    `, [req.userId, antiSpam, antiLink, antiToxic, autoReply, welcomeMsg, maxMessagesPerMinute, allowedDomains.join(','), bannedWords.join(','), JSON.stringify(autoReplies), welcomeMessage]);
    res.json({ success: true });
});

app.get('/api/bot/logs', authMiddleware, async (req, res) => {
    const filter = req.query.filter || 'all';
    let query = 'SELECT * FROM bot_logs WHERE user_id = ?';
    if (filter !== 'all') {
        query += ' AND type = ?';
        const [logs] = await pool.execute(query + ' ORDER BY timestamp DESC LIMIT 100', [req.userId, filter]);
        return res.json({ success: true, logs });
    }
    const [logs] = await pool.execute(query + ' ORDER BY timestamp DESC LIMIT 100', [req.userId]);
    res.json({ success: true, logs });
});

app.delete('/api/bot/logs/clear', authMiddleware, async (req, res) => {
    await pool.execute('DELETE FROM bot_logs WHERE user_id = ?', [req.userId]);
    res.json({ success: true });
});

app.get('/api/bot/groups', authMiddleware, async (req, res) => {
    if (!whatsappClient || botStatus !== 'connected') {
        return res.json({ success: true, groups: [] });
    }
    const chats = await whatsappClient.getChats();
    const groups = chats.filter(chat => chat.isGroup).map(chat => ({
        id: chat.id._serialized,
        name: chat.name,
        memberCount: chat.participants?.length || 0
    }));
    res.json({ success: true, groups });
});

app.get('/api/bot/stats', authMiddleware, async (req, res) => {
    const [totalMessages] = await pool.execute('SELECT COUNT(*) as total FROM bot_logs WHERE user_id = ?', [req.userId]);
    const [totalBlocked] = await pool.execute('SELECT COUNT(*) as total FROM bot_logs WHERE user_id = ? AND type IN ("spam", "link", "toxic")', [req.userId]);
    res.json({ success: true, totalGroups: 0, totalMessages: totalMessages[0].total, totalBlocked: totalBlocked[0].total });
});

app.post('/api/bot/disconnect', authMiddleware, async (req, res) => {
    if (whatsappClient) {
        await whatsappClient.destroy();
        whatsappClient = null;
        botStatus = 'disconnected';
    }
    res.json({ success: true });
});

// Start server
async function start() {
    await initDB();
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}

start();