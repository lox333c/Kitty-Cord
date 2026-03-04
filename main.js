const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let serverProcess;

// Настройка логирования обновлений (полезно для отладки)
autoUpdater.logger = require('electron-log');
autoUpdater.logger.transports.file.level = 'info';

// Мы не хотим, чтобы обновление качалось само без спросу
autoUpdater.autoDownload = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "KittyCord",
        // Устанавливаем иконку окна
        icon: path.join(__dirname, 'public', 'icon.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Запуск бэкенд-сервера
    const serverPath = path.join(__dirname, 'server.js');

    // Пытаемся запустить сервер, передавая путь к БД в папку userData,
    // чтобы данные не стирались при обновлениях.
    serverProcess = fork(serverPath, [], {
        env: {
            // Electron знает, где хранить данные пользователя в системе
            KT_DB_PATH: path.join(app.getPath('userData'), 'kittydb.sqlite'),
            KT_UPLOADS_PATH: path.join(app.getPath('userData'), 'uploads'),
            process: process.env.process
        }
    });

    // Ждем секунду, пока сервер поднимется, и загружаем URL
    setTimeout(() => {
        mainWindow.loadURL('http://localhost:3000').catch(() => {
            // Если не загрузилось, пробуем еще раз через секунду
            setTimeout(() => mainWindow.loadURL('http://localhost:3000'), 1000);
        });
    }, 1000);

    // --- ЛОГИКА АВТООБНОВЛЕНИЯ ---

    // 1. Проверяем обновления при готовности окна
    mainWindow.once('ready-to-show', () => {
        autoUpdater.checkForUpdatesAndNotify();
    });

    // 2. Если нашли обновление, спрашиваем юзера
    autoUpdater.on('update-available', (info) => {
        dialog.showMessageBox({
            type: 'info',
            title: 'Доступно обновление',
            message: `Найдена новая версия KittyCord (${info.version}). Качаем?`,
            buttons: ['Да', 'Позже'],
            cancelId: 1 // Закрытие окна приравнять к "Позже"
        }).then((result) => {
            if (result.response === 0) {
                autoUpdater.downloadUpdate(); // Начинаем закачку
                showToast('Загрузка обновления началась...');
            }
        });
    });

    // 3. Если скачалось, предлагаем перезагрузить
    autoUpdater.on('update-downloaded', () => {
        dialog.showMessageBox({
            type: 'info',
            title: 'Обновление готово',
            message: 'Новая версия скачана. Приложение перезапустится для установки.',
            buttons: ['Установить и перезапустить']
        }).then(() => {
            // Важно: убиваем сервер перед перезапуском
            if (serverProcess) serverProcess.kill();
            autoUpdater.quitAndInstall();
        });
    });

    // Обработка ошибок обновления
    autoUpdater.on('error', (err) => {
        console.error('Ошибка обновления:', err);
        // Не спамим тостами, просто логируем
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (serverProcess) serverProcess.kill();
    });
}

// Простая функция для отправки уведомлений в консоль окна (для отладки)
function showToast(message) {
    if (mainWindow) {
        mainWindow.webContents.executeJavaScript(`console.log("System: ${message}")`);
    }
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('quit', () => {
    if (serverProcess) serverProcess.kill();
});