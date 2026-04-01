const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 10 * 60 * 1000; 
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v30'; // Сбросим кэш

let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

function sanitizeContent(html) {
    if (!html) return '';
    // fragment: true предотвращает появление <html><body>
    const $ = cheerio.load(html, null, false);
    
    // Удаляем цитаты и мусор
    $('.rsshub-quote, blockquote, .tgme_widget_message_author_name, .tgme_widget_message_forwarded_from').remove();
    
    // Убираем пустые ссылки
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
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');

    const { channel, limit = POSTS_LIMIT, offset = 0 } = req.query;
    if (!channel) return res.status(400).json({ error: 'No channel' });

    if (cachedData.version !== CACHE_VERSION) cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
    if (cachedData.data && (Date.now() - cachedData.timestamp < CACHE_TTL)) {
        return res.status(200).json(cachedData.data.slice(Number(offset), Number(offset) + Number(limit)));
    }

    try {
        // ДОБАВИЛИ ?fulltext=1 чтобы RSSHub не резал текст
        const rssUrl = `https://rsshub.app/telegram/channel/${channel}?fulltext=1`;
        const response = await fetchWithTimeout(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await response.text();
        const $ = cheerio.load(text, { xmlMode: true });
        const posts = [];

        $('item').each((i, el) => {
            const desc = $(el).find('description').text() || '';
            const link = $(el).find('link').text() || '';
            
            const $desc = cheerio.load(desc, null, false);
            const image = $desc('img').first().attr('src') || null;
            $desc('img').remove();

            // Ищем YouTube ссылку для эмбеда
            const ytMatch = desc.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"']+/i);
            const embed = ytMatch ? { type: 'youtube', url: ytMatch[0] } : null;

            posts.push({
                id: link.split('/').pop() || i,
                text: sanitizeContent($desc.html()),
                image,
                embed,
                date: Math.floor(new Date($(el).find('pubDate').text()).getTime() / 1000)
            });
        });

        posts.sort((a, b) => b.date - a.date);
        cachedData = { data: posts, timestamp: Date.now(), version: CACHE_VERSION };
        return res.status(200).json(posts.slice(Number(offset), Number(offset) + Number(limit)));

    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};
