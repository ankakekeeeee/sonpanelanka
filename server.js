const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const APP_VERSION = '2026-10-31-30';

// ====== AYARLAR (sms.tc Entegrasyonu) ======
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Aklomanti';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AZC.anka.34';

const SMSTC_API_URL = 'https://sms.tc/stubs/handler_api.php';
const SMSTC_API_KEY = process.env.SMSTC_API_KEY || 'smstc_live_0vHjhoWB7H8qniIpTV5GDwF3W04eNpXRUWHZ9GYW';

// Sağlayıcı isteklerini rate-limit'e takılmamak için sıraya alan kuyruk mekanizması
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

// ====== ANA SAYFA VE KULLANICI PANELİ (HTML) ======
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <title>Anka SMS & Yönetim Paneli</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">
    <div class="max-w-4xl mx-auto p-4 sm:p-6">
        <header class="flex justify-between items-center bg-slate-900 border border-slate-800 p-4 rounded-xl mb-6 shadow-lg">
            <div>
                <h1 class="text-xl font-bold text-violet-400"><i class="fa-solid fa-shield-halved mr-2"></i>Anka SMS Panel</h1>
                <p class="text-xs text-slate-400">Sürüm: ${APP_VERSION}</p>
            </div>
            <div class="flex items-center gap-4">
                <span class="text-sm">Bakiye: <b id="lblBakiye" class="text-emerald-400">5000</b> TL</span>
                <button onclick="openAdminModal()" class="bg-violet-600 hover:bg-violet-500 text-xs px-3 py-2 rounded-lg font-semibold transition"><i class="fa-solid fa-lock mr-1"></i>Admin Panel</button>
            </div>
        </header>

        <!-- ÜRÜN LİSTESİ -->
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6 shadow-lg">
            <h2 class="text-lg font-semibold mb-4 text-violet-300"><i class="fa-solid fa-cart-shopping mr-2"></i>Numara Satın Al</h2>
            <div id="catalogList" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <!-- Dinamik yüklenecek -->
            </div>
        </div>

        <!-- AKTİF NUMARA / SMS EKRANI -->
        <div id="activeOrderBox" class="hidden bg-slate-900 border border-emerald-500/30 rounded-xl p-5 shadow-lg mb-6">
            <h2 class="text-lg font-semibold mb-2 text-emerald-400"><i class="fa-solid fa-phone mr-2"></i>Aktif Numara İşlemi</h2>
            <p class="text-sm text-slate-300">Numara: <b id="lblPhone" class="text-white text-lg"></b></p>
            <p class="text-sm text-slate-300 mt-1">Gelen SMS Kodu: <b id="lblSmsCode" class="text-amber-400 text-xl">Bekleniyor...</b></p>
            <button onclick="checkSms()" class="mt-4 bg-emerald-600 hover:bg-emerald-500 text-xs px-4 py-2 rounded-lg font-semibold"><i class="fa-solid fa-rotate mr-1"></i>SMS Kodunu Kontrol Et</button>
        </div>
    </div>

    <!-- ADMIN GİRİŞ MODALI -->
    <div id="adminModal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center p-4">
        <div class="bg-
