const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const APP_VERSION = '2026-10-31-25';

// ====== AYARLAR (sms.tc entegrasyonu) ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8989904538:AAGETyb0e5ghitsYM3yWInhnIi3lexYMjPw';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const ADMIN_TELEGRAM_USERNAME = process.env.ADMIN_TELEGRAM_USERNAME || 'vipankaa'; 
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '573181006792'; 
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://g-venlipanelsms.onrender.com';

const SMSTC_API_URL = 'https://sms.tc/stubs/handler_api.php';
const SMSTC_API_KEY = process.env.SMSTC_API_KEY || 'smstc_live_0vHjhoWB7H8qniIpTV5GDwF3W04eNpXRUWHZ9GYW';

const SMM_API_URL = process.env.SMM_API_URL || 'https://peakerr.com/api/v2';
const SMM_API_KEY = process.env.SMM_API_KEY || '';
const LOW_BALANCE_THRESHOLD = parseFloat(process.env.LOW_BALANCE_THRESHOLD || '50');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Aklomanti';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AZC.anka.34';

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
    payments: {},
    visitors: [],
    logins: [],
    orders: {},
    support: {},
    adminSessions: {},
    smmConfig: {},
    smmOrders: {},
    customCatalog: [],
    otherPlatformsMarkup: { multiplier: 1.8 }
};

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'anka_data.json');
let db = DEFAULT_DB;
try {
    if (fs.existsSync(DB_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = Object.assign({}, DEFAULT_DB, loaded);
        for (const k in DEFAULT_DB) if (db[k] === undefined) db[k] = DEFAULT_DB[k];
        if (!db.users || !Object.keys(db.users).length) db.users = DEFAULT_DB.users;
        for (const u in DEFAULT_DB.users) {
            if (!db.users[u]) db.users[u] = DEFAULT_DB.users[u];
        }
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

const CATALOG = [
    { id: 'wa_tr_dinlenmis', key: 'tr', name: 'Dinlendirilmiş WhatsApp Türkiye (Premium)', serviceCode: 'wa', defCountry: '62', price: 380, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-violet-500/10', color: 'text-violet-400', featured: true },
    { id: 'tg_tr', key: 'tr', name: 'Telegram Türkiye', serviceCode: 'tg', defCountry: '62', price: 200, icon: 'fa-telegram', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-400' }
];

(db.customCatalog || []).forEach(p => { if (p && p.id && !CATALOG.some(c => c.id === p.id)) CATALOG.push(p); });

app.listen(process.env.PORT || 3000, () => {
    console.log(`Anka SMS Panel aktif ve çalışıyor.`);
});
