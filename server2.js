require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ==================== DATABASE ====================
let pool;

async function initDB() {
    try {
        pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || 3306,
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'whatsapp_bot',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        
        // Test connection
        const connection = await pool.getConnection();
        console.log('✅ Database connected successfully');
        connection.release();
        
        // Run init SQL if needed
        const initSQL = fs.readFileSync(path.join(__dirname, 'database', 'init.sql'), 'utf8');
        const statements = initSQL.split(';').filter(stmt => stmt.trim());
        for (const statement of statements) {
            try {
                await pool.execute(statement);
            } catch (err) {
                // Table already exists, ignore error
                if (!err.message.includes('already exists')) {
                    console.log('SQL Warning:', err.message);
                }
            }
        }
        console.log('✅ Database tables verified');
        
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        process.exit(1);
    }
}

// ==================== WHATSAPP CLIENT ====================
let whatsappClient = null;
let qrCodeData = null;
let botStatus = 'disconnected';
let groupLocks = {};
let userCache = {
    stickerCount: {},
    forwardCount: {},
    lastMessage: {},
    warnings: {}
};

function initWhatsAppClient(userId) {
    if (whatsappClient && botStatus === 'connected') {
        return whatsappClient;
    }
    
    const sessionDir = path.join(__dirname, 'sessions', `user_${userId}`);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    whatsappClient = new Client({
        authStrategy: new LocalAuth({ clientId: `user_${userId}`, dataPath: sessionDir }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920,1080'
            ]
        }
    });
    
    whatsappClient.on('qr', async (qr) => {
        qrCodeData = await QRCode.toDataURL(qr);
        botStatus = 'waiting_qr';
        console.log('📱 QR Code generated, waiting for scan...');
        
        // Save QR to file
        fs.writeFileSync(path.join(__dirname, '../public/qr.txt'), qr);
    });
    
    whatsappClient.on('ready', () => {
        botStatus = 'connected';
        qrCodeData = null;
        console.log('✅ WhatsApp Bot is ready and connected!');
        
        // Send ready notification to admin
        sendAdminNotification('Bot WhatsApp telah online dan siap menjaga grup! 🚀');
    });
    
    whatsappClient.on('authenticated', () => {
        console.log('🔐 WhatsApp authenticated');
    });
    
    whatsappClient.on('auth_failure', (msg) => {
        console.error('❌ Auth failed:', msg);
        botStatus = 'auth_failed';
    });
    
    whatsappClient.on('disconnected', (reason) => {
        console.log('📴 Bot disconnected:', reason);
        botStatus = 'disconnected';
        qrCodeData = null;
        
        // Reconnect after 5 seconds
        setTimeout(() => {
            if (botStatus === 'disconnected') {
                console.log('🔄 Attempting to reconnect...');
                whatsappClient.initialize();
            }
        }, 5000);
    });
    
    whatsappClient.on('message', async (message) => {
        await processIncomingMessage(message, userId);
    });
    
    whatsappClient.on('group_join', async (notification) => {
        await handleGroupJoin(notification, userId);
    });
    
    whatsappClient.on('group_leave', async (notification) => {
        await handleGroupLeave(notification, userId);
    });
    
    whatsappClient.initialize();
    return whatsappClient;
}

