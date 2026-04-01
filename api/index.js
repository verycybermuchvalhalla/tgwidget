const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 10 * 60 * 1000; 
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v31'; // Сброс кэша

let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

function sanitizeContent(html) {
    if (!html) return '';
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
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');

    const { channel, limit = POSTS_LIMIT, offset = 0 } = req.query;
    if (!channel) return res.status(400).json({ error: 'No channel provided in URL' });

    if (cachedData.version !== CACHE_VERSION) cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
    if (cachedData.data && (Date.now() - cachedData.timestamp < CACHE_TTL)) {
        return res.status(200).json(cachedData.data.slice(Number(offset), Number(offset) + Number(limit)));
    }

    let debugLog = { rss: null, web: null };

    try {
        const rssUrl = `https://rsshub.henry.wang/telegram/channel/${channel}?fulltext=1`;
        const response = await fetchWithTimeout(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!response.ok) throw new Error(`RSSHub HTTP Status ${response.status}`);
        
        const text = await response.text();
        const $ = cheerio.load(text, { xmlMode: true });
        const posts = [];

        $('item').each((i, el) => {
            const desc = $(el).find('description').text() || '';
            const link = $(el).find('link').text() || '';
            
            const $desc = cheerio.load(desc, null, false);
            const image = $desc('img').first().attr('src') || null;
            $desc('img').remove();

            const ytMatch = desc.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"']+/i);
            const embed = ytMatch ? { type: 'youtube', link: ytMatch[0] } : null;

            posts.push({
                id: link.split('/').pop() || i,
                text: sanitizeContent($desc.html()),
                image,
                embed,
                date: Math.floor(new Date($(el).find('pubDate').text()).getTime() / 1000)
            });
        });

        if (posts.length === 0) throw new Error('RSSHub returned 0 items');

        posts.sort((a, b) => b.date - a.date);
        cachedData = { data: posts, timestamp: Date.now(), version: CACHE_VERSION };
        return res.status(200).json(posts.slice(Number(offset), Number(offset) + Number(limit)));

    } catch (e) {
        debugLog.rss = e.message;
        
        // Фолбэк на Web
        try {
            const webPosts = await fetchFromTelegramWeb(channel);
            if (webPosts && webPosts.length > 0) {
                cachedData = { data: webPosts, timestamp: Date.now(), version: CACHE_VERSION };
                return res.status(200).json(webPosts.slice(Number(offset), Number(offset) + Number(limit)));
            } else {
                throw new Error('Telegram Web returned 0 items. Possible block.');
            }
        } catch (e2) {
            debugLog.web = e2.message;
        }

        // Если дошли сюда, значит упали оба метода
        return res.status(500).json({ 
            error: 'All fetch methods failed', 
            details: debugLog 
        });
    }
};

async function fetchFromTelegramWeb(channel) {
    const response = await fetchWithTimeout(`https://t.me/s/${channel}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    
    if (!response.ok) throw new Error(`Web HTTP Status ${response.status}`);
    
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
        const date = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0;

        if (textHtml || image) {
            posts.push({
                id: $el.attr('data-post') ? $el.attr('data-post').split('/').pop() : i,
                text: sanitizeContent(textHtml),
                image,
                embed,
                date
            });
        }
    });
    
    return posts.sort((a, b) => b.date - a.date);
}
