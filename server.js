require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@libsql/client');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json()); // ВАЖНО: без этого сервер не сможет читать JSON в запросах реакций!

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- 1. НАСТРОЙКА CLOUDINARY (КАРТИНКИ) ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'kittycord_uploads',
        allowed_formats: ['jpg', 'png', 'gif', 'jpeg']
    },
});
const upload = multer({ storage: storage });

// --- 2. НАСТРОЙКА TURSO (БАЗА ДАННЫХ) ---
const db = createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
    try {
        // Создаем таблицу с колонкой reactions
        await db.execute(`
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            text TEXT,
            imageUrl TEXT,
            reactions TEXT DEFAULT '{}',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Хак: Если таблица была создана раньше без reactions, пытаемся её добавить
        try {
            await db.execute(`ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '{}'`);
        } catch (e) {
            // Ошибка здесь - это нормально, значит колонка уже существует
        }

        console.log("База данных Turso подключена и готова!");
    } catch (error) {
        console.error("Ошибка при создании таблицы:", error);
    }
}
initDB();

// --- 3. РУЧКА ДЛЯ ЗАГРУЗКИ КАРТИНОК ---
app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл не загружен' });
    }
    res.json({ url: req.file.path });
});

// --- 4. РУЧКА ДЛЯ РЕАКЦИЙ ---
app.post('/api/messages/react', async (req, res) => {
    const { id, emoji, username } = req.body;

    try {
        const rs = await db.execute({
            sql: 'SELECT reactions FROM messages WHERE id = ?',
            args: [id]
        });

        if (rs.rows.length === 0) {
            return res.status(404).json({ error: 'Сообщение не найдено' });
        }

        let reactions = {};
        const rawReacts = rs.rows[0].reactions;
        if (rawReacts && rawReacts !== '') {
            try { reactions = JSON.parse(rawReacts); } catch (e) { reactions = {}; }
        }

        if (!reactions[emoji]) reactions[emoji] = [];

        const userIndex = reactions[emoji].indexOf(username);
        if (userIndex > -1) {
            reactions[emoji].splice(userIndex, 1);
            if (reactions[emoji].length === 0) delete reactions[emoji];
        } else {
            reactions[emoji].push(username);
        }

        const newReactionsStr = JSON.stringify(reactions);
        await db.execute({
            sql: 'UPDATE messages SET reactions = ? WHERE id = ?',
            args: [newReactionsStr, id]
        });

        const updatedMsg = await db.execute({
            sql: 'SELECT * FROM messages WHERE id = ?',
            args: [id]
        });

        io.emit('message_updated', updatedMsg.rows[0]);
        res.json({ success: true });

    } catch (error) {
        console.error("Ошибка при обновлении реакций:", error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// --- 5. WEBSOCKETS (ЧАТ В РЕАЛЬНОМ ВРЕМЕНИ) ---
io.on('connection', async (socket) => {
    console.log('Новый пользователь подключился');

    try {
        const rs = await db.execute('SELECT * FROM messages ORDER BY timestamp ASC LIMIT 100');
        socket.emit('history', rs.rows);
    } catch (error) {
        console.error("Ошибка загрузки истории:", error);
    }

    socket.on('sendMessage', async (data) => {
        try {
            // RETURNING * возвращает сообщение уже с выданным ID и пустой строкой реакций
            const rs = await db.execute({
                sql: 'INSERT INTO messages (username, text, imageUrl, reactions) VALUES (?, ?, ?, ?) RETURNING *',
                args: [data.username, data.text || '', data.imageUrl || '', '{}']
            });
            io.emit('newMessage', rs.rows[0]);
        } catch (error) {
            console.error("Ошибка сохранения сообщения:", error);
        }
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключился');
    });
});

// --- 6. ЗАПУСК СЕРВЕРА ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`KittyCord server running on port ${PORT}`);
});