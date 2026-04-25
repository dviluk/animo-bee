CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_camera TEXT NOT NULL,
    original_path TEXT NOT NULL,
    current_path TEXT NOT NULL,
    stable_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN (
            'detected',
            'ready',
            'processing',
            'accepted',
            'rejected',
            'queued',
            'uploading',
            'uploaded',
            'failed'
        )
    ),
    checksum TEXT,
    size_bytes INTEGER,
    mtime_ms REAL,
    opencv_enabled INTEGER NOT NULL DEFAULT 0 CHECK (opencv_enabled IN (0, 1)),
    opencv_mode TEXT NOT NULL DEFAULT 'disabled' CHECK (
        opencv_mode IN (
            'disabled',
            'shadow',
            'enforce'
        )
    ),
    opencv_status TEXT CHECK (
        opencv_status IS NULL
        OR opencv_status IN (
            'skipped',
            'pending',
            'processing',
            'completed',
            'failed'
        )
    ),
    opencv_decision TEXT CHECK (
        opencv_decision IS NULL
        OR opencv_decision IN ('accept', 'reject', 'maybe')
    ),
    opencv_reason TEXT,
    opencv_scores_json TEXT,
    opencv_error TEXT,
    opencv_processed_at TEXT,
    decision TEXT CHECK (
        decision IS NULL
        OR decision IN ('accepted', 'rejected')
    ),
    decision_reason TEXT,
    metadata_json TEXT,
    queued_at TEXT,
    uploaded_at TEXT,
    routed_at TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (original_path, stable_at)
);

CREATE INDEX IF NOT EXISTS idx_clips_status_updated_at ON clips (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_clips_source_camera ON clips (source_camera);

CREATE TABLE IF NOT EXISTS upload_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id INTEGER NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    response_status INTEGER,
    error_summary TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (clip_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS runtime_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS irrigation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    payload_json TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL
);