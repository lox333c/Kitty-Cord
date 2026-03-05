const socket = io();
let currentUser = null, currentAvatar = '', currentBio = '', currentChat = 'friends';
let lastSender = null, lastMessageDate = null, activeDMs = new Set(), unreadCounts = {}, allUsers = [], pendingFriendRequests = 0;
let myProfileData = {};
let imgZoom = 1, currentServerObj = null, replyingTo = null;
let serverRolesCache = [], serverMembersCache = [], channelsCache = [];
let currentChannelPerms = {};

let mentionIndex = 0;
let currentMentionMatches = [];

const defaultEmojis = ['😀', '😂', '🥰', '😎', '🤔', '😭', '😡', '👍', '👎', '❤️', '🔥', '🐱', '🐾', '✨', '🎉'];

const el = id => document.getElementById(id);
const bindClick = (id, fn) => { const e = el(id); if (e) e.onclick = fn; };
const bindChange = (id, fn) => { const e = el(id); if (e) e.onchange = fn; };

let messagesContainer, ctxMenu, msgInput;

function showToast(msg, isError = false) {
    const t = el('toast'); if (!t) return;
    t.innerText = msg; t.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(() => t.classList.remove('show'), 3000);
}

let pingAudioCtx = null;
function playPingSound() {
    try {
        if (!pingAudioCtx) {
            pingAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        // Браузеры иногда "усыпляют" контекст, будим его
        if (pingAudioCtx.state === 'suspended') pingAudioCtx.resume();

        const ctx = pingAudioCtx;
        const playTone = (f, t, d) => {
            const osc = ctx.createOscillator(); const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine'; osc.frequency.value = f;
            gain.gain.setValueAtTime(0, ctx.currentTime + d);
            gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + d + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d + t);
            osc.start(ctx.currentTime + d); osc.stop(ctx.currentTime + d + t);
        };
        playTone(440, 0.4, 0); playTone(554.37, 0.4, 0.1);
    } catch (e) { console.error("Ошибка звука:", e); }
}

let confirmAction = null;
function showConfirm(title, text, btnText, onConfirm) {
    if (!el('confirmModal')) return;
    el('confirmTitle').innerText = title; el('confirmText').innerText = text; el('acceptConfirmBtn').innerText = btnText;
    confirmAction = onConfirm; el('confirmModal').style.display = 'flex';
    if (ctxMenu) ctxMenu.style.display = 'none';
}

bindClick('cancelConfirmBtn', () => { confirmAction = null; el('confirmModal').style.display = 'none'; });
bindClick('acceptConfirmBtn', () => { if (confirmAction) confirmAction(); el('confirmModal').style.display = 'none'; confirmAction = null; });

function getNiceDate(dateObj) {
    const t = new Date(); t.setHours(0, 0, 0, 0); const y = new Date(t); y.setDate(y.getDate() - 1); const m = new Date(dateObj); m.setHours(0, 0, 0, 0);
    if (m.getTime() === t.getTime()) return "Сегодня"; if (m.getTime() === y.getTime()) return "Вчера";
    return `${String(dateObj.getDate()).padStart(2, '0')}.${String(dateObj.getMonth() + 1).padStart(2, '0')}.${dateObj.getFullYear()}`;
}

function formatText(text) {
    if (!text) return '';
    let s = String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    s = s.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\*(.*?)\*/g, "<em>$1</em>").replace(/~~(.*?)~~/g, "<s>$1</s>").replace(/^&gt;\s?(.*)/gm, "<blockquote>$1</blockquote>");

    s = s.replace(/@([a-zA-Zа-яА-Я0-9_]+)/gi, (match, name) => {
        const lowerName = name.toLowerCase();
        if (lowerName === 'everyone') return '<span class="mention mention-everyone">@everyone</span>';
        if (lowerName === 'here') return '<span class="mention mention-here">@here</span>';

        if (currentServerObj && serverRolesCache && serverRolesCache.length > 0) {
            const roleObj = serverRolesCache.find(r => r.name.toLowerCase() === lowerName);
            if (roleObj) return `<span class="mention" style="color:${roleObj.color}; background-color:${roleObj.color}20;" onclick="window.openProfile('${name}')">@${roleObj.name}</span>`;
        }

        let userExists = false;
        if (currentServerObj && serverMembersCache) {
            userExists = serverMembersCache.some(m => m.username.toLowerCase() === lowerName);
        } else {
            userExists = allUsers.some(u => u.username.toLowerCase() === lowerName);
        }

        if (userExists) {
            const isMe = lowerName === currentUser.toLowerCase();
            return `<span class="mention ${isMe ? 'mention-me' : ''}" onclick="window.openProfile('${name}')">@${name}</span>`;
        }

        return match;
    });

    return s;
}

window.formatInput = function (syntax, isPrefix = false) {
    if (!msgInput) return;
    const start = msgInput.selectionStart;
    const end = msgInput.selectionEnd;
    const text = msgInput.value;
    const selectedText = text.substring(start, end);

    // Оборачиваем текст в символы (например **текст**) или ставим префикс (> цитата)
    if (isPrefix) {
        msgInput.value = text.substring(0, start) + syntax + selectedText + text.substring(end);
    } else {
        msgInput.value = text.substring(0, start) + syntax + selectedText + syntax + text.substring(end);
    }

    if (ctxMenu) ctxMenu.style.display = 'none';
    msgInput.focus();

    // Возвращаем курсор на место
    const newPos = isPrefix ? end + syntax.length : end + syntax.length * 2;
    msgInput.setSelectionRange(newPos, newPos);
};

