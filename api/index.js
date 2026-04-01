const fetch = require('node-fetch');
const cheerio = require('cheerio');

const VERSION = 'v80';
const TTL = 5 * 60 * 1000;
let storageV80 = { posts: null, time: 0 };

function sanitize(html) {
    if (!html) return '';
    const $ = cheerio.load(html, null, false);
    $('.tgme_widget_message_reply, .tgme_widget_message_author_name, .tgme_widget_message_forwarded_from, .tgme_widget_message_inline_keyboard, .tgme_widget_message_read_more').remove();
    return $.html().trim().replace(/^(?:\s*<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>\s*)+$/gi, '');
}

// Функция для получения ПОЛНОГО текста конкретного поста, если он обрезан
async function getFullPostText(channel, postId) {
    try {
        const res = await fetch(`https://t.me/${channel}/${postId}?embed=1`);
        const html = await res.text();
        const $ = cheerio.load(html);
        const fullHtml = $('.tgme_widget_message_text').html();
        return fullHtml ? sanitize(fullHtml) : null;
    } catch (e) {
        return null;
    }
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    const { channel, limit = 5 } = req.query;
    if (!channel) return res.status(400).json({ error: 'No channel' });

    if (storageV80.posts && (Date.now() - storageV80.time < TTL)) {
        return res.status(200).json(storageV80.posts.slice(0, Number(limit)));
    }

    try {
        const response = await fetch(`https://t.me/s/${channel}`);
        const html = await response.text();
        const $ = cheerio.load(html);
        const results = [];

        // Собираем посты
        const elements = $('.tgme_widget_message').toArray();
        
        for (const el of elements) {
            const $el = $(el);
            const postId = $el.attr('data-post') ? $el.attr('data-post').split('/').pop() : null;
            if (!postId) continue;

            let textHtml = $el.find('.tgme_widget_message_text').html() || "";
            
            // ДЕТЕКТОР ОБРЕЗКИ: если текст кончается на "…" или содержит кнопку "Read more"
            if (textHtml.includes('…') || $el.find('.tgme_widget_message_read_more').length > 0) {
                const fullText = await getFullPostText(channel, postId);
                if (fullText) textHtml = fullText;
            }

            let image = null;
            const style = $el.find('.tgme_widget_message_photo_wrap').attr('style');
            if (style) {
                const m = style.match(/url\(['"]?(.+?)['"]?\)/);
                if (m) image = m[1];
            }

            const yt = textHtml.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"']+/i);
            const date = $el.find('time').attr('datetime');

            results.push({
                id: postId,
                text: textHtml.includes('…') ? textHtml : sanitize(textHtml), // Финальная чистка
                image,
                embed: yt ? { type: 'youtube', link: yt[0] } : null,
                date: date ? Math.floor(new Date(date).getTime() / 1000) : 0
            });
        }

        const sorted = results.sort((a, b) => b.date - a.date);
        storageV80 = { posts: sorted, time: Date.now() };
        
        return res.status(200).json(sorted.slice(0, Number(limit)));

    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};
