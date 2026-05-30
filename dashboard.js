let currentUser = null;
let activityChart = null;
let settings = {
    antiSpam: true,
    antiLink: true,
    antiToxic: true,
    autoReply: true,
    welcomeMsg: true,
    maxMessagesPerMinute: 5,
    allowedDomains: [],
    bannedWords: [],
    autoReplies: [],
    welcomeMessage: "Selamat datang {name} di grup {group}! Semoga betah ya 😊"
};

// Check auth on load
document.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/';
        return;
    }
    currentUser = JSON.parse(localStorage.getItem('user'));
    await loadDashboard();
    await loadSettings();
    await checkBotStatus();
});

async function loadDashboard() {
    await loadStats();
    await loadGroups();
    await loadLogs();
    initChart();
}

async function loadStats() {
    try {
        const response = await fetch('/api/bot/stats', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await response.json();
        if (data.success) {
            document.getElementById('totalGroups').innerText = data.totalGroups || 0;
            document.getElementById('totalMessages').innerText = data.totalMessages || 0;
            document.getElementById('totalBlocked').innerText = data.totalBlocked || 0;
        }
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

async function checkBotStatus() {
    try {
        const response = await fetch('/api/bot/status', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await response.json();
        
        if (data.success && data.status === 'connected') {
            document.getElementById('botStatus').innerHTML = '● Online';
            document.getElementById('botStatus').className = 'text-xl font-bold text-green-500';
            document.getElementById('deviceName').innerText = data.deviceName || 'WhatsApp Bot';
            document.getElementById('phoneNumber').innerText = data.phoneNumber || '-';
            document.getElementById('connectedSince').innerText = data.connectedSince || '-';
            
            if (data.qrCode) {
                document.getElementById('qrContainer').innerHTML = `<img src="${data.qrCode}" alt="QR Code" class="mx-auto w-64">`;
            } else {
                document.getElementById('qrContainer').innerHTML = '<div class="text-center"><i class="fas fa-check-circle text-green-500 text-5xl mb-2"></i><p>Bot sudah terhubung!</p></div>';
            }
        } else {
            document.getElementById('botStatus').innerHTML = '● Offline';
            document.getElementById('botStatus').className = 'text-xl font-bold text-red-500';
            document.getElementById('qrContainer').innerHTML = `
                <div class="text-center">
                    <div class="loader border-4 border-gray-200 border-t-green-500 rounded-full w-16 h-16 animate-spin mx-auto mb-4"></div>
                    <p>Menunggu QR Code...</p>
                </div>
            `;
        }
    } catch (error) {
        console.error('Error checking bot status:', error);
    }

    setTimeout(checkBotStatus, 5000);
}

async function loadGroups() {
    try {
        const response = await fetch('/api/bot/groups', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await response.json();
        
        const tbody = document.getElementById('groupsTable');
        if (data.success && data.groups.length > 0) {
            tbody.innerHTML = data.groups.map(group => `
                <tr class="border-b">
                    <td class="py-3">${group.name}</td>
                    <td class="py-3 font-mono text-sm">${group.id}</td>
                    <td class="py-3">${group.memberCount || 0}</td>
                    <td class="py-3"><span class="bg-green-100 text-green-700 px-2 py-1 rounded-full text-xs">Terjaga</span></td>
                    <td class="py-3">
                        <button onclick="toggleGroup('${group.id}')" class="text-red-500 hover:text-red-700">
                            <i class="fas fa-stop"></i> Hentikan
                        </button>
                    </td>
                </tr>
            `).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4">Belum ada grup yang terjaga</td></tr>';
        }
    } catch (error) {
        console.error('Error loading groups:', error);
    }
}

async function loadSettings() {
    try {
        const response = await fetch('/api/bot/settings', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await response.json();
        
        if (data.success) {
            settings = data.settings;
            
            // Update toggle UI
            document.getElementById('antiSpamToggle').className = `toggle-switch ${settings.antiSpam ? 'active' : ''}`;
            document.getElementById('antiLinkToggle').className = `toggle-switch ${settings.antiLink ? 'active' : ''}`;
            document.getElementById('antiToxicToggle').className = `toggle-switch ${settings.antiToxic ? 'active' : ''}`;
            document.getElementById('autoReplyToggle').className = `toggle-switch ${settings.autoReply ? 'active' : ''}`;
            document.getElementById('welcomeMsgToggle').className = `toggle-switch ${settings.welcomeMsg ? 'active' : ''}`;
            
            document.getElementById('maxMessagesPerMinute').value = settings.maxMessagesPerMinute || 5;
            document.getElementById('allowedDomains').value = (settings.allowedDomains || []).join(', ');
            document.getElementById('bannedWords').value = (settings.bannedWords || []).join(', ');
            document.getElementById('welcomeMessage').value = settings.welcomeMessage || '';
            
            renderAutoReplies();
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

function renderAutoReplies() {
    const container = document.getElementById('autoReplyList');
    if (settings.autoReplies && settings.autoReplies.length > 0) {
        container.innerHTML = settings.autoReplies.map((reply, index) => `
            <div class="flex gap-2 mb-2">
                <input type="text" value="${reply.keyword}" placeholder="Kata kunci" class="flex-1 border rounded-lg px-3 py-2" data-keyword-index="${index}">
                <input type="text" value="${reply.response}" placeholder="Balasan" class="flex-2 border rounded-lg px-3 py-2" data-response-index="${index}">
                <button onclick="removeAutoReply(${index})" class="bg-red-500 text-white px-3 rounded-lg">×</button>
            </div>
        `).join('');
    } else {
        container.innerHTML = '<p class="text-gray-500 text-sm">Belum ada auto reply. Klik tombol di bawah untuk menambah.</p>';
    }
}

function addAutoReply() {
    if (!settings.autoReplies) settings.autoReplies = [];
    settings.autoReplies.push({ keyword: '', response: '' });
    renderAutoReplies();
}

function removeAutoReply(index) {
    settings.autoReplies.splice(index, 1);
    renderAutoReplies();
}

function toggleSetting(setting) {
    const toggle = document.getElementById(`${setting}Toggle`);
    settings[setting] = !settings[setting];
    toggle.className = `toggle-switch ${settings[setting] ? 'active' : ''}`;
}

async function saveSettings() {
    // Collect auto replies from inputs
    const keywords = document.querySelectorAll('[data-keyword-index]');
    const responses = document.querySelectorAll('[data-response-index]');
    const newReplies = [];
    for (let i = 0; i < keywords.length; i++) {
        if (keywords[i].value && responses[i].value) {
            newReplies.push({
                keyword: keywords[i].value.toLowerCase(),
                response: responses[i].value
            });
        }
    }
    settings.autoReplies = newReplies;
    settings.maxMessagesPerMinute = parseInt(document.getElementById('maxMessagesPerMinute').value);
    settings.allowedDomains = document.getElementById('allowedDomains').value.split(',').map(d => d.trim());
    settings.bannedWords = document.getElementById('bannedWords').value.split(',').map(w => w.trim().toLowerCase());
    settings.welcomeMessage = document.getElementById('welcomeMessage').value;
    
    try {
        const response = await fetch('/api/bot/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify(settings)
        });
        const data = await response.json();
        
        if (data.success) {
            Swal.fire('Berhasil!', 'Pengaturan telah disimpan', 'success');
        } else {
            Swal.fire('Gagal!', data.message, 'error');
        }
    } catch (error) {
        Swal.fire('Error!', 'Terjadi kesalahan', 'error');
    }
}

async function loadLogs() {
    try {
        const filter = document.getElementById('logFilter')?.value || 'all';
        const response = await fetch(`/api/bot/logs?filter=${filter}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await response.json();
        
        const logsDiv = document.getElementById('logsList');
        if (data.success && data.logs.length > 0) {
            logsDiv.innerHTML = data.logs.map(log => `
                <div class="border-b pb-2">
                    <div class="flex justify-between text-sm">
                        <span class="text-gray-500">${new Date(log.timestamp).toLocaleString()}</span>
                        <span class="px-2 py-1 rounded-full text-xs ${getLogBadgeClass(log.type)}">${log.type}</span>
                    </div>
                    <p class="mt-1">${log.message}</p>
                    ${log.details ? `<p class="text-gray-500 text-xs mt-1">${log.details}</p>` : ''}
                </div>
            `).join('');
        } else {
            logsDiv.innerHTML = '<p class="text-center text-gray-500">Belum ada log</p>';
        }
    } catch (error) {
        console.error('Error loading logs:', error);
    }
}

function getLogBadgeClass(type) {
    const classes = {
        'spam': 'bg-red-100 text-red-700',
        'link': 'bg-yellow-100 text-yellow-700',
        'toxic': 'bg-orange-100 text-orange-700',
        'welcome': 'bg-green-100 text-green-700',
        'info': 'bg-blue-100 text-blue-700'
    };
    return classes[type] || 'bg-gray-100 text-gray-700';
}

function clearLogs() {
    Swal.fire({
        title: 'Hapus Semua Log?',
        text: 'Aksi ini tidak dapat dibatalkan!',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Ya, hapus!'
    }).then(async (result) => {
        if (result.isConfirmed) {
            await fetch('/api/bot/logs/clear', {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            loadLogs();
            Swal.fire('Terhapus!', 'Semua log telah dihapus', 'success');
        }
    });
}

function initChart() {
    const ctx = document.getElementById('activityChart')?.getContext('2d');
    if (!ctx) return;
    
    activityChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'],
            datasets: [{
                label: 'Pesan Diproses',
                data: [0, 0, 0, 0, 0, 0, 0],
                borderColor: '#25D366',
                backgroundColor: 'rgba(37, 211, 102, 0.1)',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

async function disconnectBot() {
    Swal.fire({
        title: 'Putuskan Koneksi Bot?',
        text: 'Bot akan berhenti menjaga grup setelah diputus',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Ya, putuskan!'
    }).then(async (result) => {
        if (result.isConfirmed) {
            await fetch('/api/bot/disconnect', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            Swal.fire('Terputus!', 'Bot WhatsApp telah diputuskan', 'success');
            checkBotStatus();
        }
    });
}

function showSection(section) {
    const sections = ['overview', 'bot', 'groups', 'settings', 'logs'];
    sections.forEach(s => {
        document.getElementById(`${s}Section`).classList.add('hidden');
        document.getElementById(`nav-${s}`).classList.remove('active');
    });
    document.getElementById(`${section}Section`).classList.remove('hidden');
    document.getElementById(`nav-${section}`).classList.add('active');
    
    if (section === 'logs') loadLogs();
    if (section === 'groups') loadGroups();
    if (section === 'settings') loadSettings();
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/';
}

// Refresh data periodically
setInterval(() => {
    loadStats();
    loadLogs();
}, 30000);