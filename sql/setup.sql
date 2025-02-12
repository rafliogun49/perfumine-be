CREATE TABLE user_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    q1 TEXT,
    q2 TEXT,
    q3 TEXT,
    q4 TEXT,
    q5 TEXT,
    q6 TEXT,
    q7 TEXT,
    q8 TEXT,
    q9 TEXT,
    q10 TEXT,
    characteristics TEXT,
    ideal_scent TEXT,
    persona TEXT,
    query TEXT,
    recommendations TEXT, -- Disimpan dalam bentuk JSON array
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
