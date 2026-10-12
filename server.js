const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

// Her yeni dosya teslim edildiğinde bu tarihi değiştiriyoruz. Sitenin en altında küçük yazıyla görünür -
// Render'a yüklediğin sürümün gerçekten güncellenip güncellenmediğini buradan kontrol edebilirsin.
const APP_VERSION = '2026-10-11-10';

// ====== AYARLAR (Render > Environment bölümünden de girilebilir) ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8950975662:AAGVS-pPNJYWpxYjSLyJIXTEDBn0mD5y8XY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const ADMIN_TELEGRAM_USERNAME = process.env.ADMIN_TELEGRAM_USERNAME || 'vipankaa'; // destek için görünen iletişim kanalı
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '573181006792'; // wa.me linki için ülke koduyla, başında + ve boşluk olmadan
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://g-venlipanelsms.onrender.com';
const ONAYLI_SMS_API_KEY = process.env.ONAYLI_SMS_API_KEY || 'osms_7f193a3fe65448a9380061c1b56e9fdc29f49c67e89eb3dd';
const ONAYLI_SMS_URL = 'https://onaylasms.com.tr/stubs/handler_api.php';
// Instagram takipçi/beğeni vb. için SMM panel sağlayıcısı (standart "add/status/services/balance" API formatı).
// API anahtarını Render > Environment'tan SMM_API_KEY olarak gir - buraya yazmıyoruz, boşsa bu bölüm devre dışı kalır.
const SMM_API_URL = process.env.SMM_API_URL || 'https://peakerr.com/api/v2';
const SMM_API_KEY = process.env.SMM_API_KEY || '';
// Sağlayıcı bakiyesi bu değerin altına düşünce Telegram'dan otomatik uyarı gelir
const LOW_BALANCE_THRESHOLD = parseFloat(process.env.LOW_BALANCE_THRESHOLD || '50');

// Admin panel giriş bilgileri - burada veya Render > Environment'tan değiştirilebilir.
// Sunucu her açıldığında bu hesabın kullanıcı adı/şifresi/yetkisi ZORLA bu değerlere eşitlenir (aşağıda, db yüklendikten sonra),
// yani diskte eski/bozuk bir admin kaydı olsa bile admin girişi her zaman bununla çalışır.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Aklomanti';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AZC.anka.34';

// ====== Sağlayıcıya TEK SIRADAN istek atan kuyruk (TOO_MANY_REQUESTS'i kökten önlemek için) ======
// Aynı anda birden fazla fonksiyon (fiyat kontrolü, ülke listesi, bakiye, getNumber...) sağlayıcıya
// istek atabiliyor; bunlar üst üste binerse sağlayıcı "çok fazla istek" diyip engelliyor.
// Bu yüzden TÜM sağlayıcı istekleri burada sıraya alınır ve aralarında en az PROVIDER_MIN_INTERVAL_MS kadar süre bırakılır.
const PROVIDER_MIN_INTERVAL_MS = 2200;
let providerQueue = Promise.resolve();
let lastProviderCallAt = 0;
function providerGet(params, timeout) {
    const run = providerQueue.then(async () => {
        const wait = PROVIDER_MIN_INTERVAL_MS - (Date.now() - lastProviderCallAt);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastProviderCallAt = Date.now();
        return axios.get(ONAYLI_SMS_URL, { params: Object.assign({ api_key: ONAYLI_SMS_API_KEY }, params), timeout: timeout || 20000 });
    });
    // Zincirin bir istek hata verirse kopmaması için ayrı bir "kuyruk ilerleticisi" tutuyoruz
    providerQueue = run.then(() => {}, () => {});
    return run;
}

// ====== SMM (Instagram takipçi/beğeni vb.) sağlayıcısına istek ======
// Çoğu SMM panel sağlayıcısı (Peakerr dahil) aynı standart API'yi kullanır: POST, form-urlencoded,
// key + action (+ servise göre service/link/quantity veya order parametreleri).
function smmPost(params, timeout) {
    if (!SMM_API_KEY) return Promise.reject(new Error('SMM_API_KEY ayarlanmamış'));
    const body = new URLSearchParams(Object.assign({ key: SMM_API_KEY }, params));
    return axios.post(SMM_API_URL, body.toString(), {
        timeout: timeout || 20000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
}

const DEFAULT_DB = {
    users: {
        [ADMIN_USERNAME]: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, balance: 5000, role: "admin", banned: false }
    },
    payments: {},
    visitors: [],
    logins: [],
    orders: {},
    support: {}, // username -> [{from:'user'|'admin', text, time, ts}]
    adminSessions: {}, // token -> {username, ts} - DİSKE YAZILIR, sunucu yeniden başlasa da (Render uykudan uyanma/redeploy) admin oturumu "Yetkisiz!" vermesin diye
    smmConfig: {}, // itemId -> {serviceId, pricePerThousand, min, max} - admin panelden ayarlanır
    smmOrders: {} // id -> {username, itemId, link, quantity, price, providerOrderId, status, time, ts}
};

// ====== KALICI KAYIT (dosyaya yazma) ======
// db tamamen hafızada tutulursa sunucu her yeniden başladığında (uyku modundan uyanma, yeniden deploy, çökme vs.)
// kayıtlı kullanıcılar/siparişler/ödemeler sıfırlanır. Bunu önlemek için her değişiklikte diske de yazıyoruz ve
// açılışta diskten geri yüklüyoruz. NOT: Render'ın ücretsiz planında disk kalıcı değildir; bu, uyku/çökme sonrası
// veri kaybını önler ama GERÇEK bir "yeniden deploy" (yeni kod yükleme) sonrası diskin kendisi de sıfırlanabilir.
// Kalıcılığın garantili olması için Render'da bir "Persistent Disk" eklenmesi (Settings > Disks) gerekir -
// DB_FILE yolu o diskin bağlandığı klasöre taşınırsa (örn. /var/data/db.json) deploy'lar arasında da korunur.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'anka_data.json');
let db = DEFAULT_DB;
try {
    if (fs.existsSync(DB_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = Object.assign({}, DEFAULT_DB, loaded);
        // Eski kayıtta olmayan alanlar varsayılanla tamamlansın
        for (const k in DEFAULT_DB) if (db[k] === undefined) db[k] = DEFAULT_DB[k];
        if (!db.users || !Object.keys(db.users).length) db.users = DEFAULT_DB.users;
        // ÖNEMLİ: diskteki dosya kullanıcıları içeriyor olsa bile, varsayılan admin hesabı (Aklomanti)
        // o dosyada yoksa kayboluyordu (örn. dosya admin eklenmeden önce oluşmuşsa) - bu girişi engelliyordu.
        // Admin hesabını, diskteki diğer kullanıcılara dokunmadan her zaman garanti ediyoruz.
        for (const u in DEFAULT_DB.users) {
            if (!db.users[u]) db.users[u] = DEFAULT_DB.users[u];
        }
        console.log('[db] Kayıtlı veri diskten yüklendi: ' + Object.keys(db.users).length + ' kullanıcı, ' + Object.keys(db.orders).length + ' sipariş.');
    }
} catch (e) { console.error('[db] Diskten yükleme hatası, varsayılan veriyle başlanıyor:', e.message); }

// Admin hesabının kullanıcı adı/şifresi/rolü her başlangıçta koddaki (veya Environment'taki) değerlere ZORLA eşitlenir.
// Böylece diskte eski bir şifre kalmış olsa bile admin girişi her zaman güncel bilgilerle çalışır.
// (Bakiyesi varsa korunur, sadece kimlik bilgileri senkronize edilir.)
db.users[ADMIN_USERNAME] = Object.assign(
    { balance: 5000 },
    db.users[ADMIN_USERNAME] || {},
    { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, role: 'admin', banned: false }
);

let saveTimer = null;
function persist() {
    // Art arda gelen çok sayıda değişiklikte her seferinde diske yazmamak için 400ms topluyor (debounce)
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error('[db] Diske yazma hatası:', e.message); }
    }, 400);
}

let supportMsgMap = {}; // telegram mesaj id -> username (adminin hangi mesaja cevap verdiğini eşlemek için)

// Ziyaretçinin nereden geldiğini (hangi platform) tahmin eder: önce ?src= / ?utm_source= parametresi,
// yoksa Referer (hangi siteden tıklayıp geldi) başlığına bakar.
function guessSource(req) {
    const q = (req.query && (req.query.src || req.query.utm_source || req.query.ref) || '').toLowerCase();
    if (q) {
        if (q.includes('telegram') || q === 'tg') return 'Telegram';
        if (q.includes('whatsapp') || q === 'wa') return 'WhatsApp';
        if (q.includes('facebook') || q === 'fb') return 'Facebook';
        if (q.includes('instagram') || q === 'ig') return 'Instagram';
        return q.charAt(0).toUpperCase() + q.slice(1);
    }
    const ref = (req.headers['referer'] || req.headers['referrer'] || '').toLowerCase();
    if (!ref) return 'Direkt / Bilinmiyor';
    if (ref.includes('facebook.com') || ref.includes('fb.com')) return 'Facebook';
    if (ref.includes('t.me') || ref.includes('telegram.org')) return 'Telegram';
    if (ref.includes('wa.me') || ref.includes('whatsapp.com')) return 'WhatsApp';
    if (ref.includes('instagram.com')) return 'Instagram';
    if (ref.includes('tiktok.com')) return 'TikTok';
    if (ref.includes('google.')) return 'Google';
    if (ref.includes('twitter.com') || ref.includes('x.com')) return 'Twitter/X';
    if (ref.includes(RENDER_EXTERNAL_URL.replace(/^https?:\/\//, ''))) return 'Direkt / Bilinmiyor';
    try { return new URL(req.headers['referer']).hostname; } catch (e) { return 'Direkt / Bilinmiyor'; }
}

app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!db.visitors.some(v => v.ip === ip)) {
        db.visitors.unshift({ ip, time: new Date().toLocaleString('tr-TR'), source: guessSource(req), path: req.path });
        if (db.visitors.length > 150) db.visitors.pop();
    }
    next();
});

function isAdmin(name) {
    return db.users[name] && db.users[name].role === 'admin';
}

// ====== ADMIN OTURUM TOKENLARI (GÜVENLİK) ======
// ÖNEMLİ GÜVENLİK DÜZELTMESİ: Daha önce admin uç noktaları sadece "adminUsername" diye bir METİN alanına
// bakıyordu - yani şifre/oturum KONTROLÜ YOKTU. Herhangi biri tarayıcı konsolundan adminUsername="Aklomanti"
// göndererek (bu isim panelde zaten görünüyor) bakiye yükleyebilir, ödeme onaylayabilir vs. yapabiliyordu.
// Şimdi admin girişinde rastgele, tahmin edilemez bir TOKEN üretiliyor; tüm admin işlemleri artık
// şifre doğrulanmadan hiçbir şekilde çalışmayan bu token'ı istiyor.
// NOT: Bu oturumlar db.adminSessions içinde, diğer her şey gibi diske yazılıyor. Sadece hafızada (RAM'de)
// tutulsaydı, Render'ın ücretsiz planında sunucu uykuya dalıp uyandığında (veya her redeploy'da) TÜM admin
// oturumları sıfırlanır, tarayıcıda hâlâ eski token dururken sunucu onu tanımaz ve "Yetkisiz!" verirdi.
function createAdminSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    db.adminSessions[token] = { username, ts: Date.now() };
    persist();
    return token;
}
// Token'dan gerçek admin kullanıcı adını döndürür; geçersiz/süresi dolmuşsa (7 gün) null döner.
function checkAdminToken(token) {
    const sess = token && db.adminSessions[token];
    if (!sess) return null;
    if (Date.now() - sess.ts > 7 * 24 * 60 * 60 * 1000) { delete db.adminSessions[token]; persist(); return null; }
    if (!db.users[sess.username] || db.users[sess.username].role !== 'admin') return null;
    return sess.username;
}

