const fetch = require('node-fetch');
const cheerio = require('cheerio');

// Настройки
const CACHE_TTL = 10 * 60 * 1000; // 10 минут
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v26'; // Новая версия для сброса старого кэша

let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

/**
 * Вспомогательная функция для fetch с таймаутом
 */
async function fetchWithTimeout(url, options = {}) {
    const { timeout = 12000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

/**
 * Чистка контента от мусора RSSHub и лишних оберток Cheerio
 */
function sanitizeContent(html) {
    if (!html) return '';
    
    // Загружаем фрагмент. fragment: true предотвращает добавление html/body
    const $ = cheerio.load(html, null, false);
    
    // 1. Удаляем цитаты RSSHub ("загогулины") и служебную инфу
    $('.rsshub-quote, blockquote, .tgme_widget_message_author_name, .tgme_widget_message_forwarded_from').remove();
    
    // 2. Удаляем пустые ссылки и параграфы, которые могут остаться после удаления цитат
    $('a').each((i, el) => {
        if ($(el).text().trim() === '' && $(el).find('img').length === 0) {
            $(el).remove();
        }
    });

    // 3. Вытаскиваем результат
    let result = $.html().trim();
    
    // 4. Финальная чистка от лишних переносов строк в начале и в конце
    return result.replace(/^(?:\s*<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>\s*)+$/gi, '');
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');

    const channel = req.query.channel;
    const limit = parseInt(req.query.limit) || POSTS_LIMIT;
    const offset = parseInt(req.query.offset) || 0;

    if (!channel) return res.status(400).json({ error: 'No channel' });

    const now = Date.now();
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
        console.warn('RSSHub failed, trying Web fallback...', e.message);
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
        return res.status(500).json({ error: 'Failed to fetch' });
    }
};

async function fetchFromRSSHub(channel) {
    const response = await fetchWithTimeout(`https://rsshub.app/telegram/channel/${channel}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    const text = await response.text();
    const $ = cheerio.load(text, { xmlMode: true });
    const posts = [];

    $('item').each((i, el) => {
        const description = $(el).find('description').text() || '';
        const link = $(el).find('link').text() || '';
        const pubDate = $(el).find('pubDate').text();

        // Обрабатываем описание отдельно
        const $desc = cheerio.load(description);
        
        // Сначала достаем картинку
        let image = $desc('img').first().attr('src') || null;
        // Удаляем все картинки из текста, чтобы они не дублировались в JSON
        $desc('img').remove();

        posts.push({
            id: link.split('/').pop() || i,
            text: sanitizeContent($desc.html()),
            image: image,
            date: Math.floor(new Date(pubDate).getTime() / 1000)
        });
    });
    return posts.sort((a, b) => b.date - a.date);
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
        const textHtml = $el.find('.tgme_widget_message_text').html();
        
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
                text: sanitizeContent(textHtml),
                image,
                date
            });
        }
    });
    return posts.sort((a, b) => b.date - a.date);
}