async function processIncomingMessage(message, userId) {
    try {
        const chat = await message.getChat();
        if (!chat.isGroup) return;
        
        // Check lock group
        if (groupLocks[chat.id._serialized] && groupLocks[chat.id._serialized].lockedUntil > Date.now()) {
            const isAdmin = (await chat.getAdmins()).some(admin => admin.id._serialized === (message.author || message.from));
            if (!isAdmin) {
                await message.delete();
                return;
            }
        }
        
        // Get settings
        const [settings] = await pool.execute('SELECT * FROM bot_settings WHERE user_id = ?', [userId]);
        const setting = settings[0] || {};
        
        let blocked = false;
        let logType = null;
        let logMessage = null;
        const senderId = message.author || message.from;
        
        // 1. ANTI VIRTEX - Pesan terlalu panjang
        if (setting.anti_virtex && !blocked) {
            const maxLength = 1000;
            if (message.body && message.body.length > maxLength) {
                await message.delete();
                blocked = true;
                logType = 'virtex';
                logMessage = 'Pesan terlalu panjang (virtex)';
            }
            
            const weirdPattern = /(.)\1{20,}/;
            if (message.body && weirdPattern.test(message.body)) {
                await message.delete();
                blocked = true;
                logType = 'virtex';
                logMessage = 'Pesan mengandung karakter aneh berulang';
            }
        }
        
        // 2. ANTI STICKER SPAM
        if (setting.anti_sticker_spam && !blocked && message.type === 'sticker') {
            const stickerLimit = setting.max_sticker_per_minute || 5;
            
            if (!userCache.stickerCount[senderId]) userCache.stickerCount[senderId] = [];
            
            const now = Date.now();
            userCache.stickerCount[senderId] = userCache.stickerCount[senderId].filter(t => now - t < 60000);
            userCache.stickerCount[senderId].push(now);
            
            if (userCache.stickerCount[senderId].length > stickerLimit) {
                await message.delete();
                blocked = true;
                logType = 'sticker_spam';
                logMessage = 'Terlalu banyak stiker';
            }
        }
        
        // 3. ANTI MENTION ALL
        if (setting.anti_mention_all && !blocked && message.body) {
            const mentionPatterns = ['@all', '@everyone', '@全体成员', '@所有人'];
            const body = message.body.toLowerCase();
            
            if (mentionPatterns.some(p => body.includes(p))) {
                await message.delete();
                blocked = true;
                logType = 'mention_all';
                logMessage = 'Mention all tidak diizinkan';
            }
        }
        
        // 4. ANTI FORWARD
        if (setting.anti_forward && !blocked && message.forwarded) {
            const forwardLimit = 3;
            
            if (!userCache.forwardCount[senderId]) userCache.forwardCount[senderId] = [];
            
            const now = Date.now();
            userCache.forwardCount[senderId] = userCache.forwardCount[senderId].filter(t => now - t < 3600000);
            userCache.forwardCount[senderId].push(now);
            
            if (userCache.forwardCount[senderId].length > forwardLimit) {
                await message.delete();
                blocked = true;
                logType = 'forward_spam';
                logMessage = 'Terlalu banyak forward';
            }
        }
        
        // 5. ANTI SPAM
        if (setting.anti_spam && !blocked && message.body) {
            const recentMessages = await chat.fetchMessages({ limit: 10 });
            const sameUserMessages = recentMessages.filter(m => 
                (m.author || m.from) === senderId && m.body === message.body
            );
            
            if (sameUserMessages.length > (setting.max_messages_per_minute || 5)) {
                await message.delete();
                blocked = true;
                logType = 'spam';
                logMessage = 'Pesan spam terdeteksi';
            }
        }
        
        // 6. ANTI LINK
        if (setting.anti_link && !blocked && message.body) {
            const urlRegex = /(https?:\/\/[^\s]+)/g;
            const urls = message.body.match(urlRegex);
            
            if (urls && urls.length > 0) {
                const allowedDomains = (setting.allowed_domains || '').split(',').map(d => d.trim());
                const hasBlockedUrl = urls.some(url => {
                    return !allowedDomains.some(domain => url.includes(domain));
                });
                
                if (hasBlockedUrl) {
                    await message.delete();
                    blocked = true;
                    logType = 'link';
                    logMessage = 'Link terblokir';
                }
            }
        }
        
        // 7. ANTI TOXIC
        if (setting.anti_toxic && !blocked && message.body) {
            const bannedWords = (setting.banned_words || '').split(',').map(w => w.trim().toLowerCase());
            const hasBannedWord = bannedWords.some(word => message.body.toLowerCase().includes(word));
            
            if (hasBannedWord) {
                await message.delete();
                blocked = true;
                logType = 'toxic';
                logMessage = 'Kata toxic terdeteksi';
                
                // Auto warn system
                if (setting.auto_warn) {
                    if (!userCache.warnings[senderId]) userCache.warnings[senderId] = [];
                    
                    const maxWarnings = setting.max_warnings || 3;
                    const warningExpiry = 86400000; // 24 hours
                    const now = Date.now();
                    
                    userCache.warnings[senderId] = userCache.warnings[senderId].filter(w => now - w.timestamp < warningExpiry);
                    userCache.warnings[senderId].push({ reason: 'Kata toxic', timestamp: now });
                    
                    const warningCount = userCache.warnings[senderId].length;
                    
                    if (warningCount >= maxWarnings) {
                        await chat.removeParticipants([senderId]);
                        logMessage += ` - User dikick karena ${warningCount} peringatan`;
                    } else {
                        await message.reply(`⚠️ PERINGATAN ${warningCount}/${maxWarnings}! Hindari kata-kata toxic.`);
                    }
                }
            }
        }
        
        // 8. SLOW MODE
        if (setting.slow_mode && !blocked) {
            const slowDelay = setting.slow_mode_delay || 5;
            
            if (slowDelay > 0) {
                const now = Date.now();
                
                if (userCache.lastMessage[senderId] && (now - userCache.lastMessage[senderId]) < (slowDelay * 1000)) {
                    await message.delete();
                    blocked = true;
                    logType = 'slow_mode';
                    logMessage = `Pesan terlalu cepat (slow mode ${slowDelay} detik)`;
                } else {
                    userCache.lastMessage[senderId] = now;
                }
            }
        }
        
        // 9. AUTO REPLY
        if (setting.auto_reply && !blocked && message.body) {
            const autoReplies = JSON.parse(setting.auto_replies || '[]');
            for (const reply of autoReplies) {
                if (message.body.toLowerCase().includes(reply.keyword.toLowerCase())) {
                    await message.reply(reply.response);
                    break;
                }
            }
        }
        
        // Log if blocked
        if (blocked) {
            await pool.execute(
                `INSERT INTO bot_logs (user_id, type, message, details, group_id, user_target) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, logType, logMessage, `Group: ${chat.name}`, chat.id._serialized, senderId]
            );
        }
        
    } catch (error) {
        console.error('Error processing message:', error);
    }
}

async function handleGroupJoin(notification, userId) {
    try {
        const chat = await notification.getChat();
        const [settings] = await pool.execute('SELECT * FROM bot_settings WHERE user_id = ?', [userId]);
        const setting = settings[0] || {};
        
        if (setting.auto_welcome && setting.welcome_message) {
            let message = setting.welcome_message
                .replace('{name}', notification.body)
                .replace('{group}', chat.name);
            
            await chat.sendMessage(message);
            
            await pool.execute(
                `INSERT INTO bot_logs (user_id, type, message, details, group_id) 
                 VALUES (?, 'welcome', ?, ?, ?)`,
                [userId, `Welcome message sent to ${notification.body}`, chat.name, chat.id._serialized]
            );
        }
    } catch (error) {
        console.error('Error handling group join:', error);
    }
}

async function handleGroupLeave(notification, userId) {
    try {
        const chat = await notification.getChat();
        const [settings] = await pool.execute('SELECT * FROM bot_settings WHERE user_id = ?', [userId]);
        const setting = settings[0] || {};
        
        if (setting.auto_goodbye && setting.goodbye_message) {
            let message = setting.goodbye_message
                .replace('{name}', notification.body)
                .replace('{group}', chat.name);
            
            await chat.sendMessage(message);
        }
    } catch (error) {
        console.error('Error handling group leave:', error);
    }
}

async function sendAdminNotification(message) {
    try {
        const [admins] = await pool.execute('SELECT * FROM users WHERE role = "admin"');
        // In real implementation, send to Telegram or WebSocket
        console.log('Admin notification:', message);
    } catch (error) {
        console.error('Error sending admin notification:', error);
    }
}

// ==================== API ROUTES ====================

// Auth middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Token required' });
    }
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.id;
        req.userRole = decoded.role;
        next();
    } catch (error) {
        return res.status(403).json({ success: false, message: 'Invalid token' });
    }
}

function isAdmin(req, res, next) {
    if (req.userRole !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin only' });
    }
    next();
}

// Auth endpoints
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, username, password } = req.body;
        
        // Check existing user
        const [existing] = await pool.execute(
            'SELECT id FROM users WHERE username = ? OR email = ?',
            [username, email]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Username atau email sudah terdaftar' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.execute(
            'INSERT INTO users (name, email, username, password) VALUES (?, ?, ?, ?)',
            [name, email, username, hashedPassword]
        );
        
        // Create default settings for new user
        await pool.execute(
            `INSERT INTO bot_settings (user_id, anti_spam, anti_link, anti_toxic, auto_welcome) 
             VALUES (?, TRUE, TRUE, TRUE, TRUE)`,
            [result.insertId]
        );
        
        res.json({ success: true, message: 'Registrasi berhasil, silakan login' });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const [users] = await pool.execute(
            'SELECT * FROM users WHERE username = ? OR email = ?',
            [username, username]
        );
        
        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Username atau email tidak ditemukan' });
        }
        
        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'Password salah' });
        }
        
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                name: user.name,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Bot endpoints
app.get('/api/bot/status', authenticateToken, async (req, res) => {
    res.json({
        success: true,
        status: botStatus,
        qrCode: qrCodeData,
        deviceName: process.env.BOT_NAME || 'WABot Guard',
        phoneNumber: whatsappClient?.info?.wid?.user || '-',
        connectedSince: new Date().toISOString()
    });
});

app.post('/api/bot/connect', authenticateToken, async (req, res) => {
    try {
        if (!whatsappClient || botStatus === 'disconnected') {
            initWhatsAppClient(req.userId);
            res.json({ success: true, message: 'Bot sedang diinisialisasi, scan QR code dalam 10 detik' });
        } else {
            res.json({ success: false, message: 'Bot sudah berjalan' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/bot/disconnect', authenticateToken, async (req, res) => {
    try {
        if (whatsappClient) {
            await whatsappClient.destroy();
            whatsappClient = null;
            botStatus = 'disconnected';
            qrCodeData = null;
        }
        res.json({ success: true, message: 'Bot berhasil diputuskan' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/bot/groups', authenticateToken, async (req, res) => {
    try {
        if (!whatsappClient || botStatus !== 'connected') {
            return res.json({ success: true, groups: [] });
        }
        
        const chats = await whatsappClient.getChats();
        const groups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name,
                memberCount: chat.participants?.length || 0,
                isActive: true
            }));
        
        res.json({ success: true, groups });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/bot/settings', authenticateToken, async (req, res) => {
    try {
        const [settings] = await pool.execute(
            'SELECT * FROM bot_settings WHERE user_id = ?',
            [req.userId]
        );
        
        if (settings.length === 0) {
            // Create default settings
            await pool.execute(
                `INSERT INTO bot_settings (user_id, anti_spam, anti_link, anti_toxic, auto_welcome) 
                 VALUES (?, TRUE, TRUE, TRUE, TRUE)`,
                [req.userId]
            );
            const [newSettings] = await pool.execute(
                'SELECT * FROM bot_settings WHERE user_id = ?',
                [req.userId]
            );
            return res.json({ success: true, settings: newSettings[0] });
        }
        
        // Parse JSON fields
        const setting = settings[0];
        if (setting.auto_replies) setting.auto_replies = JSON.parse(setting.auto_replies || '[]');
        if (setting.allowed_domains) setting.allowed_domains = setting.allowed_domains.split(',');
        if (setting.banned_words) setting.banned_words = setting.banned_words.split(',');
        
        res.json({ success: true, settings: setting });
    } catch (error) {
        console.error('Error getting settings:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/bot/settings', authenticateToken, async (req, res) => {
    try {
        const {
            antiSpam, antiLink, antiToxic, antiVirtex, antiStickerSpam,
            antiMentionAll, antiForward, slowMode, autoWelcome, autoGoodbye,
            autoKick, autoWarn, aiModeration, maxMessagesPerMinute,
            maxStickerPerMinute, slowModeDelay, maxWarnings,
            allowedDomains, bannedWords, autoReplies, welcomeMessage, goodbyeMessage
        } = req.body;
        
        await pool.execute(
            `UPDATE bot_settings SET 
                anti_spam = ?, anti_link = ?, anti_toxic = ?, anti_virtex = ?,
                anti_sticker_spam = ?, anti_mention_all = ?, anti_forward = ?,
                slow_mode = ?, auto_welcome = ?, auto_goodbye = ?, auto_kick = ?,
                auto_warn = ?, ai_moderation = ?, max_messages_per_minute = ?,
                max_sticker_per_minute = ?, slow_mode_delay = ?, max_warnings = ?,
                allowed_domains = ?, banned_words = ?, auto_replies = ?,
                welcome_message = ?, goodbye_message = ?
            WHERE user_id = ?`,
            [
                antiSpam || false, antiLink || false, antiToxic || false, antiVirtex || false,
                antiStickerSpam || false, antiMentionAll || false, antiForward || false,
                slowMode || false, autoWelcome || false, autoGoodbye || false, autoKick || false,
                autoWarn || false, aiModeration || false, maxMessagesPerMinute || 5,
                maxStickerPerMinute || 3, slowModeDelay || 5, maxWarnings || 3,
                (allowedDomains || []).join(','), (bannedWords || []).join(','),
                JSON.stringify(autoReplies || []), welcomeMessage || '', goodbyeMessage || '',
                req.userId
            ]
        );
        
        res.json({ success: true, message: 'Pengaturan berhasil disimpan' });
    } catch (error) {
        console.error('Error saving settings:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/bot/logs', authenticateToken, async (req, res) => {
    try {
        const filter = req.query.filter || 'all';
        const limit = parseInt(req.query.limit) || 100;
        
        let query = 'SELECT * FROM bot_logs WHERE user_id = ?';
        const params = [req.userId];
        
        if (filter !== 'all') {
            query += ' AND type = ?';
            params.push(filter);
        }
        
        query += ' ORDER BY timestamp DESC LIMIT ?';
        params.push(limit);
        
        const [logs] = await pool.execute(query, params);
        res.json({ success: true, logs });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/bot/logs/clear', authenticateToken, async (req, res) => {
    try {
        await pool.execute('DELETE FROM bot_logs WHERE user_id = ?', [req.userId]);
        res.json({ success: true, message: 'Log berhasil dihapus' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/bot/stats', authenticateToken, async (req, res) => {
    try {
        const [totalMessages] = await pool.execute(
            'SELECT COUNT(*) as total FROM bot_logs WHERE user_id = ?',
            [req.userId]
        );
        
        const [totalBlocked] = await pool.execute(
            `SELECT COUNT(*) as total FROM bot_logs 
             WHERE user_id = ? AND type IN ('spam', 'link', 'toxic', 'virtex', 'sticker_spam')`,
            [req.userId]
        );
        
        const [totalGroups] = await pool.execute(
            'SELECT COUNT(DISTINCT group_id) as total FROM bot_logs WHERE user_id = ? AND group_id IS NOT NULL',
            [req.userId]
        );
        
        res.json({
            success: true,
            totalMessages: totalMessages[0].total,
            totalBlocked: totalBlocked[0].total,
            totalGroups: totalGroups[0].total
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/bot/lock', authenticateToken, async (req, res) => {
    try {
        const { groupId, duration } = req.body;
        
        groupLocks[groupId] = {
            isLocked: true,
            lockedUntil: Date.now() + (duration * 60 * 1000),
            lockedBy: req.userId
        };
        
        if (whatsappClient && botStatus === 'connected') {
            const chat = await whatsappClient.getChatById(groupId);
            await chat.sendMessage(`🔒 *GRUP DIKUNCI*\n\nGrup akan read-only selama ${duration} menit. Hanya admin yang bisa mengirim pesan.`);
        }
        
        res.json({ success: true, message: `Grup dikunci selama ${duration} menit` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Serve HTML pages
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ==================== START SERVER ====================
async function start() {
    await initDB();
    
    app.listen(PORT, () => {
        console.log(`
╔═══════════════════════════════════════════╗
║     🚀 WABOT GUARD SERVER RUNNING        ║
╠═══════════════════════════════════════════╣
║  PORT: ${PORT}                              ║
║  URL: http://localhost:${PORT}              ║
║  Dashboard: http://localhost:${PORT}/dashboard ║
╚═══════════════════════════════════════════╝
        `);
    });
}

start();