// ====== SABİT ÜRÜN KATALOĞU ======
// serviceCode baştan biliniyorsa direkt yazılır (wa, tg). Yeni eklenen ürünlerde serviceCode YOK;
// bunun yerine serviceHints (sağlayıcının servis listesinde isimle aranacak kelimeler) ve guessCodes
// (isimle bulunamazsa denenecek, yaygın bilinen kod tahminleri) var. Gerçek kod ilk satışta otomatik
// keşfedilip önbelleğe alınır (resolveServiceCode). Admin panelden de elle düzeltilebilir.
const CATALOG = [
    { id: 'wa_tr', key: 'tr', name: 'WhatsApp Türkiye', serviceCode: 'wa', defCountry: '62', price: 300, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-emerald-500/10', color: 'text-emerald-400' },
    // Aynı WhatsApp Türkiye havuzundan çekilir (servis/ülke aynı) - sadece panelde farklı isim/fiyatla gösterilir.
    { id: 'wa_tr_dinlenmis', key: 'tr', name: 'Dinlendirilmiş WhatsApp Türkiye', serviceCode: 'wa', defCountry: '62', price: 360, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-emerald-500/10', color: 'text-emerald-400' },
    { id: 'tg_tr', key: 'tr', name: 'Telegram Türkiye', serviceCode: 'tg', defCountry: '62', price: 200, icon: 'fa-telegram', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-400' },
    { id: 'wa_ph', key: 'ph', name: 'WhatsApp Filipinler', serviceCode: 'wa', defCountry: '4', price: 200, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-emerald-500/10', color: 'text-emerald-400' },
    { id: 'tg_us', key: 'us', name: 'Telegram ABD', serviceCode: 'tg', defCountry: '187', alt: ['12'], price: 200, icon: 'fa-telegram', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-400' },
    { id: 'ig_tr', key: 'tr', name: 'Instagram Türkiye', defCountry: '62', price: 60, serviceHints: ['instagram'], guessCodes: ['ig'], icon: 'fa-instagram', iconSet: 'fa-brands', bg: 'bg-pink-500/10', color: 'text-pink-400' },
    { id: 'go_tr', key: 'tr', name: 'Google / Gmail Türkiye', defCountry: '62', price: 60, serviceHints: ['google', 'gmail'], guessCodes: ['go'], icon: 'fa-google', iconSet: 'fa-brands', bg: 'bg-red-500/10', color: 'text-red-400' },
    { id: 'ds_tr', key: 'tr', name: 'Discord Türkiye', defCountry: '62', price: 60, serviceHints: ['discord'], guessCodes: ['ds', 'dc'], icon: 'fa-discord', iconSet: 'fa-brands', bg: 'bg-indigo-500/10', color: 'text-indigo-400' },
    { id: 'vi_tr', key: 'tr', name: 'Viber Türkiye', defCountry: '62', price: 60, serviceHints: ['viber'], guessCodes: ['vi'], icon: 'fa-viber', iconSet: 'fa-brands', bg: 'bg-purple-500/10', color: 'text-purple-400' },
    { id: 'ap_tr', key: 'tr', name: 'Apple Türkiye', defCountry: '62', price: 150, serviceHints: ['apple', 'icloud'], guessCodes: ['mz', 'ap'], icon: 'fa-apple', iconSet: 'fa-brands', bg: 'bg-slate-500/10', color: 'text-slate-300' },
    { id: 'fups_tr', key: 'tr', name: 'FUPS (Fiziki) Türkiye', defCountry: '62', price: 2000, serviceHints: ['fups'], guessCodes: [], icon: 'fa-sim-card', iconSet: 'fa-solid', bg: 'bg-amber-500/10', color: 'text-amber-300' },
    { id: 'getir_tr', key: 'tr', name: 'Getir Türkiye', defCountry: '62', price: 200, serviceHints: ['getir'], guessCodes: [], icon: 'fa-motorcycle', iconSet: 'fa-solid', bg: 'bg-violet-500/10', color: 'text-violet-300' },
    { id: 'hopi_tr', key: 'tr', name: 'Hopi Türkiye', defCountry: '62', price: 120, serviceHints: ['hopi'], guessCodes: [], icon: 'fa-gift', iconSet: 'fa-solid', bg: 'bg-orange-500/10', color: 'text-orange-300' },
    { id: 'ms_tr', key: 'tr', name: 'Microsoft Türkiye', defCountry: '62', price: 50, serviceHints: ['microsoft', 'outlook', 'hotmail'], guessCodes: ['mm', 'ms'], icon: 'fa-microsoft', iconSet: 'fa-brands', bg: 'bg-sky-500/10', color: 'text-sky-400' },
    { id: 'paycell_tr', key: 'tr', name: 'Paycell (Fiziki) Türkiye', defCountry: '62', price: 1500, serviceHints: ['paycell'], guessCodes: [], icon: 'fa-credit-card', iconSet: 'fa-solid', bg: 'bg-amber-500/10', color: 'text-amber-300' },
    { id: 'paypal_tr', key: 'tr', name: 'PayPal', defCountry: '62', price: 150, serviceHints: ['paypal'], guessCodes: ['mt', 'pp'], icon: 'fa-paypal', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-300' },
    { id: 'steam_tr', key: 'tr', name: 'Steam Türkiye', defCountry: '62', price: 150, serviceHints: ['steam'], guessCodes: ['st', 'su'], icon: 'fa-steam', iconSet: 'fa-brands', bg: 'bg-slate-500/10', color: 'text-slate-300' }
];
const SERVICE_INFO = {
    wa: { name: 'WhatsApp', icon: 'fa-whatsapp', bg: 'bg-emerald-500/10', color: 'text-emerald-400' },
    tg: { name: 'Telegram', icon: 'fa-telegram', bg: 'bg-blue-500/10', color: 'text-blue-400' }
};

// ====== Sağlayıcının TÜM servis kodu/isim listesi (isimden kod bulmak için) - 1 saatte bir yenile ======
let servicesListCache = { time: 0, byCode: {} };
async function resolveServicesList() {
    if (servicesListCache.time && Date.now() - servicesListCache.time < 3600000) return servicesListCache;
    const byCode = {};
    try {
        const r = await providerGet({ action: 'getServicesList' }, 15000);
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        let arr = [];
        if (Array.isArray(d)) arr = d;
        else if (d && Array.isArray(d.services)) arr = d.services;
        else if (d && typeof d === 'object') arr = Object.keys(d).map(k => ({ code: k, name: (d[k] && typeof d[k] === 'object') ? (d[k].name || d[k].title || d[k].eng) : d[k] }));
        for (const s of arr) {
            if (!s) continue;
            const code = s.code !== undefined ? s.code : (s.id !== undefined ? s.id : s.key);
            const name = s.name || s.title || s.eng || s.rus;
            if (code !== undefined && name) byCode[String(code)] = String(name);
        }
        console.log('[resolveServicesList] ' + Object.keys(byCode).length + ' servis bulundu');
    } catch (e) { console.error('[resolveServicesList] hata:', e.message); }
    servicesListCache = { time: Date.now(), byCode };
    return servicesListCache;
}

// Admin panelden elle girilmiş servis kodu düzeltmeleri (otomatik keşif yanlış/eksikse)
let serviceOverrides = {};
let serviceCodeCache = {}; // item.id -> { code, time, confirmed }
async function resolveServiceCode(item) {
    if (item.serviceCode) return item.serviceCode; // zaten bilinen sabit kod (wa, tg)
    if (serviceOverrides[item.id]) return serviceOverrides[item.id];
    const cached = serviceCodeCache[item.id];
    if (cached && Date.now() - cached.time < 3600000) return cached.code;
    const { byCode } = await resolveServicesList();
    const hints = (item.serviceHints || []).map(normTr);
    let found = null;
    for (const code in byCode) {
        const n = normTr(byCode[code]);
        if (hints.some(h => n.includes(h))) { found = code; break; }
    }
    const code = found || (item.guessCodes && item.guessCodes[0]) || item.id;
    serviceCodeCache[item.id] = { code, time: Date.now(), confirmed: !!found };
    if (!found) console.log('[resolveServiceCode] "' + item.name + '" için isimle eşleşme bulunamadı, tahmini kod deneniyor: ' + code);
    return code;
}
// Türkçe karakterleri sadeleştirip küçük harfe çevirir (ş/ı/ğ/ü/ö/ç eşleşme sorunlarını önler)
function normTr(s) {
    return String(s).toLowerCase()
        .replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
        .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c').trim();
}
function nameHas(key, n) {
    const t = normTr(n);
    if (key === 'tr') return t.includes('turkey') || t.includes('turkiye') || t.includes('турци') || /^tr$/.test(t) || t === 'turkiye cumhuriyeti';
    if (key === 'ph') return t.includes('philippines') || t.includes('филиппин') || t.includes('filipin');
    if (key === 'us') return /\busa\b/.test(t) || t.includes('united states') || t.includes('сша') || t.includes('amerika birlesik');
    return false;
}

// ====== Sağlayıcıdan ülke ID'lerini otomatik bul (isme göre - 1 saatte bir yenile) ======
let countryCache = { time: 0, map: {}, all: {} };
async function resolveCountries() {
    if (countryCache.time && Date.now() - countryCache.time < 3600000) return countryCache;
    const map = {};
    const all = { tr: [], ph: [], us: [] };
    try {
        const r = await providerGet({ action: 'getCountries' }, 15000);
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        if (d && typeof d === 'object') {
            const arr = Array.isArray(d) ? d : Object.keys(d).map(k => Object.assign({ _k: k }, typeof d[k] === 'object' ? d[k] : { name: d[k] }));
            for (const c of arr) {
                if (!c || typeof c !== 'object') continue;
                const id = c.id !== undefined ? String(c.id) : (c._k !== undefined ? String(c._k) : null);
                if (id === null) continue;
                // Alan adı ne olursa olsun objedeki TÜM string değerleri tara (sağlayıcıya göre alan adları değişebilir)
                const names = Object.values(c).filter(v => typeof v === 'string' || typeof v === 'number').map(x => String(x).toLowerCase().trim());
                for (const key in all) {
                    if (names.some(n => nameHas(key, n))) { if (!map[key]) map[key] = id; if (!all[key].includes(id)) all[key].push(id); }
                }
            }
        }
    } catch (e) { console.error('[resolveCountries] hata:', e.message); }
    countryCache = { time: Date.now(), map, all };
    return countryCache;
}

// ====== Sağlayıcıdan servis bazlı CANLI fiyat/stok bilgisi (ülke ID -> {cost,count}) - 45sn cache ======
let priceCache = {}; // serviceCode -> { time, data: { countryId: {cost,count} } }
async function fetchServicePrices(serviceCode) {
    const cached = priceCache[serviceCode];
    if (cached && Date.now() - cached.time < 45000) return cached.data;
    const out = {};
    try {
        const r = await providerGet({ action: 'getPrices', service: serviceCode }, 15000);
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        if (d && typeof d === 'object') {
            // Şekil B: { "<service>": { "<countryId>": {cost,count} } }
            if (d[serviceCode] && typeof d[serviceCode] === 'object') {
                for (const cid in d[serviceCode]) {
                    const svc = d[serviceCode][cid];
                    if (svc && typeof svc === 'object') {
                        const cost = svc.cost !== undefined ? svc.cost : (svc.price !== undefined ? svc.price : 0);
                        const count = svc.count !== undefined ? svc.count : (svc.quant !== undefined ? svc.quant : (svc.quantity !== undefined ? svc.quantity : 0));
                        out[cid] = { cost: Number(cost) || 0, count: Number(count) || 0 };
                    }
                }
            }
            // Şekil A: { "<countryId>": { "<service>": {cost,count} } }  veya  { "<countryId>": {cost,count} }
            if (Object.keys(out).length === 0) {
                for (const cid in d) {
                    const v = d[cid];
                    if (!v || typeof v !== 'object') continue;
                    const svc = (v[serviceCode] !== undefined) ? v[serviceCode] : v;
                    if (svc && typeof svc === 'object') {
                        const cost = svc.cost !== undefined ? svc.cost : (svc.price !== undefined ? svc.price : 0);
                        const count = svc.count !== undefined ? svc.count : (svc.quant !== undefined ? svc.quant : (svc.quantity !== undefined ? svc.quantity : 0));
                        if (cost || count) out[cid] = { cost: Number(cost) || 0, count: Number(count) || 0 };
                    }
                }
            }
        }
        console.log('[fetchServicePrices] ' + serviceCode + ' -> ' + Object.keys(out).length + ' ülke bulundu, stoklu: ' + Object.keys(out).filter(k => out[k].count > 0).length);
    } catch (e) { console.error('[fetchServicePrices] hata:', e.message); }
    priceCache[serviceCode] = { time: Date.now(), data: out };
    return out;
}

// Bir ürün için denenecek ülke ID listesi: isimle bulunan adaylar + CANLI stok bilgisine göre sıralama
// Stokta (count>0) olanlar en öne gelir, böylece hem zaman kaybı hem de yanlış ülke denemesi azalır.
async function countryCandidates(item, serviceCode) {
    const { map, all } = await resolveCountries();
    const nameList = [];
    const primary = map[item.key] || item.defCountry;
    nameList.push(primary);
    (all[item.key] || []).forEach(id => { if (!nameList.includes(id)) nameList.push(id); });
    (item.alt || []).forEach(id => { if (!nameList.includes(id)) nameList.push(id); });
    if (!nameList.includes(item.defCountry)) nameList.push(item.defCountry);

    const prices = await fetchServicePrices(serviceCode || item.serviceCode);
    const withStock = nameList.filter(id => prices[id] && prices[id].count > 0)
        .sort((a, b) => (prices[b].count - prices[a].count));
    const withoutInfo = nameList.filter(id => !prices[id]);
    const noStock = nameList.filter(id => prices[id] && prices[id].count === 0);
    // Öncelik: stoğu bilinen > bilgi yok (sağlayıcı yanıt vermediyse eski sıralama) > stoğu 0 görünen (yine de son çare dene, anlık değişebilir)
    const ordered = [...withStock, ...withoutInfo, ...noStock];
    return ordered.length ? ordered : nameList;
}

// ====== SERVİS LİSTESİ (sabit katalog, stok yazısı yok) ======
app.get('/api/getServices', (req, res) => {
    const list = CATALOG.map(item => {
        const meta = (item.icon ? item : SERVICE_INFO[item.serviceCode]) || {};
        return { id: item.id, name: item.name, price: item.price, icon: meta.icon || 'fa-circle', iconSet: meta.iconSet || 'fa-solid', bg: meta.bg || 'bg-emerald-500/10', color: meta.color || 'text-emerald-400' };
    });
    res.json({ success: true, services: list });
});

app.get('/api/getCustomerBalance', (req, res) => {
    const { username } = req.query;
    if (db.users[username]) {
        res.json({ success: true, balance: db.users[username].balance, role: db.users[username].role });
    } else {
        res.json({ success: false, message: "Kullanıcı bulunamadı." });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (db.users[username] && db.users[username].password === password) {
        if (db.users[username].banned) {
            return res.json({ success: false, message: "Hesabınız yasaklandı. Destek ile iletişime geçin." });
        }
        const visitorRec = db.visitors.find(v => v.ip === ip);
        const source = (visitorRec && visitorRec.source) || 'Bilinmiyor';
        db.logins.unshift({ username, ip, source, time: new Date().toLocaleString('tr-TR'), ts: Date.now() });
        if (db.logins.length > 300) db.logins.length = 300;
        const role = db.users[username].role;
        // Admin girişinde, admin uç noktalarının gerektirdiği tahmin edilemez oturum token'ı üretilir.
        const adminToken = role === 'admin' ? createAdminSession(username) : null;
        res.json({ success: true, username, role, adminToken });
    } else {
        res.json({ success: false, message: "Hatalı kullanıcı adı veya şifre!" });
    }
});

app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: "Alanlar boş bırakılamaz." });
    if (db.users[username]) return res.json({ success: false, message: "Bu kullanıcı adı zaten alınmış." });

    db.users[username] = { username, password, balance: 0, role: "user", banned: false, createdAt: Date.now(), registeredAt: new Date().toLocaleString('tr-TR') };
    persist();
    res.json({ success: true, username, role: "user" });
});

app.post('/api/deposit/notify', async (req, res) => {
    const { username, senderName, amount } = req.body;
    if (!username || !senderName || !amount) return res.json({ success: false, message: "Tüm alanları doldurun." });
    if (db.users[username] && db.users[username].banned) return res.json({ success: false, message: "Hesabınız yasaklandı." });

    const paymentId = 'pay_' + Date.now();
    db.payments[paymentId] = { id: paymentId, username, senderName, amount: parseFloat(amount), status: 'pending', time: new Date().toLocaleString('tr-TR'), ts: Date.now() };
    persist();

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `💰 Yeni Ödeme Bildirimi!\n\nKullanıcı: ${username}\nGönderen: ${senderName}\nTutar: ${amount} TL`,
            reply_markup: { inline_keyboard: [[{ text: "✅ Onayla", callback_data: `approve|${paymentId}` }, { text: "❌ Reddet", callback_data: `reject|${paymentId}` }]] }
        });
    } catch (e) {}

    res.json({ success: true, message: "Ödeme bildiriminiz alındı. İnceleniyor." });
});

