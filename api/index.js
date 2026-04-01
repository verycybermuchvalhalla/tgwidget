const fetch = require('node-fetch');
const cheerio = require('cheerio');

// --- НАСТРОЙКИ ---
const CACHE_TTL = 10 * 60 * 1000; // 10 минут
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v5'; // 🔁 Изменил версию (сбросит кэш)
// -----------------

let cachedData = {
  data: null,
  timestamp: 0,
  version: CACHE_VERSION
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

  const now = Date.now();

  // Сброс кэша если версия изменилась
  if (cachedData.version !== CACHE_VERSION) {
    console.log('🔄 Версия кэша устарела, сбрасываю');
    cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
  }

  // Проверка кэша
  if (cachedData.data && (now - cachedData.timestamp < CACHE_TTL)) {
    console.log('📦 Отдаю из кэша:', channel);
    const sliced = cachedData.data.slice(offset, offset + limit);
    return res.status(200).json(sliced);
  }

  // Загрузка данных из Telegram
  console.log('🌐 Качаю свежие данные:', channel);
  try {
    const response = await fetch(`https://t.me/s/${channel}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Telegram responded with ${response.status}`);
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    const posts = [];

    $('.tgme_widget_message').each((i, el) => {
      // Текст с HTML-форматированием
      const textHtml = $(el).find('.tgme_widget_message_text').html() || '';
      
      // 1. Сначала ищем КАРТИНКУ
      const imageStyle = $(el).find('.tgme_widget_message_photo_wrap').attr('style');
      let image = null;
      if (imageStyle) {
        const match = imageStyle.match(/url\('(.+?)'\)/);
        if (match) image = match[1];
      }

      // 2. Эмбеды ищем ТОЛЬКО если нет картинки
      let embedData = null;
      
      if (!image) {
        // Способ 1: Ищем блок embed (превью ссылок, YouTube)
        const embedBlocks = $(el).find('.tgme_widget_message_embed');
        embedBlocks.each((j, embedEl) => {
          const $embed = $(embedEl);
          const link = $embed.find('a').first().attr('href');
          const title = $embed.find('.tgme_widget_message_embed_title').text().trim();
          
          // Ищем картинку превью
          let embedImg = null;
          const photoWrap = $embed.find('.tgme_widget_message_embed_photo');
          const photoStyle = photoWrap.attr('style');
          if (photoStyle) {
            const imgMatch = photoStyle.match(/url\('(.+?)'\)/);
            if (imgMatch) embedImg = imgMatch[1];
          }
          
          // Проверяем, YouTube ли это
          if (link && (link.includes('youtube.com') || link.includes('youtu.be'))) {
            embedData = {
              type: 'youtube',
              link: link,
              title: title || 'YouTube Video',
              image: embedImg
            };
          } else if (link && !embedData) {
            // Другие ссылки (превью)
            embedData = {
              type: 'link',
              link: link,
              title: title,
              image: embedImg
            };
          }
        });
        
        // Способ 2: Ищем видео (если не нашли embed)
        if (!embedData) {
          const videoWrap = $(el).find('.tgme_widget_message_video_wrap, .tgme_widget_message_roundvideo_wrap');
          if (videoWrap.length > 0) {
            const video = videoWrap.find('video');
            const poster = video.attr('poster');
            const videoSrc = video.attr('src');
            
            embedData = {
              type: 'video',
              link: videoSrc || null,
              title: 'Видео',
              image: poster
            };
          }
        }
        
        // Способ 3: Ищем ссылки на YouTube прямо в тексте
        if (!embedData && textHtml) {
          const youtubeMatch = textHtml.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"]+/);
          if (youtubeMatch) {
            embedData = {
              type: 'youtube',
              link: youtubeMatch[0],
              title: 'YouTube',
              image: null
            };
          }
        }
      }

      // Дата и ID поста
      const dateAttr = $(el).find('.tgme_widget_message_date time').attr('datetime');
      const date = dateAttr ? Math.floor(new Date(dateAttr).getTime() / 1000) : 0;
      const postId = $(el).attr('data-post') ? $(el).attr('data-post').split('/').pop() : '';

      if (textHtml || image || embedData) {
        posts.push({ 
          text: textHtml, 
          image, 
          embed: embedData, 
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
      timestamp: now,
      version: CACHE_VERSION
    };

    // Отдаём нужную порцию
    const sliced = posts.slice(offset, offset + limit);
    return res.status(200).json(sliced);

  } catch (e) {
    console.error('❌ Ошибка:', e.message);
    // Если ошибка, но есть кэш — отдаём его
    if (cachedData.data) {
      console.warn('⚠️ Ошибка загрузки, отдаю старый кэш');
      const sliced = cachedData.data.slice(offset, offset + limit);
      return res.status(200).json(sliced);
    }
    return res.status(500).json({ error: e.message });
  }
};
