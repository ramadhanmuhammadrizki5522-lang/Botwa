#!/bin/bash

echo "╔═══════════════════════════════════════════╗"
echo "║     🚀 WABOT GUARD DEPLOYMENT SCRIPT     ║"
echo "╚═══════════════════════════════════════════╝"

# Update system
echo "📦 Updating system..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
echo "📦 Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2
echo "📦 Installing PM2..."
sudo npm install -g pm2

# Install MariaDB
echo "📦 Installing MariaDB..."
sudo apt install -y mariadb-server mariadb-client

# Start MariaDB
sudo systemctl start mariadb
sudo systemctl enable mariadb

# Install Nginx
echo "📦 Installing Nginx..."
sudo apt install -y nginx

# Install Chrome for Puppeteer
echo "📦 Installing Chrome..."
sudo apt install -y chromium-browser

# Install build tools
echo "📦 Installing build tools..."
sudo apt install -y build-essential g++ make python3

# Create directory
echo "📁 Creating directory..."
sudo mkdir -p /var/www/wabot
sudo chown -R $USER:$USER /var/www/wabot

# Copy files (assuming script run from project root)
echo "📁 Copying files..."
cp -r * /var/www/wabot/

# Install dependencies
echo "📦 Installing Node dependencies..."
cd /var/www/wabot
npm install

# Create .env file
echo "📝 Creating .env file..."
cat > .env << EOF
PORT=3000
NODE_ENV=production
DB_HOST=localhost
DB_PORT=3306
DB_NAME=whatsapp_bot
DB_USER=wabot
DB_PASSWORD=WabotStrongPass123!
JWT_SECRET=$(openssl rand -hex 32)
BOT_NAME=WABotGuard
EOF

# Create database
echo "🗄️ Creating database..."
sudo mysql -e "CREATE DATABASE IF NOT EXISTS whatsapp_bot"
sudo mysql -e "CREATE USER IF NOT EXISTS 'wabot'@'localhost' IDENTIFIED BY 'WabotStrongPass123!'"
sudo mysql -e "GRANT ALL PRIVILEGES ON whatsapp_bot.* TO 'wabot'@'localhost'"
sudo mysql -e "FLUSH PRIVILEGES"

# Run database init
echo "🗄️ Initializing database..."
node -e "
const mysql = require('mysql2/promise');
const fs = require('fs');
(async () => {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'wabot',
        password: 'WabotStrongPass123!',
        database: 'whatsapp_bot'
    });
    const sql = fs.readFileSync('database/init.sql', 'utf8');
    const statements = sql.split(';').filter(s => s.trim());
    for (const stmt of statements) {
        try { await conn.execute(stmt); } catch(e) {}
    }
    console.log('Database initialized');
    await conn.end();
})();
"

# Start with PM2
echo "🚀 Starting application..."
pm2 start server.js --name wabot
pm2 save
pm2 startup

# Configure Nginx
echo "🌐 Configuring Nginx..."
sudo tee /etc/nginx/sites-available/wabot > /dev/null << EOF
server {
    listen 80;
    server_name _;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/wabot /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# Setup firewall
echo "🔥 Configuring firewall..."
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 3000
echo "y" | sudo ufw enable

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║     ✅ DEPLOYMENT COMPLETE!              ║"
echo "╠═══════════════════════════════════════════╣"
echo "║  🌐 Access: http://$(curl -s ifconfig.me)  ║"
echo "║  👤 Login: admin / admin123              ║"
echo "╚═══════════════════════════════════════════╝"