// ====== ADMIN: her şeyi tek seferde getir ======
app.get('/api/admin/getData', (req, res) => {
    const { adminToken } = req.query;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz erişim." });

    const users = Object.values(db.users).map(u => ({ username: u.username, balance: u.balance, role: u.role, banned: !!u.banned, registeredAt: u.registeredAt || '-' }));
    const payments = Object.values(db.payments).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const logins = db.logins.slice(0, 100);
    const orders = Object.values(db.orders).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
    const supportChats = Object.keys(db.support).map(u => ({ username: u, last: db.support[u][db.support[u].length - 1], count: db.support[u].length })).sort((a, b) => (b.last ? b.last.ts : 0) - (a.last ? a.last.ts : 0));
    const catalogList = CATALOG.map(c => ({ id: c.id, name: c.name }));
    const visitorList = db.visitors.slice(0, 100);

    res.json({ success: true, users, payments, logins, orders, supportChats, visitors: db.visitors.length, visitorList, catalog: catalogList });
});

app.post('/api/admin/processPayment', (req, res) => {
    const { adminToken, paymentId, action } = req.body;
    if (!checkAdminToken(adminToken)) return res.json({ success: false, message: "Yetkisiz." });

    const payment = db.payments[paymentId];
    if (!payment || payment.status !== 'pending') return res.json({ success: false, message: "Ödeme bulunamadı." });

    if (action === 'approve') {
        payment.status = 'approved';
        if (db.users[payment.username]) db.users[payment.username].balance += payment.amount;
        persist();
        res.json({ success: true, message: "Ödeme onaylandı." });
    } else if (action === 'reject_ban') {
        // Ödeme yapmadan sahte bildirim gönderen kullanıcılar için: reddet + hesabı kalıcı olarak banla.
        payment.status = 'rejected';
        if (db.users[payment.username]) db.users[payment.username].banned = true;
        persist();
        res.json({ success: true, message: "Ödeme reddedildi ve " + payment.username + " kalıcı olarak banlandı." });
    } else {
        payment.status = 'rejected';
        persist();
        res.json({ success: true, message: "Ödeme reddedildi." });
    }
});

// Admin'in bir kullanıcının panel içi TL bakiyesini elle değiştirmesi (yükleme yapmadan, örn. hediye/iade/düzeltme için)
app.post('/api/admin/adjustBalance', (req, res) => {
    const { adminToken, username, amount } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    if (!username || !db.users[username]) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
    const amt = Number(amount);
    if (isNaN(amt) || amt === 0) return res.json({ success: false, message: "Geçerli bir tutar gir (eklemek için pozitif, düşmek için negatif, örn: 50 veya -20)." });
    db.users[username].balance += amt;
    if (db.users[username].balance < 0) db.users[username].balance = 0;
    persist();
    res.json({ success: true, message: username + " kullanıcısının bakiyesi güncellendi. Yeni bakiye: " + db.users[username].balance.toFixed(2) + " TL", newBalance: db.users[username].balance });
});

// Kullanıcıyı kalıcı olarak banla / banı kaldır (ödeme yapmadan bildirim gönderenler, kötüye kullanım vs. için)
app.post('/api/admin/banUser', (req, res) => {
    const { adminToken, username, banned } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    if (!username || !db.users[username]) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
    if (db.users[username].role === 'admin') return res.json({ success: false, message: "Admin hesabı banlanamaz." });
    db.users[username].banned = !!banned;
    persist();
    res.json({ success: true, message: username + (banned ? " kalıcı olarak banlandı." : " banı kaldırıldı."), banned: db.users[username].banned });
});

