const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const APP_VERSION = '2026-10-31-35';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Aklomanti';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AZC.anka.34';

const SMSTC_API_URL = 'https://sms.tc/stubs/handler_api.php';
const SMSTC_API_KEY = process.env.SMSTC_API_KEY || 'smstc_live_0vHjhoWB7H8qniIpTV5GDwF3W04eNpXRUWHZ9GYW';

const PROVIDER_MIN_INTERVAL_MS = 2200;
let providerQueue = Promise.resolve();
let lastProviderCallAt = 0;

function providerGet(params, timeout) {
    const run = providerQueue.then(async () => {
        const wait = PROVIDER_MIN_INTERVAL_MS - (Date.now() - lastProviderCallAt);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastProviderCallAt = Date.now();
        return axios.get(SMSTC_API_URL, { 
            params: Object.assign({ api_key: SMSTC_API_KEY }, params), 
            timeout: timeout || 20000 
        });
    });
    providerQueue = run.then(() => {}, () => {});
    return run;
}

const DEFAULT_DB = {
    users: {
        [ADMIN_USERNAME]: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, balance: 5000, role: "admin", banned: false }
    },
    orders: {},
    adminSessions: {},
    customCatalog: [] 
};

const DB_FILE = path.join(__dirname, 'anka_data.json');
let db = DEFAULT_DB;
try {
    if (fs.existsSync(DB_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = Object.assign({}, DEFAULT_DB, loaded);
    }
} catch (e) { }

db.users[ADMIN_USERNAME] = Object.assign(
    { balance: 5000 },
    db.users[ADMIN_USERNAME] || {},
    { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, role: 'admin', banned: false }
);

function persist() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { }
}

const DEFAULT_CATALOG = [
    { id: 'wa_tr', name: 'WhatsApp Türkiye', serviceCode: 'wa', countryCode: '62', price: 380 },
    { id: 'tg_tr', name: 'Telegram Türkiye', serviceCode: 'tg', countryCode: '62', price: 200 }
];