window.onload = async () => {
    messagesContainer = el('chat');
    ctxMenu = el('customContextMenu');
    msgInput = el('msgInput');

    if (msgInput) {
        msgInput.addEventListener('input', handleMentionInput);
        msgInput.addEventListener('keydown', handleMentionKeydown);
    }

    const savedUser = localStorage.getItem('kitty_user');
    if (savedUser) {
        const res = await fetch('/api/autologin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: savedUser }) });
        const data = await res.json();
        if (data.success) finishLogin(data);
    }
};

async function auth(action) {
    const username = el('authUsername').value.trim(), password = el('authPassword').value.trim();
    if (!username || !password) return showToast("Заполните все поля!", true);
    const res = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await res.json();
    if (data.success) { localStorage.setItem('kitty_user', data.username); finishLogin(data); }
    else el('authError').innerText = data.error;
}
bindClick('loginBtn', () => auth('login'));
bindClick('registerBtn', () => auth('register'));

async function finishLogin(data) {
    currentUser = data.username; currentAvatar = data.avatar; currentBio = data.bio || '';
    myProfileData = { display_name: data.display_name, banner_color: data.banner_color, banner_image: data.banner_image, custom_status: data.custom_status, activity: data.activity, social_links: data.social_links, pronouns: data.pronouns };
    if (el('myUsername')) el('myUsername').innerText = myProfileData.display_name || currentUser;
    updateAvatarDisplay('myAvatarDisplay', currentAvatar, currentUser);

    fetchUsers(); fetchDMs(); fetchFriends(); fetchServers();

    el('auth-screen').style.display = 'none';
    el('app-container').style.display = 'flex';
    openFriendsMenu();
}

async function fetchUsers() { const res = await fetch('/api/users'); if (res.ok) { const d = await res.json(); allUsers = d.users || []; } }
async function fetchDMs() { const res = await fetch(`/api/dms/${currentUser}`); if (res.ok) { const d = await res.json(); d.dms.forEach(u => addToDMList(u)); } }

async function fetchServers() {
    const res = await fetch(`/api/servers/list/${currentUser}`); if (!res.ok) return;
    const data = await res.json(); const sList = el('myServersList'); if (!sList) return;
    sList.innerHTML = '';
    data.servers.forEach(s => {
        const icon = s.icon ? `<img src="${s.icon}">` : `<span style="font-weight:900;">${s.name.charAt(0).toUpperCase()}</span>`;
        sList.insertAdjacentHTML('beforeend', `<div class="server-icon" id="server-btn-${s.id}" data-tooltip="${s.name}" onclick="window.loadServer(${s.id})"><div class="user-avatar">${icon}</div><span class="badge" id="badge-server_${s.id}" style="display:none; position:absolute; top:-5px; right:-5px; z-index:20;">0</span></div>`);
    });
}

bindClick('btnAddServer', () => el('serverModal').style.display = 'flex');
bindClick('closeServerModal', () => el('serverModal').style.display = 'none');

bindClick('createServerBtn', async () => {
    const name = el('newServerName').value.trim(); if (!name) return showToast('Введите название!', true);
    const res = await fetch('/api/servers/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, owner: currentUser }) });
    const data = await res.json();
    if (data.success) { showToast(`Сервер создан!`); el('newServerName').value = ''; el('serverModal').style.display = 'none'; fetchServers(); }
});

bindClick('joinServerBtn', async () => {
    const code = el('inviteCodeInput').value.trim(); if (!code) return showToast('Введите код!', true);
    const res = await fetch('/api/servers/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite_code: code, username: currentUser }) });
    const data = await res.json();
    if (data.success) { showToast(`Успешный вход!`); el('inviteCodeInput').value = ''; el('serverModal').style.display = 'none'; fetchServers(); }
    else showToast(data.error, true);
});

window.leaveServer = (srvId) => {
    showConfirm('Покинуть сервер?', 'Вы точно хотите выйти?', 'Выйти', async () => {
        await fetch('/api/servers/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server_id: srvId, username: currentUser }) });
        el('btnHome').click(); fetchServers();
    });
};

async function fetchServerData(serverId) {
    const [rolesRes, memRes] = await Promise.all([fetch(`/api/servers/${serverId}/roles`), fetch(`/api/servers/${serverId}/members`)]);
    serverRolesCache = (await rolesRes.json()).roles || [];
    serverMembersCache = (await memRes.json()).members || [];
}

function getUserRoles(username) {
    if (!currentServerObj) return [];
    if (currentServerObj.owner === username) return ['owner'];
    const member = serverMembersCache.find(m => m.username === username);
    if (!member) return [];
    return JSON.parse(member.roles || '[]');
}

function getUserTopRole(username) {
    if (!currentServerObj) return null;
    const rIds = getUserRoles(username);
    if (rIds.length === 0) return null;
    return serverRolesCache.find(r => rIds.includes(r.id.toString())) || null;
}

function renderRightMembersPanel() {
    const container = el('rightMembersList'); if (!container) return;
    container.innerHTML = '';
    if (!currentServerObj) { el('membersPanel').style.display = 'none'; return; }
    el('membersPanel').style.display = 'flex';

    const groups = {}; serverRolesCache.forEach(r => groups[r.id] = []); const noRole = [];

    serverMembersCache.forEach(m => {
        const rIds = JSON.parse(m.roles || '[]');
        if (rIds.length > 0) {
            const role = serverRolesCache.find(r => rIds.includes(r.id.toString()));
            if (role && groups[role.id]) groups[role.id].push(m); else noRole.push(m);
        } else { noRole.push(m); }
    });

    serverRolesCache.forEach(r => {
        const members = groups[r.id];
        if (members && members.length > 0) {
            container.insertAdjacentHTML('beforeend', `<div class="role-group-header">${r.name} — ${members.length}</div>`);
            members.forEach(m => {
                const aHTML = m.avatar ? `<img src="${m.avatar}">` : m.username.charAt(0).toUpperCase();
                container.insertAdjacentHTML('beforeend', `<div class="member-panel-item" onclick="window.openProfile('${m.username}')"><div class="user-avatar-wrap" style="width:32px; height:32px;"><div class="user-avatar" style="font-size:16px;">${aHTML}</div><div class="status-indicator online" style="width:10px;height:10px;border-width:2px; right:-2px; bottom:-2px;"></div></div><span style="color:${r.color}; font-weight:bold; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${m.display_name || m.username}</span></div>`);
            });
        }
    });

    if (noRole.length > 0) {
        container.insertAdjacentHTML('beforeend', `<div class="role-group-header">В сети — ${noRole.length}</div>`);
        noRole.forEach(m => {
            const aHTML = m.avatar ? `<img src="${m.avatar}">` : m.username.charAt(0).toUpperCase();
            container.insertAdjacentHTML('beforeend', `<div class="member-panel-item" onclick="window.openProfile('${m.username}')"><div class="user-avatar-wrap" style="width:32px; height:32px;"><div class="user-avatar" style="font-size:16px;">${aHTML}</div><div class="status-indicator online" style="width:10px;height:10px;border-width:2px; right:-2px; bottom:-2px;"></div></div><span style="color:var(--text-main); font-weight:bold; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${m.display_name || m.username}</span></div>`);
        });
    }
}

window.loadServer = async (serverId) => {
    document.querySelectorAll('.server-icon').forEach(e => e.classList.remove('active'));
    const btn = el(`server-btn-${serverId}`); if (btn) btn.classList.add('active');

    const infoRes = await fetch(`/api/servers/info/${serverId}`); const infoData = await infoRes.json();
    currentServerObj = infoData.success ? infoData.server : null; if (!currentServerObj) return;

    await fetchServerData(serverId);
    renderRightMembersPanel();

    el('serverChannels').style.display = 'block';
    el('dmSection').style.display = 'none';
    el('panelTitle').innerText = currentServerObj.name;
    el('serverHeaderChevron').style.display = 'inline';

    const myRoles = getUserRoles(currentUser);
    let iCanManageChannels = false;

    if (currentServerObj.owner === currentUser) { iCanManageChannels = true; }
    else { myRoles.forEach(rId => { const r = serverRolesCache.find(x => x.id == rId); if (r && r.can_manage_channels) iCanManageChannels = true; }); }

    if (el('addChannelBtn')) el('addChannelBtn').style.display = iCanManageChannels ? 'block' : 'none';

    const res = await fetch(`/api/servers/${serverId}/channels`); const data = await res.json();
    channelsCache = data.channels || [];
    const chList = el('serverChannelsList'); chList.innerHTML = '';
    let firstAllowedChannel = null;

    if (channelsCache.length > 0) {
        channelsCache.forEach(c => {
            let perms = {}; try { perms = JSON.parse(c.permissions || '{}'); } catch (e) { }
            if (!perms.everyone) perms.everyone = { view: true, send: true };

            let canView = perms.everyone.view !== false;
            let canSend = perms.everyone.send !== false;

            if (iCanManageChannels || currentServerObj.owner === currentUser) {
                canView = true; canSend = true;
            } else {
                let roleAllowView = false, roleAllowSend = false;
                myRoles.forEach(rid => {
                    if (perms.roles && perms.roles[rid]) {
                        if (perms.roles[rid].view === true) roleAllowView = true;
                        if (perms.roles[rid].send === true) roleAllowSend = true;
                    }
                });
                if (perms.everyone.view === false && roleAllowView) canView = true;
                if (perms.everyone.send === false && roleAllowSend) canSend = true;
            }

            if (canView) {
                const isPriv = !perms.everyone.view; const lockIcon = isPriv ? '🔒 ' : ''; const chId = `channel_${c.id}`;
                const permsStrEncoded = c.permissions ? encodeURIComponent(c.permissions) : '%7B%7D';
                const actionsHTML = iCanManageChannels ? `<div class="channel-actions"><span class="action-icon-small" title="Настройки" onclick="event.stopPropagation(); window.openChannelSettings(${c.id}, '${c.name.replace(/'/g, "\\'")}', '${permsStrEncoded}')">⚙️</span><span class="action-icon-small del" title="Удалить" onclick="event.stopPropagation(); window.deleteChannel(${c.id})">✖</span></div>` : '';

                if (!firstAllowedChannel) firstAllowedChannel = chId;
                chList.insertAdjacentHTML('beforeend', `<div class="channel" onclick="window.loadChat('${chId}', ${canSend})" id="ui-${chId}"><span class="name">${lockIcon}# ${c.name}</span><span class="badge-inline" id="badge-${chId}" style="display:none; margin-left:auto; margin-right: ${actionsHTML ? '45px' : '0'};">0</span>${actionsHTML}</div>`);
            }
        });

        if (firstAllowedChannel) window.loadChat(firstAllowedChannel, true);
        else { el('chatTitle').innerText = 'Нет доступа'; messagesContainer.innerHTML = ''; el('friendsArea').style.display = 'none'; el('chatArea').style.display = 'flex'; el('chatInputArea').style.display = 'none'; el('chatNoAccessArea').style.display = 'block'; }
    }
};

bindClick('serverHeader', () => {
    if (!currentServerObj) return; const drop = el('serverDropdown'); drop.style.display = drop.style.display === 'none' ? 'block' : 'none';

    let iCanManageChannels = false;
    if (currentServerObj.owner === currentUser) iCanManageChannels = true;
    else {
        const myRoles = getUserRoles(currentUser);
        myRoles.forEach(rId => { const r = serverRolesCache.find(x => x.id == rId); if (r && r.can_manage_channels) iCanManageChannels = true; });
    }

    el('dropdownSettings').style.display = (currentServerObj.owner === currentUser) ? 'flex' : 'none';
    el('dropdownCreateChannel').style.display = iCanManageChannels ? 'flex' : 'none';
    el('dropdownSeparator').style.display = iCanManageChannels ? 'block' : 'none';
    el('dropdownLeave').style.display = (currentServerObj.owner === currentUser) ? 'none' : 'flex';
});

bindClick('dropdownInvite', () => { navigator.clipboard.writeText(currentServerObj.invite_code); showToast('Инвайт скопирован!'); el('serverDropdown').style.display = 'none'; });
bindClick('dropdownSettings', () => { window.openServerSettings(currentServerObj.id); });

bindClick('dropdownCreateChannel', () => {
    const rs = el('channelRolesSelect'); rs.innerHTML = '';
    serverRolesCache.forEach(r => { rs.insertAdjacentHTML('beforeend', `<label style="display:flex;align-items:center;gap:6px; color:var(--text-main); font-size:13px; margin-bottom:6px;"><input type="checkbox" class="ch-role-cb" value="${r.id}" style="width:14px;height:14px;"> <span style="color:${r.color};">${r.name}</span></label>`); });
    if (el('isPrivateChannel')) el('isPrivateChannel').checked = false; rs.style.display = 'none';
    el('createChannelModal').style.display = 'flex'; el('serverDropdown').style.display = 'none';
});

bindClick('dropdownLeave', () => { window.leaveServer(currentServerObj.id); el('serverDropdown').style.display = 'none'; });
bindChange('isPrivateChannel', (e) => { el('channelRolesSelect').style.display = e.target.checked ? 'block' : 'none'; });
bindClick('addChannelBtn', () => { const btn = el('dropdownCreateChannel'); if (btn) btn.click(); });
bindClick('closeChannelModal', () => el('createChannelModal').style.display = 'none');

bindClick('submitChannelBtn', async () => {
    const name = el('newChannelName').value.trim(); if (!name) return;
    let perms = { everyone: { view: true, send: true }, roles: {}, users: {} };
    if (el('isPrivateChannel') && el('isPrivateChannel').checked) {
        perms.everyone.view = false;
        document.querySelectorAll('.ch-role-cb:checked').forEach(cb => { perms.roles[cb.value] = { view: true, send: true }; });
    }
    await fetch('/api/channels/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server_id: currentServerObj.id, name, permissions: perms }) });
    el('newChannelName').value = ''; el('createChannelModal').style.display = 'none';
});

function syncChannelPermsFromDOM() {
    const chEvView = el('editChEvView');
    const chEvSend = el('editChEvSend');

    if (chEvView) currentChannelPerms.everyone.view = chEvView.checked;
    if (chEvSend) currentChannelPerms.everyone.send = chEvSend.checked;

    document.querySelectorAll('.role-perm-row').forEach(row => {
        const rId = row.dataset.rid;
        if (!currentChannelPerms.roles) currentChannelPerms.roles = {};
        if (!currentChannelPerms.roles[rId]) currentChannelPerms.roles[rId] = { view: true, send: true };

        const vCb = row.querySelector('.perm-view-cb');
        const sCb = row.querySelector('.perm-send-cb');
        if (vCb) currentChannelPerms.roles[rId].view = vCb.checked;
        if (sCb) currentChannelPerms.roles[rId].send = sCb.checked;
    });
}

function renderChannelPerms() {
    const list = el('channelPermsList'); list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', `<div class="perm-row"><span>@everyone</span><div class="perm-toggles"><label class="perm-label"><input type="checkbox" id="editChEvView" ${currentChannelPerms.everyone.view !== false ? 'checked' : ''} onchange="window.toggleChannelPriv(this)"> Видеть</label><label class="perm-label"><input type="checkbox" id="editChEvSend" ${currentChannelPerms.everyone.send !== false ? 'checked' : ''}> Писать</label></div></div>`);

    for (let rId in currentChannelPerms.roles) {
        const rObj = serverRolesCache.find(r => r.id == rId); if (!rObj) continue;
        list.insertAdjacentHTML('beforeend', `<div class="perm-row role-perm-row" data-rid="${rId}"><span style="color:${rObj.color}; font-weight:bold;">${rObj.name}</span><div class="perm-toggles"><label class="perm-label"><input type="checkbox" class="perm-view-cb" ${currentChannelPerms.roles[rId].view ? 'checked' : ''}> Видеть</label><label class="perm-label"><input type="checkbox" class="perm-send-cb" ${currentChannelPerms.roles[rId].send ? 'checked' : ''}> Писать</label><span class="action-icon-small del" onclick="window.removeChPerm(${rId})">✖</span></div></div>`);
    }
    const sel = el('addPermSelect'); sel.innerHTML = '<option value="">+ Добавить роль</option>';
    serverRolesCache.forEach(r => { if (!currentChannelPerms.roles[r.id]) sel.insertAdjacentHTML('beforeend', `<option value="${r.id}">${r.name}</option>`); });
}

window.toggleChannelPriv = (cb) => {
    syncChannelPermsFromDOM();
    currentChannelPerms.everyone.view = cb.checked;
    renderChannelPerms();
};

window.removeChPerm = (id) => { syncChannelPermsFromDOM(); delete currentChannelPerms.roles[id]; renderChannelPerms(); };

bindClick('addPermBtn', () => {
    const val = el('addPermSelect').value; if (!val) return;
    syncChannelPermsFromDOM();
    if (!currentChannelPerms.roles) currentChannelPerms.roles = {};
    currentChannelPerms.roles[val] = { view: true, send: true };
    renderChannelPerms();
});

window.openChannelSettings = (id, name, permsStrEncoded) => {
    el('editChannelId').value = id; el('editChannelName').value = name;

    const permsStr = decodeURIComponent(permsStrEncoded);
    try { currentChannelPerms = JSON.parse(permsStr); } catch (e) { currentChannelPerms = {}; }
    if (!currentChannelPerms.everyone) currentChannelPerms.everyone = { view: true, send: true };
    if (!currentChannelPerms.roles) currentChannelPerms.roles = {};

    const isPriv = currentChannelPerms.everyone.view === false;
    if (el('editIsPrivateChannel')) el('editIsPrivateChannel').checked = isPriv;
    if (el('editChannelRolesSelect')) el('editChannelRolesSelect').style.display = isPriv ? 'block' : 'none';

    document.querySelectorAll('#channelSettingsModal .settings-tab').forEach(t => t.classList.remove('active')); if (el('chTabBtn-general')) el('chTabBtn-general').classList.add('active');
    document.querySelectorAll('#channelSettingsModal .settings-tab-content').forEach(t => t.style.display = 'none'); if (el('chSettingsTab-general')) el('chSettingsTab-general').style.display = 'block';

    renderChannelPerms(); el('channelSettingsModal').style.display = 'flex';
};

bindChange('editIsPrivateChannel', (e) => {
    if (el('editChannelRolesSelect')) el('editChannelRolesSelect').style.display = e.target.checked ? 'block' : 'none';
    syncChannelPermsFromDOM();
    currentChannelPerms.everyone.view = !e.target.checked;
    renderChannelPerms();
});

bindClick('chTabBtn-general', () => { document.querySelectorAll('#channelSettingsModal .settings-tab').forEach(t => t.classList.remove('active')); el('chTabBtn-general').classList.add('active'); document.querySelectorAll('#channelSettingsModal .settings-tab-content').forEach(t => t.style.display = 'none'); el('chSettingsTab-general').style.display = 'block'; });
bindClick('chTabBtn-perms', () => { document.querySelectorAll('#channelSettingsModal .settings-tab').forEach(t => t.classList.remove('active')); el('chTabBtn-perms').classList.add('active'); document.querySelectorAll('#channelSettingsModal .settings-tab-content').forEach(t => t.style.display = 'none'); el('chSettingsTab-perms').style.display = 'block'; });
bindClick('closeChannelSettingsModal', () => el('channelSettingsModal').style.display = 'none');

bindClick('saveChannelSettingsBtn', async () => {
    const id = el('editChannelId').value; const name = el('editChannelName').value.trim(); if (!name) return;

    syncChannelPermsFromDOM();
    if (el('editIsPrivateChannel') && el('editIsPrivateChannel').checked) { currentChannelPerms.everyone.view = false; }

    await fetch('/api/channels/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: id, server_id: currentServerObj.id, name, permissions: currentChannelPerms }) });
    el('channelSettingsModal').style.display = 'none'; showToast('Канал сохранен');
});

window.deleteChannel = function (channelId) { showConfirm('Удалить канал?', 'Канал и сообщения будут стерты навсегда.', 'Удалить', async () => { await fetch('/api/channels/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: channelId, server_id: currentServerObj.id }) }); }); }
socket.on('channel_update', (data) => { if (currentServerObj && currentServerObj.id === data.server_id) window.loadServer(data.server_id); });


function switchSettingsTab(tabName) {
    document.querySelectorAll('#serverSettingsModal .settings-tab-content').forEach(t => t.style.display = 'none');
    document.querySelectorAll('#serverSettingsModal .settings-tab').forEach(t => t.classList.remove('active'));
    el(`settingsTab-${tabName}`).style.display = 'block';
    el(`tabBtn-${tabName}`).classList.add('active');
}
bindClick('tabBtn-general', () => switchSettingsTab('general'));
bindClick('tabBtn-roles', () => switchSettingsTab('roles'));
bindClick('tabBtn-members', () => switchSettingsTab('members'));

function renderServerRoles() {
    const list = el('serverRolesList'); list.innerHTML = '';
    serverRolesCache.forEach(r => { list.insertAdjacentHTML('beforeend', `<div class="role-list-item"><div class="role-pill" style="border-color:${r.color};"><div class="role-pill-color" style="background:${r.color};"></div><span style="color:${r.color};">${r.name}</span></div><span class="action-icon-small del" onclick="window.deleteRole(${r.id})">🗑</span></div>`); });
}

function renderServerMembers() {
    const list = el('serverMembersList'); list.innerHTML = '';
    serverMembersCache.forEach(m => {
        const rIds = JSON.parse(m.roles || '[]'); let rolesHtml = '';
        rIds.forEach(id => { const r = serverRolesCache.find(x => x.id == id); if (r) rolesHtml += `<div class="role-pill" style="border-color:${r.color};"><div class="role-pill-color" style="background:${r.color};"></div><span style="color:${r.color};">${r.name}</span><span style="cursor:pointer; margin-left:4px;" onclick="window.toggleRole('${m.username}', ${r.id})">&times;</span></div>`; });
        let allRolesSelectHtml = `<select style="background:var(--bg-main); color:white; border:1px solid var(--bg-hover); border-radius:4px; font-size:11px; padding:2px; outline:none;" onchange="window.toggleRole('${m.username}', this.value); this.value='';"><option value="">+ Выдать роль</option>`;
        serverRolesCache.forEach(r => { if (!rIds.includes(r.id.toString())) allRolesSelectHtml += `<option value="${r.id}">${r.name}</option>`; }); allRolesSelectHtml += `</select>`;
        const aHTML = m.avatar ? `<img src="${m.avatar}">` : m.username.charAt(0).toUpperCase();
        list.insertAdjacentHTML('beforeend', `<div class="member-list-item"><div class="member-list-header"><div class="user-avatar-wrap" style="width:28px;height:28px;"><div class="user-avatar" style="font-size:14px;">${aHTML}</div></div><span style="font-weight:bold; color:var(--text-main); font-size:14px;">${m.display_name || m.username}</span></div><div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">${rolesHtml}${allRolesSelectHtml}</div></div>`);
    });
}

window.openServerSettings = async (srvId) => {
    if (currentServerObj && currentServerObj.id == srvId) {
        await fetchServerData(srvId); el('editServerName').value = currentServerObj.name; el('serverIconPreview').innerHTML = currentServerObj.icon ? `<img src="${currentServerObj.icon}">` : currentServerObj.name.charAt(0);
        if (el('serverSettingsModal').style.display !== 'flex') switchSettingsTab('general');
        renderServerRoles(); renderServerMembers(); el('serverDropdown').style.display = 'none'; el('serverSettingsModal').style.display = 'flex';
    }
};
bindClick('closeSettingsModal', () => el('serverSettingsModal').style.display = 'none');

let newServerIcon = '';
bindChange('serverIconUpload', e => { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = ev => { newServerIcon = ev.target.result; el('serverIconPreview').innerHTML = `<img src="${newServerIcon}">`; }; reader.readAsDataURL(file); });
bindClick('saveServerSettingsBtn', async () => { const name = el('editServerName').value.trim(); await fetch('/api/servers/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server_id: currentServerObj.id, name, icon: newServerIcon || currentServerObj.icon }) }); showToast('Настройки сохранены'); el('serverSettingsModal').style.display = 'none'; });
socket.on('server_updated', (data) => { if (currentServerObj && currentServerObj.id == data.server_id) { window.loadServer(currentServerObj.id); if (el('serverSettingsModal').style.display === 'flex') window.openServerSettings(currentServerObj.id); } fetchServers(); });

bindClick('createRoleBtn', async () => {
    const name = el('newRoleName').value.trim(); const color = el('newRoleColor').value;
    const cCh = el('newRoleManCh').checked; const cMsg = el('newRoleManMsg').checked;
    if (!name) return;
    await fetch('/api/roles/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server_id: currentServerObj.id, name, color, can_manage_channels: cCh, can_manage_messages: cMsg }) });
    el('newRoleName').value = ''; el('newRoleManCh').checked = false; el('newRoleManMsg').checked = false;
});
window.deleteRole = function (roleId) { showConfirm('Удалить роль?', 'Это действие нельзя отменить.', 'Удалить', async () => { await fetch('/api/roles/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role_id: roleId, server_id: currentServerObj.id }) }); }); };
window.toggleRole = async (username, roleId) => { if (!roleId) return; const member = serverMembersCache.find(m => m.username === username); if (!member) return; let rIds = JSON.parse(member.roles || '[]'); if (rIds.includes(roleId.toString())) rIds = rIds.filter(id => id != roleId); else rIds.push(roleId.toString()); await fetch('/api/members/roles/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server_id: currentServerObj.id, username, roles: rIds }) }); };

function updateHomeBadge() { let total = pendingFriendRequests; for (let c in unreadCounts) { if (c !== 'general' && !c.startsWith('channel_')) total += unreadCounts[c]; } const hb = el('badge-home'); if (hb) { if (total > 0) { hb.innerText = total; hb.style.display = 'block'; } else hb.style.display = 'none'; } }
bindClick('btnHome', () => { currentServerObj = null; el('membersPanel').style.display = 'none'; el('serverHeaderChevron').style.display = 'none'; el('btnHome').classList.add('active'); el('btnGeneral').classList.remove('active'); document.querySelectorAll('.server-icon').forEach(e => e.classList.remove('active')); el('serverChannels').style.display = 'none'; el('dmSection').style.display = 'block'; el('panelTitle').innerText = 'Главная'; openFriendsMenu(); });
bindClick('btnGeneral', () => { currentServerObj = null; el('membersPanel').style.display = 'none'; el('serverHeaderChevron').style.display = 'none'; el('btnHome').classList.remove('active'); el('btnGeneral').classList.add('active'); document.querySelectorAll('.server-icon').forEach(e => e.classList.remove('active')); el('serverChannels').style.display = 'block'; el('dmSection').style.display = 'none'; el('panelTitle').innerText = 'Kitty Server'; if (el('addChannelBtn')) el('addChannelBtn').style.display = 'none'; el('serverChannelsList').innerHTML = `<div class="channel" onclick="window.loadChat('general', true)" id="ui-general"><span class="name"># общий-чат</span></div>`; window.loadChat('general', true); });
function openFriendsMenu() { currentChat = 'friends'; document.querySelectorAll('.channel, .dm-user').forEach(e => e.classList.remove('active')); el('btnFriendsMenu').classList.add('active'); el('chatArea').style.display = 'none'; el('friendsArea').style.display = 'flex'; fetchFriends(); window.cancelReply(); }

window.loadChat = function (chatName, canSend = true) {
    currentChat = chatName;
    if (chatName === 'general') { el('chatTitle').innerText = '# общий-чат'; el('membersPanel').style.display = 'none'; }
    else if (chatName.startsWith('channel_')) { const uiCh = el(`ui-${chatName}`); const nSpan = uiCh ? uiCh.querySelector('.name') : null; el('chatTitle').innerText = nSpan ? nSpan.innerText : '# канал'; if (currentServerObj) el('membersPanel').style.display = 'flex'; }
    else { const uData = allUsers.find(u => u.username === chatName); el('chatTitle').innerText = `ЛС: @${uData?.display_name || chatName}`; el('membersPanel').style.display = 'none'; }

    document.querySelectorAll('.channel, .dm-user').forEach(e => e.classList.remove('active'));
    if (chatName === 'general') { const ug = el('ui-general'); if (ug) ug.classList.add('active'); }
    else if (chatName.startsWith('channel_')) { const ui = el(`ui-${chatName}`); if (ui) ui.classList.add('active'); }
    else { addToDMList(chatName, null, true); }

    el('friendsArea').style.display = 'none'; el('chatArea').style.display = 'flex'; clearBadge(chatName); lastMessageDate = null; window.cancelReply();

    if (canSend) { el('chatInputArea').style.display = 'flex'; el('chatNoAccessArea').style.display = 'none'; }
    else { el('chatInputArea').style.display = 'none'; el('chatNoAccessArea').style.display = 'block'; }

    if (messagesContainer) messagesContainer.innerHTML = '';
    socket.emit('get_history', { username: currentUser, chatWith: currentChat });
};

function showUnreadDMBubble(username, avatarData) { const container = el('quickDMsList'); if (el(`quick-dm-${username}`)) return; if (container.children.length >= 15) container.removeChild(container.lastChild); const avatarHTML = (avatarData && avatarData.startsWith('data:image')) ? `<img src="${avatarData}">` : username.charAt(0).toUpperCase(); container.insertAdjacentHTML('afterbegin', `<div class="server-icon" id="quick-dm-${username}" data-tooltip="${username}" onclick="window.loadChat('${username}')"><div class="user-avatar">${avatarHTML}</div><span class="quick-dm-close" onclick="event.stopPropagation(); window.closeDM('${username}')">&times;</span><span class="badge" id="quick-badge-${username}" style="position:absolute;bottom:-2px;right:-2px;transform:scale(0.8);display:none;z-index:20;">0</span></div>`); }
function removeUnreadDMBubble(username) { const elem = el(`quick-dm-${username}`); if (elem) elem.remove(); }
window.closeDM = (username) => { removeUnreadDMBubble(username); const dm = el(`dm-${username}`); if (dm) dm.remove(); activeDMs.delete(username); if (currentChat === username) el('btnHome').click(); };
function addToDMList(username, avatarData, isActive = false) { if (username === 'general' || username === currentUser || username.startsWith('channel_')) return; if (activeDMs.has(username)) { if (isActive) { el(`dm-${username}`).classList.add('active'); } if (avatarData) updateAvatarDisplay(`dm-avatar-${username}`, avatarData, username); return; } const uData = allUsers.find(u => u.username === username); const displayName = uData?.display_name || username; activeDMs.add(username); el('dmList').insertAdjacentHTML('afterbegin', `<div class="dm-user ${isActive ? 'active' : ''}" id="dm-${username}" onclick="window.loadChat('${username}')"><div class="user-avatar-wrap" style="width:32px;height:32px;"><div class="user-avatar dm-avatar" id="dm-avatar-${username}">🐱</div></div><span class="name">${displayName}</span><span class="dm-close-btn" onclick="event.stopPropagation(); window.closeDM('${username}')">&times;</span><span class="badge" id="badge-${username}" style="display:none;">0</span></div>`); fetch(`/api/user/${username}`).then(r => r.json()).then(d => { if (d.success) updateAvatarDisplay(`dm-avatar-${username}`, d.avatar, username); }); }

function incrementBadge(chatId, isPing = false, avatarData = null, serverId = null) {
    if (chatId === currentChat && document.hasFocus()) return;
    unreadCounts[chatId] = (unreadCounts[chatId] || 0) + 1;
    const b1 = el(`badge-${chatId}`); if (b1) { b1.innerText = unreadCounts[chatId]; b1.style.display = 'inline-block'; }

    if (serverId && isPing) {
        const sBadge = el(`badge-server_${serverId}`);
        if (sBadge) { let c = parseInt(sBadge.innerText) || 0; sBadge.innerText = c + 1; sBadge.style.display = 'block'; }
    } else if (chatId !== 'general' && !chatId.startsWith('channel_')) {
        showUnreadDMBubble(chatId, avatarData);
        const b2 = el(`quick-badge-${chatId}`); if (b2) { b2.innerText = unreadCounts[chatId]; b2.style.display = 'block'; }
    }
    updateHomeBadge(); playPingSound();
}
function clearBadge(chatId) {
    unreadCounts[chatId] = 0; const b1 = el(`badge-${chatId}`); if (b1) { b1.innerText = '0'; b1.style.display = 'none'; }
    if (chatId !== 'general' && !chatId.startsWith('channel_')) removeUnreadDMBubble(chatId);

    if (currentServerObj && currentChat.startsWith('channel_')) {
        const sBadge = el(`badge-server_${currentServerObj.id}`);
        if (sBadge) { sBadge.innerText = '0'; sBadge.style.display = 'none'; }
    }
    updateHomeBadge();
}

document.querySelectorAll('.friends-tabs .friend-tab').forEach(tab => { tab.onclick = () => { document.querySelectorAll('.friends-tabs .friend-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active'); document.querySelectorAll('.friend-tab-content').forEach(c => c.style.display = 'none'); el(`tab-${tab.dataset.tab}`).style.display = 'block'; }; });
async function fetchFriends() { const res = await fetch(`/api/friends/${currentUser}`); if (!res.ok) return; const data = await res.json(); const allC = el('friendsListContainer'), pendC = el('pendingListContainer'); allC.innerHTML = ''; pendC.innerHTML = ''; let pendingCount = 0; data.friends.forEach(f => { const isReq = f.requester === currentUser; const other = isReq ? f.receiver : f.requester; const uData = allUsers.find(u => u.username === other) || { avatar: '', display_name: '' }; const avatarHTML = uData.avatar ? `<img src="${uData.avatar}">` : other.charAt(0).toUpperCase(); const dName = uData.display_name || other; if (f.status === 'accepted') { allC.insertAdjacentHTML('beforeend', `<div class="friend-item" onclick="window.loadChat('${other}')"><div class="user-avatar-wrap" style="width:32px;height:32px;"><div class="user-avatar">${avatarHTML}</div></div><div class="friend-item-info"><span class="friend-item-name">${dName}</span><span class="friend-item-status">В сети</span></div><button class="friend-action-btn msg" onclick="event.stopPropagation(); window.loadChat('${other}')">💬</button></div>`); } else if (f.status === 'pending') { if (!isReq) pendingCount++; const btns = isReq ? `<button class="friend-action-btn reject" onclick="window.friendAction('${currentUser}','${other}','reject')">✖</button>` : `<button class="friend-action-btn accept" onclick="window.friendAction('${other}','${currentUser}','accept')">✔</button><button class="friend-action-btn reject" onclick="window.friendAction('${other}','${currentUser}','reject')">✖</button>`; pendC.insertAdjacentHTML('beforeend', `<div class="friend-item"><div class="user-avatar-wrap" style="width:32px;height:32px;"><div class="user-avatar">${avatarHTML}</div></div><div class="friend-item-info"><span class="friend-item-name">${dName}</span><span class="friend-item-status">${isReq ? 'Исходящий запрос' : 'Входящий запрос'}</span></div>${btns}</div>`); } }); const badge = el('pendingBadge'); if (pendingCount > 0) { badge.innerText = pendingCount; badge.style.display = 'inline-block'; } else badge.style.display = 'none'; pendingFriendRequests = pendingCount; updateHomeBadge(); if (allC.innerHTML === '') allC.innerHTML = '<p class="subtext">Тут пока пусто.</p>'; if (pendC.innerHTML === '') pendC.innerHTML = '<p class="subtext">Нет ожидающих запросов.</p>'; }
bindClick('sendFriendRequestBtn', async () => { const receiver = el('addFriendInput').value.trim(); const msgEl = el('addFriendMsg'); if (!receiver) return; if (receiver === currentUser) { msgEl.style.color = '#F04747'; msgEl.innerText = 'Нельзя добавить себя!'; return; } const res = await fetch('/api/friends/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requester: currentUser, receiver }) }); const data = await res.json(); if (data.success) { msgEl.style.color = '#43b581'; msgEl.innerText = `Запрос отправлен ${receiver}!`; el('addFriendInput').value = ''; fetchFriends(); } else { msgEl.style.color = '#F04747'; msgEl.innerText = data.error || 'Пользователь не найден'; } });
window.friendAction = async (req, rec, action) => { await fetch('/api/friends/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requester: req, receiver: rec, action }) }); fetchFriends(); };
socket.on('friend_update', (data) => { if (data.user === currentUser) fetchFriends(); });

bindClick('closeModal', () => el('profileModal').style.display = 'none');
window.openProfile = async (username, defaultAvatar) => {
    const isMe = username === currentUser; const data = await (await fetch(`/api/user/${username}`)).json(); const u = data.success ? data : {};
    el('profileDisplayName').value = u.display_name || username; el('profileUsername').innerText = `@${username}`; el('profilePronouns').value = u.pronouns || ''; el('profileCustomStatus').value = u.custom_status || ''; el('profileActivity').value = u.activity || ''; el('profileBio').value = u.bio || ''; el('profileSocials').value = u.social_links || '';
    if (u.reg_date) { const d = new Date(u.reg_date.replace(' ', 'T') + 'Z'); el('profileRegDate').innerText = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`; } else el('profileRegDate').innerText = 'Недавно';
    updateAvatarDisplay('modalAvatarPreview', u.avatar || defaultAvatar, username); const bannerEl = el('modalBanner');
    if (u.banner_image && u.banner_image.startsWith('data:image')) { bannerEl.style.backgroundImage = `url(${u.banner_image})`; bannerEl.style.backgroundColor = 'transparent'; } else { bannerEl.style.backgroundImage = 'none'; bannerEl.style.backgroundColor = u.banner_color || 'var(--accent)'; }
    ['profileDisplayName', 'profilePronouns', 'profileCustomStatus', 'profileActivity', 'profileBio', 'profileSocials'].forEach(id => el(id).disabled = !isMe);
    el('profilePronouns').style.display = (!isMe && !u.pronouns) ? 'none' : 'inline-block'; el('statusContainer').style.display = (!isMe && !u.custom_status) ? 'none' : 'flex'; el('activityContainer').style.display = (!isMe && !u.activity) ? 'none' : 'flex'; el('bioContainer').style.display = (!isMe && !u.bio) ? 'none' : 'block'; el('socialsContainer').style.display = (!isMe && !u.social_links) ? 'none' : 'block';
    el('changeAvatarBtn').style.display = isMe ? 'flex' : 'none'; el('changeBannerBtn').style.display = isMe ? 'flex' : 'none'; el('logoutBtn').style.display = isMe ? 'block' : 'none'; el('saveBioBtn').style.display = isMe ? 'block' : 'none'; el('dmBtn').style.display = isMe ? 'none' : 'block'; el('dmBtn').onclick = () => { el('profileModal').style.display = 'none'; window.loadChat(username); };
    const prList = el('profileRolesList'); prList.innerHTML = '';
    if (currentServerObj && serverMembersCache.length > 0) { const mem = serverMembersCache.find(m => m.username === username); if (mem && mem.roles) { const rIds = JSON.parse(mem.roles); rIds.forEach(id => { const roleObj = serverRolesCache.find(r => r.id == id); if (roleObj) prList.insertAdjacentHTML('beforeend', `<div class="role-pill" style="border-color:${roleObj.color};"><div class="role-pill-color" style="background:${roleObj.color};"></div><span style="color:${roleObj.color};">${roleObj.name}</span></div>`); }); } }
    el('profileModal').style.display = 'flex';
};
bindChange('avatarUpload', e => { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = ev => { currentAvatar = ev.target.result; updateAvatarDisplay('modalAvatarPreview', currentAvatar, currentUser); }; reader.readAsDataURL(file); });
bindChange('bannerUpload', e => { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = ev => { myProfileData.banner_image = ev.target.result; el('modalBanner').style.backgroundImage = `url(${myProfileData.banner_image})`; }; reader.readAsDataURL(file); });
bindClick('saveBioBtn', async () => { const p = { username: currentUser, avatar: currentAvatar, banner_color: myProfileData.banner_color, banner_image: myProfileData.banner_image, display_name: el('profileDisplayName').value.trim(), pronouns: el('profilePronouns').value.trim(), custom_status: el('profileCustomStatus').value.trim(), activity: el('profileActivity').value.trim(), bio: el('profileBio').value.trim(), social_links: el('profileSocials').value.trim() }; await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); showToast('Профиль сохранен!'); });
function updateAvatarDisplay(id, avatar, username) { const elem = el(id); if (!elem) return; elem.innerHTML = (avatar && avatar.startsWith('data:image')) ? `<img src="${avatar}">` : `<span style="font-weight:900;">${username ? username.charAt(0).toUpperCase() : '🐱'}</span>`; }
bindClick('myProfileBtn', () => window.openProfile(currentUser, currentAvatar));
bindClick('logoutBtn', () => { localStorage.removeItem('kitty_user'); location.reload(); });
socket.on('profile_updated', (data) => { if (data.username === currentUser) { currentAvatar = data.avatar; myProfileData = data; el('myUsername').innerText = data.display_name || currentUser; updateAvatarDisplay('myAvatarDisplay', currentAvatar, currentUser); } const user = allUsers.find(u => u.username === data.username); if (user) Object.assign(user, data); else allUsers.push(data); if (currentChat !== 'friends') window.loadChat(currentChat); else fetchFriends(); });

bindClick('closeLightbox', () => el('lightbox').style.display = 'none');

function updateZoom() {
    el('lightboxImg').style.transform = `scale(${imgZoom})`;
    if (el('zoomPercent')) el('zoomPercent').innerText = Math.round(imgZoom * 100) + '%';
}

function openLightbox(src, sender, timeStr) {
    imgZoom = 1;
    updateZoom();
    el('lightboxImg').src = src;
    if (el('downloadImgBtn')) el('downloadImgBtn').href = src;
    if (el('lightboxInfo')) el('lightboxInfo').innerText = `Отправил(а): ${sender} • ${timeStr}`;
    el('lightbox').style.display = 'flex';
}

bindClick('zoomInBtn', (e) => {
    e.stopPropagation();
    imgZoom = Math.min(3, imgZoom + 0.25);
    updateZoom();
});

bindClick('zoomOutBtn', (e) => {
    e.stopPropagation();
    imgZoom = Math.max(0.25, imgZoom - 0.25);
    updateZoom();
});

const lbImg = el('lightboxImg');
if (lbImg) {
    lbImg.addEventListener('wheel', (e) => {
        e.preventDefault();
        imgZoom += e.deltaY * -0.002;
        imgZoom = Math.min(Math.max(0.25, imgZoom), 3);
        updateZoom();
    }, { passive: false });
}

bindClick('showPinsBtn', async () => {
    if (!currentChat.startsWith('channel_')) return showToast('Закрепы доступны только в каналах!');
    const chId = currentChat.split('_')[1];
    const res = await fetch(`/api/channels/${chId}/pins`); const data = await res.json();
    const list = el('pinsList'); list.innerHTML = '';
    if (data.pins.length === 0) list.innerHTML = '<p class="subtext">Тут пока пусто.</p>';
    data.pins.forEach(m => { list.insertAdjacentHTML('beforeend', `<div style="background:var(--bg-servers); padding:10px; border-radius:8px; border:1px solid var(--bg-hover);"><div style="font-weight:bold; color:var(--accent); font-size:12px; margin-bottom:4px;">${m.display_name || m.sender}</div><div style="color:var(--text-main); font-size:14px;">${m.type === 'text' ? formatText(m.content) : '[Медиафайл]'}</div></div>`); });
    el('pinsModal').style.display = 'flex';
});
bindClick('closePinsModal', () => el('pinsModal').style.display = 'none');

window.startReply = function (author, text) { replyingTo = { author, text }; el('replyingToUser').innerText = author; el('replyingToText').innerText = text.length > 30 ? text.substring(0, 30) + '...' : text; el('replyBar').style.display = 'flex'; el('msgInput').focus(); }
window.cancelReply = function () { replyingTo = null; if (el('replyBar')) el('replyBar').style.display = 'none'; }
bindClick('cancelReplyBtn', window.cancelReply);
window.requestDelete = function (id) { showConfirm('Удалить сообщение?', 'Это действие нельзя отменить.', 'Удалить', () => { socket.emit('delete_message', { id, username: currentUser, chatWith: currentChat }); }); }

window.togglePin = function (id, pin) {
    if (pin) {
        if (el('pinNotifyCb')) el('pinNotifyCb').checked = true;
        showConfirm('Закрепить сообщение?', 'Все участники канала увидят этот закреп.', 'Закрепить', async () => {
            await fetch('/api/messages/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, pin: true }) });
            if (el('pinNotifyCb') && el('pinNotifyCb').checked) socket.emit('send_message', { sender: 'Система', recipient: currentChat, server_id: currentServerObj ? currentServerObj.id : null, content: `📌 Пользователь **${currentUser}** закрепил сообщение.`, type: 'system' });
            showToast('Закреплено!');
        });
    } else {
        fetch('/api/messages/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, pin: false }) }); showToast('Откреплено!');
    }
}

window.addReaction = function (msgId, emoji) {
    const msgEl = el(`msg-${msgId}`);
    if (msgEl) {
        let wrap = msgEl.querySelector('.reactions-wrapper');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'reactions-wrapper';
            const contentDiv = msgEl.querySelector('.message-content') || msgEl.querySelector('.message-grouped-text');
            if (contentDiv) contentDiv.appendChild(wrap);
        }

        // 🔥 СТАВИМ БЛОКИРОВКУ: на 1.5 секунды запрещаем серверу стирать наши локальные реакции
        wrap.dataset.locked = Date.now();

        let reactsCont = wrap.querySelector('.reactions-container');
        if (!reactsCont) {
            reactsCont = document.createElement('div');
            reactsCont.className = 'reactions-container';
            wrap.appendChild(reactsCont);
        }

        let pill = Array.from(reactsCont.children).find(c => c.innerHTML.includes(emoji));
        if (pill) {
            let countEl = pill.querySelector('.reaction-count');
            let count = parseInt(countEl.innerText);
            if (pill.classList.contains('active')) {
                count--; pill.classList.remove('active');
                if (count <= 0) pill.remove(); else countEl.innerText = count;
            } else {
                count++; pill.classList.add('active'); countEl.innerText = count;
            }
        } else {
            reactsCont.insertAdjacentHTML('beforeend', `<div class="reaction-pill active" onclick="window.addReaction(${msgId}, '${emoji}')">${emoji} <span class="reaction-count">1</span></div>`);
        }
        if (reactsCont.children.length === 0) reactsCont.remove();
    }

    fetch('/api/messages/react', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: msgId, emoji: emoji, username: currentUser }) });
    if (ctxMenu) ctxMenu.style.display = 'none';
}

function appendMessage(msg, isNew = false) {
    if (!messagesContainer) return;

    const existing = el(`msg-${msg.id}`);

    let timeObj = new Date(msg.timestamp); if (isNaN(timeObj.getTime()) && typeof msg.timestamp === 'string') { timeObj = new Date(msg.timestamp.replace(' ', 'T') + 'Z'); } if (isNaN(timeObj.getTime())) timeObj = new Date();
    const timeStr = `${String(timeObj.getHours()).padStart(2, '0')}:${String(timeObj.getMinutes()).padStart(2, '0')}`; const dateStr = getNiceDate(timeObj);

    if (!existing && lastMessageDate !== dateStr) { messagesContainer.insertAdjacentHTML('beforeend', `<div class="date-separator"><span>${dateStr}</span></div>`); lastMessageDate = dateStr; lastSender = null; }

    if (msg.type === 'system') {
        if (!existing) { messagesContainer.insertAdjacentHTML('beforeend', `<div class="system-msg" id="msg-${msg.id}">${formatText(msg.content)}</div>`); lastSender = null; if (isNew) messagesContainer.scrollTop = messagesContainer.scrollHeight; }
        return;
    }

    let reactionsHTML = '';
    try {
        const reacts = JSON.parse(msg.reactions || '{}'); const reactKeys = Object.keys(reacts);
        if (reactKeys.length > 0) {
            reactionsHTML = `<div class="reactions-container">`;
            reactKeys.forEach(emoji => { const count = reacts[emoji].length; const iDidIt = reacts[emoji].includes(currentUser); reactionsHTML += `<div class="reaction-pill ${iDidIt ? 'active' : ''}" onclick="window.addReaction(${msg.id}, '${emoji}')">${emoji} <span class="reaction-count">${count}</span></div>`; });
            reactionsHTML += `</div>`;
        }
    } catch (e) { }

    // ТОЧЕЧНОЕ ОБНОВЛЕНИЕ ЗАКРЕПОВ И РЕАКЦИЙ ДЛЯ СУЩЕСТВУЮЩИХ СООБЩЕНИЙ
    if (existing) {
        let wrap = existing.querySelector('.reactions-wrapper');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'reactions-wrapper';
            const contentDiv = existing.querySelector('.message-content') || existing.querySelector('.message-grouped-text');
            if (contentDiv) contentDiv.appendChild(wrap);
        }

        // 🔥 ПРОВЕРЯЕМ БЛОКИРОВКУ: Обновляем реакции с сервера, только если мы сами их не трогали последние 1.5 секунды
        const lockTime = parseInt(wrap.dataset.locked || '0');
        if (Date.now() - lockTime > 1500) {
            if (msg.reactions !== undefined) {
                wrap.innerHTML = reactionsHTML;
            }
        }

        existing.dataset.pinned = msg.is_pinned ? '1' : '0';
        let oldPin = existing.querySelector('.pin-badge');
        if (msg.is_pinned && !oldPin) {
            const contentDiv = existing.querySelector('.message-content') || existing.querySelector('.message-grouped-text');
            if (contentDiv) contentDiv.insertAdjacentHTML('afterbegin', `<div class="pin-badge" style="font-size:10px; color:var(--accent); font-weight:bold; margin-bottom:4px;">📌 Закреплено</div>`);
        } else if (!msg.is_pinned && oldPin) {
            oldPin.remove();
        }
        return;
    }

    const safeContent = msg.content ? String(msg.content) : '';
    let cHTML = '';
    if (msg.type === 'image') cHTML = `<img src="${safeContent}" class="message-image" onclick="openLightbox('${safeContent}', '${msg.sender}', '${timeStr}')">`;
    else if (msg.type === 'video') cHTML = `<div class="custom-video-wrapper"><video src="${safeContent}" class="message-video" preload="metadata"></video><div class="video-overlay-play">▶</div><div class="custom-video-controls"><button class="play-pause-btn">▶</button><span class="video-time">0:00 / 0:00</span><input type="range" class="video-progress" value="0" min="0" max="100" step="0.1"><a href="${safeContent}" download class="dl-video-btn" title="Скачать">📥</a><button class="fullscreen-btn" title="На весь экран">⛶</button></div></div>`;
    else if (msg.type === 'audio') cHTML = `<div class="custom-audio-wrapper"><button class="play-pause-btn audio-play-btn">▶</button><div class="audio-progress-container"><input type="range" class="audio-progress video-progress" value="0" min="0" max="100" step="0.1"></div><span class="audio-time">0:00</span><button class="audio-dots-btn" onclick="window.openAudioMenu(this, event)">⋮</button><audio id="audio-${msg.id}" src="${safeContent}" preload="auto" style="display:none;"></audio></div>`;
    else cHTML = `<div class="message-text">${formatText(safeContent)}</div>`;

    const aName = msg.display_name || msg.sender; const roleColor = getUserTopRole(msg.sender)?.color || 'var(--accent)';
    let replyHTML = msg.reply_author ? `<div class="reply-badge">Ответ <span style="font-weight:bold;color:var(--text-main);">${msg.reply_author}</span>: ${msg.reply_text.substring(0, 30)}</div>` : '';
    let pinHTML = msg.is_pinned ? `<div class="pin-badge" style="font-size:10px; color:var(--accent); font-weight:bold; margin-bottom:4px;">📌 Закреплено</div>` : '';

    let isPinged = false;
    if (safeContent) {
        if (safeContent.includes('@' + currentUser) || safeContent.includes('@everyone') || safeContent.includes('@here')) isPinged = true;
        if (!isPinged && currentServerObj) { const myRoles = getUserRoles(currentUser); myRoles.forEach(rId => { const r = serverRolesCache.find(x => x.id == rId); if (r && safeContent.includes('@' + r.name)) isPinged = true; }); }
    }
    const mentionClass = isPinged ? 'mentioned-msg' : '';
    const animStyle = isNew ? 'animation: popIn 0.3s forwards;' : '';

    const isGrouped = (lastSender === msg.sender && msg.type === 'text' && !msg.reply_author && !msg.is_pinned);

    if (isGrouped) {
        messagesContainer.insertAdjacentHTML('beforeend', `<div class="message-grouped-item ${mentionClass}" id="msg-${msg.id}" data-sender="${msg.sender}" data-pinned="${msg.is_pinned ? '1' : '0'}" style="${animStyle}"><span class="message-grouped-time">${timeStr}</span><div class="message-grouped-text"><div class="message-text-wrapper">${cHTML}</div><div class="reactions-wrapper">${reactionsHTML}</div></div></div>`);
    } else {
        const aHTML = (msg.avatar && msg.avatar.startsWith('data:image')) ? `<img src="${msg.avatar}">` : msg.sender.charAt(0).toUpperCase();
        messagesContainer.insertAdjacentHTML('beforeend', `<div class="message-group ${mentionClass}" id="msg-${msg.id}" data-sender="${msg.sender}" data-pinned="${msg.is_pinned ? '1' : '0'}" style="${animStyle}"><div class="message-avatar-wrap" onclick="window.openProfile('${msg.sender}', '${msg.avatar}')"><div class="user-avatar">${aHTML}</div></div><div class="message-content">${pinHTML}${replyHTML}<div class="message-header"><span class="message-author" style="color:${roleColor};" onclick="window.openProfile('${msg.sender}', '${msg.avatar}')">${aName}</span><span class="message-time">${timeStr}</span></div><div class="message-text-wrapper">${cHTML}</div><div class="reactions-wrapper">${reactionsHTML}</div></div></div>`);
    }
    lastSender = (msg.type === 'text' && !msg.reply_author && !msg.is_pinned) ? msg.sender : null;
    if (isNew) messagesContainer.scrollTop = messagesContainer.scrollHeight;

    if (msg.type === 'audio') { setTimeout(() => { const newAudio = el(`audio-${msg.id}`); if (newAudio) { newAudio.onloadedmetadata = function () { if (newAudio.duration === Infinity) { newAudio.currentTime = 1e101; newAudio.ontimeupdate = function () { newAudio.ontimeupdate = null; newAudio.currentTime = 0; }; } else { const w = newAudio.closest('.custom-audio-wrapper'); if (w) w.querySelector('.audio-time').innerText = `0:00 / ${formatTime(newAudio.duration)}`; } }; newAudio.load(); } }, 100); }
}

socket.on('load_history', (m) => { if (!messagesContainer) return; messagesContainer.innerHTML = ''; lastSender = null; lastMessageDate = null; m.forEach(x => appendMessage(x, false)); messagesContainer.scrollTop = messagesContainer.scrollHeight; });

socket.on('receive_message', (msg) => {
    if (currentChat === msg.recipient || currentChat === msg.sender || (currentChat === 'general' && msg.recipient === 'general')) {
        appendMessage(msg, true);
    } else {
        let isPing = false;
        if (msg.content && (msg.content.includes('@' + currentUser) || msg.content.includes('@everyone') || msg.content.includes('@here'))) isPing = true;
        if (currentServerObj && msg.content) { const myRoles = getUserRoles(currentUser); myRoles.forEach(rid => { const r = serverRolesCache.find(x => x.id == rid); if (r && msg.content.includes('@' + r.name)) isPing = true; }); }

        if (msg.recipient === currentUser) { addToDMList(msg.sender, msg.avatar); incrementBadge(msg.sender, false, msg.avatar, null); }
        else if (msg.recipient.startsWith('channel_') || msg.recipient === 'general') { if (isPing) incrementBadge(msg.recipient, true, null, msg.server_id); }
    }
});

socket.on('message_deleted', (data) => { const elem = el(`msg-${data.id}`); if (elem) elem.remove(); if (ctxMenu) ctxMenu.style.display = 'none'; });
socket.on('message_updated', (msg) => { appendMessage(msg, false); });

function sendMessage() { const text = msgInput.value.trim(); if (!text) return; socket.emit('send_message', { sender: currentUser, recipient: currentChat, server_id: currentServerObj ? currentServerObj.id : null, content: text, type: 'text', reply_author: replyingTo?.author || '', reply_text: replyingTo?.text || '' }); msgInput.value = ''; if (el('mentionDropdown')) el('mentionDropdown').style.display = 'none'; if (el('emojiDropdown')) el('emojiDropdown').style.display = 'none'; window.cancelReply(); }
bindClick('sendBtn', sendMessage); const renderEmojis = () => { if (!el('emojiDropdown')) return; el('emojiDropdown').innerHTML = ''; defaultEmojis.forEach(e => { const span = document.createElement('span'); span.className = 'emoji-item'; span.innerText = e; span.onclick = () => { msgInput.value += e; msgInput.focus(); el('emojiDropdown').style.display = 'none'; }; el('emojiDropdown').appendChild(span); }); }; renderEmojis();
bindClick('emojiBtn', (e) => { e.stopPropagation(); if (el('emojiDropdown')) el('emojiDropdown').style.display = el('emojiDropdown').style.display === 'none' ? 'flex' : 'none'; });

// ФИКС УМНОГО ПОИСКА: Железобетонный рендер
function handleMentionInput() {
    if (!msgInput || !el('mentionDropdown')) return;
    const text = msgInput.value; const cursorPos = msgInput.selectionStart;
    const textBeforeCursor = text.substring(0, cursorPos);
    const match = textBeforeCursor.match(/@([a-zA-Zа-яА-Я0-9_]*)$/);

    if (match) {
        const term = match[1].toLowerCase(); currentMentionMatches = [];

        if (currentServerObj) {
            if ('everyone'.includes(term)) currentMentionMatches.push({ username: 'everyone', display_name: 'Все на сервере', isRole: true, color: '#F04747' });
            if ('here'.includes(term)) currentMentionMatches.push({ username: 'here', display_name: 'Активные', isRole: true, color: '#FAA61A' });

            if (serverRolesCache) {
                serverRolesCache.forEach(r => { if (r.name.toLowerCase().includes(term)) currentMentionMatches.push({ username: r.name, display_name: r.name, isRole: true, color: r.color }); });
            }

            serverMembersCache.forEach(m => {
                if (m.username.toLowerCase().includes(term) && m.username !== currentUser) {
                    const uData = allUsers.find(u => u.username === m.username) || m;
                    if (!currentMentionMatches.find(x => x.username === uData.username && !x.isRole)) currentMentionMatches.push(uData);
                }
            });
        } else {
            allUsers.forEach(u => {
                if (u.username.toLowerCase().includes(term) && u.username !== currentUser) {
                    if (!currentMentionMatches.find(x => x.username === u.username && !x.isRole)) currentMentionMatches.push(u);
                }
            });
        }

        if (currentMentionMatches.length > 0) {
            mentionIndex = 0;
            renderMentionDropdown();
        } else el('mentionDropdown').style.display = 'none';
    } else {
        el('mentionDropdown').style.display = 'none';
    }
}

function handleMentionKeydown(e) {
    if (!el('mentionDropdown')) return;
    if (el('mentionDropdown').style.display === 'flex') {
        if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex = (mentionIndex + 1) % currentMentionMatches.length; renderMentionDropdown(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = (mentionIndex - 1 + currentMentionMatches.length) % currentMentionMatches.length; renderMentionDropdown(); }
        else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectMention(currentMentionMatches[mentionIndex].username); }
    } else if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
}

function renderMentionDropdown() {
    const md = el('mentionDropdown');
    if (!md) return;

    md.style.position = 'absolute';
    md.style.bottom = 'calc(100% + 10px)';
    md.style.left = '24px';
    md.style.zIndex = '999999';

    md.innerHTML = '<div style="padding: 4px 8px; font-size: 11px; font-weight: bold; color: var(--text-muted); text-transform: uppercase; border-bottom: 1px solid var(--bg-hover); margin-bottom: 4px;">Участники и Роли</div>';
    currentMentionMatches.forEach((u, i) => {
        const div = document.createElement('div'); div.className = `mention-item ${i === mentionIndex ? 'selected' : ''}`;
        if (u.isRole) {
            div.innerHTML = `<div style="width:12px;height:12px;border-radius:50%;background:${u.color};margin-right:8px;flex-shrink:0;"></div><span style="color:${u.color}; font-weight:bold;">@${u.display_name}</span>`;
        } else {
            div.innerHTML = `<div class="user-avatar-wrap" style="width:24px;height:24px; margin-right:8px;"><div class="user-avatar" style="font-size:10px;"><img src="${u.avatar || ''}" style="display:${u.avatar ? 'block' : 'none'};"> ${!u.avatar ? u.username.charAt(0).toUpperCase() : ''}</div></div><span>${u.display_name || u.username}</span>`;
        }
        div.onmousedown = (e) => { e.preventDefault(); selectMention(u.username); };
        div.onmouseenter = () => { mentionIndex = i; renderMentionDropdown(); };
        md.appendChild(div);
    });
    md.style.display = 'flex';

    const selectedEl = md.querySelector('.selected');
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
}

function selectMention(u) {
    if (!msgInput) return;
    const text = msgInput.value; const cursorPos = msgInput.selectionStart;
    const textBefore = text.substring(0, cursorPos).replace(/@[a-zA-Zа-яА-Я0-9_]*$/, `@${u} `);
    const textAfter = text.substring(cursorPos);
    msgInput.value = textBefore + textAfter;
    if (el('mentionDropdown')) el('mentionDropdown').style.display = 'none';
    msgInput.focus();
}

async function uploadFile(file, type) { const formData = new FormData(); formData.append('file', file); const res = await fetch('/api/upload', { method: 'POST', body: formData }); const data = await res.json(); if (data.success) socket.emit('send_message', { sender: currentUser, recipient: currentChat, server_id: currentServerObj ? currentServerObj.id : null, content: data.url, type: type, reply_author: replyingTo?.author || '', reply_text: replyingTo?.text || '' }); else showToast('Ошибка загрузки файла!', true); window.cancelReply(); }
bindChange('fileInput', function (e) { const file = e.target.files[0]; if (!file) return; let type = 'text'; if (file.type.startsWith('image/')) type = 'image'; else if (file.type.startsWith('video/')) type = 'video'; else if (file.type.startsWith('audio/')) type = 'audio'; uploadFile(file, type); });

let mediaRecorder, audioChunks = []; const micBtn = el('micBtn');
if (micBtn) {
    micBtn.onmousedown = async () => { try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); mediaRecorder = new MediaRecorder(stream); mediaRecorder.ondataavailable = e => audioChunks.push(e.data); mediaRecorder.onstop = () => { const audioBlob = new Blob(audioChunks, { type: 'audio/webm' }); const file = new File([audioBlob], "voice.webm", { type: 'audio/webm' }); uploadFile(file, 'audio'); audioChunks = []; }; mediaRecorder.start(); micBtn.classList.add('recording'); } catch (e) { showToast('Нет доступа к микрофону!', true); } };
    micBtn.onmouseup = () => { if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); mediaRecorder.stream.getTracks().forEach(t => t.stop()); micBtn.classList.remove('recording'); } };
    micBtn.onmouseleave = micBtn.onmouseup;
}

document.addEventListener('click', (e) => {
    if (e.target.classList.contains('video-overlay-play')) { const wrapper = e.target.closest('.custom-video-wrapper'); const video = wrapper.querySelector('video'); video.play().then(() => { e.target.classList.add('hidden'); wrapper.querySelector('.play-pause-btn').innerText = '⏸'; }).catch(err => console.log(err)); }
    if (e.target.classList.contains('play-pause-btn')) { const wrapper = e.target.closest('.custom-video-wrapper, .custom-audio-wrapper'); const media = wrapper.querySelector('video, audio'); const overlay = wrapper.querySelector('.video-overlay-play'); if (media.paused) { if (media.currentTime >= media.duration) media.currentTime = 0; media.play(); e.target.innerText = '⏸'; e.target.classList.add('playing'); if (overlay) overlay.classList.add('hidden'); } else { media.pause(); e.target.innerText = '▶'; e.target.classList.remove('playing'); if (overlay) overlay.classList.remove('hidden'); } }
    if (e.target.classList.contains('fullscreen-btn')) { const wrapper = e.target.closest('.custom-video-wrapper'); if (document.fullscreenElement) document.exitFullscreen(); else if (wrapper.requestFullscreen) wrapper.requestFullscreen(); }
});
document.addEventListener('input', (e) => { if (e.target.classList.contains('video-progress') || e.target.classList.contains('audio-progress')) { const wrapper = e.target.closest('.custom-video-wrapper, .custom-audio-wrapper'); const media = wrapper.querySelector('video, audio'); media.currentTime = (e.target.value / 100) * media.duration; e.target.style.setProperty('--progress', `${e.target.value}%`); } });
document.addEventListener('timeupdate', (e) => { if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') { const wrapper = e.target.closest('.custom-video-wrapper, .custom-audio-wrapper'); if (!wrapper) return; const progress = wrapper.querySelector('.video-progress, .audio-progress'); const timeDisplay = wrapper.querySelector('.video-time, .audio-time'); let dur = e.target.duration; if (progress && isFinite(dur) && dur > 0) { const perc = (e.target.currentTime / dur) * 100; progress.value = perc; progress.style.setProperty('--progress', `${perc}%`); } if (timeDisplay && isFinite(dur) && dur > 0) { timeDisplay.innerText = `${formatTime(e.target.currentTime)} / ${formatTime(dur)}`; } } }, true);
document.addEventListener('ended', (e) => { if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') { const wrapper = e.target.closest('.custom-video-wrapper, .custom-audio-wrapper'); const btn = wrapper.querySelector('.play-pause-btn'); btn.innerText = '▶'; btn.classList.remove('playing'); const overlay = wrapper.querySelector('.video-overlay-play'); if (overlay) overlay.classList.remove('hidden'); } }, true);

window.openAudioMenu = (btn, event) => { event.stopPropagation(); const wrapper = btn.closest('.custom-audio-wrapper'); const audio = wrapper.querySelector('audio'); ctxMenu.innerHTML = `<div class="context-menu-item" onclick="window.setAudioSpeed('${audio.id}', 1)">🐌 Скорость: 1x</div><div class="context-menu-item" onclick="window.setAudioSpeed('${audio.id}', 1.5)">🏃 Скорость: 1.5x</div><div class="context-menu-item" onclick="window.setAudioSpeed('${audio.id}', 2)">🚀 Скорость: 2x</div><a href="${audio.src}" download class="context-menu-item" style="text-decoration:none; color: var(--accent);">📥 Скачать ГС</a>`; ctxMenu.style.display = 'block'; requestAnimationFrame(() => { const rect = ctxMenu.getBoundingClientRect(); let top = event.clientY; let left = event.clientX; if (top + rect.height > window.innerHeight) top -= rect.height; if (left + rect.width > window.innerWidth) left -= rect.width; ctxMenu.style.top = top + 'px'; ctxMenu.style.left = left + 'px'; }); };
window.setAudioSpeed = (id, speed) => { const audio = el(id); if (audio) audio.playbackRate = speed; if (ctxMenu) ctxMenu.style.display = 'none'; showToast(`Скорость ГС: ${speed}x`); };


document.addEventListener('contextmenu', e => {
    let html = '';
    const menu = el('customContextMenu'); if (!menu) return;

    let iCanManageMessages = false;
    let iCanManageChannels = false;
    if (currentServerObj && currentServerObj.owner === currentUser) { iCanManageMessages = true; iCanManageChannels = true; }
    else if (currentServerObj) {
        const myRoles = getUserRoles(currentUser);
        myRoles.forEach(rId => { const r = serverRolesCache.find(x => x.id == rId); if (r) { if (r.can_manage_channels) iCanManageChannels = true; if (r.can_manage_messages) iCanManageMessages = true; } });
    }

    if (e.target === msgInput && msgInput.selectionStart !== msgInput.selectionEnd) { e.preventDefault(); html = `<div class="context-menu-item" onclick="window.formatInput('**')"><strong>Жирный</strong></div><div class="context-menu-item" onclick="window.formatInput('*')"><em>Курсив</em></div><div class="context-menu-item" onclick="window.formatInput('~~')"><s>Зачеркнутый</s></div><div class="context-menu-item" onclick="window.formatInput('> ', true)">💬 Цитата</div>`; }
    else if (e.target.closest('.message-group') || e.target.closest('.message-grouped-item')) {
        e.preventDefault(); const msgEl = e.target.closest('.message-group') || e.target.closest('.message-grouped-item'); const isMine = msgEl.dataset.sender === currentUser; const msgId = msgEl.id.split('-')[1]; const author = msgEl.querySelector('.message-author')?.innerText || lastSender; const isPinned = msgEl.dataset.pinned === '1';
        html = `<div class="context-menu-item" onclick="window.startReply('${author}', '${msgEl.querySelector('.message-text')?.innerText.substring(0, 30).replace(/'/g, "\\'") || 'Медиафайл'}')">↩ Ответить</div>`;

        let reactsHtml = `<div style="display:flex; gap:8px; padding:4px 8px; justify-content:center;">`;
        defaultEmojis.slice(0, 5).forEach(em => { reactsHtml += `<span style="cursor:pointer; font-size:20px; transition:0.2s;" onclick="window.addReaction(${msgId}, '${em}')" onmouseover="this.style.transform='scale(1.3)'" onmouseout="this.style.transform='scale(1)'">${em}</span>`; });
        reactsHtml += `</div><div class="server-separator" style="margin:4px 0; width:100%;"></div>`;
        html = reactsHtml + html;

        if (currentChat.startsWith('channel_') && (iCanManageMessages || isMine)) html += `<div class="context-menu-item" onclick="window.togglePin(${msgId}, ${!isPinned})">📌 ${isPinned ? 'Открепить' : 'Закрепить'}</div>`;
        if (isMine || iCanManageMessages) html += `<div class="context-menu-item danger" onclick="window.requestDelete(${msgId})">🗑 Удалить</div>`;
    }
    else if (e.target.closest('.server-icon') && e.target.closest('.server-icon').id.startsWith('server-btn-')) {
        e.preventDefault(); const srvId = e.target.closest('.server-icon').id.replace('server-btn-', '');
        if (currentServerObj && currentServerObj.id == srvId && currentServerObj.owner === currentUser) { html = `<div class="context-menu-item" onclick="window.openServerSettings(${srvId})">⚙️ Настройки</div><div class="context-menu-item danger" onclick="window.deleteChannel(0)">🗑 Удалить сервер</div>`; }
        else { html = `<div class="context-menu-item danger" onclick="window.leaveServer(${srvId})">🚪 Покинуть</div>`; }
    }

    if (html) {
        menu.innerHTML = html; menu.style.display = 'block';
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            let top = e.clientY; let left = e.clientX;
            if (top + rect.height > window.innerHeight) top -= rect.height;
            if (left + rect.width > window.innerWidth) left -= rect.width;
            menu.style.top = top + 'px'; menu.style.left = left + 'px';
        });
    } else { menu.style.display = 'none'; }
});

window.onclick = (e) => {
    ['confirmModal', 'profileModal', 'serverModal', 'createChannelModal', 'channelSettingsModal', 'serverSettingsModal', 'lightbox', 'pinsModal', 'pinConfirmModal'].forEach(id => {
        const modal = el(id); if (modal && e.target === modal) modal.style.display = 'none';
    });
    if (!e.target.closest('#serverDropdown') && !e.target.closest('#serverHeader')) { const sd = el('serverDropdown'); if (sd) sd.style.display = 'none'; }
    if (!e.target.closest('.context-menu') && ctxMenu) ctxMenu.style.display = 'none';
    if (!e.target.closest('.audio-dots-btn') && !e.target.closest('.audio-menu')) document.querySelectorAll('.audio-menu').forEach(m => m.style.display = 'none');

    const md = el('mentionDropdown');
    if (md && md.style.display === 'flex' && !e.target.closest('.mention-dropdown') && e.target !== msgInput) {
        md.style.display = 'none';
    }
};