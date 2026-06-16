const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 10 * 60 * 1000; // 10 минут in-memory кэш
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v33'; // Увеличил версию, чтобы сбросить старый кэш при деплое

// ✅ Структура кэша с явным ключом data и версией
let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

// Функция очистки HTML от мусора
function sanitizeContent(html) {
    if (!html) return '';
    const $ = cheerio.load(html, null, false);
    $('.rsshub-quote, blockquote, .tgme_widget_message_author_name, .tgme_widget_message_forwarded_from').remove();
    $('a:empty').remove();
    return $.html().trim().replace(/^(?:\s*<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>\s*)+$/gi, '');
}

// Функция запроса с таймаутом (12 секунд)
async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 12000);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

module.exports = async (req, res) => {
    // 1. Заголовки CORS и CDN-кэширования (КРИТИЧЕСКИ ВАЖНО)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');

    const { channel, limit = POSTS_LIMIT, offset = 0 } = req.query;
    if (!channel) return res.status(400).json({ error: 'No channel provided' });

    // 2. Проверка in-memory кэша (пока инстанс Vercel "теплый")
    if (cachedData.version !== CACHE_VERSION) {
        cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
    }
    if (cachedData.data && (Date.now() - cachedData.timestamp < CACHE_TTL)) {
        return res.status(200).json(cachedData.data.slice(Number(offset), Number(offset) + Number(limit)));
    }

    let debugLog = { web: null, rss: null };

    try {
        // 🚀 ШАГ 1: СНАЧАЛА пробуем быстрый парсинг напрямую с t.me
        const webPosts = await fetchFromTelegramWeb(channel);
        
        if (webPosts && webPosts.length > 0) {
            cachedData = { data: webPosts, timestamp: Date.now(), version: CACHE_VERSION };
            return res.status(200).json(webPosts.slice(Number(offset), Number(offset) + Number(limit)));
        }
        
        // Если постов нет (или верстка поменялась), кидаем ошибку для перехода к fallback
        throw new Error('Web returned 0 posts');

    } catch (webError) {
        debugLog.web = webError.message;
        
        // 🐢 ШАГ 2: Если t.me не сработал, идем в медленный, но стабильный RSSHub
        try {
            const rssUrl = `https://rsshub.rssforever.com/telegram/channel/${channel}?fulltext=1`;
            const response = await fetchWithTimeout(rssUrl, { 
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } 
            });
            
            if (!response.ok) throw new Error(`RSSHub Status ${response.status}`);
            
            const text = await response.text();
            const $ = cheerio.load(text, { xmlMode: true });
            const posts = [];
            
            $('item').each((i, el) => {
                const $item = $(el);
                let desc = $item.find('description').text(); 
                const $desc = cheerio.load(desc, null, false);
                const image = $desc('img').first().attr('src') || null;
                $desc('img').remove();
                const ytMatch = desc.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"']+/i);
                const embed = ytMatch ? { type: 'youtube', link: ytMatch[0] } : null;
                posts.push({
                    id: $item.find('link').text().split('/').pop() || String(i),
                    text: sanitizeContent($desc.html()),
                    image,
                    embed,
                    date: Math.floor(new Date($item.find('pubDate').text()).getTime() / 1000)
                });
            });
            
            if (posts.length === 0) throw new Error('RSSHub returned 0 items');
            posts.sort((a, b) => b.date - a.date);
            
            cachedData = { data: posts, timestamp: Date.now(), version: CACHE_VERSION };
            return res.status(200).json(posts.slice(Number(offset), Number(offset) + Number(limit)));
            
        } catch (rssError) {
            debugLog.rss = rssError.message;
            // Если оба метода упали, возвращаем 500 ошибку с деталями
            return res.status(500).json({ error: 'All failed', details: debugLog });
        }
    }
};

// Вспомогательная функция для прямого парсинга веб-версии Telegram
async function fetchFromTelegramWeb(channel) {
    const response = await fetchWithTimeout(`https://t.me/s/${channel}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const posts = [];
    
    $('.tgme_widget_message').each((i, el) => {
        const $el = $(el);
        const textHtml = $el.find('.tgme_widget_message_text').html();
        let image = null;
        const photoStyle = $el.find('.tgme_widget_message_photo_wrap').attr('style');
        if (photoStyle) {
            const m = photoStyle.match(/url\(['"]?(.+?)['"]?\)/);
            if (m) image = m[1];
        }
        const ytMatch = textHtml ? textHtml.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"']+/i) : null;
        const embed = ytMatch ? { type: 'youtube', link: ytMatch[0] } : null;
        const dateStr = $el.find('time').attr('datetime');
        
        if (textHtml || image) {
            posts.push({
                id: $el.attr('data-post') ? $el.attr('data-post').split('/').pop() : String(i),
                text: sanitizeContent(textHtml),
                image,
                embed,
                date: dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0
            });
        }
    });
    return posts.sort((a, b) => b.date - a.date);
}