function checkAdminToken(token) {
    const sess = token && db.adminSessions[token];
    if (!sess || Date.now() - sess.ts > 7 * 24 * 60 * 60 * 1000) return null;
    return sess.username;
}

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Anka SMS Panel</title><script src="https://cdn.tailwindcss.com"></script><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"></head><body class="bg-slate-950 text-slate-100 min-h-screen"><div class="max-w-4xl mx-auto p-4 sm:p-6"><header class="flex justify-between items-center bg-slate-900 border border-slate-800 p-4 rounded-xl mb-6 shadow-lg"><div><h1 class="text-xl font-bold text-violet-400"><i class="fa-solid fa-shield-halved mr-2"></i>Anka SMS Panel</h1><p class="text-xs text-slate-400">Sürüm: ${APP_VERSION}</p></div><div class="flex items-center gap-4"><span class="text-sm">Bakiye: <b id="lblBakiye" class="text-emerald-400">5000</b> TL</span><button onclick="openAdminModal()" class="bg-violet-600 hover:bg-violet-500 text-xs px-3 py-2 rounded-lg font-semibold transition"><i class="fa-solid fa-lock mr-1"></i>Admin Panel</button></div></header><div class="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6 shadow-lg"><h2 class="text-lg font-semibold mb-4 text-violet-300"><i class="fa-solid fa-cart-shopping mr-2"></i>Numara Satın Al</h2><div id="catalogList" class="grid grid-cols-1 sm:grid-cols-2 gap-4"></div></div><div id="activeOrderBox" class="hidden bg-slate-900 border border-emerald-500/30 rounded-xl p-5 shadow-lg mb-6"><h2 class="text-lg font-semibold mb-2 text-emerald-400"><i class="fa-solid fa-phone mr-2"></i>Aktif Numara İşlemi</h2><p class="text-sm text-slate-300">Numara: <b id="lblPhone" class="text-white text-lg"></b></p><p class="text-sm text-slate-300 mt-1">Gelen SMS Kodu: <b id="lblSmsCode" class="text-amber-400 text-xl">Bekleniyor...</b></p><button onclick="checkSms()" class="mt-4 bg-emerald-600 hover:bg-emerald-500 text-xs px-4 py-2 rounded-lg font-semibold"><i class="fa-solid fa-rotate mr-1"></i>SMS Kodunu Kontrol Et</button></div></div><div id="adminModal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center p-4"><div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl w-full max-w-md shadow-2xl"><h3 class="text-lg font-bold mb-4 text-violet-400">Admin Girişi</h3><input type="text" id="admUser" value="Aklomanti" class="w-full bg-slate-950 border border-slate-800 p-3 rounded-xl mb-3 text-sm"><input type="password" id="admPass" value="AZC.anka.34" class="w-full bg-slate-950 border border-slate-800 p-3 rounded-xl mb-4 text-sm"><div class="flex justify-end gap-2"><button onclick="closeAdminModal()" class="bg-slate-800 px-4 py-2 rounded-xl text-xs">İptal</button><button onclick="doAdminLogin()" class="bg-violet-600 px-4 py-2 rounded-xl text-xs font-bold">Giriş Yap</button></div></div></div><div id="adminPanelModal" class="hidden fixed inset-0 bg-black/80 flex items-center justify-center p-4 overflow-y-auto"><div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl w-full max-w-2xl shadow-2xl my-8"><div class="flex justify-between items-center mb-4"><h3 class="text-lg font-bold text-violet-400"><i class="fa-solid fa-gears mr-2"></i>Admin Yönetim Paneli</h3><button onclick="closeAdminPanel()" class="text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button></div><div class="mb-6"><h4 class="text-sm font-semibold mb-2 text-slate-300">Ürün Fiyat ve Kodlarını Düzenle</h4><div class="space-y-3" id="adminCatalogEditList"></div></div><div class="flex justify-end"><button onclick="closeAdminPanel()" class="bg-slate-800 px-4 py-2 rounded-xl text-xs">Kapat</button></div></div></div><script>
        let currentOrder = null;
        let adminToken = '';
        async function loadCatalog() {
            const res = await fetch('/api/catalog');
            const data = await res.json();
            const box = document.getElementById('catalogList');
            box.innerHTML = '';
            data.catalog.forEach(item => {
                box.innerHTML += \`<div class="bg-slate-950 border border-slate-800 p-4 rounded-xl flex justify-between items-center"><div><h3 class="font-bold text-sm">\${item.name}</h3><p class="text-xs text-slate-400">Servis: \${item.serviceCode} | Ülke: \${item.countryCode}</p><p class="text-emerald-400 font-bold mt-1">\${item.price} TL</p></div><button onclick="buyNumber('\${item.id}')" class="bg-violet-600 hover:bg-violet-500 text-xs px-4 py-2 rounded-xl font-semibold transition">Satın Al</button></div>\`;
            });
        }
        async function buyNumber(productId) {
            const res = await fetch('/api/order/buy', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username: 'Aklomanti', productId }) });
            const data = await res.json();
            if(data.success) { alert('Numara başarıyla alındı!'); currentOrder = data.orderId; document.getElementById('activeOrderBox').classList.remove('hidden'); document.getElementById('lblPhone').innerText = data.phoneNumber; document.getElementById('lblSmsCode').innerText = 'Bekleniyor...'; } else { alert('Hata: ' + data.message); }
        }
        async function checkSms() {
            if(!currentOrder) return;
            const res = await fetch('/api/order/check', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ orderId: currentOrder }) });
            const data = await res.json();
            if(data.success && data.smsCode) { document.getElementById('lblSmsCode').innerText = data.smsCode; } else { alert('Henüz SMS gelmedi.'); }
        }
        function openAdminModal() { document.getElementById('adminModal').classList.remove('hidden'); }
        function closeAdminModal() { document.getElementById('adminModal').classList.add('hidden'); }
        async function doAdminLogin() {
            const username = document.getElementById('admUser').value;
            const password = document.getElementById('admPass').value;
            const res = await fetch('/api/admin/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username, password }) });
            const data = await res.json();
            if(data.success) { adminToken = data.token; closeAdminModal(); openAdminPanel(); } else { alert('Giriş başarısız!'); }
        }
        async function openAdminPanel() {
            document.getElementById('adminPanelModal').classList.remove('hidden');
            const res = await fetch('/api/catalog');
            const data = await res.json();
            const box = document.getElementById('adminCatalogEditList');
            box.innerHTML = '';
            data.catalog.forEach(item => {
                box.innerHTML += \`<div class="bg-slate-950 p-3 rounded-xl border border-slate-800 grid grid-cols-1 sm:grid-cols-4 gap-2 items-center"><span class="text-xs font-bold">\${item.name}</span><input type="text" id="sc_\${item.id}" value="\${item.serviceCode}" class="bg-slate-900 border border-slate-800 p-2 rounded text-xs"><input type="text" id="cc_\${item.id}" value="\${item.countryCode}" class="bg-slate-900 border border-slate-800 p-2 rounded text-xs"><input type="number" id="pr_\${item.id}" value="\${item.price}" class="bg-slate-900 border border-slate-800 p-2 rounded text-xs"><button onclick="updateItem('\${item.id}')" class="col-span-full sm:col-span-4 bg-emerald-600 hover:bg-emerald-500 py-1.5 rounded text-xs font-bold">Kaydet</button></div>\`;
            });
        }
        function closeAdminPanel() { document.getElementById('adminPanelModal').classList.add('hidden'); loadCatalog(); }
        async function updateItem(id) {
            const serviceCode = document.getElementById('sc_'+id).value;
            const countryCode = document.getElementById('cc_'+id).value;
            const price = document.getElementById('pr_'+id).value;
            const res = await fetch('/api/admin/update-catalog', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken }, body: JSON.stringify({ id, serviceCode, countryCode, price }) });
            const data = await res.json();
            alert(data.message);
        }
        loadCatalog();
    </script></body></html>`);
});

