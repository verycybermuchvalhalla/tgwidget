const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 5 * 60 * 1000; 
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v25'; // Смена версии сбросит старый плохой кэш

let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

// Умная очистка контента
function sanitizeHtml(html) {
    if (!html) return '';
    const $ = cheerio.load(html);
    
    // Удаляем всё, что RSSHub сует в начало (цитаты, повторы автора)
    $('.rsshub-quote, blockquote, .tgme_widget_message_author_name, .tgme_widget_message_forwarded_from').remove();
    
    // Убираем пустые элементы и лишние переносы
    $('a:empty, p:empty').remove();
    
    let result = $.html().trim();
    // Чистим "хвосты" из <br>
    return result.replace(/^(?:\s*<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>\s*)+$/gi, '');
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
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');

    const { channel, limit = POSTS_LIMIT, offset = 0 } = req.query;
    if (!channel) return res.status(400).json({ error: 'No channel' });

    const now = Date.now();
    if (cachedData.version !== CACHE_VERSION) {
        cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
    }

    if (cachedData.data && (now - cachedData.timestamp < CACHE_TTL)) {
        return res.status(200).json(cachedData.data.slice(Number(offset), Number(offset) + Number(limit)));
    }

    let posts = [];
    try {
        console.log('--- Attempting RSSHub ---');
        posts = await fetchFromRSSHub(channel);
    } catch (e) {
        console.warn('--- RSSHub failed, switching to Web ---', e.message);
        try {
            posts = await fetchFromTelegramWeb(channel);
        } catch (e2) {
            console.error('--- Critical: Both methods failed ---');
        }
    }

    if (posts.length > 0) {
        // Всегда сортируем по дате (свежие сверху)
        posts.sort((a, b) => b.date - a.date);
        cachedData = { data: posts, timestamp: now, version: CACHE_VERSION };
        return res.status(200).json(posts.slice(Number(offset), Number(offset) + Number(limit)));
    }

    if (cachedData.data) return res.status(200).json(cachedData.data.slice(Number(offset), Number(offset) + Number(limit)));
    res.status(500).json({ error: 'All sources failed' });
};

async function fetchFromRSSHub(channel) {
    const response = await fetchWithTimeout(`https://rsshub.app/telegram/channel/${channel}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!response.ok) throw new Error('RSSHub bad response');
    
    const text = await response.text();
    const $ = cheerio.load(text, { xmlMode: true });
    const items = [];

    $('item').each((i, el) => {
        const desc = $(el).find('description').text();
        const $temp = cheerio.load(desc);
        const image = $temp('img').first().attr('src') || null;
        
        items.push({
            id: $(el).find('link').text().split('/').pop() || i,
            text: sanitizeHtml(desc),
            image,
            date: Math.floor(new Date($(el).find('pubDate').text()).getTime() / 1000)
        });
    });
    return items;
}

async function fetchFromTelegramWeb(channel) {
    const response = await fetchWithTimeout(`https://t.me/s/${channel}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const items = [];

    $('.tgme_widget_message').each((i, el) => {
        const $el = $(el);
        const textHtml = $el.find('.tgme_widget_message_text').html();
        let image = null;
        const photoStyle = $el.find('.tgme_widget_message_photo_wrap').attr('style');
        if (photoStyle) {
            const m = photoStyle.match(/url\(['"]?(.+?)['"]?\)/);
            if (m) image = m[1];
        }

        const dateStr = $el.find('time').attr('datetime');
        if (textHtml || image) {
            items.push({
                id: $el.attr('data-post') ? $el.attr('data-post').split('/').pop() : i,
                text: sanitizeHtml(textHtml),
                image,
                date: dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0
            });
        }
    });
    return items;
}
