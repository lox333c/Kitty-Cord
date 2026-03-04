const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e7 });

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const db = new sqlite3.Database('./kittydb.sqlite');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, avatar TEXT DEFAULT '', bio TEXT DEFAULT '', banner_color TEXT DEFAULT '#FF4DA6', banner_image TEXT DEFAULT '', display_name TEXT DEFAULT '', custom_status TEXT DEFAULT '', activity TEXT DEFAULT '', social_links TEXT DEFAULT '', pronouns TEXT DEFAULT '', reg_date DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, recipient TEXT, content TEXT, type TEXT DEFAULT 'text', reply_author TEXT DEFAULT '', reply_text TEXT DEFAULT '', is_pinned BOOLEAN DEFAULT 0, reactions TEXT DEFAULT '{}', timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS friends (id INTEGER PRIMARY KEY AUTOINCREMENT, requester TEXT, receiver TEXT, status TEXT DEFAULT 'pending')`);
    db.run(`CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, icon TEXT DEFAULT '', banner TEXT DEFAULT '', owner TEXT, invite_code TEXT UNIQUE)`);
    db.run(`CREATE TABLE IF NOT EXISTS server_members (server_id INTEGER, username TEXT, roles TEXT DEFAULT '[]')`);
    db.run(`CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, name TEXT, permissions TEXT DEFAULT '{}')`);
    db.run(`CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, name TEXT, color TEXT, can_manage_channels BOOLEAN DEFAULT 0, can_manage_messages BOOLEAN DEFAULT 0)`);

    db.run(`ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '{}'`, (err) => { });
    db.run(`ALTER TABLE messages ADD COLUMN is_pinned BOOLEAN DEFAULT 0`, (err) => { });
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({ destination: (req, file, cb) => cb(null, uploadsDir), filename: (req, file, cb) => { const ext = file.originalname.split('.').pop() || file.mimetype.split('/')[1]; cb(null, `file_${Date.now()}.${ext}`); } });
const upload = multer({ storage: storage, limits: { fileSize: 100 * 1024 * 1024 } });

app.post('/api/upload', upload.single('file'), (req, res) => { if (!req.file) return res.status(400).json({ error: 'Нет файла' }); res.json({ success: true, url: `/uploads/${req.file.filename}` }); });
app.post('/api/register', (req, res) => { db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [req.body.username, req.body.password], function (err) { if (err) return res.status(400).json({ error: 'Имя уже занято' }); res.json({ success: true, username: req.body.username, avatar: '', bio: '' }); }); });
app.post('/api/login', (req, res) => { db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [req.body.username, req.body.password], (err, row) => { if (row) res.json({ success: true, ...row }); else res.status(401).json({ error: 'Неверный логин/пароль' }); }); });
app.post('/api/autologin', (req, res) => { db.get(`SELECT * FROM users WHERE username = ?`, [req.body.username], (err, row) => { if (row) res.json({ success: true, ...row }); else res.status(401).json({ error: 'Сессия истекла' }); }); });
app.post('/api/profile', (req, res) => { const { avatar, bio, banner_color, banner_image, display_name, custom_status, activity, social_links, pronouns, username } = req.body; db.run(`UPDATE users SET avatar=?, bio=?, banner_color=?, banner_image=?, display_name=?, custom_status=?, activity=?, social_links=?, pronouns=? WHERE username=?`, [avatar, bio, banner_color, banner_image, display_name, custom_status, activity, social_links, pronouns, username], (err) => { if (err) return res.status(500).json({ error: 'Ошибка БД' }); res.json({ success: true }); io.emit('profile_updated', req.body); }); });
app.get('/api/user/:username', (req, res) => { db.get(`SELECT * FROM users WHERE username = ?`, [req.params.username], (err, row) => { if (row) res.json({ success: true, ...row }); else res.status(404).json({ error: 'Не найден' }); }); });
app.get('/api/users', (req, res) => { db.all(`SELECT username, display_name, avatar FROM users`, [], (err, rows) => res.json({ success: true, users: rows || [] })); });
app.get('/api/dms/:username', (req, res) => { const u = req.params.username; db.all(`SELECT DISTINCT sender, recipient FROM messages WHERE sender = ? OR recipient = ?`, [u, u], (err, rows) => { const dms = new Set(); if (rows) rows.forEach(r => { if (r.sender !== 'general' && r.recipient !== 'general' && !r.recipient.startsWith('channel_')) dms.add(r.sender === u ? r.recipient : r.sender); }); dms.delete(u); res.json({ success: true, dms: Array.from(dms) }); }); });
app.get('/api/friends/:username', (req, res) => { db.all(`SELECT * FROM friends WHERE requester = ? OR receiver = ?`, [req.params.username, req.params.username], (err, rows) => { res.json({ success: true, friends: rows || [] }); }); });
app.post('/api/friends/request', (req, res) => { const { requester, receiver } = req.body; db.get(`SELECT id FROM users WHERE username = ?`, [receiver], (err, row) => { if (!row) return res.status(404).json({ error: 'Не найден' }); db.run(`INSERT INTO friends (requester, receiver, status) VALUES (?, ?, 'pending')`, [requester, receiver], (err) => { res.json({ success: true }); io.emit('friend_update', { user: receiver }); }); }); });
app.post('/api/friends/action', (req, res) => { const { requester, receiver, action } = req.body; if (action === 'accept') db.run(`UPDATE friends SET status = 'accepted' WHERE requester = ? AND receiver = ?`, [requester, receiver], () => { res.json({ success: true }); io.emit('friend_update', { user: requester }); }); else db.run(`DELETE FROM friends WHERE requester = ? AND receiver = ?`, [requester, receiver], () => { res.json({ success: true }); io.emit('friend_update', { user: requester }); }); });

function generateInviteCode() { return Math.random().toString(36).substring(2, 8); }
app.post('/api/servers/create', (req, res) => { const { name, owner } = req.body; const invite_code = generateInviteCode(); db.run(`INSERT INTO servers (name, owner, invite_code) VALUES (?, ?, ?)`, [name, owner, invite_code], function (err) { if (err) return res.status(500).json({ error: 'Ошибка' }); const serverId = this.lastID; db.run(`INSERT INTO server_members (server_id, username, roles) VALUES (?, ?, '[]')`, [serverId, owner]); db.run(`INSERT INTO channels (server_id, name, permissions) VALUES (?, 'основной', '{}')`, [serverId]); res.json({ success: true, server: { id: serverId, name, invite_code } }); }); });
app.post('/api/servers/join', (req, res) => { const { invite_code, username } = req.body; db.get(`SELECT id, name FROM servers WHERE invite_code = ?`, [invite_code], (err, server) => { if (!server) return res.status(404).json({ error: 'Неверный код' }); db.get(`SELECT * FROM server_members WHERE server_id = ? AND username = ?`, [server.id, username], (err, member) => { if (member) return res.status(400).json({ error: 'Уже тут' }); db.run(`INSERT INTO server_members (server_id, username, roles) VALUES (?, ?, '[]')`, [server.id, username], () => { res.json({ success: true, server }); }); }); }); });
app.get('/api/servers/list/:username', (req, res) => { db.all(`SELECT s.id, s.name, s.icon, s.invite_code, s.owner FROM servers s JOIN server_members sm ON s.id = sm.server_id WHERE sm.username = ?`, [req.params.username], (err, rows) => { res.json({ success: true, servers: rows || [] }); }); });
app.get('/api/servers/info/:id', (req, res) => { db.get(`SELECT * FROM servers WHERE id = ?`, [req.params.id], (err, row) => { if (row) res.json({ success: true, server: row }); else res.status(404).json({ error: 'Не найден' }); }); });
app.post('/api/servers/edit', (req, res) => { db.run(`UPDATE servers SET name = ?, icon = ? WHERE id = ?`, [req.body.name, req.body.icon, req.body.server_id], () => { res.json({ success: true }); io.emit('server_updated', { server_id: req.body.server_id }); }); });
app.post('/api/servers/leave', (req, res) => { db.run(`DELETE FROM server_members WHERE server_id = ? AND username = ?`, [req.body.server_id, req.body.username], () => { res.json({ success: true }); }); });

app.get('/api/servers/:id/roles', (req, res) => { db.all(`SELECT * FROM roles WHERE server_id = ?`, [req.params.id], (err, rows) => res.json({ success: true, roles: rows || [] })); });
app.post('/api/roles/create', (req, res) => { db.run(`INSERT INTO roles (server_id, name, color, can_manage_channels, can_manage_messages) VALUES (?, ?, ?, ?, ?)`, [req.body.server_id, req.body.name, req.body.color, req.body.can_manage_channels, req.body.can_manage_messages], function () { res.json({ success: true }); io.emit('server_updated', { server_id: req.body.server_id }); }); });
app.post('/api/roles/delete', (req, res) => { db.run(`DELETE FROM roles WHERE id = ?`, [req.body.role_id], () => { res.json({ success: true }); io.emit('server_updated', { server_id: req.body.server_id }); }); });
app.get('/api/servers/:id/members', (req, res) => { db.all(`SELECT sm.username, sm.roles, u.display_name, u.avatar FROM server_members sm JOIN users u ON sm.username = u.username WHERE sm.server_id = ?`, [req.params.id], (err, rows) => res.json({ success: true, members: rows || [] })); });
app.post('/api/members/roles/update', (req, res) => { db.run(`UPDATE server_members SET roles = ? WHERE server_id = ? AND username = ?`, [JSON.stringify(req.body.roles), req.body.server_id, req.body.username], () => { res.json({ success: true }); io.emit('server_updated', { server_id: req.body.server_id }); }); });

app.get('/api/servers/:id/channels', (req, res) => { db.all(`SELECT * FROM channels WHERE server_id = ?`, [req.params.id], (err, rows) => { res.json({ success: true, channels: rows || [] }); }); });
app.post('/api/channels/create', (req, res) => { const p = req.body.permissions ? JSON.stringify(req.body.permissions) : '{}'; db.run(`INSERT INTO channels (server_id, name, permissions) VALUES (?, ?, ?)`, [req.body.server_id, req.body.name, p], function (err) { res.json({ success: true }); io.emit('channel_update', { server_id: req.body.server_id }); }); });
app.post('/api/channels/edit', (req, res) => { const p = req.body.permissions ? JSON.stringify(req.body.permissions) : '{}'; db.run(`UPDATE channels SET name = ?, permissions = ? WHERE id = ?`, [req.body.name, p, req.body.channel_id], function (err) { res.json({ success: true }); io.emit('channel_update', { server_id: req.body.server_id }); }); });
app.post('/api/channels/delete', (req, res) => { db.run(`DELETE FROM channels WHERE id = ?`, [req.body.channel_id], () => { db.run(`DELETE FROM messages WHERE recipient = ?`, [`channel_${req.body.channel_id}`], () => { res.json({ success: true }); io.emit('channel_update', { server_id: req.body.server_id }); }); }); });

app.get('/api/channels/:id/pins', (req, res) => { db.all(`SELECT m.*, u.avatar, u.display_name FROM messages m JOIN users u ON m.sender = u.username WHERE recipient = ? AND is_pinned = 1`, [`channel_${req.params.id}`], (err, rows) => res.json({ success: true, pins: rows || [] })); });
app.post('/api/messages/pin', (req, res) => { db.run(`UPDATE messages SET is_pinned = ? WHERE id = ?`, [req.body.pin ? 1 : 0, req.body.id], () => { res.json({ success: true }); io.emit('message_updated', { id: req.body.id }); }); });
app.post('/api/messages/react', (req, res) => {
    db.get(`SELECT reactions FROM messages WHERE id = ?`, [req.body.id], (err, row) => {
        let r = {}; try { r = JSON.parse(row.reactions || '{}'); } catch (e) { }
        if (!r[req.body.emoji]) r[req.body.emoji] = [];
        if (r[req.body.emoji].includes(req.body.username)) { r[req.body.emoji] = r[req.body.emoji].filter(u => u !== req.body.username); if (r[req.body.emoji].length === 0) delete r[req.body.emoji]; }
        else { r[req.body.emoji].push(req.body.username); }
        db.run(`UPDATE messages SET reactions = ? WHERE id = ?`, [JSON.stringify(r), req.body.id], () => { res.json({ success: true }); io.emit('message_updated', { id: req.body.id }); });
    });
});

io.on('connection', (socket) => {
    socket.on('get_history', (data) => {
        const { username, chatWith } = data; let query;
        if (chatWith === 'general') query = `SELECT m.*, u.avatar, u.display_name FROM messages m LEFT JOIN users u ON m.sender = u.username WHERE recipient = 'general' ORDER BY timestamp ASC LIMIT 100`;
        else if (chatWith.startsWith('channel_')) query = `SELECT m.*, u.avatar, u.display_name FROM messages m LEFT JOIN users u ON m.sender = u.username WHERE recipient = '${chatWith}' ORDER BY timestamp ASC LIMIT 100`;
        else query = `SELECT m.*, u.avatar, u.display_name FROM messages m LEFT JOIN users u ON m.sender = u.username WHERE (sender = '${username}' AND recipient = '${chatWith}') OR (sender = '${chatWith}' AND recipient = '${username}') ORDER BY timestamp ASC LIMIT 100`;
        db.all(query, [], (err, rows) => { if (rows) socket.emit('load_history', rows); });
    });
    socket.on('send_message', (data) => {
        db.run(`INSERT INTO messages (sender, recipient, content, type, reply_author, reply_text) VALUES (?, ?, ?, ?, ?, ?)`,
            [data.sender, data.recipient, data.content, data.type, data.reply_author || '', data.reply_text || ''], function (err) {
                const msgId = this.lastID;
                db.get(`SELECT avatar, display_name FROM users WHERE username = ?`, [data.sender], (err, row) => {
                    io.emit('receive_message', { ...data, id: msgId, avatar: row?.avatar || '', display_name: row?.display_name || '', reactions: '{}', is_pinned: 0, timestamp: new Date() });
                });
            });
    });
    socket.on('delete_message', (data) => { db.run(`DELETE FROM messages WHERE id = ?`, [data.id], function (err) { if (this.changes > 0) io.emit('message_deleted', { id: data.id, chatWith: data.chatWith }); }); });
});

const PORT = 3000; server.listen(PORT, () => console.log(`Сервер запущен на http://localhost:${PORT}`));