app.get('/api/catalog', (req, res) => {
    const catalog = DEFAULT_CATALOG.map(item => {
        const custom = (db.customCatalog || []).find(c => c.id === item.id);
        return custom ? Object.assign({}, item, custom) : item;
    });
    (db.customCatalog || []).filter(c => !DEFAULT_CATALOG.some(d => d.id === c.id)).forEach(c => catalog.push(c));
    res.json({ success: true, catalog });
});

app.post('/api/order/buy', async (req, res) => {
    const { username, productId } = req.body;
    const user = db.users[username];
    if (!user) return res.json({ success: false, message: 'Kullanıcı bulunamadı.' });

    const allCatalog = [...DEFAULT_CATALOG, ...(db.customCatalog || [])];
    const product = allCatalog.find(p => p.id === productId);
    if (!product) return res.json({ success: false, message: 'Ürün bulunamadı.' });

    if (user.balance < product.price) {
        return res.json({ success: false, message: 'Yetersiz bakiye!' });
    }

    try {
        const r = await providerGet({
            action: 'getNumber',
            service: product.serviceCode,
            country: product.countryCode
        });

        let data = r.data;
        if (typeof data === 'string' && data.includes('ACCESS_NUMBER')) {
            const parts = data.split(':');
            const activationId = parts[1];
            const phoneNumber = parts[2];

            user.balance -= product.price;
            const orderId = 'ord_' + Date.now();
            db.orders[orderId] = { id: orderId, activationId, phoneNumber, status: 'active' };
            persist();

            return res.json({ success: true, orderId, phoneNumber, activationId });
        } else {
            return res.json({ success: false, message: 'Sağlayıcı yanıtı: ' + JSON.stringify(data) });
        }
    } catch (e) {
        return res.json({ success: false, message: 'Hata: ' + e.message });
    }
});

app.post('/api/order/check', async (req, res) => {
    const { orderId } = req.body;
    const order = db.orders[orderId];
    if (!order) return res.json({ success: false, message: 'Sipariş yok.' });

    try {
        const r = await providerGet({ action: 'getStatus', id: order.activationId });
        let data = r.data;
        if (typeof data === 'string' && data.includes('STATUS_OK')) {
            const code = data.split(':')[1];
            return res.json({ success: true, smsCode: code });
        }
        return res.json({ success: true, smsCode: null });
    } catch (e) {
        return res.json({ success: false, message: e.message });
    }
});

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        db.adminSessions[token] = { username, ts: Date.now() };
        persist();
        return res.json({ success: true, token });
    }
    res.json({ success: false, message: 'Hatalı bilgi!' });
});

app.post('/api/admin/update-catalog', (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!checkAdminToken(token)) return res.status(401).json({ success: false, message: 'Yetkisiz!' });

    const { id, serviceCode, countryCode, price } = req.body;
    let custom = db.customCatalog.find(c => c.id === id);
    const def = DEFAULT_CATALOG.find(d => d.id === id) || { name: id };

    if (custom) {
        custom.serviceCode = serviceCode;
        custom.countryCode = countryCode;
        custom.price = parseFloat(price);
    } else {
        db.customCatalog.push({ id, name: def.name, serviceCode, countryCode, price: parseFloat(price) });
    }
    persist();
    res.json({ success: true, message: 'Güncellendi.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Anka SMS Panel ${PORT} portunda aktif.`);
});
