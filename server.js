require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@libsql/client');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e7, cors: { origin: "*" } });

// --- 1. НАСТРОЙКА CLOUDINARY ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: { folder: 'kittycord_uploads', allowed_formats: ['jpg', 'png', 'gif', 'jpeg', 'webm', 'mp4', 'mp3', 'wav', 'ogg'] },
});
const upload = multer({ storage: storage, limits: { fileSize: 100 * 1024 * 1024 } });

// --- 2. НАСТРОЙКА TURSO ---
const db = createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, avatar TEXT DEFAULT '', bio TEXT DEFAULT '', banner_color TEXT DEFAULT '#FF4DA6', banner_image TEXT DEFAULT '', display_name TEXT DEFAULT '', custom_status TEXT DEFAULT '', activity TEXT DEFAULT '', social_links TEXT DEFAULT '', pronouns TEXT DEFAULT '', reg_date DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, recipient TEXT, content TEXT, type TEXT DEFAULT 'text', reply_author TEXT DEFAULT '', reply_text TEXT DEFAULT '', is_pinned BOOLEAN DEFAULT 0, reactions TEXT DEFAULT '{}', timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS friends (id INTEGER PRIMARY KEY AUTOINCREMENT, requester TEXT, receiver TEXT, status TEXT DEFAULT 'pending')`);
    await db.execute(`CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, icon TEXT DEFAULT '', banner TEXT DEFAULT '', owner TEXT, invite_code TEXT UNIQUE)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS server_members (server_id INTEGER, username TEXT, roles TEXT DEFAULT '[]')`);
    await db.execute(`CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, name TEXT, permissions TEXT DEFAULT '{}')`);
    await db.execute(`CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, name TEXT, color TEXT, can_manage_channels BOOLEAN DEFAULT 0, can_manage_messages BOOLEAN DEFAULT 0)`);
    console.log("База данных Turso подключена и готова!");
}

// --- 3. API МАРШРУТЫ (С ПРЕДОХРАНИТЕЛЯМИ) ---
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    res.json({ success: true, url: req.file.path });
});

app.post('/api/register', async (req, res) => {
    try {
        await db.execute({ sql: `INSERT INTO users (username, password) VALUES (?, ?)`, args: [req.body.username, req.body.password] });
        res.json({ success: true, username: req.body.username, avatar: '', bio: '' });
    } catch (err) { res.status(400).json({ error: 'Имя уже занято' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const rs = await db.execute({ sql: `SELECT * FROM users WHERE username = ? AND password = ?`, args: [req.body.username, req.body.password] });
        if (rs.rows.length > 0) res.json({ success: true, ...rs.rows[0] });
        else res.status(401).json({ error: 'Неверный логин/пароль' });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/autologin', async (req, res) => {
    try {
        const rs = await db.execute({ sql: `SELECT * FROM users WHERE username = ?`, args: [req.body.username] });
        if (rs.rows.length > 0) res.json({ success: true, ...rs.rows[0] });
        else res.status(401).json({ error: 'Сессия истекла' });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/profile', async (req, res) => {
    try {
        const { avatar, bio, banner_color, banner_image, display_name, custom_status, activity, social_links, pronouns, username } = req.body;
        await db.execute({ sql: `UPDATE users SET avatar=?, bio=?, banner_color=?, banner_image=?, display_name=?, custom_status=?, activity=?, social_links=?, pronouns=? WHERE username=?`, args: [avatar, bio, banner_color, banner_image, display_name, custom_status, activity, social_links, pronouns, username] });
        res.json({ success: true }); io.emit('profile_updated', req.body);
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/user/:username', async (req, res) => {
    try {
        const rs = await db.execute({ sql: `SELECT * FROM users WHERE username = ?`, args: [req.params.username] });
        if (rs.rows.length > 0) res.json({ success: true, ...rs.rows[0] }); else res.status(404).json({ error: 'Не найден' });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/users', async (req, res) => {
    try {
        const rs = await db.execute(`SELECT username, display_name, avatar FROM users`);
        res.json({ success: true, users: rs.rows || [] });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/dms/:username', async (req, res) => {
    try {
        const u = req.params.username;
        const rs = await db.execute({ sql: `SELECT DISTINCT sender, recipient FROM messages WHERE sender = ? OR recipient = ?`, args: [u, u] });
        const dms = new Set();
        if (rs.rows) rs.rows.forEach(r => { if (r.sender !== 'general' && r.recipient !== 'general' && r.recipient && !r.recipient.startsWith('channel_')) dms.add(r.sender === u ? r.recipient : r.sender); });
        dms.delete(u); res.json({ success: true, dms: Array.from(dms) });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/friends/:username', async (req, res) => {
    try {
        const rs = await db.execute({ sql: `SELECT * FROM friends WHERE requester = ? OR receiver = ?`, args: [req.params.username, req.params.username] });
        res.json({ success: true, friends: rs.rows || [] });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/friends/request', async (req, res) => {
    try {
        const { requester, receiver } = req.body;
        const rs = await db.execute({ sql: `SELECT id FROM users WHERE username = ?`, args: [receiver] });
        if (rs.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
        await db.execute({ sql: `INSERT INTO friends (requester, receiver, status) VALUES (?, ?, 'pending')`, args: [requester, receiver] });
        res.json({ success: true }); io.emit('friend_update', { user: receiver });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/friends/action', async (req, res) => {
    try {
        const { requester, receiver, action } = req.body;
        if (action === 'accept') await db.execute({ sql: `UPDATE friends SET status = 'accepted' WHERE requester = ? AND receiver = ?`, args: [requester, receiver] });
        else await db.execute({ sql: `DELETE FROM friends WHERE requester = ? AND receiver = ?`, args: [requester, receiver] });
        res.json({ success: true }); io.emit('friend_update', { user: requester });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

function generateInviteCode() { return Math.random().toString(36).substring(2, 8); }

app.post('/api/servers/create', async (req, res) => {
    try {
        const { name, owner } = req.body; const invite_code = generateInviteCode();
        const rs = await db.execute({ sql: `INSERT INTO servers (name, owner, invite_code) VALUES (?, ?, ?)`, args: [name, owner, invite_code] });
        const serverId = Number(rs.lastInsertRowid);
        await db.execute({ sql: `INSERT INTO server_members (server_id, username, roles) VALUES (?, ?, '[]')`, args: [serverId, owner] });
        await db.execute({ sql: `INSERT INTO channels (server_id, name, permissions) VALUES (?, 'основной', '{}')`, args: [serverId] });
        res.json({ success: true, server: { id: serverId, name, invite_code } });
    } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/servers/join', async (req, res) => {
    try {
        const { invite_code, username } = req.body;
        const sRs = await db.execute({ sql: `SELECT id, name FROM servers WHERE invite_code = ?`, args: [invite_code] });
        if (sRs.rows.length === 0) return res.status(404).json({ error: 'Неверный код' });
        const server = sRs.rows[0];
        const mRs = await db.execute({ sql: `SELECT * FROM server_members WHERE server_id = ? AND username = ?`, args: [server.id, username] });
        if (mRs.rows.length > 0) return res.status(400).json({ error: 'Уже тут' });
        await db.execute({ sql: `INSERT INTO server_members (server_id, username, roles) VALUES (?, ?, '[]')`, args: [server.id, username] });
        res.json({ success: true, server });
    } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/servers/list/:username', async (req, res) => {
    try {
        const rs = await db.execute({ sql: `SELECT s.id, s.name, s.icon, s.invite_code, s.owner FROM servers s JOIN server_members sm ON s.id = sm.server_id WHERE sm.username = ?`, args: [req.params.username] });
        res.json({ success: true, servers: rs.rows || [] });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/servers/info/:id', async (req, res) => {
    try {
        const rs = await db.execute({ sql: `SELECT * FROM servers WHERE id = ?`, args: [req.params.id] });
        if (rs.rows.length > 0) res.json({ success: true, server: rs.rows[0] }); else res.status(404).json({ error: 'Не найден' });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/servers/edit', async (req, res) => {
    try {
        await db.execute({ sql: `UPDATE servers SET name = ?, icon = ? WHERE id = ?`, args: [req.body.name, req.body.icon, req.body.server_id] });
        res.json({ success: true }); io.emit('server_updated', { server_id: req.body.server_id });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/servers/leave', async (req, res) => {
    try {
        await db.execute({ sql: `DELETE FROM server_members WHERE server_id = ? AND username = ?`, args: [req.body.server_id, req.body.username] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/servers/:id/roles', async (req, res) => {
    try {
        const rs = await db.execute({ sql: `SELECT * FROM roles WHERE server_id = ?`, args: [req.params.id] });
        res.json({ success: true, roles: rs.rows || [] });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/roles/create', async (req, res) => {
    try {
        await db.execute({ sql: `INSERT INTO roles (server_id, name, color, can_manage_channels, can_manage_messages) VALUES (?, ?, ?, ?, ?)`, args: [req.body.server_id, req.body.name, req.body.color, req.body.can_manage_channels ? 1 : 0, req.body.can_manage_messages ? 1 : 0] });
        res.json({ success: true }); io.emit('server_updated', { server_id: req.body.server_id });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/roles/delete', async (req, res) => {
    try {
        await db.execute({ sql: `DELETE FROM roles WHERE id = ?`, args: [req.body.role_id] });
        res.json({ success: true }); io.emit('server_updated', { server_id: req.body.server_id });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/servers/:id/members', async (req, res) => {
    try {
        const rs = await db.execute({ sql: `SELECT sm.username, sm.roles, u.display_name, u.avatar FROM server_members sm JOIN users u ON sm.username = u.username WHERE sm.server_id = ?`, args: [req.params.id] });
        res.json({ success: true, members: rs.rows || [] });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/members/roles/update', async (req, res) => {
    try {
        await db.execute({ sql: `UPDATE server_members SET roles = ? WHERE server_id = ? AND username = ?`, args: [JSON.stringify(req.body.roles), req.body.server_id, req.body.username] });
        res.json({ success: true }); io.emit('server_updated', { server_id: req.body.server_id });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/servers/:id/channels', async (req, res) => {
    try {
        const rs = await db.execute({ sql: `SELECT * FROM channels WHERE server_id = ?`, args: [req.params.id] });
        res.json({ success: true, channels: rs.rows || [] });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/channels/create', async (req, res) => {
    try {
        const p = req.body.permissions ? JSON.stringify(req.body.permissions) : '{}';
        await db.execute({ sql: `INSERT INTO channels (server_id, name, permissions) VALUES (?, ?, ?)`, args: [req.body.server_id, req.body.name, p] });
        res.json({ success: true }); io.emit('channel_update', { server_id: req.body.server_id });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/channels/edit', async (req, res) => {
    try {
        const p = req.body.permissions ? JSON.stringify(req.body.permissions) : '{}';
        await db.execute({ sql: `UPDATE channels SET name = ?, permissions = ? WHERE id = ?`, args: [req.body.name, p, req.body.channel_id] });
        res.json({ success: true }); io.emit('channel_update', { server_id: req.body.server_id });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/channels/delete', async (req, res) => {
    try {
        await db.execute({ sql: `DELETE FROM channels WHERE id = ?`, args: [req.body.channel_id] });
        await db.execute({ sql: `DELETE FROM messages WHERE recipient = ?`, args: [`channel_${req.body.channel_id}`] });
        res.json({ success: true }); io.emit('channel_update', { server_id: req.body.server_id });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.get('/api/channels/:id/pins', async (req, res) => {
    try {
        const rs = await db.execute({ sql: `SELECT m.*, u.avatar, u.display_name FROM messages m JOIN users u ON m.sender = u.username WHERE recipient = ? AND is_pinned = 1`, args: [`channel_${req.params.id}`] });
        res.json({ success: true, pins: rs.rows || [] });
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/messages/pin', async (req, res) => {
    try {
        await db.execute({ sql: `UPDATE messages SET is_pinned = ? WHERE id = ?`, args: [req.body.pin ? 1 : 0, req.body.id] });
        const rs = await db.execute({ sql: 'SELECT * FROM messages WHERE id = ?', args: [req.body.id] });
        res.json({ success: true }); io.emit('message_updated', rs.rows[0]);
    } catch (e) { res.status(500).json({ error: 'Ошибка БД' }); }
});

app.post('/api/messages/react', async (req, res) => {
    try {
        const { id, emoji, username } = req.body;
        const rs = await db.execute({ sql: 'SELECT reactions FROM messages WHERE id = ?', args: [id] });
        if (rs.rows.length === 0) return res.status(404).json({ error: 'Сообщение не найдено' });

        let reactions = {};
        try { reactions = JSON.parse(rs.rows[0].reactions || '{}'); } catch (e) { }

        if (!reactions[emoji]) reactions[emoji] = [];
        const userIndex = reactions[emoji].indexOf(username);

        if (userIndex > -1) {
            reactions[emoji].splice(userIndex, 1);
            if (reactions[emoji].length === 0) delete reactions[emoji];
        } else {
            reactions[emoji].push(username);
        }

        await db.execute({ sql: `UPDATE messages SET reactions = ? WHERE id = ?`, args: [JSON.stringify(reactions), id] });
        const updatedMsg = await db.execute({ sql: 'SELECT * FROM messages WHERE id = ?', args: [id] });
        res.json({ success: true });
        io.emit('message_updated', updatedMsg.rows[0]);
    } catch (error) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// --- 4. WEBSOCKETS (ЧАТ) ---
io.on('connection', (socket) => {
    socket.on('get_history', async (data) => {
        try {
            const { username, chatWith } = data; let query;
            if (chatWith === 'general') query = `SELECT m.*, u.avatar, u.display_name FROM messages m LEFT JOIN users u ON m.sender = u.username WHERE recipient = 'general' ORDER BY timestamp ASC LIMIT 100`;
            else if (chatWith.startsWith('channel_')) query = `SELECT m.*, u.avatar, u.display_name FROM messages m LEFT JOIN users u ON m.sender = u.username WHERE recipient = '${chatWith}' ORDER BY timestamp ASC LIMIT 100`;
            else query = `SELECT m.*, u.avatar, u.display_name FROM messages m LEFT JOIN users u ON m.sender = u.username WHERE (sender = '${username}' AND recipient = '${chatWith}') OR (sender = '${chatWith}' AND recipient = '${username}') ORDER BY timestamp ASC LIMIT 100`;

            const rs = await db.execute(query);
            if (rs.rows) socket.emit('load_history', rs.rows);
        } catch (e) { console.error("Ошибка сокетов:", e); }
    });

    socket.on('send_message', async (data) => {
        try {
            const rs = await db.execute({
                sql: `INSERT INTO messages (sender, recipient, content, type, reply_author, reply_text) VALUES (?, ?, ?, ?, ?, ?)`,
                args: [data.sender, data.recipient, data.content, data.type, data.reply_author || '', data.reply_text || '']
            });
            const msgId = Number(rs.lastInsertRowid);
            const uRs = await db.execute({ sql: `SELECT avatar, display_name FROM users WHERE username = ?`, args: [data.sender] });
            const row = uRs.rows[0];
            io.emit('receive_message', { ...data, id: msgId, avatar: row?.avatar || '', display_name: row?.display_name || '', reactions: '{}', is_pinned: 0, timestamp: new Date() });
        } catch (e) { console.error("Ошибка отправки:", e); }
    });

    socket.on('delete_message', async (data) => {
        try {
            const rs = await db.execute({ sql: `DELETE FROM messages WHERE id = ?`, args: [data.id] });
            if (rs.rowsAffected > 0) io.emit('message_deleted', { id: data.id, chatWith: data.chatWith });
        } catch (e) { console.error("Ошибка удаления:", e); }
    });
});

// --- 5. БЕЗОПАСНЫЙ ЗАПУСК СЕРВЕРА ---
// Ждем, пока создадутся таблицы, и только потом открываем двери для пользователей
initDB().then(() => {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`KittyCord server running on port ${PORT}`));
}).catch(err => {
    console.error("Критическая ошибка при старте БД:", err);
});