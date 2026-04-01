const fetch = require('node-fetch');
const cheerio = require('cheerio');

// Смена версии заставит сервер очистить память
const CACHE_VERSION = 'v60'; 
const CACHE_TTL = 5 * 60 * 1000; 

let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

function sanitizeContent(html) {
    if (!html) return '';
    // Используем xmlMode: false чтобы не плодить <html><body>
    const $ = cheerio.load(html, null, false);
    
    // Удаляем мусор телеграма
    $('.tgme_widget_message_reply, .tgme_widget_message_author_name, .tgme_widget_message_forwarded_from, .tgme_widget_message_inline_keyboard').remove();
    
    // Удаляем кнопку "Read more", если она пришла в HTML
    $('.tgme_widget_message_read_more').remove();

    return $.html().trim().replace(/^(?:\s*<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>\s*)+$/gi, '');
}

module.exports = async (req, res) => {
    // Убиваем кэширование на всех уровнях
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const { channel, limit = 5, offset = 0 } = req.query;
    if (!channel) return res.status(400).json({ error: 'No channel' });

    if (cachedData.version !== CACHE_VERSION) {
        cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
    }

    // Если кэш свежий — отдаем его
    if (cachedData.data && (Date.now() - cachedData.timestamp < CACHE_TTL)) {
        const sliced = cachedData.data.slice(Number(offset), Number(offset) + Number(limit));
        return res.status(200).json(sliced);
    }

    try {
        // Запрашиваем напрямую публичную веб-страницу канала
        const response = await fetch(`https://t.me/s/${channel}`, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
            }
        });
        
        const html = await response.text();
        const $ = cheerio.load(html);
        const posts = [];

        $('.tgme_widget_message').each((i, el) => {
            const $el = $(el);
            
            // ТЕКСТ: Ищем именно блок с текстом
            const $textEl = $el.find('.tgme_widget_message_text');
            const textHtml = $textEl.html() || "";

            // КАРТИНКА
            let image = null;
            const photoWrap = $el.find('.tgme_widget_message_photo_wrap').attr('style');
            if (photoWrap) {
                const m = photoWrap.match(/url\(['"]?(.+?)['"]?\)/);
                if (m) image = m[1];
            }

            // ВИДЕО/YouTube
            const ytMatch = textHtml.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"']+/i);
            
            // ДАТА
            const dateStr = $el.find('time').attr('datetime');
            const ts = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0;

            if (textHtml || image) {
                posts.push({
                    id: $el.attr('data-post') ? $el.attr('data-post').split('/').pop() : String(i),
                    text: sanitizeContent(textHtml),
                    image: image,
                    embed: ytMatch ? { type: 'youtube', link: ytMatch[0] } : null,
                    date: ts
                });
            }
        });

        // Сортируем (свежие сверху) и сохраняем
        const finalPosts = posts.sort((a, b) => b.date - a.date);
        
        if (finalPosts.length > 0) {
            cachedData = { data: finalPosts, timestamp: Date.now(), version: CACHE_VERSION };
            return res.status(200).json(finalPosts.slice(Number(offset), Number(offset) + Number(limit)));
        } else {
            throw new Error("No posts found on page");
        }

    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};
