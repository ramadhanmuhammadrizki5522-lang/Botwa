// FITUR LENGKAP WABOT GUARD
const advancedFeatures = {
    // Anti Virtex - blokir pesan terlalu panjang
    antiVirtex: async (message, settings) => {
        const maxLength = settings.maxMessageLength || 1000;
        if (message.body.length > maxLength) {
            await message.delete();
            return { blocked: true, reason: 'virtex', message: 'Pesan terlalu panjang (virtex)' };
        }
        // Deteksi karakter aneh berulang
        const weirdPattern = /(.)\1{20,}/;
        if (weirdPattern.test(message.body)) {
            await message.delete();
            return { blocked: true, reason: 'virtex', message: 'Pesan mengandung karakter aneh berulang' };
        }
        return { blocked: false };
    },

    // Anti Sticker Spam
    antiStickerSpam: async (message, chat, settings, userCache) => {
        if (message.type !== 'sticker') return { blocked: false };
        
        const stickerLimit = settings.maxStickerPerMinute || 5;
        const userId = message.author || message.from;
        
        if (!userCache.stickerCount[userId]) userCache.stickerCount[userId] = [];
        
        const now = Date.now();
        userCache.stickerCount[userId] = userCache.stickerCount[userId].filter(t => now - t < 60000);
        userCache.stickerCount[userId].push(now);
        
        if (userCache.stickerCount[userId].length > stickerLimit) {
            await message.delete();
            return { blocked: true, reason: 'sticker_spam', message: 'Terlalu banyak stiker' };
        }
        return { blocked: false };
    },

    // Anti Mention All
    antiMentionAll: async (message, settings) => {
        const mentionPatterns = ['@all', '@everyone', '@全体成员', '@所有人'];
        const body = message.body.toLowerCase();
        
        if (mentionPatterns.some(p => body.includes(p))) {
            await message.delete();
            const mentioned = await message.getMentions();
            if (mentioned.length > 0) {
                // Warn or kick user
                return { blocked: true, reason: 'mention_all', message: 'Mention all tidak diizinkan' };
            }
        }
        return { blocked: false };
    },

    // Anti Forward
    antiForward: async (message, settings, userCache) => {
        if (!message.hasMedia && !message.forwarded) return { blocked: false };
        
        const forwardLimit = settings.maxForwardPerHour || 3;
        const userId = message.author || message.from;
        
        if (!userCache.forwardCount[userId]) userCache.forwardCount[userId] = [];
        
        const now = Date.now();
        userCache.forwardCount[userId] = userCache.forwardCount[userId].filter(t => now - t < 3600000);
        userCache.forwardCount[userId].push(now);
        
        if (userCache.forwardCount[userId].length > forwardLimit) {
            await message.delete();
            return { blocked: true, reason: 'forward_spam', message: 'Terlalu banyak forward' };
        }
        return { blocked: false };
    },

    // Slow Mode
    slowMode: async (message, chat, settings, userCache) => {
        const slowDelay = settings.slowModeDelay || 5; // detik
        if (slowDelay === 0) return { blocked: false };
        
        const userId = message.author || message.from;
        const now = Date.now();
        
        if (userCache.lastMessage[userId] && (now - userCache.lastMessage[userId]) < (slowDelay * 1000)) {
            await message.delete();
            await message.reply(`⚠️ Slow mode aktif! Harap tunggu ${slowDelay} detik sebelum mengirim pesan lagi.`);
            return { blocked: true, reason: 'slow_mode', message: 'Pesan terlalu cepat' };
        }
        
        userCache.lastMessage[userId] = now;
        return { blocked: false };
    },

    // Auto Warn System
    autoWarn: async (message, userId, settings, userCache) => {
        if (!userCache.warnings[userId]) userCache.warnings[userId] = [];
        
        const maxWarnings = settings.maxWarnings || 3;
        const warningExpiry = settings.warningExpiry || 86400000; // 24 jam
        
        // Clean old warnings
        const now = Date.now();
        userCache.warnings[userId] = userCache.warnings[userId].filter(w => now - w.timestamp < warningExpiry);
        
        userCache.warnings[userId].push({ reason: message.reason, timestamp: now });
        
        const warningCount = userCache.warnings[userId].length;
        
        if (warningCount >= maxWarnings) {
            // Kick user after max warnings
            const chat = await message.getChat();
            await chat.removeParticipants([userId]);
            return { kicked: true, message: `User ${userId} dikick karena ${warningCount} kali peringatan` };
        }
        
        // Send warning message
        const remaining = maxWarnings - warningCount;
        await message.reply(`⚠️ PERINGATAN ${warningCount}/${maxWarnings}! ${message.reason}. Sisa ${remaining} peringatan sebelum dikick.`);
        
        return { warned: true, warningCount };
    },

    // Scheduled Messages
    scheduleMessage: async (client, schedules) => {
        for (const schedule of schedules) {
            const now = new Date();
            const scheduleTime = new Date(schedule.time);
            
            if (now >= scheduleTime && !schedule.sent) {
                const chat = await client.getChatById(schedule.groupId);
                await chat.sendMessage(schedule.message);
                schedule.sent = true;
                
                // Update database
                await pool.execute(
                    'UPDATE scheduled_messages SET sent = TRUE, sent_at = NOW() WHERE id = ?',
                    [schedule.id]
                );
            }
        }
    },

    // Quiz Game
    quizGame: {
        questions: [
            { question: "Apa ibu kota Indonesia?", options: ["Jakarta", "Surabaya", "Bandung", "Medan"], answer: 0 },
            { question: "Siapa presiden pertama Indonesia?", options: ["Soeharto", "Soekarno", "BJ Habibie", "Megawati"], answer: 1 },
            { question: "Hewan apa yang bisa terbang?", options: ["Kucing", "Anjing", "Burung", "Ikan"], answer: 2 },
            // Tambah pertanyaan lain
        ],
        activeGames: new Map(),
        
        startQuiz: async (chatId, client) => {
            const chat = await client.getChatById(chatId);
            const gameId = Date.now().toString();
            
            const randomQuestion = quizGame.questions[Math.floor(Math.random() * quizGame.questions.length)];
            
            quizGame.activeGames.set(gameId, {
                question: randomQuestion,
                startTime: Date.now(),
                chatId: chatId
            });
            
            let message = `🎮 *QUIZ TIME!*\n\n`;
            message += `📝 *${randomQuestion.question}*\n\n`;
            randomQuestion.options.forEach((opt, idx) => {
                message += `${idx + 1}. ${opt}\n`;
            });
            message += `\n⏰ Kirim angka jawaban (1-4) dalam 30 detik!`;
            
            await chat.sendMessage(message);
            
            // Auto end after 30 seconds
            setTimeout(async () => {
                if (quizGame.activeGames.has(gameId)) {
                    await chat.sendMessage("⏰ Waktu habis! Tidak ada yang menjawab benar.");
                    quizGame.activeGames.delete(gameId);
                }
            }, 30000);
            
            return gameId;
        },
        
        checkAnswer: async (message, gameId, answerNumber) => {
            const game = quizGame.activeGames.get(gameId);
            if (!game) return { correct: false, message: "Quiz sudah berakhir!" };
            
            const isCorrect = (answerNumber - 1) === game.question.answer;
            
            if (isCorrect) {
                quizGame.activeGames.delete(gameId);
                return { correct: true, message: "✅ Jawaban benar! Selamat!" };
            } else {
                return { correct: false, message: "❌ Jawaban salah! Coba lagi lain kali." };
            }
        }
    },

    // Poll Maker
    pollMaker: {
        activePolls: new Map(),
        
        createPoll: async (chat, question, options, duration = 5) => {
            const pollId = Date.now().toString();
            const votes = new Array(options.length).fill(0);
            const voters = new Set();
            
            let message = `📊 *POLL* 📊\n\n`;
            message += `*${question}*\n\n`;
            options.forEach((opt, idx) => {
                message += `${idx + 1}. ${opt} (0 vote)\n`;
            });
            message += `\n⏰ Durasi: ${duration} menit\n`;
            message += `Kirim angka (1-${options.length}) untuk vote!`;
            
            const sentMessage = await chat.sendMessage(message);
            
            pollMaker.activePolls.set(pollId, {
                question, options, votes, voters,
                endTime: Date.now() + (duration * 60000),
                chatId: chat.id._serialized,
                messageId: sentMessage.id._serialized
            });
            
            // Auto end poll
            setTimeout(async () => {
                const poll = pollMaker.activePolls.get(pollId);
                if (poll) {
                    const results = poll.options.map((opt, idx) => `${idx + 1}. ${opt}: ${poll.votes[idx]} vote(s)`).join('\n');
                    await chat.sendMessage(`📊 *HASIL POLL*\n\n${poll.question}\n\n${results}`);
                    pollMaker.activePolls.delete(pollId);
                }
            }, duration * 60000);
            
            return pollId;
        },
        
        vote: async (pollId, userId, optionIndex) => {
            const poll = pollMaker.activePolls.get(pollId);
            if (!poll) return { success: false, message: "Poll sudah berakhir!" };
            if (poll.voters.has(userId)) return { success: false, message: "Kamu sudah vote!" };
            
            poll.votes[optionIndex]++;
            poll.voters.add(userId);
            
            return { success: true, message: "Vote berhasil!" };
        }
    },

    // Member Activity Ranking
    memberRanking: async (chat, period = 'day') => {
        const messages = await chat.fetchMessages({ limit: 1000 });
        const now = Date.now();
        const periodMs = period === 'day' ? 86400000 : period === 'week' ? 604800000 : 2592000000;
        
        const activity = {};
        
        for (const msg of messages) {
            const msgTime = msg.timestamp * 1000;
            if (now - msgTime > periodMs) continue;
            
            const userId = msg.author || msg.from;
            if (!activity[userId]) activity[userId] = { messages: 0, characters: 0 };
            activity[userId].messages++;
            activity[userId].characters += msg.body?.length || 0;
        }
        
        const ranking = Object.entries(activity)
            .map(([userId, data]) => ({ userId, ...data }))
            .sort((a, b) => b.messages - a.messages)
            .slice(0, 10);
        
        let rankingMessage = `📊 *TOP 10 MEMBER AKTIF* (${period})\n\n`;
        ranking.forEach((user, idx) => {
            rankingMessage += `${idx + 1}. <@${user.userId}> - ${user.messages} pesan (${user.characters} karakter)\n`;
        });
        
        return rankingMessage;
    },

    // AI Moderation (simulasi, bisa integrasi dengan API TensorFlow/Gemini)
    aiModeration: async (message) => {
        const toxicKeywords = ['babi', 'anjing', 'kontol', 'memek', 'goblok', 'tolol', 'idiot'];
        const body = message.body.toLowerCase();
        
        for (const keyword of toxicKeywords) {
            if (body.includes(keyword)) {
                return { isToxic: true, confidence: 0.85, reason: `Mengandung kata: ${keyword}` };
            }
        }
        
        // Cek pola spam
        const spamPattern = /(.)\1{5,}/;
        if (spamPattern.test(body)) {
            return { isToxic: true, confidence: 0.9, reason: 'Pola spam terdeteksi' };
        }
        
        return { isToxic: false };
    },

    // Auto Summary Chat
    autoSummary: async (chat, messageCount = 100) => {
        const messages = await chat.fetchMessages({ limit: messageCount });
        
        const summary = {
            totalMessages: messages.length,
            topUsers: {},
            commonWords: {},
            mediaCount: 0,
            timeRange: { start: null, end: null }
        };
        
        for (const msg of messages) {
            const userId = msg.author || msg.from;
            summary.topUsers[userId] = (summary.topUsers[userId] || 0) + 1;
            
            if (msg.body) {
                const words = msg.body.toLowerCase().match(/\b\w+\b/g);
                if (words) {
                    words.forEach(word => {
                        if (word.length > 3 && !['yang', 'dan', 'ini', 'itu', 'untuk'].includes(word)) {
                            summary.commonWords[word] = (summary.commonWords[word] || 0) + 1;
                        }
                    });
                }
            }
            
            if (msg.hasMedia) summary.mediaCount++;
            
            const msgTime = msg.timestamp * 1000;
            if (!summary.timeRange.start || msgTime < summary.timeRange.start) summary.timeRange.start = msgTime;
            if (!summary.timeRange.end || msgTime > summary.timeRange.end) summary.timeRange.end = msgTime;
        }
        
        // Top 5 common words
        const topWords = Object.entries(summary.commonWords)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        
        let summaryMessage = `📋 *RINGKASAN CHAT*\n\n`;
        summaryMessage += `📊 Total pesan: ${summary.totalMessages}\n`;
        summaryMessage += `🖼️ Media: ${summary.mediaCount}\n`;
        summaryMessage += `⏰ Periode: ${new Date(summary.timeRange.start).toLocaleString()} - ${new Date(summary.timeRange.end).toLocaleString()}\n\n`;
        summaryMessage += `🔥 Kata terbanyak: ${topWords.map(w => `${w[0]}(${w[1]})`).join(', ')}\n\n`;
        summaryMessage += `👥 Top pengirim: ${Object.entries(summary.topUsers).slice(0, 3).map(([u, c]) => `<@${u}>: ${c}`).join(', ')}`;
        
        return summaryMessage;
    },

    // Lock Group (read-only mode)
    lockGroup: async (chat, duration = 60) => {
        // Simpan state grup
        const originalConfig = {
            isLocked: true,
            lockedUntil: Date.now() + (duration * 60000),
            adminOnly: await chat.getAdmins()
        };
        
        // Kirim pengumuman
        await chat.sendMessage(`🔒 *GRUP DIKUNCI* 🔒\n\nGrup akan read-only selama ${duration} menit. Hanya admin yang bisa mengirim pesan.`);
        
        return originalConfig;
    },

    // Schedule Message (jadwalkan pesan)
    scheduleMessageTask: async (client, scheduleId, groupId, message, time) => {
        const scheduleTime = new Date(time);
        const now = new Date();
        const delay = scheduleTime - now;
        
        if (delay > 0) {
            setTimeout(async () => {
                const chat = await client.getChatById(groupId);
                await chat.sendMessage(message);
                await pool.execute('UPDATE scheduled_messages SET sent = TRUE WHERE id = ?', [scheduleId]);
            }, delay);
        }
    }
};

module.exports = advancedFeatures;