// Sağlayıcı bağlantı testi: bakiye + her ürün için denenecek ülke ID'leri
app.get('/api/admin/testApi', async (req, res) => {
    if (!checkAdminToken(req.query.adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    try {
        const balResp = await providerGet({ action: 'getBalance' }, 20000);
        countryCache.time = 0;
        servicesListCache.time = 0;
        const { map, all } = await resolveCountries();
        const onlyId = req.query.productId;
        const items = onlyId ? CATALOG.filter(c => c.id === onlyId) : CATALOG;
        const urunler = [];
        for (const item of items) {
            const serviceCode = await resolveServiceCode(item);
            const candidates = await countryCandidates(item, serviceCode);
            const prices = await fetchServicePrices(serviceCode);
            urunler.push({
                urun: item.name, servisKodu: serviceCode,
                kodOnaylandi: !!(serviceCodeCache[item.id] && serviceCodeCache[item.id].confirmed) || !!item.serviceCode,
                denenecekUlkeler: candidates,
                ilkUlkeFiyatBilgisi: prices[candidates[0]] || 'fiyat bilgisi yok'
            });
        }
        res.json({ success: true, providerBalance: balResp.data, bulunanUlkeIdleri: map, tumAdaylar: all, urunler });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ====== Servis kodu elle düzeltme (otomatik keşif yanlışsa admin düzeltebilir) ======
app.post('/api/admin/setServiceCode', (req, res) => {
    const { adminToken, itemId, code } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    const item = CATALOG.find(c => c.id === itemId);
    if (!item) return res.json({ success: false, message: "Ürün bulunamadı." });
    if (!code || !code.trim()) { delete serviceOverrides[itemId]; return res.json({ success: true, message: "Elle ayar kaldırıldı, otomatik keşfe dönüldü." }); }
    serviceOverrides[itemId] = code.trim();
    delete serviceCodeCache[itemId];
    res.json({ success: true, message: "Servis kodu kaydedildi: " + code.trim() });
});
app.get('/api/admin/serviceCodes', async (req, res) => {
    if (!checkAdminToken(req.query.adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    const list = [];
    for (const item of CATALOG) {
        if (item.serviceCode) continue; // sabit olanları göstermeye gerek yok
        const code = await resolveServiceCode(item);
        list.push({ id: item.id, name: item.name, code, confirmed: !!(serviceCodeCache[item.id] && serviceCodeCache[item.id].confirmed), override: serviceOverrides[item.id] || '' });
    }
    res.json({ success: true, list });
});

// ====== CANLI DESTEK ======
app.post('/api/support/send', async (req, res) => {
    const { username, text } = req.body;
    if (!db.users[username] || !text || !text.trim()) return res.json({ success: false });
    if (!db.support[username]) db.support[username] = [];
    const msg = { from: 'user', text: text.trim().slice(0, 1000), time: new Date().toLocaleString('tr-TR'), ts: Date.now() };
    db.support[username].push(msg);
    if (db.support[username].length > 200) db.support[username].shift();

    try {
        const sent = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_CHAT_ID, text: `💬 Destek | ${username}:\n${msg.text}` });
        const tgId = sent.data && sent.data.result && sent.data.result.message_id;
        if (tgId) supportMsgMap[tgId] = username;
    } catch (e) {}

    res.json({ success: true });
});

app.get('/api/support/messages', (req, res) => {
    const { username, sinceTs } = req.query;
    if (!db.users[username]) return res.json({ success: false, messages: [] });
    let list = db.support[username] || [];
    if (sinceTs) list = list.filter(m => m.ts > parseInt(sinceTs));
    res.json({ success: true, messages: list, contact: ADMIN_TELEGRAM_USERNAME, whatsapp: ADMIN_WHATSAPP });
});

app.post('/api/admin/support/reply', async (req, res) => {
    const { adminToken, username, text } = req.body;
    if (!checkAdminToken(adminToken)) return res.json({ success: false });
    if (!db.users[username] || !text || !text.trim()) return res.json({ success: false });
    if (!db.support[username]) db.support[username] = [];
    db.support[username].push({ from: 'admin', text: text.trim().slice(0, 1000), time: new Date().toLocaleString('tr-TR'), ts: Date.now() });
    res.json({ success: true });
});

// ====== OTOMASYON: sağlayıcı bakiyesi düşükse Telegram uyarısı ======
// NOT: Bu fonksiyon iki farklı amaç için kullanılıyordu ve ikisi de AYNI 10 dakikalık limiti paylaşıyordu -
// bu yüzden bir satın alma denemesindeki NO_BALANCE teşhis mesajı, az önce gönderilmiş genel "bakiye azaldı"
// uyarısı yüzünden sessizce engellenebiliyordu. Artık ayrı: periyodik genel uyarı kısıtlı, her başarısız
// satın alma denemesinin teşhis mesajı ise (spam olmasın diye yine de çok kısa bir aralıkla) ayrı gönderiliyor.
let lastBalanceAlert = 0;
async function notifyLowProviderBalance(text) {
    if (Date.now() - lastBalanceAlert < 600000) return; // en fazla 10 dakikada bir
    lastBalanceAlert = Date.now();
    try { await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_CHAT_ID, text }); } catch (e) {}
}
let lastPurchaseFailAlert = 0;
async function notifyPurchaseFailure(text) {
    if (Date.now() - lastPurchaseFailAlert < 8000) return; // aynı anda art arda gelen denemelerde spam olmasın diye 8sn
    lastPurchaseFailAlert = Date.now();
    try { await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_CHAT_ID, text }); } catch (e) {}
}

const PROVIDER_ERRORS = {
    NO_NUMBERS: 'Bu ürün için şu an numara kalmamış.',
    NO_BALANCE: 'Sağlayıcı hesabında bakiye yok (panel sahibi bakiye yüklemeli).',
    BAD_KEY: 'Sağlayıcı API anahtarı hatalı.',
    BAD_SERVICE: 'Servis kodu geçersiz.',
    WRONG_SERVICE: 'Servis kodu geçersiz.',
    BAD_COUNTRY: 'Ülke kodu geçersiz.',
    BANNED: 'Sağlayıcı API hesabı engellenmiş.',
    ERROR_SQL: 'Sağlayıcıda geçici hata, tekrar deneyin.'
};

// ====== NUMARA SATIN ALMA ======
// NOT: Önceki sürümdeki "daha pahalıya da olsa al" (freePrice/maxPrice) mantığı kaldırıldı.
// O mantık TL satış fiyatını sağlayıcının kendi para birimiyle karıştırıp bakiyeyi gerçekte
// aşan isteklere yol açıyor ve NO_BALANCE hatasının asıl sebebiydi. Artık sağlayıcıdan sadece
// kendi normal/en uygun fiyatından numara isteniyor; satış fiyatımız hep sabit kalıyor.
app.post('/api/buyNumber', async (req, res) => {
    const { productId, username } = req.body;
    const userObj = db.users[username];
    if (!userObj) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
    if (userObj.banned) return res.json({ success: false, message: "Hesabınız yasaklandı, satın alma yapamazsınız." });

    const item = CATALOG.find(c => c.id === productId);
    if (!item) return res.json({ success: false, message: "Geçersiz ürün." });

    const price = item.price;
    if (userObj.balance < price) return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin." });

    const showDetail = userObj.role === 'admin';

    try {
        const serviceCode = await resolveServiceCode(item);
        // Adaylar zaten stoğa göre en iyiden en kötüye sıralı; hepsini denemek (özellikle sağlayıcı
        // yavaşsa/sınırlıyorsa) kullanıcıyı çok uzun bekletir. İlk 4 adayla sınırlıyoruz.
        const candidates = (await countryCandidates(item, serviceCode)).slice(0, 4);
        let responseText = '';
        let usedCountry = candidates[0];
        let allRaw = [];
        let sawNoBalance = false;

        const ATTEMPTS_PER_COUNTRY = 2; // adaylar artık canlı stoğa göre sıralı, gereksiz yere aynı ülkede bekletmeye gerek yok
        outer:
        for (const country of candidates) {
            usedCountry = country;
            for (let attempt = 0; attempt < ATTEMPTS_PER_COUNTRY; attempt++) {
                const resp = await providerGet({ action: 'getNumber', service: serviceCode, country: country }, 30000);
                responseText = resp.data;
                if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
                responseText = responseText ? String(responseText).trim() : '';
                allRaw.push(country + ':' + responseText);
                console.log('[getNumber] ' + item.id + ' country=' + country + ' deneme=' + (attempt + 1) + ' -> "' + responseText + '"');

                if (responseText.startsWith('ACCESS_NUMBER')) break outer;
                if (responseText.startsWith('NO_NUMBERS')) {
                    if (attempt < ATTEMPTS_PER_COUNTRY - 1) await new Promise(r => setTimeout(r, 1200));
                    continue;
                }
                if (responseText.startsWith('TOO_MANY_REQUESTS')) {
                    // Sağlayıcı "çok fazla istek" diyor - stok/bakiye sorunu değil, sadece yavaşlamamız gerekiyor.
                    await new Promise(r => setTimeout(r, 4000));
                    continue;
                }
                if (responseText.startsWith('NO_BALANCE')) {
                    // Bu ülke/servis kombinasyonu için sağlayıcı bakiyesi yetersiz; yine de daha ucuz olabilecek
                    // başka bir aday ülke varsa onu denemeye devam et, direkt teslim olma.
                    sawNoBalance = true;
                    break; // bu ülkede daha fazla deneme yapma, sıradaki aday ülkeye geç
                }
                break outer; // başka bir sağlayıcı hatası (anahtar, servis vs.) -> denemeyi bitir
            }
            if (responseText.startsWith('ACCESS_NUMBER')) break;
        }

        if (responseText.startsWith('ACCESS_NUMBER')) {
            const parts = responseText.split(':');
            const activationId = parts[1];
            const phoneNumber = parts.slice(2).join(':');
            userObj.balance -= price;
            const order = {
                activationId, productName: item.name, price, phoneNumber,
                code: "Bekleniyor...", status: 'waiting', username,
                time: new Date().toLocaleString('tr-TR'), createdAt: Date.now()
            };
            db.orders[activationId] = order;
            persist();
            return res.json({ success: true, order });
        }

        const key = responseText.split(':')[0];
        let balanceDiag = '';
        if (key === 'NO_BALANCE' || sawNoBalance) {
            // Teşhis için: gerçek sağlayıcı bakiyesi ve bu ülke/servis için güncel maliyeti karşılaştırıp admin'e bildir
            try {
                const balResp = await providerGet({ action: 'getBalance' }, 15000);
                const balText = String(balResp.data || '').trim();
                const prices = await fetchServicePrices(serviceCode);
                const costInfo = prices[usedCountry] ? ('maliyet: ' + prices[usedCountry].cost + ', stok: ' + prices[usedCountry].count) : 'fiyat bilgisi alınamadı';
                balanceDiag = 'Gerçek sağlayıcı bakiyesi: ' + balText + ' | Bu numaranın maliyeti: ' + costInfo + '. NOT: Bu, panel içindeki TL bakiyenden FARKLI bir şey - sağlayıcı hesabına gerçek para yüklenmesi gerekiyor.';
                notifyPurchaseFailure('⚠️ NO_BALANCE: "' + item.name + '" (servis ' + serviceCode + ', ülke ' + usedCountry + ') alınamadı.\nSağlayıcı bakiyesi: ' + balText + '\n' + costInfo + '\nDenenen: ' + allRaw.join(' | '));
            } catch (e) { notifyPurchaseFailure('⚠️ NO_BALANCE: "' + item.name + '" alınamadı (bakiye kontrolü de başarısız: ' + e.message + ').'); }
        }
        let msg;
        if (showDetail) {
            msg = (PROVIDER_ERRORS[key] || ('Sağlayıcı yanıtı: ' + responseText)) + ' [servis kodu: ' + serviceCode + ', denenen ülkeler: ' + allRaw.join(' | ') + ']' + (balanceDiag ? ('\n\n' + balanceDiag) : '');
        } else if (key === 'NO_NUMBERS') {
            msg = 'Bu ürün için şu an numara bulunamadı, otomatik tekrar deneniyor...';
        } else if (key === 'TOO_MANY_REQUESTS') {
            msg = 'Sistem yoğun, birkaç saniye içinde otomatik tekrar deneniyor...';
        } else {
            msg = 'Şu an numara alınamıyor, lütfen daha sonra tekrar deneyin.';
        }
        return res.json({ success: false, message: msg, retryable: (key === 'NO_NUMBERS' || key === 'TOO_MANY_REQUESTS') });
    } catch (error) {
        console.error("API Bağlantı Hatası:", error.message);
        return res.json({ success: false, message: showDetail ? ("Sağlayıcı bağlantı hatası: " + error.message) : "Bağlantı hatası, lütfen tekrar deneyin." });
    }
});

// ====== SİPARİŞLERİM (sayfa yenilenince numaralar kaybolmasın) ======
app.get('/api/myOrders', (req, res) => {
    const { username } = req.query;
    if (!db.users[username]) return res.json({ success: false, orders: [] });
    const now = Date.now();
    const list = Object.values(db.orders)
        .filter(o => o.username === username && o.createdAt)
        .filter(o => (o.status === 'waiting' && now - o.createdAt < 600000) || (o.status === 'completed' && now - o.createdAt < 1800000))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(o => ({
            activationId: o.activationId, phoneNumber: o.phoneNumber, productName: o.productName,
            status: o.status, code: o.code, remaining: Math.max(1, Math.floor((600000 - (now - o.createdAt)) / 1000))
        }));
    res.json({ success: true, orders: list });
});

// ====== NUMARA İPTAL ======
app.post('/api/cancelNumber', async (req, res) => {
    const { activationId, username } = req.body;
    const order = db.orders[activationId];
    const userObj = db.users[username];

    if (!order || !userObj || order.username !== username) return res.json({ success: false, message: "Sipariş bulunamadı." });
    if (order.status !== 'waiting') return res.json({ success: false, message: "Bu sipariş iptal edilemez." });

    try {
        const resp = await providerGet({ action: 'setStatus', status: 8, id: activationId }, 20000);
        const text = String(resp.data || '').trim();
        if (text.startsWith('ACCESS_CANCEL')) {
            userObj.balance += order.price;
            order.status = 'cancelled';
            persist();
            return res.json({ success: true, message: "Numara iptal edildi ve bakiye hesabınıza iade edildi." });
        }
        if (text.startsWith('EARLY_CANCEL_DENIED')) {
            return res.json({ success: false, message: "Numara aldıktan sonra ilk 2 dakika iptal edilemez. Biraz sonra tekrar deneyin." });
        }
        return res.json({ success: false, message: "İptal edilemedi. Sağlayıcı yanıtı: " + text });
    } catch (error) {
        return res.json({ success: false, message: "Sağlayıcı bağlantı hatası, iptal yapılamadı: " + error.message });
    }
});

// ====== SMS KOD SORGULAMA ======
app.get('/api/checkSms/:id', async (req, res) => {
    const activationId = req.params.id;
    const order = db.orders[activationId];
    if (!order || order.status !== 'waiting') return res.json({ success: false, message: "Sipariş aktif değil." });

    try {
        const resp = await providerGet({ action: 'getStatus', id: activationId }, 20000);
        let responseText = resp.data;
        if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
        responseText = responseText ? String(responseText).trim() : '';

        if (responseText.startsWith('STATUS_OK')) {
            const code = responseText.split(':').slice(1).join(':');
            order.code = code;
            order.status = 'completed';
            persist();
            return res.json({ success: true, status: 'completed', code, phoneNumber: order.phoneNumber });
        }
        return res.json({ success: true, status: 'waiting', code: "Bekleniyor...", phoneNumber: order.phoneNumber });
    } catch (error) {
        return res.json({ success: true, status: 'waiting', code: "Bekleniyor...", phoneNumber: order.phoneNumber });
    }
});

// ====== TELEGRAM WEBHOOK (ödeme onay/reddet + destek cevapları) ======
const webhookPath = `/api/telegram-webhook-${TELEGRAM_BOT_TOKEN}`;
app.post(webhookPath, async (req, res) => {
    const update = req.body;
    try {
        if (update.message && update.message.reply_to_message && String(update.message.chat.id) === String(ADMIN_CHAT_ID)) {
            const origId = update.message.reply_to_message.message_id;
            const username = supportMsgMap[origId];
            const replyText = (update.message.text || '').trim();
            if (username && db.users[username] && replyText) {
                if (!db.support[username]) db.support[username] = [];
                db.support[username].push({ from: 'admin', text: replyText, time: new Date().toLocaleString('tr-TR'), ts: Date.now() });
                if (db.support[username].length > 200) db.support[username].shift();
                persist();
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_CHAT_ID, text: `➡️ ${username} kullanıcısına iletildi.`, reply_to_message_id: update.message.message_id });
            }
        }
        if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
            if (String(chatId) === String(ADMIN_CHAT_ID)) {
                const sep = cb.data.indexOf('|');
                const action = cb.data.slice(0, sep);
                const paymentId = cb.data.slice(sep + 1);
                const payment = db.payments[paymentId];
                if (payment && payment.status === 'pending') {
                    if (action === 'approve') {
                        payment.status = 'approved';
                        if (db.users[payment.username]) db.users[payment.username].balance += payment.amount;
                        persist();
                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `✅ Ödeme Onaylandı!\nKullanıcı: ${payment.username}\nTutar: ${payment.amount} TL` });
                    } else if (action === 'reject') {
                        payment.status = 'rejected';
                        persist();
                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `❌ Ödeme Reddedildi!\nKullanıcı: ${payment.username}` });
                    }
                }
            }
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: cb.id });
        }
    } catch (e) {
        console.error('Webhook hatası:', e.message);
    }
    res.sendStatus(200);
});

