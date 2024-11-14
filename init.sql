CREATE TABLE groups (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    owner_jid VARCHAR(255),
    creation_time TIMESTAMP,
    participant_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
    id VARCHAR(255) PRIMARY KEY,
    group_id VARCHAR(255) REFERENCES groups(id),
    sender_jid VARCHAR(255) NOT NULL,
    message_type VARCHAR(50),
    content TEXT,
    timestamp BIGINT NOT NULL,
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_messages_group_id ON messages(group_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);