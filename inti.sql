-- Create database
CREATE DATABASE IF NOT EXISTS whatsapp_bot;
USE whatsapp_bot;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role ENUM('user', 'admin') DEFAULT 'user',
    telegram_id VARCHAR(50) NULL,
    balance INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Bot settings table
CREATE TABLE IF NOT EXISTS bot_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    anti_spam BOOLEAN DEFAULT TRUE,
    anti_link BOOLEAN DEFAULT TRUE,
    anti_toxic BOOLEAN DEFAULT TRUE,
    anti_virtex BOOLEAN DEFAULT TRUE,
    anti_sticker_spam BOOLEAN DEFAULT FALSE,
    anti_mention_all BOOLEAN DEFAULT TRUE,
    anti_forward BOOLEAN DEFAULT FALSE,
    slow_mode BOOLEAN DEFAULT FALSE,
    auto_welcome BOOLEAN DEFAULT TRUE,
    auto_goodbye BOOLEAN DEFAULT FALSE,
    auto_kick BOOLEAN DEFAULT FALSE,
    auto_warn BOOLEAN DEFAULT TRUE,
    ai_moderation BOOLEAN DEFAULT FALSE,
    max_messages_per_minute INT DEFAULT 5,
    max_sticker_per_minute INT DEFAULT 3,
    slow_mode_delay INT DEFAULT 5,
    max_warnings INT DEFAULT 3,
    allowed_domains TEXT,
    banned_words TEXT,
    auto_replies TEXT,
    welcome_message TEXT DEFAULT 'Selamat datang {name} di grup {group}! Semoga betah ya 😊',
    goodbye_message TEXT DEFAULT 'Selamat tinggal {name}, semoga sukses di tempat lain! 👋',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Bot logs table
CREATE TABLE IF NOT EXISTS bot_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    group_id VARCHAR(100),
    user_target VARCHAR(100),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_type (type),
    INDEX idx_timestamp (timestamp)
);

-- Groups table
CREATE TABLE IF NOT EXISTS groups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    group_id VARCHAR(100) NOT NULL,
    group_name VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_group (user_id, group_id)
);

-- Scheduled messages table
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    group_id VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    schedule_time DATETIME NOT NULL,
    sent BOOLEAN DEFAULT FALSE,
    sent_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_schedule (schedule_time, sent)
);

-- Active polls table
CREATE TABLE IF NOT EXISTS active_polls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    poll_id VARCHAR(50) NOT NULL,
    group_id VARCHAR(100) NOT NULL,
    question TEXT NOT NULL,
    options JSON NOT NULL,
    votes JSON NOT NULL,
    voters JSON NOT NULL,
    created_by INT,
    end_time DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_poll_id (poll_id)
);

-- Insert default admin
INSERT INTO users (name, email, username, password, role) 
SELECT 'Administrator', 'admin@wabot.com', 'admin', '$2a$10$YourHashedPasswordHere', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin');

-- Insert default settings for admin
INSERT INTO bot_settings (user_id, anti_spam, anti_link, anti_toxic, auto_welcome)
SELECT id, TRUE, TRUE, TRUE, TRUE FROM users WHERE username = 'admin'
WHERE NOT EXISTS (SELECT 1 FROM bot_settings WHERE user_id = (SELECT id FROM users WHERE username = 'admin'));