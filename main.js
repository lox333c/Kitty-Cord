const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

log.transports.file.level = 'info';
autoUpdater.logger = log;

let mainWindow;

autoUpdater.autoDownload = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "KittyCord",
        icon: path.join(__dirname, 'public', 'icon.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadURL('https://kitty-cord-server.onrender.com');

    mainWindow.once('ready-to-show', () => {
        autoUpdater.checkForUpdatesAndNotify();
    });

    autoUpdater.on('update-available', (info) => {
        dialog.showMessageBox({
            type: 'info',
            title: 'Доступно обновление',
            message: `Найдена новая версия KittyCord (${info.version}). Качаем?`,
            buttons: ['Да', 'Позже'],
            cancelId: 1
        }).then((result) => {
            if (result.response === 0) autoUpdater.downloadUpdate();
        });
    });

    autoUpdater.on('update-downloaded', () => {
        dialog.showMessageBox({
            type: 'info',
            title: 'Обновление готово',
            message: 'Новая версия скачана. Приложение перезапустится для установки.',
            buttons: ['Установить и перезапустить']
        }).then(() => {
            autoUpdater.quitAndInstall();
        });
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});