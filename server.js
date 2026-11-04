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
const APP_VERSION = '2026-11-01-16';

// ====== AYARLAR (Render > Environment bölümünden de girilebilir) ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8989904538:AAGETyb0e5ghitsYM3yWInhnIi3lexYMjPw';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const ADMIN_TELEGRAM_USERNAME = process.env.ADMIN_TELEGRAM_USERNAME || 'vipankaa'; // destek için görünen iletişim kanalı
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '573181006792'; // wa.me linki için ülke koduyla, başında + ve boşluk olmadan
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://g-venlipanelsms.onrender.com';
// ====== SAĞLAYICI: sms.tc (SMS-Activate uyumlu uç nokta) ======
// sms.tc'nin kendi dokümantasyonu doğrulandı: /stubs/handler_api.php, OnaylaSMS ile BİREBİR aynı
// SMS-Activate protokolünü konuşuyor (ACCESS_NUMBER:id:phone, STATUS_OK:code, NO_NUMBERS, NO_BALANCE,
// api_key query parametresi vb.) - bu yüzden providerGet() hiç değişmeden sadece URL+key değişti.
// ÖNEMLİ: sms.tc'de TÜM fiyat/bakiye değerleri USD cinsinden döner (TL değil) - bkz. USD_TRY_RATE.
const ONAYLI_SMS_API_KEY = process.env.PROVIDER_API_KEY || 'smstc_live_0vHjhoWB7H8qniIpTV5GDwF3W04eNpXRUWHZ9GYW';
const ONAYLI_SMS_URL = process.env.PROVIDER_URL || 'https://sms.tc/stubs/handler_api.php';
// Instagram takipçi/beğeni vb. için SMM panel sağlayıcısı (standart "add/status/services/balance" API formatı).
// API anahtarını Render > Environment'tan SMM_API_KEY olarak gir - buraya yazmıyoruz, boşsa bu bölüm devre dışı kalır.
const SMM_API_URL = process.env.SMM_API_URL || 'https://peakerr.com/api/v2';
const SMM_API_KEY = process.env.SMM_API_KEY || '';
// Sağlayıcı bakiyesi bu değerin altına düşünce Telegram'dan otomatik uyarı gelir
const LOW_BALANCE_THRESHOLD = parseFloat(process.env.LOW_BALANCE_THRESHOLD || '5'); // USD cinsinden (sms.tc bakiyesi USD döner)

// Admin panel giriş bilgileri - burada veya Render > Environment'tan değiştirilebilir.
// Sunucu her açıldığında bu hesabın kullanıcı adı/şifresi/yetkisi ZORLA bu değerlere eşitlenir (aşağıda, db yüklendikten sonra),
// yani diskte eski/bozuk bir admin kaydı olsa bile admin girişi her zaman bununla çalışır.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Aklomanti';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AZC.anka.34';

// ====== Admin girişine kaba kuvvet (brute-force) koruması ======
// Admin kullanıcı adını hedef alan art arda yanlış şifre denemeleri belirli bir IP'yi geçici kilitler.
const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 dakika
let adminLoginAttempts = {}; // ip -> {count, lastAttempt}

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

