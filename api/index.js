const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 10 * 60 * 1000;
const POSTS_LIMIT = 5;

let cachedData = { data: null, timestamp: 0 };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });

  const channel = req.query.channel;
  const limit = parseInt(req.query.limit) || POSTS_LIMIT;
  const offset = parseInt(req.query.offset) || 0;

  if (!channel) return res.status(400).json({ error: 'No channel' });

  const now = Date.now();
  if (cachedData.data && (now - cachedData.timestamp < CACHE_TTL)) {
    console.log('📦 Cache hit:', channel);
    return res.status(200).json(cachedData.data.slice(offset, offset + limit));
  }

  console.log('🌐 Fetching:', channel);
  try {
    const response = await fetch(`https://t.me/s/${channel}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const posts = [];

    $('.tgme_widget_message').each((i, el) => {
      const textHtml = $(el).find('.tgme_widget_message_text').html() || '';
      
      // 1. Картинки
      const imageStyle = $(el).find('.tgme_widget_message_photo_wrap').attr('style');
      let image = null;
      if (imageStyle) {
        const match = imageStyle.match(/url\('(.+?)'\)/);
        if (match) image = match[1];
      }

      // 2. Эмбеды (Видео YouTube, превью ссылок и т.д.)
      const embed = $(el).find('.tgme_widget_message_embed').first();
      let embedData = null;
      if (embed.length > 0) {
        const embedLink = embed.find('.tgme_widget_message_embed_title').attr('href');
        const embedTitle = embed.find('.tgme_widget_message_embed_title').text().trim();
        const embedImage = embed.find('.tgme_widget_message_embed_photo').attr('style');
        
        if (embedLink || embedTitle) {
          embedData = {
            link: embedLink,
            title: embedTitle,
            image: embedImage ? embedImage.match(/url\('(.+?)'\)/)?.[1] : null
          };
        }
      }

      const dateAttr = $(el).find('.tgme_widget_message_date time').attr('datetime');
      const date = dateAttr ? Math.floor(new Date(dateAttr).getTime() / 1000) : 0;
      const postId = $(el).attr('data-post') ? $(el).attr('data-post').split('/').pop() : '';

      if (textHtml || image || embedData) {
        posts.push({ text: textHtml, image, embed: embedData, date, id: postId });
      }
    });

    posts.sort((a, b) => b.date - a.date);
    cachedData = { data: posts, timestamp: now };

    return res.status(200).json(posts.slice(offset, offset + limit));
  } catch (e) {
    if (cachedData.data) {
      return res.status(200).json(cachedData.data.slice(offset, offset + limit));
    }
    return res.status(500).json({ error: e.message });
  }
};
