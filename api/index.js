const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 10 * 60 * 1000; 
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v40'; 

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
    if (!channel) return res.status(400).json({ error: 'No channel' });

    if (cachedData.version !== CACHE_VERSION) cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
    if (cachedData.data && (Date.now() - cachedData.timestamp < CACHE_TTL)) {
        return res.status(200).json(cachedData.data.slice(Number(offset), Number(offset) + Number(limit)));
    }

    try {
        // Пробуем официальный RSSHub с fulltext
        const rssUrl = `https://rsshub.rssforever.com/telegram/channel/${channel}?fulltext=1`;
        const response = await fetchWithTimeout(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await response.text();
        const $ = cheerio.load(text, { xmlMode: true });
        let posts = [];

        $('item').each((i, el) => {
            const rawDesc = $(el).find('description').text() || '';
            const $desc = cheerio.load(rawDesc, null, false);
            
            const ytMatch = rawDesc.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"']+/i);
            const embed = ytMatch ? { type: 'youtube', link: ytMatch[0] } : null;

            let image = null;
            $desc('img').each((idx, img) => {
                const src = $(img).attr('src');
                if (src && !src.includes('ytimg.com') && !src.includes('youtube.com')) {
                    image = src;
                    return false;
                }
            });

            $desc('img').remove();

            posts.push({
                id: $(el).find('link').text().split('/').pop() || String(i),
                text: sanitizeContent($desc.html()),
                image,
                embed,
                date: Math.floor(new Date($(el).find('pubDate').text()).getTime() / 1000)
            });
        });

        // ПРОВЕРКА: Если тексты обрезаны (есть "…"), бросаем ошибку, чтобы сработал фолбэк на Web
        const isTruncated = posts.some(p => p.text.includes('…') || p.text.includes('...'));
        if (posts.length === 0 || isTruncated) throw new Error('Truncated or empty');

        posts.sort((a, b) => b.date - a.date);
        cachedData = { data: posts, timestamp: Date.now(), version: CACHE_VERSION };
        return res.status(200).json(posts.slice(Number(offset), Number(offset) + Number(limit)));

    } catch (e) {
        // Если RSS подвел, парсим саму страницу Телеграма (там всегда ПОЛНЫЙ текст)
        const webPosts = await fetchFromTelegramWeb(channel);
        cachedData = { data: webPosts, timestamp: Date.now(), version: CACHE_VERSION };
        return res.status(200).json(webPosts.slice(Number(offset), Number(offset) + Number(limit)));
    }
};

async function fetchFromTelegramWeb(channel) {
    try {
        const response = await fetchWithTimeout(`https://t.me/s/${channel}`);
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
            if (textHtml || image) {
                posts.push({
                    id: $el.attr('data-post') ? $el.attr('data-post').split('/').pop() : String(i),
                    text: sanitizeContent(textHtml),
                    image,
                    embed: ytMatch ? { type: 'youtube', link: ytMatch[0] } : null,
                    date: Math.floor(new Date($el.find('time').attr('datetime')).getTime() / 1000) || 0
                });
            }
        });
        return posts.sort((a, b) => b.date - a.date);
    } catch (e) { return []; }
}
