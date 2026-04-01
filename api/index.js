const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 5 * 60 * 1000; 
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v17'; // Поднял версию

let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

async function fetchWithTimeout(url, options = {}) {
    const { timeout = 10000 } = options;
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

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate'); // Кэш на стороне Vercel Edge

    if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });

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
        throw new Error('RSSHub returned no posts');
    } catch (e) {
        console.error('RSSHub failed, trying Web fallback...');
        try {
            const posts = await fetchFromTelegramWeb(channel);
            if (posts && posts.length > 0) {
                cachedData = { data: posts, timestamp: now, version: CACHE_VERSION };
                return res.status(200).json(posts.slice(offset, offset + limit));
            }
        } catch (e2) {
            console.error('Web fallback failed:', e2.message);
        }
        
        if (cachedData.data) return res.status(200).json(cachedData.data.slice(offset, offset + limit));
        return res.status(500).json({ error: 'Failed to fetch data' });
    }
};

async function fetchFromRSSHub(channel) {
    const response = await fetchWithTimeout(`https://rsshub.app/telegram/channel/${channel}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const rssText = await response.text();
    const $ = cheerio.load(rssText, { xmlMode: true });
    const posts = [];

    $('item').each((i, el) => {
        const title = $(el).find('title').text().trim();
        const description = $(el).find('description').text() || '';
        const link = $(el).find('link').text();
        const pubDate = $(el).find('pubDate').text();
        
        // Загружаем описание как HTML для манипуляций
        const $desc = cheerio.load(description);
        
        // 🔥 УДАЛЯЕМ те самые "загогулины" RSShub
        $desc('.rsshub-quote').remove(); 
        $desc('blockquote').remove();
        
        // Удаляем пустые ссылки, которые иногда остаются после вырезания цитат
        $desc('a').each((i, a) => {
            if ($desc(a).text().trim() === '' && $desc(a).find('img').length === 0) {
                $desc(a).remove();
            }
        });

        // Извлекаем основную картинку (если есть)
        let image = null;
        const imgTag = $desc('img').first();
        if (imgTag.length) {
            image = imgTag.attr('src');
            imgTag.remove(); // Убираем из текста, чтобы не дублировать с основным полем image
        }

        // Поиск YouTube
        let embed = null;
        const ytMatch = description.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"]+/i);
        if (ytMatch) {
            embed = { type: 'youtube', link: ytMatch[0], title: 'YouTube Video' };
        }

        // Получаем чистый HTML без лишних оберток
        let cleanHtml = $desc('body').html() || title;

        // Финальная чистка от лишних переносов в начале и конце
        cleanHtml = cleanHtml.replace(/^(?:\s*<br\s*\/?>\s*)+|(?:\s*<br\s*\/?>\s*)+$/gi, '').trim();

        posts.push({
            id: link.split('/').pop() || i,
            text: cleanHtml,
            image,
            embed,
            date: Math.floor(new Date(pubDate).getTime() / 1000)
        });
    });

    return posts.sort((a, b) => b.date - a.date);
}

async function fetchFromTelegramWeb(channel) {
    const response = await fetchWithTimeout(`https://t.me/s/${channel}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await response.text();
    const $ = cheerio.load(html);
    const posts = [];

    $('.tgme_widget_message').each((i, el) => {
        const $el = $(el);
        const textHtml = $el.find('.tgme_widget_message_text').html() || '';
        
        // Поиск картинки в веб-версии
        let image = null;
        const style = $el.find('.tgme_widget_message_photo_wrap').attr('style');
        if (style) {
            const match = style.match(/url\(['"]?(.+?)['"]?\)/);
            if (match) image = match[1];
        }

        const date = Math.floor(new Date($el.find('time').attr('datetime')).getTime() / 1000);
        const postId = $el.attr('data-post') ? $el.attr('data-post').split('/').pop() : i;

        if (textHtml || image) {
            posts.push({ id: postId, text: textHtml, image, date });
        }
    });
    return posts.sort((a, b) => b.date - a.date);
}
