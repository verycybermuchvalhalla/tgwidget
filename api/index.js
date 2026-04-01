const fetch = require('node-fetch');
const cheerio = require('cheerio');

module.exports = async (req, res) => {
    // Разрешаем CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Только GET запросы' });
    }

    const channel = req.query.channel;
    if (!channel) {
        return res.status(400).json({ error: 'Укажите параметр channel' });
    }

    try {
        const response = await fetch(`https://t.me/s/${channel}`);
        const html = await response.text();
        const $ = cheerio.load(html);
        const posts = [];

        $('.tgme_widget_message').each((i, el) => {
            const text = $(el).find('.tgme_widget_message_text').text().trim();
            const imageStyle = $(el).find('.tgme_widget_message_photo_wrap').attr('style');
            const dateAttr = $(el).find('.tgme_widget_message_date time').attr('datetime');
            const date = dateAttr ? Math.floor(new Date(dateAttr).getTime() / 1000) : 0;

            let image = null;
            if (imageStyle) {
                const match = imageStyle.match(/url\('(.+?)'\)/);
                if (match) image = match[1];
            }

            if (text || image) {
                posts.push({ text, image, date });
            }
        });

        // Сортируем: новые сверху
        posts.sort((a, b) => b.date - a.date);

        res.status(200).json(posts.slice(0, 10));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