// ====== ADMIN'E WHATSAPP ÜZERİNDEN BİLDİRİM (CallMeBot) ======
// Resmi WhatsApp Business API ücretli/onay gerektirdiği için, admin'in KENDİ numarasına ücretsiz mesaj
// göndermek üzere CallMeBot servisi kullanılıyor. Kurulum (tek seferlik, admin kendisi yapmalı):
//   1) WhatsApp'tan +34 644 59 71 67 numarasına "I allow callmebot to send me messages" yaz.
//   2) Gelen cevaptaki API key'i CALLMEBOT_APIKEY ortam değişkenine ekle (Render > Environment).
// Bu değişken boşsa WhatsApp bildirimi sessizce atlanır (hata vermez), sadece Telegram bildirimi gider.
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY || '';
async function notifyAdminWhatsapp(text) {
    if (!CALLMEBOT_APIKEY) return;
    try {
        const phone = ADMIN_WHATSAPP.startsWith('+') ? ADMIN_WHATSAPP : ('+' + ADMIN_WHATSAPP);
        await axios.get('https://api.callmebot.com/whatsapp.php', {
            params: { phone, text, apikey: CALLMEBOT_APIKEY },
            timeout: 15000
        });
    } catch (e) { console.error('[notifyAdminWhatsapp] hata:', e.message); }
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
    smmOrders: {}, // id -> {username, itemId, link, quantity, price, providerOrderId, status, time, ts}
    customCatalog: [], // admin panelden elle eklenen ürünler (sunucu yeniden başlayınca CATALOG'a geri yüklenir)
    otherPlatformsMarkup: { multiplier: 1.8 }, // "Diğer SMS Platformları" VE ana kataloğun kâr çarpanı - admin panelden ayarlanır
    usdTryRate: 42 // sms.tc fiyatları USD döndürüyor - TL'ye çevirmek için kur, admin panelden güncellenebilir
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
// ====== KATALOG (2026-11-01'de tamamen yenilendi - eski tüm ürünler silindi, sadece aşağıdakiler satılıyor) ======
// Fiyatlar admin'in verdiği TL değerleri; dynamicPricing:true olanlar sms.tc canlı maliyetine göre arka planda
// (refreshDynamicCatalogPrices) güncellenir ama asla bu başlangıç fiyatının ALTINA düşmez (bkz. computeOtherPrice).
const CATALOG = [
    { id: 'tg_tr', key: 'tr', name: 'Telegram Türkiye', serviceCode: 'tg', defCountry: '62', price: 250, icon: 'fa-telegram', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-400', featured: true, dynamicPricing: true },
    { id: 'tg_co', key: 'co', name: 'Telegram Kolombiya', serviceCode: 'tg', defCountry: '10', price: 200, icon: 'fa-telegram', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-400', dynamicPricing: true },
    { id: 'tg_us', key: 'us', name: 'Telegram Amerika', serviceCode: 'tg', defCountry: '187', alt: ['12'], price: 200, icon: 'fa-telegram', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-400', dynamicPricing: true },
    { id: 'tg_gb', key: 'gb', name: 'Telegram İngiltere', serviceCode: 'tg', defCountry: '16', price: 250, icon: 'fa-telegram', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-400', dynamicPricing: true },
    { id: 'wa_tr', key: 'tr', name: 'WhatsApp Türkiye', serviceCode: 'wa', defCountry: '62', price: 300, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-violet-500/10', color: 'text-violet-400', featured: true, dynamicPricing: true },
    { id: 'wa_us', key: 'us', name: 'WhatsApp Amerika', serviceCode: 'wa', defCountry: '187', alt: ['12'], price: 200, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-violet-500/10', color: 'text-violet-400', dynamicPricing: true },
    { id: 'wa_sy', key: 'sy', name: 'WhatsApp Suriye', serviceCode: 'wa', defCountry: '199', price: 100, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-violet-500/10', color: 'text-violet-400', dynamicPricing: true },
    { id: 'wa_gb', key: 'gb', name: 'WhatsApp İngiltere', serviceCode: 'wa', defCountry: '16', price: 250, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-violet-500/10', color: 'text-violet-400', dynamicPricing: true },
    { id: 'wa_sg', key: 'sg', name: 'WhatsApp Singapur', serviceCode: 'wa', defCountry: '52', price: 250, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-violet-500/10', color: 'text-violet-400', dynamicPricing: true },
    // "Anonim/Rastgele" ürünler: tek bir sabit ülkeye bağlı değil - sistem o anki en GÜVENİLİR (stoklu) VE en UCUZ
    // ülkeyi otomatik seçer (randomPool + countryCandidates'deki ucuz-önce sıralaması sayesinde). Müşteri belirli bir
    // ülkede numara alamazsa (sms gelmiyor/stok yok) bu ürünü deneyerek garanti bir numara alabilir.
    { id: 'wa_anonim', randomPool: ['co', 'us', 'gb', 'sg', 'ph'], name: 'WhatsApp Anonim (Rastgele Ülke)', serviceCode: 'wa', defCountry: '10', price: 300, icon: 'fa-shuffle', iconSet: 'fa-solid', bg: 'bg-violet-500/10', color: 'text-violet-400', featured: true, dynamicPricing: true },
    { id: 'tg_anonim', randomPool: ['co', 'us', 'gb', 'ph'], name: 'Telegram Anonim (Rastgele Ülke)', serviceCode: 'tg', defCountry: '10', price: 300, icon: 'fa-shuffle', iconSet: 'fa-solid', bg: 'bg-blue-500/10', color: 'text-blue-400', featured: true, dynamicPricing: true },
    { id: 'pazarama_tr', key: 'tr', name: 'Pazarama Türkiye', defCountry: '62', price: 300, serviceHints: ['pazarama'], guessCodes: [], icon: 'fa-store', iconSet: 'fa-solid', bg: 'bg-amber-500/10', color: 'text-amber-300', dynamicPricing: true },
    { id: 'sahibinden_tr', key: 'tr', name: 'Sahibinden Türkiye', defCountry: '62', price: 200, serviceHints: ['sahibinden'], guessCodes: [], icon: 'fa-shop', iconSet: 'fa-solid', bg: 'bg-amber-500/10', color: 'text-amber-300', dynamicPricing: true },
    { id: 'dolap_tr', key: 'tr', name: 'Dolap Türkiye', defCountry: '62', price: 350, serviceHints: ['dolap'], guessCodes: [], icon: 'fa-shirt', iconSet: 'fa-solid', bg: 'bg-pink-500/10', color: 'text-pink-400', dynamicPricing: true },
    // NOT: Letgo için admin fiyat belirtmedi - 250 TL geçici/varsayılan fiyat olarak ayarlandı, admin panelden değiştirilebilir.
    { id: 'letgo_tr', key: 'tr', name: 'Letgo Türkiye', defCountry: '62', price: 250, serviceHints: ['letgo'], guessCodes: [], icon: 'fa-tag', iconSet: 'fa-solid', bg: 'bg-orange-500/10', color: 'text-orange-300', dynamicPricing: true },
    { id: 'uber_tr', key: 'tr', name: 'Uber Türkiye', defCountry: '62', price: 200, serviceHints: ['uber'], guessCodes: ['ub'], icon: 'fa-uber', iconSet: 'fa-brands', bg: 'bg-slate-500/10', color: 'text-slate-200', dynamicPricing: true },
    { id: 'paycell_tr', key: 'tr', name: 'Paycell Türkiye', defCountry: '62', price: 250, serviceHints: ['paycell'], guessCodes: [], icon: 'fa-credit-card', iconSet: 'fa-solid', bg: 'bg-amber-500/10', color: 'text-amber-300', dynamicPricing: true },
    { id: 'trendyolgo_tr', key: 'tr', name: 'Trendyol Go', defCountry: '62', price: 250, serviceHints: ['trendyol go', 'trendyolgo'], guessCodes: [], icon: 'fa-motorcycle', iconSet: 'fa-solid', bg: 'bg-orange-500/10', color: 'text-orange-400', dynamicPricing: true },
    { id: 'paypal_tr', key: 'tr', name: 'PayPal Türkiye', defCountry: '62', price: 250, serviceHints: ['paypal'], guessCodes: ['mt', 'pp'], icon: 'fa-paypal', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-300', dynamicPricing: true },
    { id: 'trendyol_tr', key: 'tr', name: 'Trendyol', defCountry: '62', price: 200, serviceHints: ['trendyol'], guessCodes: [], icon: 'fa-bag-shopping', iconSet: 'fa-solid', bg: 'bg-orange-500/10', color: 'text-orange-400', dynamicPricing: true },
    { id: 'ds_tr', key: 'tr', name: 'Discord Türkiye', defCountry: '62', price: 100, serviceHints: ['discord'], guessCodes: ['ds', 'dc'], icon: 'fa-discord', iconSet: 'fa-brands', bg: 'bg-indigo-500/10', color: 'text-indigo-400', dynamicPricing: true },
    { id: 'ap_tr', key: 'tr', name: 'Apple Türkiye', defCountry: '62', price: 200, serviceHints: ['apple', 'icloud'], guessCodes: ['mz', 'ap'], icon: 'fa-apple', iconSet: 'fa-brands', bg: 'bg-slate-500/10', color: 'text-slate-300', dynamicPricing: true }
];
// Admin panelden elle eklenmiş ürünler (disk'ten yüklendi) - sunucu her yeniden başladığında CATALOG'a geri eklenir,
// böylece admin'in eklediği ürünler bir Render yeniden başlatmasıyla kaybolmaz.
(db.customCatalog || []).forEach(p => { if (p && p.id && !CATALOG.some(c => c.id === p.id)) CATALOG.push(p); });
const SERVICE_INFO = {
    wa: { name: 'WhatsApp', icon: 'fa-whatsapp', bg: 'bg-violet-500/10', color: 'text-violet-400' },
    tg: { name: 'Telegram', icon: 'fa-telegram', bg: 'bg-blue-500/10', color: 'text-blue-400' }
};

// ====== SMM KATALOĞU (Instagram takipçi/beğeni vb.) ======
// 2026-11-01: Admin isteğiyle TikTok/Instagram hizmetleri panelden tamamen kaldırıldı - panelde sadece
// sms.tc'den çekilen numaralar (CATALOG) satılıyor. Dizi boş bırakıldı, ona bağlı tüm uç noktalar/arayüz
// otomatik olarak boş/gizli davranıyor (kod güvenliği için silinmedi, sadece devre dışı).
const SMM_CATALOG = [];

// ====== ELDEN SATIŞ KATALOĞU (Instagram/TikTok/Telegram takipçi-beğeni-abone) ======
// 2026-11-01: Admin isteğiyle kaldırıldı - panelde sadece sms.tc numaraları satılıyor.
const MANUAL_SOCIAL_CATALOG = [];

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
// key -> isim eşleştirme ipuçları (kelime bazlı, ör. "turkey" "united states" gibi çok kelimeli ifadeler de dahil).
// Yeni bir ülke eklemek için sadece burada bir satır eklemek yeterli - CATALOG'daki item.key otomatik keşfedilir,
// resolveCountries() artık CATALOG'u tarayıp hangi key'lerin gerektiğini kendisi bulur (aşağıdaki KEY_HINTS listesi).
const KEY_HINTS = {
    tr: ['turkey', 'turkiye', 'турци', 'turkiye cumhuriyeti'],
    ph: ['philippines', 'филиппин', 'filipin'],
    us: ['usa', 'united states', 'сша', 'amerika birlesik'],
    co: ['colombia', 'kolombiya', 'колумби'],
    gb: ['united kingdom', 'britain', 'ingiltere', 'англ', 'great britain'],
    sg: ['singapore', 'singapur', 'сингапур'],
    sy: ['syria', 'suriye', 'сирия']
};
function nameHas(key, n) {
    const t = normTr(n);
    const hints = KEY_HINTS[key];
    if (!hints) return false;
    return hints.some(h => h.includes(' ') ? t.includes(h) : new RegExp('\\b' + h + '\\b').test(t));
}

// ====== Sağlayıcıdan ülke ID'lerini otomatik bul (isme göre - 1 saatte bir yenile) ======
// NOT: aranacak key listesi CATALOG'daki ürünlerin kullandığı tüm "key" değerlerinden otomatik çıkarılır,
// böylece yeni bir ülke/ürün eklenince burayı elle güncellemeye gerek kalmaz.
let countryCache = { time: 0, map: {}, all: {} };
async function resolveCountries() {
    if (countryCache.time && Date.now() - countryCache.time < 3600000) return countryCache;
    const map = {};
    const wantedKeys = Array.from(new Set(CATALOG.map(c => c.key).filter(Boolean).concat(Object.keys(KEY_HINTS))));
    const all = {};
    wantedKeys.forEach(k => { all[k] = []; });
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
    if (cached && Date.now() - cached.time < 300000) return cached.data;
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
    if (item.randomPool && item.randomPool.length) {
        // "Anonim/Rastgele" ürünler: tek bir key'e değil, bir ÜLKE HAVUZUNA bağlı - havuzdaki her ülkenin
        // bilinen tüm aday ID'leri birleştirilir, aşağıdaki ucuz-önce sıralaması en iyisini otomatik seçer.
        item.randomPool.forEach(k => {
            const p = map[k]; if (p && !nameList.includes(p)) nameList.push(p);
            (all[k] || []).forEach(id => { if (!nameList.includes(id)) nameList.push(id); });
        });
        if (item.defCountry && !nameList.includes(item.defCountry)) nameList.push(item.defCountry);
    } else {
        const primary = map[item.key] || item.defCountry;
        nameList.push(primary);
        (all[item.key] || []).forEach(id => { if (!nameList.includes(id)) nameList.push(id); });
        (item.alt || []).forEach(id => { if (!nameList.includes(id)) nameList.push(id); });
        if (!nameList.includes(item.defCountry)) nameList.push(item.defCountry);
    }

    const prices = await fetchServicePrices(serviceCode || item.serviceCode);
    // Önce en UCUZ maliyetli adayı dene (kâr marjını korumak için pahalı seçenek asla önce denenmez),
    // eşit maliyette stoğu yüksek olan öne alınır.
    const withStock = nameList.filter(id => prices[id] && prices[id].count > 0)
        .sort((a, b) => (prices[a].cost - prices[b].cost) || (prices[b].count - prices[a].count));
    const withoutInfo = nameList.filter(id => !prices[id]);
    const noStock = nameList.filter(id => prices[id] && prices[id].count === 0);
    // Öncelik: stoğu bilinen > bilgi yok (sağlayıcı yanıt vermediyse eski sıralama) > stoğu 0 görünen (yine de son çare dene, anlık değişebilir)
    const ordered = [...withStock, ...withoutInfo, ...noStock];
    return ordered.length ? ordered : nameList;
}

// ====== "DİĞER SMS PLATFORMLARI": sağlayıcıda Türkiye için mevcut TÜM servisler (Trendyol vb. dahil) ======
// Elle seçilmiş CATALOG'un aksine burası sağlayıcının o ülke için sunduğu HER servisi otomatik listeler;
// satış fiyatı = sağlayıcı maliyeti * kâr çarpanı (db.otherPlatformsMarkup, admin panelden ayarlanır).
let countryPriceCache = {}; // countryId -> { time, data: { serviceCode: {cost,count} } }
async function fetchPricesForCountry(countryId) {
    const cached = countryPriceCache[countryId];
    if (cached && Date.now() - cached.time < 300000) return cached.data;
    const out = {};
    try {
        const r = await providerGet({ action: 'getPrices', country: countryId }, 20000);
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        let svcMap = null;
        if (d && typeof d === 'object') {
            if (d[countryId] && typeof d[countryId] === 'object') svcMap = d[countryId];
            else if (Object.keys(d).length === 1) svcMap = d[Object.keys(d)[0]];
            else svcMap = d; // bazı sağlayıcılar tek ülke istenince doğrudan {servis:{cost,count}} döner
        }
        if (svcMap && typeof svcMap === 'object') {
            for (const code in svcMap) {
                const svc = svcMap[code];
                if (svc && typeof svc === 'object') {
                    const cost = svc.cost !== undefined ? svc.cost : (svc.price !== undefined ? svc.price : 0);
                    const count = svc.count !== undefined ? svc.count : (svc.quant !== undefined ? svc.quant : (svc.quantity !== undefined ? svc.quantity : 0));
                    out[code] = { cost: Number(cost) || 0, count: Number(count) || 0 };
                }
            }
        }
        console.log('[fetchPricesForCountry] ülke ' + countryId + ' -> ' + Object.keys(out).length + ' servis bulundu');
    } catch (e) { console.error('[fetchPricesForCountry] hata:', e.message); }
    countryPriceCache[countryId] = { time: Date.now(), data: out };
    return out;
}
// Maliyetten satış fiyatı: çarpanla çarpılır, 10 TL'ye yuvarlanır, en az +20 TL kâr garantilenir.
function computeOtherPrice(costUsd) {
    const rate = db.usdTryRate || 42;
    const mult = (db.otherPlatformsMarkup && db.otherPlatformsMarkup.multiplier) || 1.8;
    const costTry = costUsd * rate;
    let price = Math.ceil((costTry * mult) / 10) * 10;
    if (price < costTry + 20) price = Math.ceil((costTry + 20) / 10) * 10;
    return price;
}
// Ana kataloğun (WhatsApp TR, Telegram TR vb.) satış fiyatını canlı sağlayıcı maliyetinden hesaplar.
// Stok yoksa / fiyat alınamazsa null döner - çağıran yer bu durumda eski (son bilinen) fiyatı korur.
async function getLiveSalePrice(item) {
    try {
        const serviceCode = await resolveServiceCode(item);
        const candidates = await countryCandidates(item, serviceCode);
        const prices = await fetchServicePrices(serviceCode);
        const best = candidates.find(c => prices[c] && prices[c].count > 0);
        if (!best) return null;
        return computeOtherPrice(prices[best].cost);
    } catch (e) { return null; }
}
// CATALOG'daki "dynamicPricing" işaretli ürünlerin fiyatını arka planda periyodik tazeler - böylece
// hiçbir müşteri isteği canlı sağlayıcı sorgusunu BEKLEMEZ, her zaman son hesaplanan fiyat anında sunulur.
let catalogPriceRefreshing = false;
async function refreshDynamicCatalogPrices() {
    if (catalogPriceRefreshing) return;
    catalogPriceRefreshing = true;
    try {
        for (const item of CATALOG) {
            if (!item.dynamicPricing) continue;
            const live = await getLiveSalePrice(item);
            if (live) item.price = live;
        }
    } finally { catalogPriceRefreshing = false; }
}
app.get('/api/getOtherServices', async (req, res) => {
    try {
        const { map } = await resolveCountries();
        const trId = map['tr'] || '62';
        const { byCode } = await resolveServicesList();
        const prices = await fetchPricesForCountry(trId);
        const excluded = new Set((await Promise.all(CATALOG.map(it => resolveServiceCode(it)))).filter(Boolean));
        const list = [];
        for (const code in prices) {
            if (excluded.has(code)) continue;
            const info = prices[code];
            if (!info || !info.cost) continue;
            list.push({ code, name: byCode[code] || code, price: computeOtherPrice(info.cost), inStock: info.count > 0 });
        }
        list.sort((a, b) => (b.inStock - a.inStock) || a.name.localeCompare(b.name));
        res.json({ success: true, services: list });
    } catch (e) {
        res.json({ success: false, message: 'Diğer platformlar yüklenemedi: ' + e.message });
    }
});
app.post('/api/buyOtherService', async (req, res) => {
    const { username, code } = req.body;
    const userObj = db.users[username];
    if (!userObj) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
    if (userObj.banned) return res.json({ success: false, message: "Hesabınız yasaklandı, satın alma yapamazsınız." });
    if (!code) return res.json({ success: false, message: "Geçersiz servis." });
    try {
        const { map } = await resolveCountries();
        const trId = map['tr'] || '62';
        const prices = await fetchPricesForCountry(trId);
        const info = prices[code];
        if (!info) return res.json({ success: false, message: "Bu servis şu an bulunamadı, listeyi yenileyip tekrar deneyin." });
        const price = computeOtherPrice(info.cost);
        if (userObj.balance < price) return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin.", insufficientBalance: true });
        const { byCode } = await resolveServicesList();
        const name = byCode[code] || code;

        let responseText = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            const resp = await providerGet({ action: 'getNumber', service: code, country: trId }, 30000);
            responseText = resp.data;
            if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
            responseText = responseText ? String(responseText).trim() : '';
            if (responseText.startsWith('ACCESS_NUMBER')) break;
            if (responseText.startsWith('NO_NUMBERS') && attempt === 0) { await new Promise(r => setTimeout(r, 1200)); continue; }
            break;
        }
        if (responseText.startsWith('ACCESS_NUMBER')) {
            const parts = responseText.split(':');
            const activationId = parts[1];
            const phoneNumber = parts.slice(2).join(':');
            userObj.balance -= price;
            const order = {
                activationId, productName: name + ' (Diğer Platform)', price, phoneNumber,
                code: "Bekleniyor...", status: 'waiting', username,
                time: new Date().toLocaleString('tr-TR'), createdAt: Date.now()
            };
            db.orders[activationId] = order;
            persist();
            return res.json({ success: true, order });
        }
        const key = responseText.split(':')[0];
        const msg = PROVIDER_ERRORS[key] || 'Şu an numara alınamıyor, lütfen daha sonra tekrar deneyin.';
        res.json({ success: false, message: msg, retryable: key === 'NO_NUMBERS' });
    } catch (e) {
        res.json({ success: false, message: "Bağlantı hatası, lütfen tekrar deneyin." });
    }
});
// Admin'in "Diğer Platformlar" kâr çarpanını ayarlaması (örn. maliyet 200 TL ise 1.8x -> 360 TL gibi)
app.post('/api/admin/setOtherPlatformsMarkup', (req, res) => {
    const { adminToken, multiplier } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    const m = Number(multiplier);
    if (isNaN(m) || m <= 1) return res.json({ success: false, message: "Geçerli bir çarpan gir (örn: 1.8 veya 2)." });
    db.otherPlatformsMarkup = { multiplier: m };
    persist();
    res.json({ success: true, message: "Kâr çarpanı güncellendi: " + m + "x" });
});

// ====== SERVİS LİSTESİ (sabit katalog, stok yazısı yok) ======
app.get('/api/getServices', (req, res) => {
    const list = CATALOG.map(item => {
        const meta = (item.icon ? item : SERVICE_INFO[item.serviceCode]) || {};
        // "group" ve "country" sadece arayüzdeki kategori sekmeleri/ülke etiketleri içindir (filtreleme amaçlı) -
        // satın alma mantığını etkilemez, o yine serviceCode/key üzerinden çalışır.
        let group = 'other';
        if (item.serviceCode === 'wa') group = 'wa';
        else if (item.serviceCode === 'tg') group = 'tg';
        else if (item.id.indexOf('ds_') === 0) group = 'ds';
        const country = item.randomPool ? 'random' : (item.key || null);
        return { id: item.id, name: item.name, price: item.price, icon: meta.icon || 'fa-circle', iconSet: meta.iconSet || 'fa-solid', bg: meta.bg || 'bg-violet-500/10', color: meta.color || 'text-violet-400', featured: !!item.featured, group, country };
    });
    res.json({ success: true, services: list });
});

// Sadece admin panelden serviceId + fiyat ayarlanmış SMM ürünleri müşteriye görünür (ayarlanmamışsa listeye girmez)
app.get('/api/getSmmServices', (req, res) => {
    const list = SMM_CATALOG.filter(item => db.smmConfig[item.id] && db.smmConfig[item.id].serviceId && db.smmConfig[item.id].pricePerThousand)
        .map(item => {
            const cfg = db.smmConfig[item.id];
            return { id: item.id, name: item.name, icon: item.icon, iconSet: item.iconSet, bg: item.bg, color: item.color, linkLabel: item.linkLabel, pricePerThousand: cfg.pricePerThousand, min: cfg.min || 100, max: cfg.max || 10000 };
        });
    res.json({ success: true, services: list });
});

// Elden satış fiyat listesi - sadece gösterim, satın alma linki Telegram'a (admine) gider.
app.get('/api/getManualServices', (req, res) => {
    res.json({ success: true, categories: MANUAL_SOCIAL_CATALOG, whatsapp: ADMIN_WHATSAPP });
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

    // ====== Admin hesabına kaba kuvvet (brute-force) koruması ======
    // Birisi admin şifresini tahmin etmeye çalışıyorsa (çok sayıda yanlış deneme), o IP geçici olarak kilitlenir
    // ve admin'e Telegram'dan anında haber verilir. Admin kullanıcı adını hedef almayan denemeler etkilenmez.
    const isAdminAttempt = username === ADMIN_USERNAME;
    if (isAdminAttempt) {
        const lock = adminLoginAttempts[ip];
        if (lock && lock.count >= ADMIN_LOGIN_MAX_ATTEMPTS && (Date.now() - lock.lastAttempt) < ADMIN_LOGIN_LOCKOUT_MS) {
            const waitMin = Math.ceil((ADMIN_LOGIN_LOCKOUT_MS - (Date.now() - lock.lastAttempt)) / 60000);
            return res.json({ success: false, message: "Çok fazla hatalı deneme. Lütfen " + waitMin + " dakika sonra tekrar deneyin." });
        }
    }

    if (db.users[username] && db.users[username].password === password) {
        if (db.users[username].banned) {
            return res.json({ success: false, message: "Hesabınız yasaklandı. Destek ile iletişime geçin." });
        }
        if (isAdminAttempt) {
            delete adminLoginAttempts[ip];
            notifyAdminLoginEvent('✅ Admin paneline giriş yapıldı.\nIP: ' + ip + '\nZaman: ' + new Date().toLocaleString('tr-TR'), true);
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
        if (isAdminAttempt) {
            const lock = adminLoginAttempts[ip] || { count: 0 };
            lock.count += 1;
            lock.lastAttempt = Date.now();
            adminLoginAttempts[ip] = lock;
            notifyAdminLoginEvent('🚨 Admin paneline HATALI giriş denemesi (' + lock.count + '. deneme)!\nDenenen kullanıcı adı: ' + username + '\nIP: ' + ip + '\nZaman: ' + new Date().toLocaleString('tr-TR') + (lock.count >= ADMIN_LOGIN_MAX_ATTEMPTS ? '\n⛔ Bu IP ' + Math.round(ADMIN_LOGIN_LOCKOUT_MS / 60000) + ' dakika kilitlendi.' : ''), lock.count >= ADMIN_LOGIN_MAX_ATTEMPTS);
        }
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
    // Onayla/Reddet butonları sadece Telegram'da çalışır (WhatsApp'ta etkileşimli buton yok) - WhatsApp
    // bildirimi sadece haber amaçlı düz metin olarak gider, onay yine panelden veya Telegram'dan yapılır.
    notifyAdminWhatsapp(`💰 Yeni ödeme bildirimi!\nKullanıcı: ${username}\nGönderen: ${senderName}\nTutar: ${amount} TL\nOnaylamak için panele veya Telegram'a bak.`);

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
    const catalogList = CATALOG.map(c => ({ id: c.id, name: c.name, price: c.price, manual: !!c.manual }));
    const visitorList = db.visitors.slice(0, 100);
    const smmOrders = Object.values(db.smmOrders).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
    const smmConfig = SMM_CATALOG.map(c => Object.assign({ id: c.id, name: c.name }, db.smmConfig[c.id] || {}));

    res.json({ success: true, users, payments, logins, orders, supportChats, visitors: db.visitors.length, visitorList, catalog: catalogList, smmOrders, smmConfig, otherPlatformsMarkup: (db.otherPlatformsMarkup && db.otherPlatformsMarkup.multiplier) || 1.8 });
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

// ====== ADMIN: ürün kataloğuna elle yeni ürün ekle ======
// Sağlayıcı API'sinde sorun olsa bile admin panelden manuel olarak yeni bir numara ürünü tanımlanabilir.
// "key" alanı resolveCountries() tarafından isimle ülke bulma için kullanılır (KEY_HINTS listesinde yoksa
// sadece defCountry'ye güvenilir) - admin isterse hem key hem defCountry hem de doğrudan serviceCode girebilir.
app.post('/api/admin/addProduct', (req, res) => {
    const { adminToken, name, price, key, defCountry, serviceCode, serviceHints, guessCodes, icon } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    if (!name || !String(name).trim()) return res.json({ success: false, message: "Ürün adı gerekli." });
    const p = Number(price);
    if (isNaN(p) || p <= 0) return res.json({ success: false, message: "Geçerli bir fiyat gir." });
    if (!defCountry || !String(defCountry).trim()) return res.json({ success: false, message: "Varsayılan ülke ID'si gerekli (örn. Türkiye için 62)." });

    const slug = String(name).toLowerCase()
        .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    let id = (slug || 'urun') + '_' + Date.now().toString(36);
    const item = {
        id, name: String(name).trim(), price: p,
        key: key && String(key).trim() ? String(key).trim() : undefined,
        defCountry: String(defCountry).trim(),
        serviceCode: serviceCode && String(serviceCode).trim() ? String(serviceCode).trim() : undefined,
        serviceHints: serviceHints ? String(serviceHints).split(',').map(s => s.trim()).filter(Boolean) : undefined,
        guessCodes: guessCodes ? String(guessCodes).split(',').map(s => s.trim()).filter(Boolean) : undefined,
        icon: (icon && String(icon).trim()) || 'fa-sim-card', iconSet: 'fa-solid',
        bg: 'bg-violet-500/10', color: 'text-violet-400', manual: true
    };
    Object.keys(item).forEach(k => item[k] === undefined && delete item[k]);
    CATALOG.push(item);
    db.customCatalog.push(item);
    persist();
    res.json({ success: true, message: "Ürün eklendi: " + item.name, product: item });
});

// Sadece admin panelden elle eklenmiş (manual:true) ürünler silinebilir - sabit kataloğu korur.
app.post('/api/admin/deleteProduct', (req, res) => {
    const { adminToken, id } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    const idx = CATALOG.findIndex(c => c.id === id && c.manual);
    if (idx === -1) return res.json({ success: false, message: "Bu ürün silinemez (sabit katalog ürünü) ya da bulunamadı." });
    CATALOG.splice(idx, 1);
    db.customCatalog = db.customCatalog.filter(c => c.id !== id);
    persist();
    res.json({ success: true, message: "Ürün silindi." });
});

// ====== ADMIN: bir siparişin SMS kodunu elle gir / tamamlandı olarak işaretle ======
// Sağlayıcı API'sinden kod otomatik gelmediğinde (gecikme, API sorunu vb.) admin kodu elden görüp buradan girebilir.
app.post('/api/admin/setOrderCode', (req, res) => {
    const { adminToken, activationId, code } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    const order = db.orders[activationId];
    if (!order) return res.json({ success: false, message: "Sipariş bulunamadı." });
    if (!code || !String(code).trim()) return res.json({ success: false, message: "Kod boş olamaz." });
    order.code = String(code).trim();
    order.status = 'completed';
    persist();
    res.json({ success: true, message: "Sipariş " + activationId + " için kod elle girildi ve tamamlandı olarak işaretlendi." });
});

// ====== ADMIN: tamamen elle (sağlayıcıya hiç gitmeden) bir sipariş/numara oluştur ======
// Sağlayıcı tamamen çöktüğünde bile admin, başka bir kaynaktan temin ettiği bir numarayı müşteriye
// panel üzerinden "satın alınmış" gibi teslim edebilir - kullanıcının bakiyesinden ürün fiyatı düşülür.
app.post('/api/admin/manualOrder', (req, res) => {
    const { adminToken, username, productName, phoneNumber, code, price } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    if (!username || !db.users[username]) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
    if (!phoneNumber || !String(phoneNumber).trim()) return res.json({ success: false, message: "Telefon numarası gerekli." });
    const p = Number(price) || 0;
    if (p > 0 && db.users[username].balance < p) return res.json({ success: false, message: "Kullanıcının bakiyesi yetersiz." });
    const activationId = 'manual_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    if (p > 0) db.users[username].balance -= p;
    const order = {
        activationId, productName: (productName && String(productName).trim()) || 'Elle Eklenen Numara', price: p,
        phoneNumber: String(phoneNumber).trim(),
        code: (code && String(code).trim()) || 'Bekleniyor...', status: (code && String(code).trim()) ? 'completed' : 'waiting',
        username, time: new Date().toLocaleString('tr-TR'), createdAt: Date.now(), manual: true
    };
    db.orders[activationId] = order;
    persist();
    res.json({ success: true, message: "Sipariş elle oluşturuldu.", order });
});

// ====== SMM (Instagram vb.) ADMIN AYARLARI ======
// Admin'in bir SMM ürününe (ig_followers, ig_likes) sağlayıcı service ID'si ve satış fiyatını atamasını sağlar.
app.post('/api/admin/setSmmConfig', (req, res) => {
    const { adminToken, itemId, serviceId, pricePerThousand, min, max } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    const item = SMM_CATALOG.find(c => c.id === itemId);
    if (!item) return res.json({ success: false, message: "Ürün bulunamadı." });
    const price = Number(pricePerThousand);
    if (!serviceId || !String(serviceId).trim()) return res.json({ success: false, message: "Service ID gerekli." });
    if (!price || price <= 0) return res.json({ success: false, message: "Geçerli bir fiyat gir (1000 adet için TL)." });
    db.smmConfig[itemId] = {
        serviceId: String(serviceId).trim(),
        pricePerThousand: price,
        min: Number(min) || 100,
        max: Number(max) || 10000
    };
    persist();
    res.json({ success: true, message: item.name + " ayarlandı. Artık müşterilere görünür.", config: db.smmConfig[itemId] });
});

// Admin'in sağlayıcının CANLI servis listesinde arama yapıp doğru service ID'yi bulmasını sağlar
// (örn. "instagram takip" yazınca sadece eşleşen servisleri döner - tüm liste binlerce satır olabiliyor).
app.get('/api/admin/smmLiveServices', async (req, res) => {
    if (!checkAdminToken(req.query.adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    if (!SMM_API_KEY) return res.json({ success: false, message: "SMM_API_KEY ayarlanmamış (Render > Environment)." });
    try {
        const resp = await smmPost({ action: 'services' }, 25000);
        const all = Array.isArray(resp.data) ? resp.data : [];
        const q = (req.query.q || '').toLowerCase();
        const filtered = (q ? all.filter(s => (String(s.name || '') + ' ' + String(s.category || '')).toLowerCase().includes(q)) : all).slice(0, 60);
        res.json({ success: true, count: all.length, list: filtered.map(s => ({ service: s.service, name: s.name, category: s.category, rate: s.rate, min: s.min, max: s.max })) });
    } catch (e) {
        res.json({ success: false, message: "Sağlayıcı bağlantı hatası: " + e.message });
    }
});

// Belirli bir SMM siparişinin güncel durumunu sağlayıcıdan çeker (admin panelden elle yenilenir)
app.get('/api/admin/smmOrderStatus', async (req, res) => {
    if (!checkAdminToken(req.query.adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    const order = db.smmOrders[req.query.orderId];
    if (!order) return res.json({ success: false, message: "Sipariş bulunamadı." });
    try {
        const resp = await smmPost({ action: 'status', order: order.providerOrderId }, 20000);
        const d = resp.data || {};
        if (d.status) { order.status = d.status; persist(); }
        res.json({ success: true, status: d.status || order.status, remains: d.remains, start_count: d.start_count, charge: d.charge });
    } catch (e) {
        res.json({ success: false, message: "Sağlayıcı bağlantı hatası: " + e.message });
    }
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
// Admin girişi (başarılı veya hatalı deneme) Telegram'dan anında bildirilir - kilitlenme/başarı mesajları
// hep gönderilir, ardı ardına gelen hatalı deneme spam'ını önlemek için sadece sıradan hatalı denemeler kısılır.
let lastAdminLoginAlert = 0;
async function notifyAdminLoginEvent(text, important) {
    if (!important && Date.now() - lastAdminLoginAlert < 4000) return;
    lastAdminLoginAlert = Date.now();
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
    if (userObj.balance < price) return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin.", insufficientBalance: true });

    const showDetail = userObj.role === 'admin';

    try {
        const serviceCode = await resolveServiceCode(item);
        let responseText = '';
        let usedCountry = null;
        let allRaw = [];
        let sawNoBalance = false;

        const ATTEMPTS_PER_COUNTRY = 2; // adaylar artık canlı stoğa göre sıralı, gereksiz yere aynı ülkede bekletmeye gerek yok
        // "havuzda stok yok" hatasının en sık kökeni önbellekteki (45sn/1sa) fiyat-stok bilgisinin bayatlamış
        // olması: sağlayıcı az önce stok eklemiş/azaltmış olabilir ama biz hâlâ eski veriyi kullanıyor oluruz.
        // Bu yüzden 2 geçiş yapıyoruz: 1) normal (önbellekli) aday listesiyle dene, 2) hepsi NO_NUMBERS ise
        // önbelleği zorla temizleyip GERÇEK canlı veriyle bir kez daha dene, sonra teslim ol.
        for (let pass = 0; pass < 2; pass++) {
            if (pass === 1) {
                delete priceCache[serviceCode];
                countryCache.time = 0;
            }
            // Adaylar zaten stoğa göre en iyiden en kötüye sıralı; hepsini denemek (özellikle sağlayıcı
            // yavaşsa/sınırlıyorsa) kullanıcıyı çok uzun bekletir. İlk 6 adayla sınırlıyoruz.
            const candidates = (await countryCandidates(item, serviceCode)).slice(0, 6);
            let gotAccess = false;
            outer:
            for (const country of candidates) {
                usedCountry = country;
                for (let attempt = 0; attempt < ATTEMPTS_PER_COUNTRY; attempt++) {
                    const resp = await providerGet({ action: 'getNumber', service: serviceCode, country: country }, 30000);
                    responseText = resp.data;
                    if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
                    responseText = responseText ? String(responseText).trim() : '';
                    allRaw.push(country + ':' + responseText);
                    console.log('[getNumber] ' + item.id + ' pass=' + pass + ' country=' + country + ' deneme=' + (attempt + 1) + ' -> "' + responseText + '"');

                    if (responseText.startsWith('ACCESS_NUMBER')) { gotAccess = true; break outer; }
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
                if (responseText.startsWith('ACCESS_NUMBER')) { gotAccess = true; break; }
            }
            if (gotAccess) break;
            // NO_NUMBERS dışında bir hatayla (NO_BALANCE, anahtar hatası vs.) çıkıldıysa tazelenmiş önbellekle
            // tekrar denemenin faydası yok, ikinci geçişi atla.
            if (!responseText.startsWith('NO_NUMBERS') && pass === 0) break;
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
                balanceDiag = 'Gerçek sağlayıcı bakiyesi (USD): ' + balText + ' | Bu numaranın maliyeti (USD): ' + costInfo + '. NOT: Bu, panel içindeki TL bakiyenden FARKLI bir şey - sms.tc hesabına gerçek USD yüklenmesi gerekiyor.';
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

// ====== SMM SİPARİŞ (Instagram takipçi/beğeni vb.) ======
app.post('/api/buySmm', async (req, res) => {
    const { productId, username, link, quantity } = req.body;
    const userObj = db.users[username];
    if (!userObj) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
    if (userObj.banned) return res.json({ success: false, message: "Hesabınız yasaklandı, satın alma yapamazsınız." });

    const item = SMM_CATALOG.find(c => c.id === productId);
    const cfg = item && db.smmConfig[productId];
    if (!item || !cfg || !cfg.serviceId || !cfg.pricePerThousand) return res.json({ success: false, message: "Geçersiz ürün." });

    const qty = parseInt(quantity, 10);
    const min = cfg.min || 100, max = cfg.max || 10000;
    if (!link || !String(link).trim()) return res.json({ success: false, message: "Lütfen link girin." });
    if (!qty || qty < min || qty > max) return res.json({ success: false, message: "Miktar " + min + " ile " + max + " arasında olmalı." });

    const price = Math.round((cfg.pricePerThousand / 1000) * qty * 100) / 100;
    if (userObj.balance < price) return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin.", insufficientBalance: true });

    try {
        const resp = await smmPost({ action: 'add', service: cfg.serviceId, link: String(link).trim(), quantity: qty }, 20000);
        const data = resp.data;
        if (!data || data.error || !data.order) {
            const errMsg = (data && data.error) ? data.error : 'Sağlayıcı siparişi reddetti.';
            return res.json({ success: false, message: userObj.role === 'admin' ? ("Sağlayıcı hatası: " + errMsg) : "Şu an bu hizmet alınamıyor, lütfen daha sonra tekrar deneyin." });
        }
        userObj.balance -= price;
        const orderId = 'smm_' + Date.now();
        db.smmOrders[orderId] = {
            id: orderId, username, itemId: productId, itemName: item.name, link: String(link).trim(), quantity: qty,
            price, providerOrderId: data.order, status: 'İşleme Alındı',
            time: new Date().toLocaleString('tr-TR'), createdAt: Date.now()
        };
        persist();
        res.json({ success: true, message: item.name + " siparişi alındı. Sipariş sağlayıcıya iletildi.", order: db.smmOrders[orderId] });
    } catch (error) {
        console.error("SMM API hatası:", error.message);
        res.json({ success: false, message: userObj.role === 'admin' ? ("SMM sağlayıcı bağlantı hatası: " + error.message) : "Bağlantı hatası, lütfen tekrar deneyin." });
    }
});

app.get('/api/mySmmOrders', (req, res) => {
    const { username } = req.query;
    if (!db.users[username]) return res.json({ success: false, orders: [] });
    const list = Object.values(db.smmOrders).filter(o => o.username === username).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
    res.json({ success: true, orders: list });
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

// ====== TÜM SİPARİŞ GEÇMİŞİ (müşteri panelindeki "Siparişlerim" sekmesi için) ======
// /api/myOrders yukarıdaki sadece son birkaç dakikalık aktif siparişleri döndürüyor (canlı sayaç yeniden
// bağlanması içindi). Bu uç nokta ise süre sınırı olmadan kullanıcının TÜM geçmiş siparişlerini döndürür.
app.get('/api/myAllOrders', (req, res) => {
    const { username } = req.query;
    if (!db.users[username]) return res.json({ success: false, orders: [] });
    const list = Object.values(db.orders)
        .filter(o => o.username === username)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .map(o => ({
            activationId: o.activationId, phoneNumber: o.phoneNumber, productName: o.productName,
            status: o.status, code: o.code, price: o.price, time: o.time
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
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
            /* ====== ANKA SMS - TASARIM SİSTEMİ (2026-11-04 baştan tasarlandı) ======
               Önceki "VIP/mor-neon anka kuşu" teması kalabalık ve şablon gibi görünüyordu - admin'in isteğiyle
               sade, hızlı, kendine özgü bir arayüze geçildi. Tek bir vurgu rengi (sinyal amber) + nötr koyu
               zemin; animasyon sadece anlamlı anlarda (satın alma onayı, bildirimler) kullanılıyor. */
            :root {
                --bg: #0B0E13; --surface: #141921; --surface-2: #1B212B; --border: #262D38;
                --text: #EEF1F5; --text-muted: #8B93A3; --accent: #E8A33D; --accent-ink: #1A1206;
                --success: #3DBD82; --danger: #E2574C;
            }
            * { box-sizing: border-box; }
            body { background: var(--bg); color: var(--text); font-family: 'Manrope', sans-serif; -webkit-font-smoothing: antialiased; }
            h1, h2, h3, .anka, .font-black, button { font-family: 'Space Grotesk', sans-serif; }
            ::selection { background: var(--accent); color: var(--accent-ink); }
            a { color: inherit; }
            .anka { color: var(--text); letter-spacing: -.01em; }
            .glassCard { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; }
            .fadeUp { animation: fadeUp .5s cubic-bezier(.16,.84,.44,1) both; }
            @keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
            .blink { animation: blink 1.1s steps(2) infinite; }
            @keyframes blink { 50% { opacity: 0; } }

            /* ====== Ürün kartları: sade, durgun; sadece odaklanınca hafif belirginleşir ====== */
            .prodCard { background: var(--surface); border: 1px solid var(--border); transition: border-color .2s ease, background-color .2s ease; }
            .prodCard:hover { border-color: #3A4354; background: var(--surface-2); }
            .prodIcon { background: var(--surface-2); border: 1px solid var(--border); color: var(--accent); }
            .featuredCard { border-color: rgba(232,163,61,.4) !important; }

            /* ====== Buton/aktif durum stilleri ====== */
            .btnAccent { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
            .btnAccent:hover { background: #F0B25C; }
            .chip { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-muted); white-space: nowrap; transition: border-color .15s ease, color .15s ease; }
            .chip:hover { color: var(--text); }
            .chip.active { background: var(--accent); border-color: var(--accent); color: var(--accent-ink) !important; font-weight: 700; }
            .tabBtn { color: var(--text-muted); border-bottom: 2px solid transparent; }
            .tabBtn.active { color: var(--text) !important; border-bottom-color: var(--accent); }

            /* ====== Işık geçişli butonlar (korundu, ama sade) ====== */
            .shineBtn { position: relative; overflow: hidden; }
            .shineBtn::after { content: ''; position: absolute; top: 0; left: -60%; width: 40%; height: 100%; background: linear-gradient(115deg,transparent,rgba(255,255,255,.18),transparent); transform: skewX(-20deg); transition: left .5s ease; }
            .shineBtn:hover::after { left: 130%; }

            /* ====== Aktif numara kartı: satın alma sonrası net görünürlük, tek seferlik vurgulama ====== */
            #activeOrderWrap { position: relative; }
            #activeOrderWrap.hasOrders #activeOrderHeading { display: flex; }
            .orderFlashCard { animation: orderGlow 1.4s ease-out 1; }
            @keyframes orderGlow {
                0% { box-shadow: 0 0 0 0 rgba(232,163,61,.5); border-color: var(--accent) !important; }
                100% { box-shadow: 0 0 0 0 rgba(232,163,61,0); }
            }
            #toastStack { position: fixed; top: 16px; right: 16px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; pointer-events: none; max-width: 92vw; }
            .appToast { pointer-events: auto; background: var(--surface-2); border: 1px solid var(--border); border-left: 3px solid var(--accent); color: var(--text); padding: 13px 16px; border-radius: 12px; font-size: .88rem; font-weight: 600; display: flex; align-items: center; gap: 10px; animation: toastIn .3s ease, toastOut .3s ease 3.6s forwards; max-width: 360px; box-shadow: 0 10px 30px -10px rgba(0,0,0,.5); }
            @keyframes toastIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
            @keyframes toastOut { to { opacity: 0; transform: translateY(-8px); } }
            @media (max-width: 640px) {
                #toastStack { left: 12px; right: 12px; top: 12px; max-width: unset; }
                .appToast { max-width: unset; }
            }

            /* ====== Tailwind'in varsayılan renk paletini tek bir marka diline eşliyoruz ======
               Dosyanın geri kalanında (admin panel dahil) hâlâ Tailwind'in violet/blue/pink vb. sınıfları
               kullanılıyor - her şablon dizesini tek tek değiştirmek yerine, o sınıfları burada yeni tasarım
               diline eşliyoruz. Böylece TEK renk sistemi (amber vurgu + nötr koyu yüzeyler) tüm panelde geçerli
               olur; kart/servis ikonlarındaki mavi/turuncu/pembe gibi ayırt edici renkler bilinçli olarak
               kalıyor (hangi serviste olduğunu ayırt etmeye yarıyor), sadece doygunlukları törpülendi. */
            .bg-violet-500\/10, .bg-violet-500\/15 { background-color: rgba(232,163,61,.12) !important; }
            .bg-violet-500\/20, .bg-violet-600\/20, .bg-violet-900\/30, .hover\:bg-violet-900\/30:hover { background-color: rgba(232,163,61,.18) !important; }
            .bg-violet-600, .bg-violet-500 { background-color: var(--accent) !important; color: var(--accent-ink) !important; }
            .hover\:bg-violet-500:hover, .hover\:bg-violet-600:hover { background-color: #F0B25C !important; }
            .text-violet-300, .text-violet-400, .text-violet-200\/60, .text-violet-200\/70 { color: var(--accent) !important; }
            .text-violet-200\/30, .text-violet-200\/40, .text-violet-300\/60 { color: var(--text-muted) !important; }
            .border-violet-500, .border-violet-500\/15, .border-violet-500\/20, .border-violet-500\/25, .border-violet-500\/30, .border-violet-500\/40 { border-color: var(--border) !important; }
            .focus\:border-violet-500:focus { border-color: var(--accent) !important; }
            .bg-slate-900, .bg-slate-950 { background-color: var(--surface) !important; }
            .bg-black\/40 { background-color: var(--surface-2) !important; }
            .bg-black\/85 { background-color: rgba(8,10,14,.88) !important; }
            header { background: var(--surface); border-color: var(--border) !important; }
            .bg-blue-500\/10 { background-color: rgba(96,165,250,.1) !important; }
            .bg-blue-600 { background-color: #3B6FD6 !important; }
            .hover\:bg-blue-500:hover { background-color: #4D7FE0 !important; }
            .bg-pink-500\/10 { background-color: rgba(232,163,61,.08) !important; }
            .bg-pink-600 { background-color: var(--accent) !important; }
            .hover\:bg-pink-500:hover { background-color: #F0B25C !important; }
            .bg-amber-400 { background-color: var(--accent) !important; }
            .hover\:bg-amber-300:hover { background-color: #F0B25C !important; }
            .text-slate-100, .text-slate-200, .text-slate-300 { color: var(--text) !important; }
            .text-slate-400, .text-slate-500, .text-slate-600 { color: var(--text-muted) !important; }

            /* ====== Mobil ====== */
            @media (max-width: 640px) {
                header { flex-direction: column; align-items: stretch; gap: 12px; padding: 14px; }
                header > div:first-child { justify-content: center; }
                #contactCapsule { order: 3; }
                #userArea { width: 100%; }
                #userArea > div { width: 100%; }
                #userArea .flex { width: 100%; justify-content: center; }
                body { font-size: 15.5px; overflow-x: hidden; }
                .text-\[10px\] { font-size: .76rem !important; }
                .text-xs { font-size: .85rem !important; line-height: 1.3rem !important; }
                .text-sm { font-size: .95rem !important; line-height: 1.4rem !important; }
                button, .shineBtn { min-height: 44px; }
                input, select { font-size: 1rem !important; min-height: 44px; }
                #mainContent h3 { font-size: 1.05rem !important; }
                .prodCard { padding: .9rem !important; gap: 10px; }
                .prodCard h3.truncate { max-width: 38vw; }
                #depositModal .glassCard, #authModal .glassCard { width: 94vw; max-width: 94vw; padding: 1.5rem !important; margin: 0 auto; }
                .catTabs, .countryChips { -webkit-overflow-scrolling: touch; }
            }
            @media (prefers-reduced-motion: reduce) {
                .prodCard, .fadeUp, .shineBtn::after { animation: none !important; transition: none !important; }
            }
        </style>
    </head>
    <body class="text-slate-100 font-sans min-h-screen flex flex-col justify-between">
        <div id="toastStack"></div>

        <div class="max-w-5xl mx-auto w-full p-4 relative z-10">
            <header class="flex justify-between items-center py-3.5 px-5 border border-[var(--border)] mb-6 rounded-2xl">
                <div class="flex items-center gap-3">
                    <div class="bg-violet-500/15 p-2.5 rounded-xl border border-violet-500/40">
                        <i class="fa-solid fa-signal text-lg" style="color:var(--accent)"></i>
                    </div>
                    <div>
                        <h1 class="anka text-xl font-bold tracking-tight inline-block">Anka SMS</h1>
                        <p class="text-[11px] text-violet-300/60">Sanal numara ve SMS doğrulama</p>
                    </div>
                </div>
                <div class="flex items-center gap-2 sm:gap-4 flex-wrap justify-end">
                    <div id="contactCapsule" style="display:flex;align-items:center;gap:6px;background:rgba(232,163,61,.08);border:1px solid rgba(232,163,61,.3);border-radius:999px;padding:5px 10px">
                        <a href="https://wa.me/573181006792" target="_blank" title="WhatsApp Destek" style="color:var(--accent);font-size:15px;line-height:0"><i class="fa-brands fa-whatsapp"></i></a>
                    </div>
                    <div id="userArea" class="flex items-center gap-2 sm:gap-4 flex-wrap justify-end"></div>
                </div>
            </header>
            <main id="mainContent"></main>
            <p style="text-align:center;color:var(--text-muted);opacity:.5;font-size:10px;font-family:monospace;margin-top:30px">sürüm: ${APP_VERSION}</p>
        </div>
</div>

        <div id="authModal" class="fixed inset-0 bg-black/85 flex items-center justify-center hidden z-50" onclick="if(event.target===this) closeAuthModal()">
            <div class="glassCard p-8 rounded-3xl w-full max-w-md relative shadow-2xl" onclick="event.stopPropagation()">
                <button onclick="closeAuthModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white" style="z-index:5"><i class="fa-solid fa-xmark text-xl"></i></button>
                <div class="text-center mb-6"><h2 id="authTitle" class="text-2xl font-black text-white">Giriş Yap</h2></div>
                <div class="space-y-4">
                    <input type="text" id="authUsername" placeholder="Kullanıcı Adı" class="w-full bg-black/40 border border-violet-500/20 rounded-xl p-3 text-white focus:border-violet-500">
                    <input type="password" id="authPassword" placeholder="Şifre" class="w-full bg-black/40 border border-violet-500/20 rounded-xl p-3 text-white focus:border-violet-500">
                    <button onclick="handleAuthSubmit()" id="authSubmitBtn" class="w-full bg-violet-600 hover:bg-violet-500 text-white font-bold py-3 rounded-xl transition">Giriş Yap</button>
                    <p class="text-center text-sm text-slate-400"><span onclick="switchAuthMode()" id="switchText" class="text-violet-400 cursor-pointer underline">Kayıt Ol</span></p>
                </div>
            </div>
        </div>

        <div id="depositModal" class="fixed inset-0 bg-black/85 flex items-center justify-center hidden z-50" onclick="if(event.target===this) closeDeposit()">
            <div class="glassCard p-8 rounded-3xl w-full max-w-md relative shadow-2xl" onclick="event.stopPropagation()">
                <button onclick="closeDeposit()" class="absolute top-4 right-4 text-slate-400 hover:text-white" style="z-index:5"><i class="fa-solid fa-xmark text-xl"></i></button>
                <h2 class="text-xl font-black mb-4 text-violet-400"><i class="fa-solid fa-wallet"></i> Bakiye Yükle (IBAN)</h2>
                <div class="space-y-4 text-sm text-slate-300">
                    <div class="bg-black/40 p-4 rounded-xl border border-violet-500/20">
                        <p class="text-slate-500 text-xs">Banka IBAN:</p>
                        <p class="font-mono text-violet-400 font-bold text-base select-all">TR62 0006 2000 5000 0006 8107 73</p>
                        <p class="text-slate-500 text-xs mt-2">Alıcı:</p>
                        <p class="font-bold text-white text-base">Resul Sakal</p>
                    </div>
                    <input type="text" id="depositSender" placeholder="Gönderen Ad Soyad" class="w-full bg-black/40 border border-violet-500/20 rounded-xl p-3 text-white">
                    <input type="number" id="depositAmount" placeholder="Tutar (TL)" class="w-full bg-black/40 border border-violet-500/20 rounded-xl p-3 text-white">
                    <button onclick="submitDeposit()" class="w-full bg-violet-600 hover:bg-violet-500 text-white font-bold py-3 rounded-xl">Bildirim Gönder</button>
                </div>
            </div>
        </div>


        <script>
            var currentUser = localStorage.getItem('currentUser') || null;
            var currentRole = localStorage.getItem('currentRole') || 'user';
            var adminToken = localStorage.getItem('adminToken') || null;
            var isRegisterMode = false;
            var orderTimers = {};

            function init() {
                updateUserArea();
                if (currentUser) {
                    buildMain();
                    loadServices();
                    loadSmmServices();
                    loadManualServices();
                    restoreOrders();
                    loadRecentOrders();
                }
            }

            function updateUserArea() {
                var area = document.getElementById('userArea');
                if (currentUser) {
                    area.innerHTML =
                        '<div class="flex items-center gap-2 flex-wrap justify-end" style="row-gap:8px">' +
                        '<span class="text-sm font-medium" style="white-space:nowrap">@<strong class="text-white">' + currentUser + '</strong></span>' +
                        '<span id="userBalance" class="bg-violet-500/10 text-violet-300 px-3.5 py-1.5 rounded-full text-xs font-bold border border-violet-500/30" style="white-space:nowrap">0.00 TL</span>' +
                        '<button onclick="openDeposit()" class="bg-amber-400 hover:bg-amber-300 text-black px-3.5 py-1.5 rounded-xl text-xs font-black shadow-lg" style="white-space:nowrap"><i class="fa-solid fa-circle-plus mr-1"></i>Bakiye Yükle</button>' +
                        (currentRole === 'admin' && adminToken ? '<button onclick="openAdminPanel()" class="bg-violet-600 hover:bg-violet-500 px-3.5 py-1.5 rounded-xl text-xs font-bold" style="white-space:nowrap">Admin Panel</button>' : '') +
                        '<button onclick="logout()" class="text-violet-400 text-sm p-2" style="white-space:nowrap"><i class="fa-solid fa-right-from-bracket"></i></button>' +
                        '</div>';
                    fetchBalance();
                } else {
                    area.innerHTML =
                        '<button onclick="openAuthModal(\\'login\\')" class="bg-violet-600 hover:bg-violet-500 px-5 py-2.5 rounded-xl text-sm font-bold">Giriş Yap</button>' +
                        '<button onclick="openAuthModal(\\'register\\')" class="bg-black/40 border border-violet-500/30 px-5 py-2.5 rounded-xl text-sm font-bold">Kayıt Ol</button>';
                    document.getElementById('mainContent').innerHTML =
                        '<div class="text-center py-14 glassCard rounded-3xl p-8 fadeUp">' +
                        '<div class="mx-auto mb-5 flex items-center justify-center" style="width:64px;height:64px;border-radius:18px;background:var(--surface-2);border:1px solid var(--border)"><i class="fa-solid fa-signal text-2xl" style="color:var(--accent)"></i></div>' +
                        '<h2 class="anka text-3xl md:text-4xl font-bold mb-3">Anka SMS</h2>' +
                        '<p class="text-violet-200/70 mb-8 max-w-sm mx-auto">WhatsApp, Telegram ve daha fazlası için anında sanal numara. Satın al, kodu al, kullan.</p>' +
                        '<div class="flex gap-3 justify-center flex-wrap"><button onclick="openAuthModal(\\'login\\')" class="bg-violet-600 hover:bg-violet-500 px-8 py-3 rounded-xl font-bold">Giriş Yap</button>' +
                        '<button onclick="openAuthModal(\\'register\\')" class="bg-black/40 border border-violet-500/40 hover:bg-violet-900/30 px-8 py-3 rounded-xl font-bold text-violet-300">Kayıt Ol</button></div>' +
                        '<p class="text-violet-200/40 text-xs mt-6">Destek: WhatsApp <a href="https://wa.me/573181006792" target="_blank" class="text-violet-400 underline">+57 318 100 6792</a></p>' +
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
                    '<div id="navTabs" class="flex gap-1 mb-6" style="border-bottom:1px solid var(--border)">' +
                    '<button onclick="switchPanel(\'home\')" id="navHomeBtn" class="tabBtn active px-4 py-2.5 text-sm font-semibold">Ana Sayfa</button>' +
                    '<button onclick="switchPanel(\'orders\')" id="navOrdersBtn" class="tabBtn px-4 py-2.5 text-sm font-semibold">Siparişlerim</button>' +
                    '</div>' +
                    '<div id="homePanel">' +
                    '<div class="glassCard rounded-2xl p-5 mb-7 flex items-center justify-between flex-wrap gap-4">' +
                    '<div><p class="text-xs text-slate-400 mb-1">Bakiyeniz</p><p id="homeBalance" class="text-3xl font-bold anka">0.00 TL</p></div>' +
                    '<button onclick="openDeposit()" class="btnAccent px-5 py-2.5 rounded-xl text-sm"><i class="fa-solid fa-circle-plus mr-2"></i>Bakiye Yükle</button>' +
                    '</div>' +
                    '<div id="activeOrderWrap" class="mb-8">' +
                    '<div id="activeOrderHeading" class="items-center gap-2 mb-3" style="display:none;"><i class="fa-solid fa-signal" style="color:var(--accent)"></i><h3 class="font-bold text-lg">Aktif Numaralarım</h3></div>' +
                    '<div id="activeOrderArea"></div>' +
                    '</div>' +
                    '<div id="featuredWrap" class="mb-7" style="display:none;">' +
                    '<div class="flex items-center gap-2 mb-3"><i class="fa-solid fa-star" style="color:var(--accent)"></i><h3 class="font-bold text-lg">Popüler Servisler</h3></div>' +
                    '<div id="featuredGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>' +
                    '</div>' +
                    '<div class="mb-5">' +
                    '<div id="groupTabs" class="flex gap-1 overflow-x-auto mb-3" style="scrollbar-width:none"></div>' +
                    '<div id="countryChips" class="flex gap-2 overflow-x-auto" style="scrollbar-width:none"></div>' +
                    '</div>' +
                    '<div id="servicesGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4"><p class="text-slate-400 text-sm">Yükleniyor...</p></div>' +
                    '<div class="mt-8">' +
                    '<button onclick="toggleOtherPlatforms()" class="w-full text-left bg-black/40 border border-violet-500/15 p-4 rounded-2xl flex items-center justify-between"><span class="font-bold text-sm"><i class="fa-solid fa-globe mr-2" style="color:var(--accent)"></i>Diğer SMS Platformları (Trendyol ve tüm Türkiye servisleri)</span><i id="otherPlatformsChevron" class="fa-solid fa-chevron-down"></i></button>' +
                    '<div id="otherPlatformsBody" class="mt-3" style="display:none;">' +
                    '<input id="otherPlatformsSearch" oninput="filterOtherPlatforms()" placeholder="Servis ara (örn: Trendyol)" class="w-full bg-black/40 border border-violet-500/20 rounded-xl p-3 text-white text-sm mb-3">' +
                    '<div id="otherPlatformsGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4"><p class="text-slate-400 text-sm">Yükleniyor...</p></div>' +
                    '</div></div>' +
                    '<div id="smmSection" class="mt-8"></div>' +
                    '<div id="manualSection" class="mt-8"></div>' +
                    '<div class="mt-10">' +
                    '<div class="flex items-center justify-between mb-3"><h3 class="font-bold text-lg">Son Siparişler</h3><button onclick="switchPanel(\'orders\')" class="text-xs font-semibold" style="color:var(--accent)">Tümünü gör</button></div>' +
                    '<div id="recentOrdersArea"><p class="text-slate-400 text-sm">Yükleniyor...</p></div>' +
                    '</div>' +
                    '<div class="mt-10 mb-4 glassCard rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4">' +
                    '<div class="flex items-center gap-3"><div class="prodIcon w-11 h-11 rounded-xl flex items-center justify-center text-lg shrink-0"><i class="fa-brands fa-whatsapp"></i></div><div><h3 class="font-bold text-sm">Yardıma mı ihtiyacınız var?</h3><p class="text-xs text-slate-400">Sorularınız için WhatsApp üzerinden bize ulaşın.</p></div></div>' +
                    '<a href="https://wa.me/573181006792" target="_blank" class="bg-black/40 border border-violet-500/20 px-5 py-2.5 rounded-xl text-sm font-semibold">WhatsApp\'tan Yaz</a>' +
                    '</div>' +
                    '</div>' +
                    '<div id="ordersPanel" style="display:none"></div>';
            }

            function switchPanel(name) {
                var home = document.getElementById('homePanel');
                var orders = document.getElementById('ordersPanel');
                var hb = document.getElementById('navHomeBtn');
                var ob = document.getElementById('navOrdersBtn');
                if (home) home.style.display = name === 'home' ? 'block' : 'none';
                if (orders) orders.style.display = name === 'orders' ? 'block' : 'none';
                if (hb) hb.className = 'tabBtn' + (name === 'home' ? ' active' : '') + ' px-4 py-2.5 text-sm font-semibold';
                if (ob) ob.className = 'tabBtn' + (name === 'orders' ? ' active' : '') + ' px-4 py-2.5 text-sm font-semibold';
                if (name === 'orders') loadOrdersTab();
            }

            // ====== Kategori (servis tipi) ve ülke filtreleri ======
            var allServicesData = [];
            var activeGroup = 'all';
            var activeCountry = 'all';
            var GROUP_LABELS = { all: 'Tümü', wa: 'WhatsApp', tg: 'Telegram', ds: 'Discord', other: 'Diğer' };
            var COUNTRY_LABELS = { tr: 'Türkiye', co: 'Kolombiya', us: 'Amerika', gb: 'İngiltere', sg: 'Singapur', sy: 'Suriye', random: 'Anonim/Rastgele' };
            function buildFilterChips() {
                var groups = {}, countries = {};
                allServicesData.forEach(function (s) { if (s.group) groups[s.group] = true; if (s.country) countries[s.country] = true; });
                var groupOrder = ['all', 'wa', 'tg', 'ds', 'other'];
                var gWrap = document.getElementById('groupTabs');
                if (gWrap) {
                    gWrap.innerHTML = groupOrder.filter(function (g) { return g === 'all' || groups[g]; }).map(function (g) {
                        return '<button onclick="setGroupFilter(\\'' + g + '\\')" class="tabBtn' + (activeGroup === g ? ' active' : '') + ' px-3 py-2 text-sm font-semibold shrink-0">' + GROUP_LABELS[g] + '</button>';
                    }).join('');
                }
                var cWrap = document.getElementById('countryChips');
                if (cWrap) {
                    var list = Object.keys(countries);
                    cWrap.innerHTML = (list.length > 1 ? '<button onclick="setCountryFilter(\\'all\\')" class="chip' + (activeCountry === 'all' ? ' active' : '') + ' px-3 py-1.5 rounded-full text-xs shrink-0">Tüm ülkeler</button>' : '') +
                        list.map(function (c) {
                            return '<button onclick="setCountryFilter(\\'' + c + '\\')" class="chip' + (activeCountry === c ? ' active' : '') + ' px-3 py-1.5 rounded-full text-xs shrink-0">' + (COUNTRY_LABELS[c] || c) + '</button>';
                        }).join('');
                }
            }
            function setGroupFilter(g) { activeGroup = g; buildFilterChips(); renderFilteredServices(); }
            function setCountryFilter(c) { activeCountry = c; buildFilterChips(); renderFilteredServices(); }
            function renderFilteredServices() {
                var grid = document.getElementById('servicesGrid');
                if (!grid) return;
                var list = allServicesData.filter(function (s) {
                    if (s.featured) return false;
                    if (activeGroup !== 'all' && s.group !== activeGroup) return false;
                    if (activeCountry !== 'all' && s.country !== activeCountry) return false;
                    return true;
                });
                if (!list.length) { grid.innerHTML = '<p class="text-slate-400 text-sm">Bu filtreyle eşleşen servis yok.</p>'; return; }
                grid.innerHTML = list.map(function (s) { return renderServiceCard(s, false); }).join('');
            }

            // ====== Siparişlerim sekmesi ve "Son Siparişler" ======
            var STATUS_LABELS = { waiting: ['Bekleniyor', '#E8A33D'], completed: ['Tamamlandı', '#3DBD82'], cancelled: ['İptal Edildi', '#8B93A3'], expired: ['Süresi Doldu', '#8B93A3'] };
            function orderRowHTML(o) {
                var st = STATUS_LABELS[o.status] || [o.status, '#8B93A3'];
                return '<div class="glassCard rounded-2xl p-4 mb-3">' +
                    '<div class="flex items-center justify-between gap-3 flex-wrap">' +
                    '<div class="min-w-0"><h3 class="font-bold text-sm truncate">' + o.productName + '</h3>' +
                    '<p class="text-xs text-slate-400 font-mono">' + (o.phoneNumber || '-') + '</p></div>' +
                    '<span class="text-[11px] font-bold px-2.5 py-1 rounded-full shrink-0" style="background:' + st[1] + '22;color:' + st[1] + '">' + st[0] + '</span>' +
                    '</div>' +
                    '<div class="flex items-center justify-between mt-3 text-xs text-slate-400">' +
                    '<span>' + (o.time || '') + '</span>' +
                    '<span class="font-bold" style="color:var(--text)">' + (o.price != null ? Number(o.price).toFixed(2) + ' TL' : '') + '</span>' +
                    '</div>' +
                    (o.code && o.code !== 'Bekleniyor...' ? '<div class="mt-2 bg-black/40 rounded-lg px-3 py-2 text-xs"><span class="text-slate-400">Kod: </span><span class="font-mono font-bold">' + o.code + '</span></div>' : '') +
                    '</div>';
            }
            async function loadOrdersTab() {
                var box = document.getElementById('ordersPanel');
                if (!box || !currentUser) return;
                box.innerHTML = '<p class="text-slate-400 text-sm">Yükleniyor...</p>';
                try {
                    var res = await fetch('/api/myAllOrders?username=' + encodeURIComponent(currentUser));
                    var data = await res.json();
                    if (!data.success || !data.orders.length) { box.innerHTML = '<div class="glassCard rounded-2xl p-8 text-center"><p class="text-slate-400 text-sm">Henüz siparişiniz yok.</p></div>'; return; }
                    box.innerHTML = data.orders.map(orderRowHTML).join('');
                } catch (e) { box.innerHTML = '<p class="text-slate-400 text-sm">Yüklenemedi.</p>'; }
            }
            async function loadRecentOrders() {
                var box = document.getElementById('recentOrdersArea');
                if (!box || !currentUser) return;
                try {
                    var res = await fetch('/api/myAllOrders?username=' + encodeURIComponent(currentUser));
                    var data = await res.json();
                    if (!data.success || !data.orders.length) { box.innerHTML = '<p class="text-slate-400 text-sm">Henüz siparişiniz yok.</p>'; return; }
                    box.innerHTML = data.orders.slice(0, 3).map(orderRowHTML).join('');
                } catch (e) { box.innerHTML = ''; }
            }

            var otherPlatformsLoaded = false;
            var otherPlatformsData = [];
            function toggleOtherPlatforms() {
                var body = document.getElementById('otherPlatformsBody');
                var chev = document.getElementById('otherPlatformsChevron');
                var open = body.style.display !== 'none';
                body.style.display = open ? 'none' : 'block';
                if (chev) chev.className = open ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
                if (!open && !otherPlatformsLoaded) loadOtherServices();
            }
            async function loadOtherServices() {
                var grid = document.getElementById('otherPlatformsGrid');
                if (!grid) return;
                try {
                    var res = await fetch('/api/getOtherServices');
                    var data = await res.json();
                    otherPlatformsLoaded = true;
                    if (!data.success || !data.services.length) { grid.innerHTML = '<p class="text-slate-400 text-sm">Şu an listelenecek servis yok.</p>'; return; }
                    otherPlatformsData = data.services;
                    renderOtherPlatforms(otherPlatformsData);
                } catch (e) { grid.innerHTML = '<p class="text-slate-400 text-sm">Yüklenemedi.</p>'; }
            }
            function renderOtherPlatforms(list) {
                var grid = document.getElementById('otherPlatformsGrid');
                if (!grid) return;
                if (!list.length) { grid.innerHTML = '<p class="text-slate-400 text-sm">Eşleşen servis yok.</p>'; return; }
                grid.innerHTML = list.map(function (s) {
                    return '<div class="prodCard bg-black/40 border border-violet-500/15 p-5 rounded-2xl flex items-center justify-between shadow-xl transition' + (s.inStock ? '' : ' opacity-50') + '">' +
                        '<div class="min-w-0"><h3 class="font-bold text-sm text-white truncate">' + s.name + '</h3>' +
                        '<p class="text-violet-300 font-bold text-sm">' + s.price.toFixed(2) + ' TL' + (s.inStock ? '' : ' <span class="text-slate-500 font-normal">(stok yok)</span>') + '</p></div>' +
                        '<button data-code="' + s.code + '" onclick="buyOtherService(this)" ' + (s.inStock ? '' : 'disabled') + ' class="shineBtn bg-violet-600 hover:bg-violet-500 disabled:opacity-40 px-4 py-2.5 rounded-xl text-sm font-bold shadow-lg transition shrink-0">Numara Al</button>' +
                        '</div>';
                }).join('');
            }
            function filterOtherPlatforms() {
                var q = document.getElementById('otherPlatformsSearch').value.toLocaleLowerCase('tr');
                renderOtherPlatforms(otherPlatformsData.filter(function (s) { return s.name.toLocaleLowerCase('tr').includes(q); }));
            }
            async function buyOtherService(btn) {
                var code = btn.getAttribute('data-code');
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                try {
                    var res = await fetch('/api/buyOtherService', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: currentUser, code: code }) });
                    var data = await res.json();
                    if (data.success) {
                        fetchBalance();
                        trackOrder(data.order.activationId, data.order.phoneNumber, 600, data.order.productName, null, true);
                        btn.innerText = 'Numara Al';
                        btn.disabled = false;
                    } else {
                        btn.innerText = 'Numara Al';
                        btn.disabled = false;
                        if (data.insufficientBalance) { showToast(data.message, 'fa-wallet'); openDeposit(); }
                        else alert(data.message);
                    }
                } catch (e) {
                    btn.innerText = 'Numara Al';
                    btn.disabled = false;
                    alert('Bağlantı hatası, tekrar deneyin.');
                }
            }

            function showToast(message, icon) {
                var stack = document.getElementById('toastStack');
                if (!stack) return;
                var t = document.createElement('div');
                t.className = 'appToast';
                t.innerHTML = '<i class="fa-solid ' + (icon || 'fa-circle-check') + ' text-violet-400 text-lg"></i><span>' + message + '</span>';
                stack.appendChild(t);
                setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4100);
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
                    var featured = data.services.filter(function (s) { return s.featured; });
                    var rest = data.services.filter(function (s) { return !s.featured; });
                    var fWrap = document.getElementById('featuredWrap');
                    var fGrid = document.getElementById('featuredGrid');
                    if (featured.length && fWrap && fGrid) {
                        fWrap.style.display = 'block';
                        fGrid.innerHTML = featured.map(function (s) { return renderServiceCard(s, true); }).join('');
                    } else if (fWrap) { fWrap.style.display = 'none'; }
                    grid.innerHTML = rest.map(function (s) { return renderServiceCard(s, false); }).join('');
                } catch (e) {}
            }

            function renderServiceCard(s, isFeatured) {
                return '<div class="prodCard bg-black/40 border ' + (isFeatured ? 'border-amber-400/50 featuredCard' : 'border-violet-500/15') + ' p-5 rounded-2xl flex items-center justify-between shadow-xl transition relative">' +
                    (isFeatured ? '<span class="absolute -top-2.5 right-4 bg-amber-400 text-black text-[10px] font-black px-2 py-0.5 rounded-full tracking-wide"><i class="fa-solid fa-star"></i> ÖNE ÇIKAN</span>' : '') +
                    '<div class="flex items-center gap-4 min-w-0">' +
                    '<div class="' + s.bg + ' ' + s.color + ' prodIcon w-12 h-12 rounded-xl flex items-center justify-center text-xl border border-violet-500/15 shrink-0"><i class="' + (s.iconSet || 'fa-brands') + ' ' + s.icon + '"></i></div>' +
                    '<div class="min-w-0"><h3 class="font-bold text-sm text-white truncate">' + s.name + '</h3>' +
                    '<p class="text-violet-300 font-bold text-sm">' + s.price.toFixed(2) + ' TL</p></div>' +
                    '</div>' +
                    '<button data-id="' + s.id + '" onclick="buyNumber(this)" class="shineBtn bg-violet-600 hover:bg-violet-500 px-4 sm:px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg transition shrink-0">Numara Al</button>' +
                    '</div>';
            }

            async function loadSmmServices() {
                var box = document.getElementById('smmSection');
                if (!box) return;
                try {
                    var res = await fetch('/api/getSmmServices');
                    var data = await res.json();
                    if (!data.success || !data.services.length) { box.innerHTML = ''; return; }
                    box.innerHTML = '<h2 class="text-sm font-bold text-pink-300 mb-3 flex items-center gap-2"><i class="fa-brands fa-instagram"></i> Instagram Hizmetleri</h2>' +
                        '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">' + data.services.map(renderSmmCard).join('') + '</div>';
                } catch (e) { box.innerHTML = ''; }
            }

            // Elden satış: fiyatlar gösterilir, bakiyeden düşülmez - satın almak için Telegram'a yönlendirir.
            async function loadManualServices() {
                var box = document.getElementById('manualSection');
                if (!box) return;
                try {
                    var res = await fetch('/api/getManualServices');
                    var data = await res.json();
                    if (!data.success || !data.categories.length) { box.innerHTML = ''; return; }
                    var waUrl = 'https://wa.me/' + data.whatsapp;
                    box.innerHTML = '<h2 class="text-sm font-bold text-violet-300 mb-1 flex items-center gap-2"><i class="fa-solid fa-crown"></i> Instagram / TikTok / Telegram Takipçi &amp; Beğeni</h2>' +
                        '<p class="text-[11px] text-slate-500 mb-3">Bu hizmetler panel bakiyesinden otomatik alınmaz - fiyatı seç, WhatsApp üzerinden bizimle iletişime geç.</p>' +
                        '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">' + data.categories.map(function (cat) {
                            return '<div class="prodCard bg-black/40 border border-violet-500/15 p-5 rounded-2xl shadow-xl transition">' +
                                '<div class="flex items-center gap-3 mb-3">' +
                                '<div class="' + cat.bg + ' ' + cat.color + ' prodIcon w-11 h-11 rounded-xl flex items-center justify-center text-lg border border-violet-500/15 shrink-0"><i class="' + cat.iconSet + ' ' + cat.icon + '"></i></div>' +
                                '<h3 class="font-bold text-sm text-white">' + cat.category + '</h3>' +
                                '</div>' +
                                '<div class="space-y-1.5">' + cat.packages.map(function (p) {
                                    return '<div class="flex justify-between items-center bg-black/30 rounded-lg px-3 py-1.5 text-xs"><span class="text-slate-300">' + p.label + '</span><span class="text-violet-300 font-bold">' + p.price.toFixed(2) + ' TL</span></div>';
                                }).join('') + '</div>' +
                                '<a href="' + waUrl + '" target="_blank" class="shineBtn mt-3 block text-center bg-violet-600 hover:bg-violet-500 px-4 py-2 rounded-xl text-xs font-bold shadow-lg transition">WhatsApp ile Satın Al</a>' +
                                '</div>';
                        }).join('') + '</div>';
                } catch (e) { box.innerHTML = ''; }
            }

            function renderSmmCard(s) {
                return '<div class="prodCard bg-black/40 border border-pink-500/15 p-5 rounded-2xl shadow-xl transition">' +
                    '<div class="flex items-center gap-3 mb-3">' +
                    '<div class="' + s.bg + ' ' + s.color + ' prodIcon w-11 h-11 rounded-xl flex items-center justify-center text-lg border border-pink-500/15 shrink-0"><i class="' + (s.iconSet || 'fa-solid') + ' ' + s.icon + '"></i></div>' +
                    '<div class="min-w-0"><h3 class="font-bold text-sm text-white truncate">' + s.name + '</h3>' +
                    '<p class="text-pink-300 font-bold text-xs">1000 adet: ' + s.pricePerThousand.toFixed(2) + ' TL</p></div>' +
                    '</div>' +
                    '<input id="smmLink_' + s.id + '" placeholder="' + s.linkLabel + '" class="w-full bg-black/40 border border-violet-500/20 rounded-lg px-3 py-2 text-xs text-white mb-2">' +
                    '<div class="flex gap-2 items-center">' +
                    '<input id="smmQty_' + s.id + '" type="number" min="' + s.min + '" max="' + s.max + '" placeholder="Miktar (' + s.min + '-' + s.max + ')" oninput="updateSmmPrice(\\'' + s.id + '\\',' + s.pricePerThousand + ')" class="flex-1 bg-black/40 border border-violet-500/20 rounded-lg px-3 py-2 text-xs text-white">' +
                    '<button onclick="buySmm(\\'' + s.id + '\\')" class="shineBtn bg-pink-600 hover:bg-pink-500 px-4 py-2 rounded-xl text-xs font-bold shadow-lg transition shrink-0">Sipariş Ver</button>' +
                    '</div>' +
                    '<p id="smmPrice_' + s.id + '" class="text-[11px] text-slate-400 mt-1.5"></p>' +
                    '</div>';
            }

            function updateSmmPrice(id, pricePerThousand) {
                var qty = parseInt(document.getElementById('smmQty_' + id).value, 10);
                var el = document.getElementById('smmPrice_' + id);
                if (!qty) { el.innerText = ''; return; }
                el.innerText = 'Tutar: ' + ((pricePerThousand / 1000) * qty).toFixed(2) + ' TL';
            }

            async function buySmm(id) {
                var link = document.getElementById('smmLink_' + id).value;
                var qty = document.getElementById('smmQty_' + id).value;
                if (!link || !qty) return alert('Lütfen link ve miktar girin.');
                var r = await fetch('/api/buySmm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: id, username: currentUser, link: link, quantity: qty }) });
                var d = await r.json();
                if (d.insufficientBalance) { showToast(d.message, 'fa-wallet'); openDeposit(); return; }
                alert(d.message);
                if (d.success) { fetchBalance(); document.getElementById('smmLink_' + id).value = ''; document.getElementById('smmQty_' + id).value = ''; }
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
                        trackOrder(data.order.activationId, data.order.phoneNumber, 600, data.order.productName, null, true);
                    } else if (data.retryable && attemptNo <= MAX_AUTO_RETRY) {
                        setTimeout(function () { buyNumber(btn, attemptNo + 1); }, 2500);
                    } else {
                        btn.disabled = false;
                        btn.innerText = 'Numara Al';
                        if (data.insufficientBalance) { showToast(data.message, 'fa-wallet'); openDeposit(); }
                        else alert(data.message);
                    }
                } catch (e) {
                    btn.disabled = false;
                    btn.innerText = 'Numara Al';
                    alert('Bağlantı hatası, tekrar deneyin.');
                }
            }

            function trackOrder(id, phone, timeLeft, productName, doneCode, isNew) {
                var area = document.getElementById('activeOrderArea');
                if (!area) return;
                var wrap = document.getElementById('activeOrderWrap');
                var heading = document.getElementById('activeOrderHeading');
                if (wrap) wrap.classList.add('hasOrders');
                if (heading) heading.style.display = 'flex';
                var old = document.getElementById('order_' + id);
                if (old) old.parentNode.removeChild(old);
                if (orderTimers[id]) { clearInterval(orderTimers[id]); delete orderTimers[id]; }
                var done = !!doneCode;

                var card = document.createElement('div');
                card.id = 'order_' + id;
                card.className = 'bg-black/40 border border-violet-500 p-6 rounded-2xl shadow-2xl relative mb-4' + (isNew ? ' orderFlashCard' : '');
                card.innerHTML =
                    '<h3 class="font-bold text-violet-400 text-lg mb-3"><i class="fa-solid fa-circle-check mr-2"></i> ' + (productName || 'Numara') + '</h3>' +
                    '<p class="text-sm text-slate-300">Numara: <strong class="text-white font-mono text-xl select-all">' + phone + '</strong></p>' +
                    '<p class="text-sm text-slate-300 mt-2">SMS Kod: <strong id="smsCode_' + id + '" class="text-violet-400 font-mono text-xl ' + (done ? '' : 'animate-pulse') + '">' + (done ? doneCode : 'Bekleniyor...') + '</strong></p>' +
                    '<div class="mt-4 flex items-center justify-between border-t border-violet-500/20 pt-4">' +
                    '<span class="text-xs text-slate-400">' + (done ? '' : 'Kod Süresi: <strong id="timerDisplay_' + id + '" class="text-violet-400 font-mono text-sm">--:--</strong>') + '</span>' +
                    '<div id="actionButtons_' + id + '">' + (done
                        ? '<span class="text-violet-400 font-bold text-xs"><i class="fa-solid fa-check"></i> Tamamlandı</span>'
                        : '<button data-id="' + id + '" onclick="cancelBtn(this)" class="bg-violet-600/20 hover:bg-violet-600 text-violet-400 hover:text-white border border-violet-500/40 px-4 py-2 rounded-xl text-xs font-bold transition">Değiştir / İptal Et</button>') +
                    '</div></div>';
                area.insertBefore(card, area.firstChild);
                if (isNew) {
                    showToast('Numaranız alındı: ' + phone + ' — SMS kodunu yukarıdan takip edin.', 'fa-circle-check');
                    setTimeout(function () { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150);
                }
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
                            if (actionArea) actionArea.innerHTML = '<span class="text-violet-400 font-bold text-xs"><i class="fa-solid fa-check"></i> Tamamlandı</span>';
                            var tEl = document.getElementById('timerDisplay_' + id);
                            if (tEl) tEl.parentNode.innerHTML = '';
                            var cardEl = document.getElementById('order_' + id);
                            if (cardEl) {
                                cardEl.classList.remove('orderFlashCard');
                                void cardEl.offsetWidth;
                                cardEl.classList.add('orderFlashCard');
                            }
                            showToast('SMS kodunuz geldi: ' + data.code, 'fa-comment-sms');
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
                        '<button onclick="processPay(\\'' + p.id + '\\',\\'approve\\')" class="bg-violet-600 px-3 py-1 rounded text-xs font-bold mr-1">Onayla</button>' +
                        '<button onclick="processPay(\\'' + p.id + '\\',\\'reject\\')" class="bg-red-600 px-3 py-1 rounded text-xs font-bold mr-1">Reddet</button>' +
                        '<button onclick="processPay(\\'' + p.id + '\\',\\'reject_ban\\')" class="bg-red-800 px-3 py-1 rounded text-xs font-bold" title="Ödeme yapmadan sahte bildirim gönderenler için">Reddet + Banla</button></div></div>';
                });
                if (!pendingHtml) pendingHtml = '<p class="text-sm text-slate-500">Bekleyen ödeme yok.</p>';

                var allPayHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.payments.map(function (p) {
                    var c = p.status === 'approved' ? 'text-violet-400' : (p.status === 'rejected' ? 'text-red-400' : 'text-amber-400');
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
                        '<input id="balAdj_' + u.username + '" placeholder="+50 / -20" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-20">' +
                        '<button onclick="adjustBalance(\\'' + u.username + '\\')" class="bg-blue-600 px-2 py-1 rounded text-xs font-bold">Uygula</button>' +
                        banBtn +
                        '</div>';
                }).join('') + '</div>';

                var loginsHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.logins.map(function (l) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex flex-wrap justify-between gap-1"><span class="font-bold text-white">' + l.username + '</span><span class="text-slate-400 font-mono">' + l.ip + '</span><span class="text-violet-400">' + (l.source || '-') + '</span><span class="text-slate-500">' + l.time + '</span></div>';
                }).join('') + '</div>';
                if (!data.logins.length) loginsHtml = '<p class="text-sm text-slate-500">Henüz giriş kaydı yok.</p>';

                var visitorsHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + (data.visitorList || []).map(function (v) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex flex-wrap justify-between gap-1"><span class="text-slate-400 font-mono">' + v.ip + '</span><span class="text-violet-400 font-bold">' + v.source + '</span><span class="text-slate-500">' + v.time + '</span></div>';
                }).join('') + '</div>';
                if (!data.visitorList || !data.visitorList.length) visitorsHtml = '<p class="text-sm text-slate-500">Henüz ziyaretçi kaydı yok.</p>';

                var ordersHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.orders.map(function (o) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex justify-between"><span class="font-bold text-white">' + o.username + '</span><span>' + o.productName + '</span><span class="font-mono">' + o.phoneNumber + '</span><span class="text-slate-500">' + o.status + '</span><span class="text-slate-500">' + o.time + '</span></div>';
                }).join('') + '</div>';
                if (!data.orders.length) ordersHtml = '<p class="text-sm text-slate-500">Henüz sipariş yok.</p>';

                var supportHtml = '<div class="space-y-2">' + data.supportChats.map(function (c) {
                    return '<div class="bg-black/30 p-3 rounded-lg text-xs"><div class="flex justify-between mb-1"><span class="font-bold text-white">' + c.username + '</span><span class="text-slate-500">' + (c.last ? c.last.time : '') + '</span></div>' +
                        '<div class="text-slate-400 mb-2">' + (c.last ? c.last.text.replace(/</g, '&lt;') : '') + '</div>' +
                        '<div class="flex gap-1"><input id="adminReply_' + c.username + '" placeholder="Cevap yaz..." class="flex-1 bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white">' +
                        '<button onclick="adminReplySupport(\\'' + c.username + '\\')" class="bg-violet-600 px-3 rounded text-xs font-bold">Gönder</button></div></div>';
                }).join('') + '</div>';
                if (!data.supportChats.length) supportHtml = '<p class="text-sm text-slate-500">Henüz destek mesajı yok.</p>';

                var catalogMgmtHtml = '<p class="text-xs text-slate-500 mb-2">Sağlayıcıda yeni bir servis olmasa bile, elle yeni bir numara ürünü tanımlayabilirsin (fiyatı ve ülke ID\\'sini sen belirlersin, sistem onu normal bir ürün gibi satışa sunar).</p>' +
                    '<div class="max-h-44 overflow-y-auto space-y-1 mb-3">' + (data.catalog || []).map(function (c) {
                        return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex flex-wrap justify-between items-center gap-2"><span class="font-bold text-white flex-1 min-w-[140px]">' + c.name + (c.manual ? ' <span class="text-amber-400">(elle eklendi)</span>' : '') + '</span><span>' + (c.price || 0) + ' TL</span>' +
                            (c.manual ? '<button onclick="deleteProductAdmin(\\'' + c.id + '\\')" class="bg-red-800 px-2 py-1 rounded text-xs font-bold">Sil</button>' : '<span class="text-slate-600">sabit</span>') + '</div>';
                    }).join('') + '</div>' +
                    '<div class="bg-black/30 p-3 rounded-xl space-y-2">' +
                    '<div class="flex flex-wrap gap-2"><input id="npName" placeholder="Ürün adı (örn: WhatsApp Brezilya)" class="flex-1 min-w-[160px] bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white">' +
                    '<input id="npPrice" type="number" placeholder="Fiyat (TL)" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-24"></div>' +
                    '<div class="flex flex-wrap gap-2"><input id="npServiceCode" placeholder="servis kodu (biliniyorsa, örn: wa)" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-40">' +
                    '<input id="npDefCountry" placeholder="ülke ID (örn: 62)" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-32">' +
                    '<input id="npKey" placeholder="ülke anahtarı (ops., örn: tr)" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-40">' +
                    '<input id="npHints" placeholder="isim ipucu (ops., virgülle)" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-44"></div>' +
                    '<button onclick="addProductSubmit()" class="bg-violet-600 hover:bg-violet-500 px-4 py-2 rounded-xl text-xs font-bold">Ürünü Ekle</button>' +
                    '</div>';

                var otherPlatformsAdminHtml = '<p class="text-xs text-slate-500 mb-2">"Diğer SMS Platformları" bölümünde sağlayıcının Türkiye için sunduğu TÜM servisler (Trendyol vb. dahil) otomatik listelenir. Satış fiyatı = sağlayıcı maliyeti × bu çarpan (en az +20 TL kâr garantilenir, 10 TL\\'ye yuvarlanır).</p>' +
                    '<div class="flex flex-wrap gap-2 items-center"><input id="otherMarkup" type="number" step="0.1" placeholder="örn: 1.8" value="' + (data.otherPlatformsMarkup || 1.8) + '" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-24">' +
                    '<button onclick="saveOtherMarkup()" class="bg-violet-600 hover:bg-violet-500 px-4 py-2 rounded-xl text-xs font-bold">Kaydet</button>' +
                    '<span class="text-slate-500">örnek: maliyet 200 TL ise ' + (data.otherPlatformsMarkup || 1.8) + 'x ile ≈ ' + Math.ceil((200 * (data.otherPlatformsMarkup || 1.8)) / 10) * 10 + ' TL\\'ye satılır</span></div>';

                var manualOrderHtml =
                    '<p class="text-xs text-slate-500 mb-2">Sağlayıcı API\\'si tamamen çöktüğünde bile, elinde olan bir numarayı müşteriye panel üzerinden teslim edebilirsin.</p>' +
                    '<div class="bg-black/30 p-3 rounded-xl space-y-2 mb-4">' +
                    '<div class="flex flex-wrap gap-2"><input id="moUser" placeholder="kullanıcı adı" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-32">' +
                    '<input id="moProduct" placeholder="ürün adı" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-40">' +
                    '<input id="moPhone" placeholder="telefon numarası" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-36">' +
                    '<input id="moCode" placeholder="SMS kod (varsa)" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-28">' +
                    '<input id="moPrice" type="number" placeholder="düşülecek tutar (TL)" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-32"></div>' +
                    '<button onclick="manualOrderSubmit()" class="bg-violet-600 hover:bg-violet-500 px-4 py-2 rounded-xl text-xs font-bold">Elle Sipariş Oluştur</button>' +
                    '</div>' +
                    '<p class="text-xs text-slate-500 mb-2">Mevcut bir siparişin kodu sağlayıcıdan otomatik gelmediyse (gecikme/API sorunu), aktivasyon ID\\'siyle burada elle girebilirsin.</p>' +
                    '<div class="bg-black/30 p-3 rounded-xl space-y-2">' +
                    '<div class="flex flex-wrap gap-2"><input id="ocId" placeholder="aktivasyon ID" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-40">' +
                    '<input id="ocCode" placeholder="SMS kod" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-28"></div>' +
                    '<button onclick="setOrderCodeSubmit()" class="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-xl text-xs font-bold">Kodu Kaydet</button>' +
                    '</div>';

                var svcRes = await fetch('/api/admin/serviceCodes?adminToken=' + encodeURIComponent(adminToken || ''));
                var svcData = await svcRes.json();
                var serviceCodesHtml = '<p class="text-xs text-slate-500 mb-2">Yeni ürünlerin sağlayıcıdaki gerçek servis kodu isimle otomatik bulunur. Yanlış/eksikse buradan elle düzeltebilirsin.</p><div class="max-h-56 overflow-y-auto space-y-1">' + (svcData.list || []).map(function (s) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex flex-wrap items-center gap-2"><span class="font-bold text-white flex-1 min-w-[120px]">' + s.name + '</span>' +
                        '<span class="' + (s.confirmed ? 'text-violet-400' : 'text-amber-400') + '">' + s.code + (s.confirmed ? ' (bulundu)' : ' (tahmin)') + '</span>' +
                        '<input id="svcCode_' + s.id + '" placeholder="elle kod gir" value="' + s.override + '" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-28">' +
                        '<button onclick="saveServiceCode(\\'' + s.id + '\\')" class="bg-violet-600 px-3 py-1 rounded text-xs font-bold">Kaydet</button></div>';
                }).join('') + '</div>';

                var smmConfigHtml = '<p class="text-xs text-slate-500 mb-2">Service ID\\'yi aşağıdaki canlı arama kutusundan bul (örn. "instagram takip" yaz), sağlayıcı panelinden fiyatı 1000 adet başına görüp üzerine kar koyarak buraya gir. Ayarlanmayan ürün müşteride görünmez.</p>' +
                    '<div class="flex flex-wrap gap-2 items-center mb-3">' +
                    '<input id="smmSearchQ" placeholder="sağlayıcı servislerinde ara (örn: instagram takip)" class="flex-1 min-w-[200px] bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white">' +
                    '<button onclick="searchSmmServices()" class="bg-blue-600 px-3 py-1 rounded text-xs font-bold">Ara</button>' +
                    '</div>' +
                    '<div id="smmSearchResult" class="text-xs text-slate-400 mb-4"></div>' +
                    '<div class="space-y-2">' + (data.smmConfig || []).map(function (c) {
                        return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex flex-wrap items-center gap-2">' +
                            '<span class="font-bold text-white flex-1 min-w-[110px]">' + c.name + '</span>' +
                            '<input id="smmSvc_' + c.id + '" placeholder="service ID" value="' + (c.serviceId || '') + '" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-24">' +
                            '<input id="smmPrice_cfg_' + c.id + '" type="number" placeholder="TL/1000" value="' + (c.pricePerThousand || '') + '" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-20">' +
                            '<input id="smmMin_' + c.id + '" type="number" placeholder="min" value="' + (c.min || 100) + '" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-16">' +
                            '<input id="smmMax_' + c.id + '" type="number" placeholder="max" value="' + (c.max || 10000) + '" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white w-20">' +
                            '<button onclick="saveSmmConfig(\\'' + c.id + '\\')" class="bg-violet-600 px-3 py-1 rounded text-xs font-bold">Kaydet</button>' +
                            (c.serviceId ? '<span class="text-violet-400">✓ aktif</span>' : '<span class="text-amber-400">ayarlanmadı</span>') +
                            '</div>';
                    }).join('') + '</div>';

                var smmOrdersHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + (data.smmOrders || []).map(function (o) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex flex-wrap justify-between items-center gap-2"><span class="font-bold text-white">' + o.username + '</span><span>' + o.itemName + ' x' + o.quantity + '</span><span class="text-pink-300">' + o.price.toFixed(2) + ' TL</span><span id="smmStatus_' + o.id + '" class="text-slate-400">' + o.status + '</span><span class="text-slate-500">' + o.time + '</span><button onclick="refreshSmmStatus(\\'' + o.id + '\\')" class="bg-blue-600 px-2 py-1 rounded text-xs font-bold">Durumu Yenile</button></div>';
                }).join('') + '</div>';
                if (!data.smmOrders || !data.smmOrders.length) smmOrdersHtml = '<p class="text-sm text-slate-500">Henüz SMM siparişi yok.</p>';

                document.getElementById('mainContent').innerHTML =
                    '<div class="glassCard p-6 rounded-2xl space-y-6">' +
                    '<div class="flex justify-between items-center"><h2 class="text-xl font-bold text-violet-400">Admin Paneli</h2><button onclick="location.reload();" class="bg-black/40 border border-violet-500/30 px-4 py-2 rounded-xl text-xs font-bold">Geri Dön</button></div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-money-bill-wave mr-1"></i> Bekleyen Ödemeler</h3>' + pendingHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-receipt mr-1"></i> Tüm Ödemeler (kim ödeme yapmış)</h3>' + allPayHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-users mr-1"></i> Kayıtlı Kullanıcılar</h3>' + usersHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-right-to-bracket mr-1"></i> Giriş Yapanlar (kullanıcı / IP / kaynak / zaman)</h3>' + loginsHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-eye mr-1"></i> Ziyaretçiler (IP / nereden geldi / zaman)</h3>' + visitorsHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-sim-card mr-1"></i> Son Siparişler</h3>' + ordersHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-headset mr-1"></i> Destek Sohbetleri</h3>' + supportHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-code mr-1"></i> Yeni Ürünler - Servis Kodu Ayarları</h3>' + serviceCodesHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-plus mr-1"></i> Ürün Yönetimi (elle ürün ekle/sil)</h3>' + catalogMgmtHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-globe mr-1"></i> Diğer SMS Platformları - Kâr Çarpanı</h3>' + otherPlatformsAdminHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-pen mr-1"></i> Sipariş - Elle Kod Gir / Elle Sipariş Oluştur</h3>' + manualOrderHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-violet-300"><i class="fa-solid fa-stethoscope mr-1"></i> Sağlayıcı Teşhis (neden numara alınamıyor?)</h3>' +
                    '<div class="flex flex-wrap gap-2 items-center mb-2">' +
                    '<select id="diagProduct" class="bg-black/40 border border-violet-500/20 rounded px-2 py-1 text-xs text-white">' + (data.catalog || []).map(function (c) { return '<option value="' + c.id + '">' + c.name + '</option>'; }).join('') + '</select>' +
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
                    if (!d.success) { box.innerHTML = '<span class="text-violet-400">Hata: ' + (d.error || 'bilinmiyor') + '</span>'; return; }
                    var u = d.urunler[0];
                    if (!u) { box.innerHTML = '<span class="text-violet-400">Ürün bulunamadı.</span>'; return; }
                    var p = u.ilkUlkeFiyatBilgisi;
                    var priceHtml = (p && typeof p === 'object') ? ('maliyet: <b>' + p.cost + '</b> / stok: <b>' + p.count + '</b>') : 'fiyat bilgisi alınamadı (sağlayıcı bu ülke için fiyat döndürmedi)';
                    box.innerHTML =
                        '<div class="bg-black/30 p-3 rounded-lg space-y-1">' +
                        '<div>Gerçek sağlayıcı bakiyesi: <b class="text-violet-400">' + JSON.stringify(d.providerBalance) + '</b></div>' +
                        '<div>Kullanılan servis kodu: <b>' + u.servisKodu + '</b> (' + (u.kodOnaylandi ? 'isimle doğrulandı' : 'tahmin') + ')</div>' +
                        '<div>Denenecek ülke kodları (öncelik sırasıyla): <b>' + u.denenecekUlkeler.join(', ') + '</b></div>' +
                        '<div>İlk denenecek ülkenin fiyat/stok bilgisi: ' + priceHtml + '</div>' +
                        '</div>';
                } catch (e) { box.innerHTML = '<span class="text-violet-400">İstek başarısız: ' + e.message + '</span>'; }
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

            async function saveSmmConfig(itemId) {
                var serviceId = document.getElementById('smmSvc_' + itemId).value.trim();
                var price = document.getElementById('smmPrice_cfg_' + itemId).value;
                var min = document.getElementById('smmMin_' + itemId).value;
                var max = document.getElementById('smmMax_' + itemId).value;
                var r = await fetch('/api/admin/setSmmConfig', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, itemId: itemId, serviceId: serviceId, pricePerThousand: price, min: min, max: max }) });
                var d = await r.json();
                alert(d.message);
                openAdminPanel();
            }

            async function searchSmmServices() {
                var q = document.getElementById('smmSearchQ').value.trim();
                var box = document.getElementById('smmSearchResult');
                box.innerHTML = '<span class="text-slate-500">Aranıyor...</span>';
                try {
                    var r = await fetch('/api/admin/smmLiveServices?adminToken=' + encodeURIComponent(adminToken || '') + '&q=' + encodeURIComponent(q));
                    var d = await r.json();
                    if (!d.success) { box.innerHTML = '<span class="text-violet-400">' + (d.message || 'Hata') + '</span>'; return; }
                    if (!d.list.length) { box.innerHTML = '<span class="text-slate-500">Eşleşen servis yok (' + d.count + ' servis içinde arandı).</span>'; return; }
                    box.innerHTML = '<div class="max-h-48 overflow-y-auto space-y-1">' + d.list.map(function (s) {
                        return '<div class="bg-black/30 px-2 py-1.5 rounded text-xs flex flex-wrap items-center gap-2"><span class="font-mono text-violet-400">#' + s.service + '</span><span class="flex-1 min-w-[160px]">' + s.name + '</span><span class="text-slate-500">' + (s.category || '') + '</span><span class="text-amber-300">rate: ' + s.rate + '</span><span class="text-slate-500">min-max: ' + s.min + '-' + s.max + '</span></div>';
                    }).join('') + '</div>';
                } catch (e) { box.innerHTML = '<span class="text-violet-400">İstek başarısız: ' + e.message + '</span>'; }
            }

            async function refreshSmmStatus(orderId) {
                var el = document.getElementById('smmStatus_' + orderId);
                el.innerText = 'Sorgulanıyor...';
                try {
                    var r = await fetch('/api/admin/smmOrderStatus?adminToken=' + encodeURIComponent(adminToken || '') + '&orderId=' + encodeURIComponent(orderId));
                    var d = await r.json();
                    el.innerText = d.success ? (d.status + (d.remains != null ? ' (kalan: ' + d.remains + ')' : '')) : (d.message || 'Hata');
                } catch (e) { el.innerText = 'İstek başarısız'; }
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

            async function addProductSubmit() {
                var name = document.getElementById('npName').value.trim();
                var price = document.getElementById('npPrice').value.trim();
                var serviceCode = document.getElementById('npServiceCode').value.trim();
                var defCountry = document.getElementById('npDefCountry').value.trim();
                var key = document.getElementById('npKey').value.trim();
                var hints = document.getElementById('npHints').value.trim();
                var r = await fetch('/api/admin/addProduct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, name: name, price: price, serviceCode: serviceCode, defCountry: defCountry, key: key, serviceHints: hints }) });
                var d = await r.json();
                alert(d.message);
                if (d.success) openAdminPanel();
            }
            async function deleteProductAdmin(id) {
                if (!confirm('Bu ürünü silmek istediğine emin misin?')) return;
                var r = await fetch('/api/admin/deleteProduct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, id: id }) });
                var d = await r.json();
                alert(d.message);
                if (d.success) openAdminPanel();
            }
            async function saveOtherMarkup() {
                var v = document.getElementById('otherMarkup').value.trim();
                var r = await fetch('/api/admin/setOtherPlatformsMarkup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, multiplier: v }) });
                var d = await r.json();
                alert(d.message);
                if (d.success) openAdminPanel();
            }
            async function manualOrderSubmit() {
                var username = document.getElementById('moUser').value.trim();
                var productName = document.getElementById('moProduct').value.trim();
                var phoneNumber = document.getElementById('moPhone').value.trim();
                var code = document.getElementById('moCode').value.trim();
                var price = document.getElementById('moPrice').value.trim();
                var r = await fetch('/api/admin/manualOrder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, username: username, productName: productName, phoneNumber: phoneNumber, code: code, price: price }) });
                var d = await r.json();
                alert(d.message);
                if (d.success) openAdminPanel();
            }
            async function setOrderCodeSubmit() {
                var activationId = document.getElementById('ocId').value.trim();
                var code = document.getElementById('ocCode').value.trim();
                var r = await fetch('/api/admin/setOrderCode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken: adminToken, activationId: activationId, code: code }) });
                var d = await r.json();
                alert(d.message);
                if (d.success) openAdminPanel();
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

// Ana katalog ürünlerinin (WhatsApp TR, Telegram TR vb.) fiyatını canlı sağlayıcı maliyetinden tazele -
// sunucu açılışında bir kez ve sonra 10 dakikada bir. Hiçbir müşteri isteğini beklemez (arka planda çalışır).
refreshDynamicCatalogPrices();
setInterval(refreshDynamicCatalogPrices, 10 * 60 * 1000);

// Sağlayıcı bakiyesi düşükse 15 dakikada bir otomatik kontrol + Telegram uyarısı
setInterval(async () => {
    try {
        const r = await providerGet({ action: 'getBalance' }, 15000);
        const m = String(r.data || '').match(/ACCESS_BALANCE:([0-9.]+)/);
        if (m) {
            const bal = parseFloat(m[1]);
            if (bal < LOW_BALANCE_THRESHOLD) await notifyLowProviderBalance('⚠️ sms.tc bakiyen azaldı: $' + bal + ' (≈' + Math.round(bal * (db.usdTryRate || 42)) + ' TL). Lütfen yükleme yap.');
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
