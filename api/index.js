const fetch = require('node-fetch');
const cheerio = require('cheerio');

// --- НАСТРОЙКИ ---
const CACHE_TTL = 10 * 60 * 1000; // 10 минут
const POSTS_LIMIT = 5;            // 5 постов за запрос
// -----------------

// Хранилище кэша в памяти
let cachedData = {
    data: null,
    timestamp: 0
};

module.exports = async (req, res) => {
    // CORS заголовки
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Только GET запросы' });
    }

    const channel = req.query.channel;
    const limit = parseInt(req.query.limit) || POSTS_LIMIT;
    const offset = parseInt(req.query.offset) || 0;

    if (!channel) {
        return res.status(400).json({ error: 'Укажите параметр channel' });
    }

    // Проверка кэша
    const now = Date.now();
    if (cachedData.data && (now - cachedData.timestamp < CACHE_TTL)) {
        console.log('📦 Отдаю из кэша:', channel);
        const sliced = cachedData.data.slice(offset, offset + limit);
        return res.status(200).json(sliced);
    }

    // Загрузка данных из Telegram
    console.log('🌐 Качаю свежие данные:', channel);
    try {
        const response = await fetch(`https://t.me/s/${channel}`);
        const html = await response.text();
        const $ = cheerio.load(html);
        const posts = [];

        $('.tgme_widget_message').each((i, el) => {
            // Сохраняем HTML с форматированием
            const textHtml = $(el).find('.tgme_widget_message_text').html() || '';

            const imageStyle = $(el).find('.tgme_widget_message_photo_wrap').attr('style');
            const dateAttr = $(el).find('.tgme_widget_message_date time').attr('datetime');
            const date = dateAttr ? Math.floor(new Date(dateAttr).getTime() / 1000) : 0;
            const postId = $(el).attr('data-post') ? $(el).attr('data-post').split('/').pop() : '';

            let image = null;
            if (imageStyle) {
                const match = imageStyle.match(/url\('(.+?)'\)/);
                if (match) image = match[1];
            }

            if (textHtml || image) {
                posts.push({
                    text: textHtml,
                    image,
                    date,
                    id: postId
                });
            }
        });

        // Сортировка: новые сверху
        posts.sort((a, b) => b.date - a.date);

        // Сохраняем в кэш
        cachedData = {
            data: posts,
            timestamp: now
        };

        // Отдаём нужную порцию
        const sliced = posts.slice(offset, offset + limit);
        return res.status(200).json(sliced);

    } catch (e) {
        // Если ошибка, но есть кэш — отдаём его
        if (cachedData.data) {
            console.warn('⚠️ Ошибка загрузки, отдаю старый кэш');
            const sliced = cachedData.data.slice(offset, offset + limit);
            return res.status(200).json(sliced);
        }
        return res.status(500).json({ error: e.message });
    }
};
