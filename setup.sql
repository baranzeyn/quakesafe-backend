-- QuakeSafe MySQL Database Setup

-- Veritabanını oluştur
CREATE DATABASE IF NOT EXISTS quakesafe CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE quakesafe;

-- 1. Kullanıcı token'ları tablosu
CREATE TABLE IF NOT EXISTS user_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token VARCHAR(500) NOT NULL UNIQUE,
    latitude DECIMAL(10, 8) NULL,
    longitude DECIMAL(11, 8) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_token (token),
    INDEX idx_location (latitude, longitude)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Kullanıcı tercihleri tablosu
CREATE TABLE IF NOT EXISTS user_preferences (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_token VARCHAR(500) NOT NULL,
    selected_data_source VARCHAR(50) NULL DEFAULT NULL,
    magnitude_threshold DECIMAL(3, 1) DEFAULT 4.0,
    distance_threshold INT DEFAULT 140,
    notifications_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_token) REFERENCES user_tokens(token) ON DELETE CASCADE,
    INDEX idx_user_token (user_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Kullanıcı bildirimleri geçmişi tablosu
CREATE TABLE IF NOT EXISTS user_notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    earthquake_id VARCHAR(255) NOT NULL,
    user_token VARCHAR(500) NOT NULL,
    location VARCHAR(500) NOT NULL,
    magnitude DECIMAL(3, 1) NOT NULL,
    distance DECIMAL(6, 1) DEFAULT 0,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    source VARCHAR(50) NOT NULL,
    notification_type VARCHAR(50) NOT NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_token) REFERENCES user_tokens(token) ON DELETE CASCADE,
    INDEX idx_earthquake_user (earthquake_id, user_token),
    INDEX idx_user_token (user_token),
    INDEX idx_timestamp (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Deprem verileri tablosu (opsiyonel - cache için)
CREATE TABLE IF NOT EXISTS earthquakes (
    id VARCHAR(255) PRIMARY KEY,
    location VARCHAR(500) NOT NULL,
    magnitude DECIMAL(3, 1) NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    depth DECIMAL(6, 1) NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    source VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_location (latitude, longitude),
    INDEX idx_magnitude (magnitude),
    INDEX idx_timestamp (timestamp),
    INDEX idx_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. API log tablosu (opsiyonel - debugging için)
CREATE TABLE IF NOT EXISTS api_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    source VARCHAR(50) NOT NULL,
    request_url TEXT,
    response_status INT,
    earthquakes_found INT DEFAULT 0,
    notifications_sent INT DEFAULT 0,
    error_message TEXT NULL,
    execution_time_ms INT DEFAULT 0,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_source (source),
    INDEX idx_timestamp (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Test verisi ekle (opsiyonel)
INSERT INTO user_tokens (token, latitude, longitude) VALUES
('test_token_123', 39.9334, 32.8597)
ON DUPLICATE KEY UPDATE token = token;

-- İndex optimizasyonları
OPTIMIZE TABLE user_tokens;
OPTIMIZE TABLE user_preferences;
OPTIMIZE TABLE user_notifications;
OPTIMIZE TABLE earthquakes;
OPTIMIZE TABLE api_logs;