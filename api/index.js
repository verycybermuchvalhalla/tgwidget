const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 5 * 60 * 1000; // 5 минут
const POSTS_LIMIT = 10;
const CACHE_VERSION = 'v50'; 

let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

function sanitizeContent(html) {
    if (!html) return '';
    const $ = cheerio.load(html, null, false);
    // Чистим мусор телеграма
    $('.tgme_widget_message_author_name, .tgme_widget_message_forwarded_from, .tgme_widget_message_reply').remove();
    $('a:empty').remove();
    let result = $.html().trim();
    return result.replace(/^(?:\s*<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>\s*)+$/gi, '');
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10000);
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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); // Запрещаем кэш браузеру

    const { channel, limit = POSTS_LIMIT, offset = 0 } = req.query;
    if (!channel) return res.status(400).json({ error: 'No channel' });

    // Сброс кэша
    if (cachedData.version !== CACHE_VERSION) {
        cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
    }

    // Если в кэше пусто или он протух — тянем заново
    if (!cachedData.data || (Date.now() - cachedData.timestamp > CACHE_TTL)) {
        try {
            // Идем ПРЯМО в Телеграм (через s/ версию)
            // Добавляем ?before=9999999 чтобы сбросить кэш самого телеграма
            const response = await fetchWithTimeout(`https://t.me/s/${channel}?v=${Date.now()}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            
            const html = await response.text();
            const $ = cheerio.load(html);
            const posts = [];

            $('.tgme_widget_message').each((i, el) => {
                const $el = $(el);
                const textHtml = $el.find('.tgme_widget_message_text').html() || "";
                
                // Картинка
                let image = null;
                const photoWrap = $el.find('.tgme_widget_message_photo_wrap').attr('style');
                if (photoWrap) {
                    const m = photoWrap.match(/url\(['"]?(.+?)['"]?\)/);
                    if (m) image = m[1];
                }

                // Видео/YouTube
                const ytMatch = textHtml.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"']+/i);
                
                // Дата
                const dateStr = $el.find('time').attr('datetime');
                const timestamp = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0;

                if (textHtml || image) {
                    posts.push({
                        id: $el.attr('data-post') ? $el.attr('data-post').split('/').pop() : String(i),
                        text: sanitizeContent(textHtml),
                        image: image,
                        embed: ytMatch ? { type: 'youtube', link: ytMatch[0] } : null,
                        date: timestamp
                    });
                }
            });

            if (posts.length > 0) {
                posts.sort((a, b) => b.date - a.date);
                cachedData = { data: posts, timestamp: Date.now(), version: CACHE_VERSION };
            } else {
                throw new Error("Telegram blocked or no posts");
            }
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // Отдаем данные
    const result = cachedData.data.slice(Number(offset), Number(offset) + Number(limit));
    return res.status(200).json(result);
};
