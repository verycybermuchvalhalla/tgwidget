const fetch = require('node-fetch');
const cheerio = require('cheerio');
const CACHE_TTL = 10 * 60 * 1000; 
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v32'; 
// ✅ ИСПРАВЛЕНО: Добавлен ключ "data"
let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
function sanitizeContent(html) {
    if (!html) return '';
    // Используем xmlMode: false для корректного рендеринга HTML фрагмента
    const $ = cheerio.load(html, null, false);
    $('.rsshub-quote, blockquote, .tgme_widget_message_author_name, .tgme_widget_message_forwarded_from').remove();
    $('a:empty').remove();
    return $.html().trim().replace(/^(?:\s*<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>\s*)+$/gi, '');
}
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
    const { channel, limit = POSTS_LIMIT, offset = 0 } = req.query;
    if (!channel) return res.status(400).json({ error: 'No channel provided' });
    // ✅ ИСПРАВЛЕНО: Правильный сброс объекта
    if (cachedData.version !== CACHE_VERSION) {
        cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
    }
    if (cachedData.data && (Date.now() - cachedData.timestamp < CACHE_TTL)) {
        return res.status(200).json(cachedData.data.slice(Number(offset), Number(offset) + Number(limit)));
    }
    let debugLog = { rss: null, web: null };
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
            let desc = $item.find('description').text(); // RSS обычно хранит HTML внутри как текст или CDATA
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
        // ✅ ИСПРАВЛЕНО: ключ data
        cachedData = { data: posts, timestamp: Date.now(), version: CACHE_VERSION };
        return res.status(200).json(posts.slice(Number(offset), Number(offset) + Number(limit)));
    } catch (e) {
        debugLog.rss = e.message;
        try {
        // 1. СНАЧАЛА пробуем быстрый парсинг напрямую с t.me
        const webPosts = await fetchFromTelegramWeb(channel);
        
        if (webPosts && webPosts.length > 0) {
            cachedData = { data: webPosts, timestamp: Date.now(), version: CACHE_VERSION };
            return res.status(200).json(webPosts.slice(Number(offset), Number(offset) + Number(limit)));
        }
        
        // Если постов нет (или верстка поменялась и парсер вернул пустоту), 
        // кидаем ошибку, чтобы уйти в fallback
        throw new Error('Web returned 0 posts');

    } catch (webError) {
        debugLog.web = webError.message;
        
        // 2. Если t.me не сработал (ошибка сети, таймаут и т.д.), 
        // идем в медленный, но более стабильный по структуре RSSHub
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