// ====== ARAYÜZ ======
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="tr" class="dark">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Anka SMS</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
            body { background: radial-gradient(ellipse at 50% 20%, #04130a 0%, #030a06 42%, #010302 100%); }
            #emberCanvas { position: fixed; inset: 0; z-index: 0; }
            #matrixCanvas { position: fixed; inset: 0; z-index: 0; opacity: .55; }
            .anka { background: linear-gradient(90deg,#eaffd6,#4ade80,#16a34a,#4ade80,#eaffd6); background-size: 300% auto; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shimmer 4s linear infinite; }
            @keyframes shimmer { to { background-position: 300% center; } }
            .vipBadge { display: inline-block; margin-left: 8px; padding: 2px 10px; font-size: 11px; font-weight: 900; letter-spacing: 2px; color: #04170c; background: linear-gradient(90deg,#fde68a,#facc15,#fde68a); background-size: 200% auto; border-radius: 6px; animation: shine 3s linear infinite; vertical-align: middle; box-shadow: 0 0 12px rgba(74,222,128,.5); }
            @keyframes shine { to { background-position: 200% center; } }
            .glassCard { background: rgba(5,16,10,.55); border: 1px solid rgba(74,222,128,.28); box-shadow: 0 0 60px rgba(34,197,94,.12), inset 0 0 40px rgba(74,222,128,.04); backdrop-filter: blur(10px); }
            .ring { position: absolute; inset: -30px; border-radius: 50%; border: 1px solid rgba(74,222,128,.25); animation: spin 18s linear infinite; }
            .ring2 { position: absolute; inset: -60px; border-radius: 50%; border: 1px dashed rgba(250,204,21,.15); animation: spin 28s linear infinite reverse; }
            @keyframes spin { to { transform: rotate(360deg); } }
            .introStage { opacity: 0; transform: translateY(22px) scale(.94); animation: introIn 1s cubic-bezier(.16,.84,.44,1) forwards; }
            @keyframes introIn { to { opacity: 1; transform: none; } }
            .introFlash { position: absolute; inset: 0; background: radial-gradient(circle at 50% 45%, rgba(74,222,128,.55) 0%, rgba(74,222,128,0) 60%); animation: flashOut 1.4s ease-out forwards; pointer-events: none; }
            @keyframes flashOut { 0% { opacity: 1; transform: scale(.3); } 100% { opacity: 0; transform: scale(2.2); } }
            .phoenixWrap { width: min(360px,78vw); margin: 0 auto; position: relative; }
            .phoenixWrap svg { width: 100%; height: auto; display: block; filter: drop-shadow(0 0 28px rgba(74,222,128,.65)); }
            .wingR { transform-origin: 0 0; animation: wingFlap 1.6s ease-in-out infinite; }
            @keyframes wingFlap { 0%,100% { transform: rotate(6deg); } 50% { transform: rotate(-10deg); } }
            .birdFloat { animation: floaty 3.2s ease-in-out infinite; }
            @keyframes floaty { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-14px); } }
            .tailE { transform-origin: 0 0; animation: tailSway 2.8s ease-in-out infinite alternate; }
            @keyframes tailSway { from { transform: rotate(-4deg); } to { transform: rotate(4deg); } }
            .spark { opacity: 0; animation: sparkUp 2.6s ease-in infinite; }
            @keyframes sparkUp { 0% { opacity: 0; transform: translateY(0); } 20% { opacity: 1; } 100% { opacity: 0; transform: translateY(-70px); } }
            .fadeUp { animation: fadeUp 1.1s ease both; }
            @keyframes fadeUp { from { opacity: 0; transform: translateY(26px) scale(.96); } to { opacity: 1; transform: none; } }
            .blink { animation: blink 1s steps(2) infinite; }
            @keyframes blink { 50% { opacity: 0; } }
            .vipCard { border: 1px solid rgba(250,204,21,.45) !important; }
            .bg-slate-900, .bg-slate-950 { background-color: rgba(4,12,8,.82) !important; }
            header { backdrop-filter: blur(6px); box-shadow: 0 0 30px rgba(34,197,94,.12); }

            /* ====== DERİNLİK KATMANI: süzülen ışık küreleri + doku (gerçek 3D değil ama cam/derinlik hissi, hafif ve mobilde de akıcı) ====== */
            .orbField { position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }
            .orb { position: absolute; border-radius: 50%; filter: blur(60px); will-change: transform; opacity: .5; }
            .orb1 { width: 46vmax; height: 46vmax; left: -14vmax; top: -16vmax; background: radial-gradient(circle,rgba(74,222,128,.35),transparent 70%); animation: driftA 26s ease-in-out infinite; }
            .orb2 { width: 38vmax; height: 38vmax; right: -12vmax; top: 10vmax; background: radial-gradient(circle,rgba(250,204,21,.22),transparent 70%); animation: driftB 32s ease-in-out infinite; }
            .orb3 { width: 50vmax; height: 50vmax; left: 20vmax; bottom: -22vmax; background: radial-gradient(circle,rgba(16,185,129,.25),transparent 70%); animation: driftC 38s ease-in-out infinite; }
            @keyframes driftA { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(6vmax,8vmax) scale(1.15); } }
            @keyframes driftB { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-7vmax,5vmax) scale(1.1); } }
            @keyframes driftC { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-4vmax,-9vmax) scale(1.08); } }
            .grainOverlay { position: fixed; inset: 0; z-index: 1; pointer-events: none; opacity: .05; mix-blend-mode: overlay; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }

            /* ====== Ürün kartları: hafif kalkma + parlama, gerçek cam/VIP hissi ====== */
            .prodCard { transform: translateZ(0); transition: transform .35s cubic-bezier(.16,.84,.44,1), box-shadow .35s ease, border-color .35s ease; }
            .prodCard:hover { transform: translateY(-5px); border-color: rgba(74,222,128,.55) !important; box-shadow: 0 16px 40px -12px rgba(16,185,129,.35), 0 0 0 1px rgba(250,204,21,.08); }
            .prodIcon { transition: transform .4s ease, box-shadow .4s ease; }
            .prodCard:hover .prodIcon { transform: scale(1.08) rotate(-4deg); box-shadow: 0 0 22px rgba(74,222,128,.35); }

            /* ====== Işık geçişli butonlar ====== */
            .shineBtn { position: relative; overflow: hidden; }
            .shineBtn::after { content: ''; position: absolute; top: 0; left: -60%; width: 40%; height: 100%; background: linear-gradient(115deg,transparent,rgba(255,255,255,.35),transparent); transform: skewX(-20deg); transition: left .6s ease; }
            .shineBtn:hover::after { left: 130%; }

            /* ====== Mobil incelikler ====== */
            @media (max-width: 640px) {
                header { flex-wrap: wrap; gap: 10px; padding: 14px; }
                #contactCapsule { order: 3; }
                .anka { font-size: 1.35rem !important; }
                .orb1, .orb2, .orb3 { filter: blur(40px); }
            }
            @media (prefers-reduced-motion: reduce) {
                .orb1, .orb2, .orb3, .prodCard, .shineBtn::after, .wingR, .birdFloat, .tailE, .spark, .anka, .vipBadge { animation: none !important; transition: none !important; }
            }
        </style>
    </head>
    <body class="text-slate-100 font-sans min-h-screen flex flex-col justify-between">
        <canvas id="matrixCanvas"></canvas>
        <canvas id="emberCanvas"></canvas>
        <div class="orbField"><div class="orb orb1"></div><div class="orb orb2"></div><div class="orb orb3"></div></div>
        <div class="grainOverlay"></div>
        <template id="phoenixTpl">
            <svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Anka amblemi">
            <defs>
                <linearGradient id="gBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eaffd6"/><stop offset=".45" stop-color="#4ade80"/><stop offset="1" stop-color="#065f46"/></linearGradient>
                <linearGradient id="gWingR" x1="0" y1="0" x2="1" y2=".2"><stop offset="0" stop-color="#fff9db"/><stop offset=".4" stop-color="#facc15"/><stop offset=".75" stop-color="#22c55e"/><stop offset="1" stop-color="#064e3b"/></linearGradient>
                <linearGradient id="gWingL" x1="0" y1="0" x2="1" y2=".2"><stop offset="0" stop-color="#fff9db"/><stop offset=".4" stop-color="#facc15"/><stop offset=".75" stop-color="#22c55e"/><stop offset="1" stop-color="#064e3b"/></linearGradient>
                <filter id="eGlow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            </defs>
            <polygon points="200,8 362,100 362,284 200,376 38,284 38,100" fill="none" stroke="#22c55e" stroke-opacity=".35" stroke-width="2"/>
            <polygon points="200,34 338,112 338,272 200,350 62,272 62,112" fill="none" stroke="#facc15" stroke-opacity=".25" stroke-width="1" stroke-dasharray="6 7"/>
            <g class="birdFloat" filter="url(#eGlow)">
              <g transform="translate(200 185)"><g class="wingR">
                <polygon points="0,0 150,-64 128,-28 150,-2 118,6 136,24 100,22 108,44 76,32 72,54 50,30 36,40" fill="url(#gWingR)" stroke="#eaffd6" stroke-opacity=".5" stroke-width="1.5"/>
              </g></g>
              <g transform="translate(200 185) scale(-1 1)"><g class="wingR">
                <polygon points="0,0 150,-64 128,-28 150,-2 118,6 136,24 100,22 108,44 76,32 72,54 50,30 36,40" fill="url(#gWingL)" stroke="#eaffd6" stroke-opacity=".5" stroke-width="1.5"/>
              </g></g>
              <g transform="translate(200 220)"><g class="tailE">
                <polygon points="0,0 -40,120 -14,70 0,150 14,70 40,120" fill="url(#gBody)" opacity=".9"/>
              </g></g>
              <polygon points="200,96 222,150 212,230 200,268 188,230 178,150" fill="url(#gBody)" stroke="#eaffd6" stroke-opacity=".6" stroke-width="1.5"/>
              <polygon points="200,56 214,96 200,112 186,96" fill="#eaffd6"/>
              <polygon points="200,34 207,58 200,70 193,58" fill="#facc15"/>
            </g>
            <g class="sparkLayer">
              <circle class="spark" cx="130" cy="300" r="2.2" fill="#86efac" style="animation-delay:.2s"/>
              <circle class="spark" cx="270" cy="300" r="2.2" fill="#fde047" style="animation-delay:1s"/>
              <circle class="spark" cx="200" cy="330" r="2" fill="#86efac" style="animation-delay:1.8s"/>
              <circle class="spark" cx="160" cy="60" r="1.8" fill="#fde047" style="animation-delay:.6s"/>
              <circle class="spark" cx="245" cy="70" r="1.8" fill="#86efac" style="animation-delay:1.4s"/>
            </g>
            </svg>
        </template>

        <div id="intro" style="position:fixed;inset:0;z-index:100;background:radial-gradient(ellipse at 50% 35%,rgba(4,21,12,.92) 0%,rgba(2,7,5,.96) 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;transition:opacity .9s ease;cursor:pointer;overflow:hidden" onclick="closeIntro()">
            <div class="introFlash"></div>
            <div class="ring introStage" style="z-index:1;animation-delay:.05s"></div>
            <div class="ring2 introStage" style="z-index:1;animation-delay:.05s"></div>
            <span class="vipBadge introStage" style="z-index:1;animation-delay:.15s;letter-spacing:3px">VIP ERİŞİM</span>
            <div id="introPhoenix" class="phoenixWrap introStage" style="width:min(260px,62vw);z-index:1;animation-delay:.3s"></div>
            <h1 class="anka text-4xl md:text-6xl font-black tracking-widest mt-4 introStage" style="z-index:1;animation-delay:.55s">ANKA SMS</h1>
            <p class="text-emerald-200/60 text-xs font-mono mt-1 tracking-widest introStage" style="z-index:1;animation-delay:.7s">KÜLLERİNDEN DOĞAN GÜVENLİ SİSTEM</p>
            <div id="introLog" class="introStage" style="z-index:1;animation-delay:.85s;margin-top:22px;font-family:monospace;color:#4ade80;font-size:13px;min-height:70px;text-align:center"></div>
            <div class="introStage" style="z-index:1;animation-delay:.85s;margin-top:10px;width:260px;height:3px;background:rgba(74,222,128,.15);border-radius:4px;overflow:hidden"><div id="introBar" style="height:100%;width:0;background:linear-gradient(90deg,#facc15,#4ade80);transition:width .6s ease;box-shadow:0 0 10px #4ade80"></div></div>
            <p class="text-emerald-200/30 text-[10px] mt-5 introStage" style="z-index:1;animation-delay:1s">(geçmek için dokun)</p>
        </div>

        <div class="max-w-5xl mx-auto w-full p-4 relative z-10">
            <header class="flex justify-between items-center py-4 px-6 border border-emerald-500/25 mb-6 rounded-2xl shadow-2xl">
                <div class="flex items-center gap-3">
                    <div class="bg-emerald-500/15 p-2.5 rounded-xl border border-emerald-500/40">
                        <i class="fa-solid fa-gem text-xl" style="color:#facc15;text-shadow:0 0 14px #4ade80"></i>
                    </div>
                    <div>
                        <h1 class="anka text-2xl font-black tracking-widest inline-block">ANKA SMS</h1><span class="vipBadge">VIP</span>
                        <p class="text-[10px] text-emerald-300/60 font-mono">GÜVENLİ SANAL NUMARA SİSTEMİ</p>
                    </div>
                </div>
                <div class="flex items-center gap-2 sm:gap-4 flex-wrap justify-end">
                    <div id="contactCapsule" style="display:flex;align-items:center;gap:6px;background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.3);border-radius:999px;padding:5px 10px">
                        <a href="https://t.me/vipankaa" target="_blank" title="Telegram" style="color:#60a5fa;font-size:15px;line-height:0"><i class="fa-brands fa-telegram"></i></a>
                        <span style="width:1px;height:14px;background:rgba(74,222,128,.25)"></span>
                        <a href="https://wa.me/573181006792" target="_blank" title="WhatsApp" style="color:#4ade80;font-size:15px;line-height:0"><i class="fa-brands fa-whatsapp"></i></a>
                    </div>
                    <div id="userArea" class="flex items-center gap-2 sm:gap-4"></div>
                </div>
            </header>
            <main id="mainContent"></main>
            <p style="text-align:center;color:rgba(74,222,128,.25);font-size:10px;font-family:monospace;margin-top:30px">sürüm: ${APP_VERSION}</p>
        </div>

        <div id="authModal" class="fixed inset-0 bg-black/85 flex items-center justify-center hidden z-50" onclick="if(event.target===this) closeAuthModal()">
            <div class="glassCard p-8 rounded-3xl w-full max-w-md relative shadow-2xl" onclick="event.stopPropagation()">
                <button onclick="closeAuthModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white" style="z-index:5"><i class="fa-solid fa-xmark text-xl"></i></button>
                <div class="text-center mb-6"><h2 id="authTitle" class="text-2xl font-black text-white">Giriş Yap</h2></div>
                <div class="space-y-4">
                    <input type="text" id="authUsername" placeholder="Kullanıcı Adı" class="w-full bg-black/40 border border-emerald-500/20 rounded-xl p-3 text-white focus:border-emerald-500">
                    <input type="password" id="authPassword" placeholder="Şifre" class="w-full bg-black/40 border border-emerald-500/20 rounded-xl p-3 text-white focus:border-emerald-500">
                    <button onclick="handleAuthSubmit()" id="authSubmitBtn" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl transition">Giriş Yap</button>
                    <p class="text-center text-sm text-slate-400"><span onclick="switchAuthMode()" id="switchText" class="text-emerald-400 cursor-pointer underline">Kayıt Ol</span></p>
                </div>
            </div>
        </div>

        <div id="depositModal" class="fixed inset-0 bg-black/85 flex items-center justify-center hidden z-50" onclick="if(event.target===this) closeDeposit()">
            <div class="glassCard p-8 rounded-3xl w-full max-w-md relative shadow-2xl" onclick="event.stopPropagation()">
                <button onclick="closeDeposit()" class="absolute top-4 right-4 text-slate-400 hover:text-white" style="z-index:5"><i class="fa-solid fa-xmark text-xl"></i></button>
                <h2 class="text-xl font-black mb-4 text-emerald-400"><i class="fa-solid fa-wallet"></i> Bakiye Yükle (IBAN)</h2>
                <div class="space-y-4 text-sm text-slate-300">
                    <div class="bg-black/40 p-4 rounded-xl border border-emerald-500/20">
                        <p class="text-slate-500 text-xs">Banka IBAN:</p>
                        <p class="font-mono text-emerald-400 font-bold text-base select-all">TR62 0006 2000 5000 0006 8107 73</p>
                        <p class="text-slate-500 text-xs mt-2">Alıcı:</p>
                        <p class="font-bold text-white text-base">Resul Sakal</p>
                    </div>
                    <input type="text" id="depositSender" placeholder="Gönderen Ad Soyad" class="w-full bg-black/40 border border-emerald-500/20 rounded-xl p-3 text-white">
                    <input type="number" id="depositAmount" placeholder="Tutar (TL)" class="w-full bg-black/40 border border-emerald-500/20 rounded-xl p-3 text-white">
                    <button onclick="submitDeposit()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl">Bildirim Gönder</button>
                </div>
            </div>
        </div>


        <script>
            var currentUser = localStorage.getItem('currentUser') || null;
            var currentRole = localStorage.getItem('currentRole') || 'user';
            var adminToken = localStorage.getItem('adminToken') || null;
            var isRegisterMode = false;
            var orderTimers = {};
            var phoenixCount = 0;

            (function () {
                // Yesil Matrix yagmuru arka plan
                var c = document.getElementById('matrixCanvas');
                var ctx = c.getContext('2d');
                var cols, drops, fontSize = 16;
                var chars = 'ANKASMS01アイウエオカキクケコサシスセソ0123456789ﾊﾋﾌﾍﾎﾗﾘﾟｳｴｵ'.split('');
                function resize() {
                    c.width = window.innerWidth; c.height = window.innerHeight;
                    cols = Math.ceil(c.width / fontSize);
                    drops = [];
                    for (var i = 0; i < cols; i++) drops[i] = Math.random() * -100;
                }
                resize();
                window.addEventListener('resize', resize);
                function tickMatrix() {
                    ctx.fillStyle = 'rgba(2,10,6,0.18)';
                    ctx.fillRect(0, 0, c.width, c.height);
                    ctx.font = fontSize + 'px monospace';
                    for (var i = 0; i < drops.length; i++) {
                        var ch = chars[Math.floor(Math.random() * chars.length)];
                        var x = i * fontSize, y = drops[i] * fontSize;
                        ctx.fillStyle = Math.random() > .93 ? '#eaffd6' : (Math.random() > .5 ? '#4ade80' : '#16a34a');
                        ctx.fillText(ch, x, y);
                        if (y > c.height && Math.random() > .975) drops[i] = 0;
                        drops[i]++;
                    }
                    setTimeout(function () { requestAnimationFrame(tickMatrix); }, 45);
                }
                tickMatrix();
            })();

            (function () {
                // Altin/yesil kivilcim parcaciklari (ust katman, hafif)
                var c = document.getElementById('emberCanvas');
                var ctx = c.getContext('2d');
                var parts = [];
                function resize() { c.width = window.innerWidth; c.height = window.innerHeight; }
                resize();
                window.addEventListener('resize', resize);
                function spawn() {
                    if (parts.length > 90) return;
                    parts.push({ x: Math.random() * c.width, y: c.height + 10, r: 1 + Math.random() * 2.2, vy: .4 + Math.random() * .9, vx: (Math.random() - .5) * .5, a: 0, life: 0, max: 160 + Math.random() * 160, hue: Math.random() > .5 ? '74,222,128' : '250,204,21' });
                }
                setInterval(spawn, 140);
                function tick() {
                    ctx.clearRect(0, 0, c.width, c.height);
                    for (var i = parts.length - 1; i >= 0; i--) {
                        var p = parts[i];
                        p.life++; p.y -= p.vy; p.x += p.vx + Math.sin(p.life * .05) * .3;
                        p.a = Math.sin((p.life / p.max) * Math.PI);
                        ctx.beginPath(); ctx.fillStyle = 'rgba(' + p.hue + ',' + (p.a * .8) + ')'; ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
                        if (p.life > p.max) parts.splice(i, 1);
                    }
                    requestAnimationFrame(tick);
                }
                tick();
            })();

            function phoenixHTML() {
                var t = document.getElementById('phoenixTpl');
                if (!t) return '';
                phoenixCount++;
                return t.innerHTML.replace(/(gBody|gWingR|gWingL|eGlow)/g, '$1_' + phoenixCount);
            }

            var introClosed = false;
            function closeIntro() {
                if (introClosed) return;
                introClosed = true;
                var o = document.getElementById('intro');
                if (!o) return;
                o.style.opacity = '0';
                setTimeout(function () { if (o.parentNode) o.parentNode.removeChild(o); }, 900);
            }
            function runIntro() {
                var ip = document.getElementById('introPhoenix');
                if (ip) ip.innerHTML = phoenixHTML();
                var lines = ['> sistem başlatılıyor...', '> şifreli bağlantı kuruluyor...', '> sunucu doğrulandı [OK]', '> anka külllerinden doğuyor...', '> erişim sağlandı'];
                var log = document.getElementById('introLog');
                var bar = document.getElementById('introBar');
                lines.forEach(function (t, i) {
                    setTimeout(function () {
                        if (introClosed) return;
                        var d = document.createElement('div'); d.textContent = t; log.appendChild(d);
                        bar.style.width = ((i + 1) * 20) + '%';
                    }, 450 + i * 620);
                });
                setTimeout(function () { closeIntro(); }, 3900);
            }
            if (sessionStorage.getItem('introDone')) {
                var introEl = document.getElementById('intro');
                if (introEl) introEl.parentNode.removeChild(introEl);
                introClosed = true;
            } else {
                runIntro();
                sessionStorage.setItem('introDone', '1');
            }

            function init() {
                updateUserArea();
                if (currentUser) {
                    buildMain();
                    loadServices();
                    restoreOrders();
                }
            }

            function updateUserArea() {
                var area = document.getElementById('userArea');
                if (currentUser) {
                    area.innerHTML =
                        '<div class="flex items-center gap-3">' +
                        '<span class="text-sm font-medium">@<strong class="text-white">' + currentUser + '</strong></span>' +
                        '<span id="userBalance" class="bg-emerald-500/10 text-emerald-300 px-3.5 py-1.5 rounded-full text-xs font-bold border border-emerald-500/30">0.00 TL</span>' +
                        (currentRole === 'admin' && adminToken ? '<button onclick="openAdminPanel()" class="bg-emerald-600 hover:bg-emerald-500 px-3.5 py-1.5 rounded-xl text-xs font-bold">Admin Panel</button>' : '') +
                        '<button onclick="logout()" class="text-red-400 text-sm p-2"><i class="fa-solid fa-right-from-bracket"></i></button>' +
                        '</div>';
                    fetchBalance();
                } else {
                    area.innerHTML =
                        '<button onclick="openAuthModal(\\'login\\')" class="bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-xl text-sm font-bold">Giriş Yap</button>' +
                        '<button onclick="openAuthModal(\\'register\\')" class="bg-black/40 border border-emerald-500/30 px-5 py-2.5 rounded-xl text-sm font-bold">Kayıt Ol</button>';
                    document.getElementById('mainContent').innerHTML =
                        '<div class="text-center py-16 glassCard vipCard rounded-3xl p-8 fadeUp">' +
                        '<div class="phoenixWrap">' + phoenixHTML() + '</div>' +
                        '<div class="mb-3 mt-2"><span class="vipBadge">VIP ÜYELİK PANELİ</span></div>' +
                        '<h2 class="anka text-5xl md:text-6xl font-black mb-4 font-mono tracking-widest">ANKA SMS</h2>' +
                        '<p class="text-emerald-200/70 font-mono mb-8">Anlık sanal numara &bull; Hızlı SMS kodu &bull; 7/24 aktif<span class="blink">_</span></p>' +
                        '<div class="flex gap-3 justify-center"><button onclick="openAuthModal(\\'login\\')" class="bg-emerald-600 hover:bg-emerald-500 px-8 py-3 rounded-xl font-bold">Giriş Yap</button>' +
                        '<button onclick="openAuthModal(\\'register\\')" class="bg-black/40 border border-emerald-500/40 hover:bg-emerald-900/30 px-8 py-3 rounded-xl font-bold text-emerald-300">Kayıt Ol</button></div>' +
                        '<p class="text-emerald-200/40 text-xs mt-6">Destek: Telegram <a href="https://t.me/vipankaa" target="_blank" class="text-emerald-400 underline">@vipankaa</a> &bull; WhatsApp <a href="https://wa.me/573181006792" target="_blank" class="text-emerald-400 underline">+57 318 100 6792</a></p>' +
                        '</div>';
                }
            }

            async function fetchBalance() {
                if (!currentUser) return;
                var res = await fetch('/api/getCustomerBalance?username=' + encodeURIComponent(currentUser));
                var data = await res.json();
                var el = document.getElementById('userBalance');
                if (data.success && el) el.innerText = data.balance.toFixed(2) + ' TL';
            }

            function buildMain() {
                document.getElementById('mainContent').innerHTML =
                    '<div id="servicesGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4"><p class="text-slate-400 text-sm">Yükleniyor...</p></div>' +
                    '<div class="mt-6 flex justify-end"><button onclick="openDeposit()" class="bg-emerald-600 hover:bg-emerald-500 px-6 py-3 rounded-xl font-bold text-sm"><i class="fa-solid fa-wallet mr-2"></i> Bakiye Yükle</button></div>' +
                    '<div id="activeOrderArea" class="mt-8"></div>';
            }

            function openDeposit() { document.getElementById('depositModal').classList.remove('hidden'); }
            function closeDeposit() { document.getElementById('depositModal').classList.add('hidden'); }

            async function loadServices() {
                if (!currentUser) return;
                var grid = document.getElementById('servicesGrid');
                if (!grid) return;
                try {
                    var res = await fetch('/api/getServices');
                    var data = await res.json();
                    if (!data.success || !data.services.length) {
                        grid.innerHTML = '<p class="text-slate-400 text-sm">Şu an ürün yüklenemedi.</p>';
                        return;
                    }
                    grid.innerHTML = data.services.map(renderServiceCard).join('');
                } catch (e) {}
            }

            function renderServiceCard(s) {
                return '<div class="prodCard bg-black/40 border border-emerald-500/15 p-5 rounded-2xl flex items-center justify-between shadow-xl transition">' +
                    '<div class="flex items-center gap-4 min-w-0">' +
                    '<div class="' + s.bg + ' ' + s.color + ' prodIcon w-12 h-12 rounded-xl flex items-center justify-center text-xl border border-emerald-500/15 shrink-0"><i class="' + (s.iconSet || 'fa-brands') + ' ' + s.icon + '"></i></div>' +
                    '<div class="min-w-0"><h3 class="font-bold text-sm text-white truncate">' + s.name + '</h3>' +
                    '<p class="text-emerald-300 font-bold text-sm">' + s.price.toFixed(2) + ' TL</p></div>' +
                    '</div>' +
                    '<button data-id="' + s.id + '" onclick="buyNumber(this)" class="shineBtn bg-emerald-600 hover:bg-emerald-500 px-4 sm:px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg transition shrink-0">Numara Al</button>' +
                    '</div>';
            }

            var MAX_AUTO_RETRY = 6;
            async function buyNumber(btn, attemptNo) {
                attemptNo = attemptNo || 1;
                var productId = btn.getAttribute('data-id');
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> ' + (attemptNo > 1 ? 'Tekrar deneniyor (' + attemptNo + '/' + (MAX_AUTO_RETRY + 1) + ')...' : 'Alınıyor...');
                try {
                    var res = await fetch('/api/buyNumber', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: productId, username: currentUser }) });
                    var data = await res.json();
                    if (data.success) {
                        btn.disabled = false;
                        btn.innerText = 'Numara Al';
                        fetchBalance();
                        trackOrder(data.order.activationId, data.order.phoneNumber, 600, data.order.productName, null);
                    } else if (data.retryable && attemptNo <= MAX_AUTO_RETRY) {
                        setTimeout(function () { buyNumber(btn, attemptNo + 1); }, 2500);
                    } else {
                        btn.disabled = false;
                        btn.innerText = 'Numara Al';
                        alert(data.message);
                    }
                } catch (e) {
                    btn.disabled = false;
                    btn.innerText = 'Numara Al';
                    alert('Bağlantı hatası, tekrar deneyin.');
                }
            }

            function trackOrder(id, phone, timeLeft, productName, doneCode) {
                var area = document.getElementById('activeOrderArea');
                if (!area) return;
                var old = document.getElementById('order_' + id);
                if (old) old.parentNode.removeChild(old);
                if (orderTimers[id]) { clearInterval(orderTimers[id]); delete orderTimers[id]; }
                var done = !!doneCode;

                var card = document.createElement('div');
                card.id = 'order_' + id;
                card.className = 'bg-black/40 border border-emerald-500 p-6 rounded-2xl shadow-2xl relative mb-4';
                card.innerHTML =
                    '<h3 class="font-bold text-emerald-400 text-lg mb-3"><i class="fa-solid fa-circle-check mr-2"></i> ' + (productName || 'Numara') + '</h3>' +
                    '<p class="text-sm text-slate-300">Numara: <strong class="text-white font-mono text-xl select-all">' + phone + '</strong></p>' +
                    '<p class="text-sm text-slate-300 mt-2">SMS Kod: <strong id="smsCode_' + id + '" class="text-emerald-400 font-mono text-xl ' + (done ? '' : 'animate-pulse') + '">' + (done ? doneCode : 'Bekleniyor...') + '</strong></p>' +
                    '<div class="mt-4 flex items-center justify-between border-t border-emerald-500/20 pt-4">' +
                    '<span class="text-xs text-slate-400">' + (done ? '' : 'Kod Süresi: <strong id="timerDisplay_' + id + '" class="text-emerald-400 font-mono text-sm">--:--</strong>') + '</span>' +
                    '<div id="actionButtons_' + id + '">' + (done
                        ? '<span class="text-emerald-400 font-bold text-xs"><i class="fa-solid fa-check"></i> Tamamlandı</span>'
                        : '<button data-id="' + id + '" onclick="cancelBtn(this)" class="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white border border-red-500/40 px-4 py-2 rounded-xl text-xs font-bold transition">Değiştir / İptal Et</button>') +
                    '</div></div>';
                area.insertBefore(card, area.firstChild);
                if (done) return;

                var tick = 0;
                orderTimers[id] = setInterval(async function () {
                    timeLeft--; tick++;
                    var min = Math.floor(timeLeft / 60), sec = timeLeft % 60;
                    var timerEl = document.getElementById('timerDisplay_' + id);
                    if (timerEl) timerEl.innerText = String(Math.max(min, 0)).padStart(2, '0') + ':' + String(Math.max(sec, 0)).padStart(2, '0');
                    if (timeLeft <= 0) { clearInterval(orderTimers[id]); delete orderTimers[id]; cancelOrder(id, true); return; }
                    if (tick % 5 !== 0) return;
                    try {
                        var res = await fetch('/api/checkSms/' + id);
                        var data = await res.json();
                        if (data.success && data.status === 'completed') {
                            clearInterval(orderTimers[id]); delete orderTimers[id];
                            var codeEl = document.getElementById('smsCode_' + id);
                            if (codeEl) { codeEl.innerText = data.code; codeEl.classList.remove('animate-pulse'); }
                            var actionArea = document.getElementById('actionButtons_' + id);
                            if (actionArea) actionArea.innerHTML = '<span class="text-emerald-400 font-bold text-xs"><i class="fa-solid fa-check"></i> Tamamlandı</span>';
                            var tEl = document.getElementById('timerDisplay_' + id);
                            if (tEl) tEl.parentNode.innerHTML = '';
                            alert('SMS Kodunuz Geldi: ' + data.code);
                        }
                    } catch (e) {}
                }, 1000);
            }

            async function restoreOrders() {
                if (!currentUser) return;
                try {
                    var res = await fetch('/api/myOrders?username=' + encodeURIComponent(currentUser));
                    var data = await res.json();
                    if (!data.success) return;
                    data.orders.slice().reverse().forEach(function (o) {
                        trackOrder(o.activationId, o.phoneNumber, o.remaining, o.productName, o.status === 'completed' ? o.code : null);
                    });
                } catch (e) {}
            }

            function cancelBtn(btn) { cancelOrder(btn.getAttribute('data-id'), false); }

            async function cancelOrder(id, isTimeout) {
                if (!isTimeout && !confirm('Bu numarayı iptal etmek istediğinize emin misiniz? Bakiyeniz hesabınıza iade edilecektir.')) return;
                var res = await fetch('/api/cancelNumber', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activationId: id, username: currentUser }) });
                var data = await res.json();
                alert(data.message);
                fetchBalance();
                if (data.success) {
                    if (orderTimers[id]) { clearInterval(orderTimers[id]); delete orderTimers[id]; }
                    var card = document.getElementById('order_' + id);
                    if (card) card.parentNode.removeChild(card);
                }
            }

            function openAuthModal(mode) {
                isRegisterMode = (mode === 'register');
                document.getElementById('authTitle').innerText = isRegisterMode ? 'Kayıt Ol' : 'Giriş Yap';
                document.getElementById('authSubmitBtn').innerText = isRegisterMode ? 'Kayıt Ol' : 'Giriş Yap';
                document.getElementById('switchText').innerText = isRegisterMode ? 'Zaten hesabın var mı? Giriş Yap' : 'Hesabın yok mu? Kayıt Ol';
                document.getElementById('authModal').classList.remove('hidden');
            }
            function closeAuthModal() { document.getElementById('authModal').classList.add('hidden'); }
            function switchAuthMode() { openAuthModal(isRegisterMode ? 'login' : 'register'); }
            function openLogin() { openAuthModal('login'); }
            function openRegister() { openAuthModal('register'); }

            async function handleAuthSubmit() {
                var username = document.getElementById('authUsername').value;
                var password = document.getElementById('authPassword').value;
                var endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
                var res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username, password: password }) });
                var data = await res.json();
                if (data.success) {
                    currentUser = data.username;
                    currentRole = data.role || 'user';
                    localStorage.setItem('currentUser', currentUser);
                    localStorage.setItem('currentRole', currentRole);
                    if (data.adminToken) { adminToken = data.adminToken; localStorage.setItem('adminToken', adminToken); }
                    else { adminToken = null; localStorage.removeItem('adminToken'); }
                    closeAuthModal();
                    init();
                } else {
                    alert(data.message);
                }
            }

            async function submitDeposit() {
                var senderName = document.getElementById('depositSender').value;
                var amount = document.getElementById('depositAmount').value;
                var res = await fetch('/api/deposit/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: currentUser, senderName: senderName, amount: amount }) });
                var data = await res.json();
                alert(data.message);
                closeDeposit();
            }


            async function openAdminPanel() {
                var res = await fetch('/api/admin/getData?adminToken=' + encodeURIComponent(adminToken || ''));
                var data = await res.json();
                if (!data.success) {
                    // Token geçersiz/süresi dolmuş olabilir (örn. sunucu yeniden başladı) - tekrar giriş iste.
                    localStorage.removeItem('adminToken');
                    adminToken = null;
                    alert('Oturumun süresi dolmuş veya geçersiz. Lütfen tekrar giriş yap.');
                    updateUserArea();
                    openAuthModal('login');
                    return;
                }

                var pendingHtml = '';
                data.payments.filter(function (p) { return p.status === 'pending'; }).forEach(function (p) {
                    pendingHtml += '<div class="bg-black/40 p-4 rounded-xl mb-2 flex justify-between items-center"><span>' + p.username + ' - ' + p.amount + ' TL (' + p.senderName + ') <span class="text-slate-500 text-xs">' + p.time + '</span></span><div>' +
                        '<button onclick="processPay(\\'' + p.id + '\\',\\'approve\\')" class="bg-emerald-600 px-3 py-1 rounded text-xs font-bold mr-1">Onayla</button>' +
                        '<button onclick="processPay(\\'' + p.id + '\\',\\'reject\\')" class="bg-red-600 px-3 py-1 rounded text-xs font-bold mr-1">Reddet</button>' +
                        '<button onclick="processPay(\\'' + p.id + '\\',\\'reject_ban\\')" class="bg-red-800 px-3 py-1 rounded text-xs font-bold" title="Ödeme yapmadan sahte bildirim gönderenler için">Reddet + Banla</button></div></div>';
                });
                if (!pendingHtml) pendingHtml = '<p class="text-sm text-slate-500">Bekleyen ödeme yok.</p>';

                var allPayHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.payments.map(function (p) {
                    var c = p.status === 'approved' ? 'text-emerald-400' : (p.status === 'rejected' ? 'text-red-400' : 'text-emerald-400');
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex justify-between"><span>' + p.username + '</span><span>' + p.amount + ' TL</span><span class="' + c + '">' + p.status + '</span><span class="text-slate-500">' + p.time + '</span></div>';
                }).join('') + '</div>';
                if (!data.payments.length) allPayHtml = '<p class="text-sm text-slate-500">Henüz ödeme yok.</p>';

                var usersHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.users.map(function (u) {
                    var banBtn = u.role === 'admin' ? '' : (u.banned ?
                        '<button onclick="toggleBan(\\'' + u.username + '\\',false)" class="bg-slate-600 px-2 py-1 rounded text-xs font-bold">Banı Kaldır</button>' :
                        '<button onclick="toggleBan(\\'' + u.username + '\\',true)" class="bg-red-800 px-2 py-1 rounded text-xs font-bold">Banla</button>');
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex flex-wrap justify-between items-center gap-2' + (u.banned ? ' border border-red-800/60' : '') + '">' +
                        '<span class="font-bold text-white">' + u.username + (u.banned ? ' <span class="text-red-400">(BANLI)</span>' : '') + '</span>' +
                        '<span>' + u.balance.toFixed(2) + ' TL</span>' +
                        '<span class="text-slate-500">' + u.role + '</span>' +
                        '<span class="text-slate-500">' + u.registeredAt + '</span>' +
                        '<input id="balAdj_' + u.username + '" placeholder="+50 / -20" class="bg-black/40 border border-emerald-500/20 rounded px-2 py-1 text-xs text-white w-20">' +
                        '<button onclick="adjustBalance(\\'' + u.username + '\\')" class="bg-blue-600 px-2 py-1 rounded text-xs font-bold">Uygula</button>' +
                        banBtn +
                        '</div>';
                }).join('') + '</div>';

                var loginsHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.logins.map(function (l) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex flex-wrap justify-between gap-1"><span class="font-bold text-white">' + l.username + '</span><span class="text-slate-400 font-mono">' + l.ip + '</span><span class="text-emerald-400">' + (l.source || '-') + '</span><span class="text-slate-500">' + l.time + '</span></div>';
                }).join('') + '</div>';
                if (!data.logins.length) loginsHtml = '<p class="text-sm text-slate-500">Henüz giriş kaydı yok.</p>';

                var visitorsHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + (data.visitorList || []).map(function (v) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex flex-wrap justify-between gap-1"><span class="text-slate-400 font-mono">' + v.ip + '</span><span class="text-emerald-400 font-bold">' + v.source + '</span><span class="text-slate-500">' + v.time + '</span></div>';
                }).join('') + '</div>';
                if (!data.visitorList || !data.visitorList.length) visitorsHtml = '<p class="text-sm text-slate-500">Henüz ziyaretçi kaydı yok.</p>';

                var ordersHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.orders.map(function (o) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex justify-between"><span class="font-bold text-white">' + o.username + '</span><span>' + o.productName + '</span><span class="font-mono">' + o.phoneNumber + '</span><span class="text-slate-500">' + o.status + '</span><span class="text-slate-500">' + o.time + '</span></div>';
                }).join('') + '</div>';
                if (!data.orders.length) ordersHtml = '<p class="text-sm text-slate-500">Henüz sipariş yok.</p>';

                var supportHtml = '<div class="space-y-2">' + data.supportChats.map(function (c) {
                    return '<div class="bg-black/30 p-3 rounded-lg text-xs"><div class="flex justify-between mb-1"><span class="font-bold text-white">' + c.username + '</span><span class="text-slate-500">' + (c.last ? c.last.time : '') + '</span></div>' +
                        '<div class="text-slate-400 mb-2">' + (c.last ? c.last.text.replace(/</g, '&lt;') : '') + '</div>' +
                        '<div class="flex gap-1"><input id="adminReply_' + c.username + '" placeholder="Cevap yaz..." class="flex-1 bg-black/40 border border-emerald-500/20 rounded px-2 py-1 text-xs text-white">' +
                        '<button onclick="adminReplySupport(\\'' + c.username + '\\')" class="bg-emerald-600 px-3 rounded text-xs font-bold">Gönder</button></div></div>';
                }).join('') + '</div>';
                if (!data.supportChats.length) supportHtml = '<p class="text-sm text-slate-500">Henüz destek mesajı yok.</p>';

                var svcRes = await fetch('/api/admin/serviceCodes?adminToken=' + encodeURIComponent(adminToken || ''));
                var svcData = await svcRes.json();
                var serviceCodesHtml = '<p class="text-xs text-slate-500 mb-2">Yeni ürünlerin sağlayıcıdaki gerçek servis kodu isimle otomatik bulunur. Yanlış/eksikse buradan elle düzeltebilirsin.</p><div class="max-h-56 overflow-y-auto space-y-1">' + (svcData.list || []).map(function (s) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex flex-wrap items-center gap-2"><span class="font-bold text-white flex-1 min-w-[120px]">' + s.name + '</span>' +
                        '<span class="' + (s.confirmed ? 'text-emerald-400' : 'text-amber-400') + '">' + s.code + (s.confirmed ? ' (bulundu)' : ' (tahmin)') + '</span>' +
                        '<input id="svcCode_' + s.id + '" placeholder="elle kod gir" value="' + s.override + '" class="bg-black/40 border border-emerald-500/20 rounded px-2 py-1 text-xs text-white w-28">' +
                        '<button onclick="saveServiceCode(\\'' + s.id + '\\')" class="bg-emerald-600 px-3 py-1 rounded text-xs font-bold">Kaydet</button></div>';
                }).join('') + '</div>';

                document.getElementById('mainContent').innerHTML =
                    '<div class="glassCard p-6 rounded-2xl space-y-6">' +
                    '<div class="flex justify-between items-center"><h2 class="text-xl font-bold text-emerald-400">Admin Paneli</h2><button onclick="location.reload();" class="bg-black/40 border border-emerald-500/30 px-4 py-2 rounded-xl text-xs font-bold">Geri Dön</button></div>' +
                    '<div><h3 class="font-bold mb-2 text-emerald-300"><i class="fa-solid fa-money-bill-wave mr-1"></i> Bekleyen Ödemeler</h3>' + pendingHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-emerald-300"><i class="fa-solid fa-receipt mr-1"></i> Tüm Ödemeler (kim ödeme yapmış)</h3>' + allPayHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-emerald-300"><i class="fa-solid fa-users mr-1"></i> Kayıtlı Kullanıcılar</h3>' + usersHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-emerald-300"><i class="fa-solid fa-right-to-bracket mr-1"></i> Giriş Yapanlar (kullanıcı / IP / kaynak / zaman)</h3>' + loginsHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-emerald-300"><i class="fa-solid fa-eye mr-1"></i> Ziyaretçiler (IP / nereden geldi / zaman)</h3>' + visitorsHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-emerald-300"><i class="fa-solid fa-sim-card mr-1"></i> Son Siparişler</h3>' + ordersHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-emerald-300"><i class="fa-solid fa-headset mr-1"></i> Destek Sohbetleri</h3>' + supportHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-emerald-300"><i class="fa-solid fa-code mr-1"></i> Yeni Ürünler - Servis Kodu Ayarları</h3>' + serviceCodesHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-emerald-300"><i class="fa-solid fa-stethoscope mr-1"></i> Sağlayıcı Teşhis (neden numara alınamıyor?)</h3>' +
                    '<div class="flex flex-wrap gap-2 items-center mb-2">' +
                    '<select id="diagProduct" class="bg-black/40 border border-emerald-500/20 rounded px-2 py-1 text-xs text-white">' + (data.catalog || []).map(function (c) { return '<option value="' + c.id + '">' + c.name + '</option>'; }).join('') + '</select>' +
                    '<button onclick="runDiag()" class="bg-blue-600 px-3 py-1 rounded text-xs font-bold">Kontrol Et</button>' +
                    '</div>' +
                    '<div id="diagResult" class="text-xs text-slate-400">Bir ürün seçip "Kontrol Et" butonuna bas.</div>' +
                    '</div>' +
                    '</div>';
            }

            async function runDiag() {
                var sel = document.getElementById('diagProduct');
                var box = document.getElementById('diagResult');
                box.innerHTML = '<span class="text-slate-500">Sorgulanıyor, birkaç saniye sürebilir...</span>';
                try {
                    var r = await fetch('/api/admin/testApi?adminToken=' + encodeURIComponent(adminToken || '') + '&productId=' + encodeURIComponent(sel.value));
                    var d = await r.json();
                    if (!d.success) { box.innerHTML = '<span class="text-red-400">Hata: ' + (d.error || 'bilinmiyor') + '</span>'; return; }
                    var u = d.urunler[0];
                    if (!u) { box.innerHTML = '<span class="text-red-400">Ürün bulunamadı.</span>'; return; }
                    var p = u.ilkUlkeFiyatBilgisi;
                    var priceHtml = (p && typeof p === 'object') ? ('maliyet: <b>' + p.cost + '</b> / stok: <b>' + p.count + '</b>') : 'fiyat bilgisi alınamadı (sağlayıcı bu ülke için fiyat döndürmedi)';
                    box.innerHTML =
                        '<div class="bg-black/30 p-3 rounded-lg space-y-1">' +
                        '<div>Gerçek sağlayıcı bakiyesi: <b class="text-emerald-400">' + JSON.stringify(d.providerBalance) + '</b></div>' +
                        '<div>Kullanılan servis kodu: <b>' + u.servisKodu + '</b> (' + (u.kodOnaylandi ? 'isimle doğrulandı' : 'tahmin') + ')</div>' +
                        '<div>Denenecek ülke kodları (öncelik sırasıyla): <b>' + u.denenecekUlkeler.join(', ') + '</b></div>' +
                        '<div>İlk denenecek ülkenin fiyat/stok bilgisi: ' + priceHtml + '</div>' +
                        '</div>';
                } catch (e) { box.innerHTML = '<span class="text-red-400">İstek başarısız: ' + e.message + '</span>'; }
            }

            async function adminReplySupport(username) {
                var inp = document.getElementById('adminReply_' + username);
                var text = inp.value.trim();
                if (!text) return;
                await fetch('/api/admin/support/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, username: username, text: text }) });
                openAdminPanel();
            }

            async function adjustBalance(username) {
                var inp = document.getElementById('balAdj_' + username);
                var val = inp.value.trim();
                if (!val) return;
                var r = await fetch('/api/admin/adjustBalance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, username: username, amount: val }) });
                var d = await r.json();
                alert(d.message);
                if (d.success) openAdminPanel();
            }

            async function saveServiceCode(itemId) {
                var inp = document.getElementById('svcCode_' + itemId);
                var code = inp.value.trim();
                var r = await fetch('/api/admin/setServiceCode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, itemId: itemId, code: code }) });
                var d = await r.json();
                alert(d.message);
                openAdminPanel();
            }

            async function processPay(paymentId, action) {
                if (action === 'reject_ban' && !confirm('Bu kullanıcıyı reddet VE kalıcı olarak banla? Bu işlem geri alınamaz.')) return;
                var r = await fetch('/api/admin/processPayment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, paymentId: paymentId, action: action }) });
                var d = await r.json();
                if (action === 'reject_ban') alert(d.message);
                openAdminPanel();
            }

            async function toggleBan(username, banned) {
                if (banned && !confirm(username + ' kullanıcısını kalıcı olarak banlamak istediğine emin misin?')) return;
                var r = await fetch('/api/admin/banUser', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, username: username, banned: banned }) });
                var d = await r.json();
                alert(d.message);
                openAdminPanel();
            }

            function logout() {
                Object.keys(orderTimers).forEach(function (id) { clearInterval(orderTimers[id]); });
                orderTimers = {};
                localStorage.clear();
                currentUser = null;
                currentRole = 'user';
                adminToken = null;
                init();
            }
            window.onload = init;
        </script>
    </body>
    </html>
    `);
});

// Süresi dolan ya da yarım kalan siparişleri sunucu kendisi temizler (kullanıcı sayfayı kapatsa bile)
setInterval(async () => {
    const now = Date.now();
    let changed = false;
    for (const id in db.orders) {
        const o = db.orders[id];
        if (o.status !== 'waiting' || !o.createdAt || now - o.createdAt < 11 * 60 * 1000) continue;
        o.sweepTries = (o.sweepTries || 0) + 1;
        if (o.sweepTries > 5) { o.status = 'expired'; changed = true; continue; }
        try {
            const st = await providerGet({ action: 'getStatus', id: id }, 15000);
            const t = String(st.data || '').trim();
            if (t.startsWith('STATUS_OK')) { o.code = t.split(':').slice(1).join(':'); o.status = 'completed'; changed = true; continue; }
            const c = await providerGet({ action: 'setStatus', status: 8, id: id }, 15000);
            if (String(c.data || '').trim().startsWith('ACCESS_CANCEL') && db.users[o.username]) {
                db.users[o.username].balance += o.price;
                o.status = 'cancelled';
                changed = true;
            }
        } catch (e) {}
    }
    if (changed) persist();
}, 60000);

// Sağlayıcı bakiyesi düşükse 15 dakikada bir otomatik kontrol + Telegram uyarısı
setInterval(async () => {
    try {
        const r = await providerGet({ action: 'getBalance' }, 15000);
        const m = String(r.data || '').match(/ACCESS_BALANCE:([0-9.]+)/);
        if (m) {
            const bal = parseFloat(m[1]);
            if (bal < LOW_BALANCE_THRESHOLD) await notifyLowProviderBalance('⚠️ Sağlayıcı bakiyen azaldı: ' + bal + ' TL. Lütfen yükleme yap.');
        }
    } catch (e) {}
}, 15 * 60 * 1000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor. Sürüm: ${APP_VERSION}`);
    if (!ONAYLI_SMS_API_KEY) console.warn('UYARI: ONAYLI_SMS_API_KEY ayarlanmamış!');
    try {
        const webhookUrl = `${RENDER_EXTERNAL_URL}${webhookPath}`;
        await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
    } catch (err) {}
});
