const fetch = require('node-fetch');
const cheerio = require('cheerio');

// Константы
const CACHE_TTL = 5 * 60 * 1000; 
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v21'; // Подняли версию, чтобы сбросить старый "битый" кэш

let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

/**
 * Чистка контента от мусора RSSHub и Telegram Web
 */
function cleanContent(html) {
    if (!html) return '';
    const $ = cheerio.load(html);
    
    // Удаляем цитаты RSSHub и служебные блоки
    $('.rsshub-quote, blockquote, .tgme_widget_message_author_name, .tgme_widget_message_forwarded_from').remove();
    
    // Убираем пустые ссылки
    $('a').each((i, el) => {
        if ($(el).text().trim() === '' && $(el).find('img').length === 0) {
            $(el).remove();
        }
    });

    return $.html().trim();
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

    const channel = req.query.channel;
    const limit = parseInt(req.query.limit) || POSTS_LIMIT;
    const offset = parseInt(req.query.offset) || 0;

    if (!channel) return res.status(400).json({ error: 'No channel' });

    const now = Date.now();
    
    // Сброс кэша при смене версии кода
    if (cachedData.version !== CACHE_VERSION) {
        cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
    }

    if (cachedData.data && (now - cachedData.timestamp < CACHE_TTL)) {
        return res.status(200).json(cachedData.data.slice(offset, offset + limit));
    }

    try {
        const posts = await fetchFromRSSHub(channel);
        if (posts && posts.length > 0) {
            cachedData = { data: posts, timestamp: now, version: CACHE_VERSION };
            return res.status(200).json(posts.slice(offset, offset + limit));
        }
        throw new Error('RSSHub empty');
    } catch (e) {
        console.warn('RSSHub failed, fallback to Web...');
        try {
            const posts = await fetchFromTelegramWeb(channel);
            if (posts && posts.length > 0) {
                cachedData = { data: posts, timestamp: now, version: CACHE_VERSION };
                return res.status(200).json(posts.slice(offset, offset + limit));
            }
        } catch (e2) {
            console.error('All methods failed');
        }
        
        if (cachedData.data) return res.status(200).json(cachedData.data.slice(offset, offset + limit));
        return res.status(500).json({ error: 'Failed' });
    }
};

async function fetchFromRSSHub(channel) {
    // Используем современный URL API вместо url.parse()
    const targetUrl = new URL(`https://rsshub.app/telegram/channel/${channel}`);
    const response = await fetchWithTimeout(targetUrl.href, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    if (!response.ok) throw new Error(`RSSHub status ${response.status}`);
    
    const text = await response.text();
    const $ = cheerio.load(text, { xmlMode: true });
    const posts = [];

    $('item').each((i, el) => {
        const description = $(el).find('description').text() || '';
        const link = $(el).find('link').text() || '';
        const pubDate = $(el).find('pubDate').text();

        const $temp = cheerio.load(description);
        const image = $temp('img').first().attr('src') || null;
        
        posts.push({
            id: link.split('/').pop() || Date.now() + i,
            text: cleanContent(description), // Чистим от "загогулин"
            image,
            date: Math.floor(new Date(pubDate).getTime() / 1000)
        });
    });

    return posts.sort((a, b) => b.date - a.date); // Сортировка по дате
}

async function fetchFromTelegramWeb(channel) {
    const response = await fetchWithTimeout(`https://t.me/s/${channel}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const posts = [];

    $('.tgme_widget_message').each((i, el) => {
        const $el = $(el);
        const textHtml = $el.find('.tgme_widget_message_text').html() || '';
        
        let image = null;
        const photoStyle = $el.find('.tgme_widget_message_photo_wrap').attr('style');
        if (photoStyle) {
            const m = photoStyle.match(/url\(['"]?(.+?)['"]?\)/);
            if (m) image = m[1];
        }

        const dateStr = $el.find('time').attr('datetime');
        const date = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0;

        if (textHtml || image) {
            posts.push({
                id: $el.attr('data-post') ? $el.attr('data-post').split('/').pop() : i,
                text: cleanContent(textHtml),
                image,
                date
            });
        }
    });
    return posts.sort((a, b) => b.date - a.date);
}
