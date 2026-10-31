// ====== AYARLAR (sms.tc entegrasyonu) ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8989904538:AAGETyb0e5ghitsYM3yWInhnIi3lexYMjPw';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const ADMIN_TELEGRAM_USERNAME = process.env.ADMIN_TELEGRAM_USERNAME || 'vipankaa'; 
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '573181006792'; 
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://g-venlipanelsms.onrender.com';

// sms.tc Sağlayıcı Ayarları
const SMSTC_API_URL = 'https://sms.tc/stubs/handler_api.php';
const SMSTC_API_KEY = process.env.SMSTC_API_KEY || 'smstc_live_0vHjhoWB7H8qniIpTV5GDwF3W04eNpXRUWHZ9GYW';

// Instagram takipçi/beğeni vb. için SMM panel sağlayıcısı
const SMM_API_URL = process.env.SMM_API_URL || 'https://peakerr.com/api/v2';
const SMM_API_KEY = process.env.SMM_API_KEY || '';
const LOW_BALANCE_THRESHOLD = parseFloat(process.env.LOW_BALANCE_THRESHOLD || '50');

// Admin giriş bilgileri
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Aklomanti';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AZC.anka.34';

const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_LOGIN_LOCKOUT_MS = 15 * 60 * 1000; 
let adminLoginAttempts = {}; 

// ====== sms.tc İçin İstek Kuyruğu ======
const PROVIDER_MIN_INTERVAL_MS = 2200;
let providerQueue = Promise.resolve();
let lastProviderCallAt = 0;

function providerGet(params, timeout) {
    const run = providerQueue.then(async () => {
        const wait = PROVIDER_MIN_INTERVAL_MS - (Date.now() - lastProviderCallAt);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastProviderCallAt = Date.now();
        // OnaylaSMS yerine doğrudan sms.tc API URL ve Key kullanılıyor
        return axios.get(SMSTC_API_URL, { 
            params: Object.assign({ api_key: SMSTC_API_KEY }, params), 
            timeout: timeout || 20000 
        });
    });
    providerQueue = run.then(() => {}, () => {});
    return run;
}
