const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 5 * 60 * 1000; // 5 минут
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v20'; // Новая версия для сброса старого кэша

let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

/**
 * Чистка HTML от "загогулин" RSSHub и лишнего мусора
 */
function cleanPostHTML(html, $) {
    const $content = cheerio.load(html);
    
    // Удаляем блоки превью и цитат, которые сует RSSHub
    $content('.rsshub-quote, blockquote, .tgme_widget_message_author_name').remove();
    
    // Удаляем пустые ссылки и лишние переносы
    $content('a').each((i, el) => {
        if ($content(el).text().trim() === '' && $content(el).find('img').length === 0) {
            $content(el).remove();
        }
    });

    let clean = $content('body').html() || '';
    return clean.replace(/^(?:\s*<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>\s*)+$/gi, '').trim();
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
    if (cachedData.version !== CACHE_VERSION) cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
    if (cachedData.data && (now - cachedData.timestamp < CACHE_TTL)) {
        return res.status(200).json(cachedData.data.slice(offset, offset + limit));
    }

    try {
        console.log('Trying RSSHub...');
        const posts = await fetchFromRSSHub(channel);
        if (posts && posts.length > 0) {
            cachedData = { data: posts, timestamp: now, version: CACHE_VERSION };
            return res.status(200).json(posts.slice(offset, offset + limit));
        }
        throw new Error('RSSHub empty');
    } catch (e) {
        console.warn('RSSHub failed, trying Web fallback...');
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
    if (!response.ok) throw new Error('RSSHub Down');
    
    const text = await response.text();
    const $ = cheerio.load(text, { xmlMode: true });
    const posts = [];

    $('item').each((i, el) => {
        const description = $(el).find('description').text() || '';
        const link = $(el).find('link').text() || '';
        const pubDate = $(el).find('pubDate').text();

        const $temp = cheerio.load(description);
        let image = $temp('img').first().attr('src') || null;
        
        // Поиск YouTube
        let embed = null;
        const ytMatch = description.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"]+/i);
        if (ytMatch) embed = { type: 'youtube', link: ytMatch[0], title: 'YouTube' };

        posts.push({
            id: link.split('/').pop() || i,
            text: cleanPostHTML(description),
            image,
            embed,
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
                text: cleanPostHTML(textHtml),
                image,
                date
            });
        }
    });
    return posts.sort((a, b) => b.date - a.date);
}
