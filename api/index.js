// ✅ ПРАВИЛЬНО (скопируйте именно так):
let cachedData = {
   null,        // ← ← ← ключ "  " + двоеточие + пробел + null
  timestamp: 0,
  version: CACHE_VERSION
};

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
  if (cachedData.version !== CACHE_VERSION) {
    cachedData = {  null, timestamp: 0, version: CACHE_VERSION };
  }

  if (cachedData.data && (now - cachedData.timestamp < CACHE_TTL)) {
    return res.status(200).json(cachedData.data.slice(offset, offset + limit));
  }

  try {
    const posts = await fetchFromRSSHub(channel);
    
    if (!posts || posts.length === 0) {
      console.log('⚠️ RSSHub вернул пусто');
      return res.status(200).json([]);
    }

    cachedData = {  posts, timestamp: now, version: CACHE_VERSION };
    return res.status(200).json(posts.slice(offset, offset + limit));

  } catch (e) {
    console.error('❌ RSSHub ошибка:', e.message);
    
    // Фоллбэк на прямой парсинг
    try {
      console.log('🔄 Пробуем прямой парсинг...');
      const posts = await fetchFromTelegramWeb(channel);
      
      if (posts && posts.length > 0) {
        cachedData = {  posts, timestamp: now, version: CACHE_VERSION };
        return res.status(200).json(posts.slice(offset, offset + limit));
      }
    } catch (e2) {
      console.error('❌ Прямой парсинг тоже упал:', e2.message);
    }
    
    if (cachedData.data) {
      console.warn('⚠️ Отдаю старый кэш');
      return res.status(200).json(cachedData.data.slice(offset, offset + limit));
    }
    
    return res.status(500).json({ error: 'Не удалось получить посты: ' + e.message });
  }
};

// ===== Функция 1: Парсинг через RSSHub (с простой очисткой) =====
async function fetchFromRSSHub(channel) {
  const rssUrl = `https://rsshub.app/telegram/channel/${channel}`;
  
  const response = await fetch(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 10000
  });
  
  if (!response.ok) throw new Error(`RSSHub: ${response.status}`);
  
  const rssText = await response.text();
  
  if (!rssText.includes('<rss') && !rssText.includes('<feed')) {
    throw new Error('RSSHub вернул не XML');
  }
  
  const $ = cheerio.load(rssText, { xmlMode: true });
  const posts = [];

  $('item').each((i, el) => {
    try {
      const title = $(el).find('title').text().trim();
      let description = $(el).find('description').text() || title;
      const link = $(el).find('link').text();
      const pubDate = $(el).find('pubDate').text();
      const guid = link.split('/').pop();
      
      // 🔥 ПРОСТАЯ ОЧИСТКА через строковые замены
      let cleanHtml = description;
      
      // Удаляем блок с обрезанной цитатой
      cleanHtml = cleanHtml.replace(/<div class="rsshub-quote">[\s\S]*?<\/div>/gi, '');
      cleanHtml = cleanHtml.replace(/<blockquote>[\s\S]*?<\/blockquote>/gi, '');
      
      // Чистим от лишних обёрток
      cleanHtml = cleanHtml
        .replace(/^<p>/i, '').replace(/<\/p>$/i, '')
        .replace(/^\s*<br\s*\/?>\s*/i, '').replace(/\s*<br\s*\/?>\s*$/i, '')
        .trim();
      
      const textHtml = cleanHtml || title;
      
      // Ищем картинку
      let image = null;
      const imgMatch = description.match(/<img[^>]+src="([^"]+)"/i);
      if (imgMatch) image = imgMatch[1];
      
      // Ищем YouTube
      let embedData = null;
      if (!image) {
        const ytMatch = description.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"]+/i);
        if (ytMatch) {
          embedData = { type: 'youtube', link: ytMatch[0], title: 'YouTube', image: null };
        }
      }
      
      const date = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : 0;
      
      if (textHtml || image || embedData) {
        posts.push({ text: textHtml, image, embed: embedData, date, id: guid });
      }
    } catch (e) {
      console.warn('⚠️ Ошибка парсинга поста:', e.message);
    }
  });

  return posts.sort((a, b) => b.date - a.date);
}

// ===== Функция 2: Прямой парсинг t.me/s/ (фоллбэк) =====
async function fetchFromTelegramWeb(channel) {
  const response = await fetch(`https://t.me/s/${channel}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 10000
  });
  
  if (!response.ok) throw new Error(`Telegram: ${response.status}`);
  
  const html = await response.text();
  const $ = cheerio.load(html);
  const posts = [];

  $('.tgme_widget_message').each((i, el) => {
    try {
      const textHtml = $(el).find('.tgme_widget_message_text').html() || '';
      
      let image = null;
      const imageStyle = $(el).find('.tgme_widget_message_photo_wrap').attr('style');
      if (imageStyle) {
        const match = imageStyle.match(/url\('(.+?)'\)/i);
        if (match) image = match[1];
      }
      
      let embedData = null;
      if (!image) {
        const embedBlocks = $(el).find('.tgme_widget_message_embed');
        embedBlocks.each((j, embedEl) => {
          const $embed = $(embedEl);
          const link = $embed.find('a').first().attr('href');
          const title = $embed.find('.tgme_widget_message_embed_title').text().trim();
          let embedImg = null;
          const photoStyle = $embed.find('.tgme_widget_message_embed_photo').attr('style');
          if (photoStyle) {
            const imgMatch = photoStyle.match(/url\('(.+?)'\)/i);
            if (imgMatch) embedImg = imgMatch[1];
          }
          if (link && (link.includes('youtube.com') || link.includes('youtu.be'))) {
            embedData = { type: 'youtube', link, title: title || 'YouTube', image: embedImg };
          } else if (link && !embedData) {
            embedData = { type: 'link', link, title, image: embedImg };
          }
        });
      }
      
      const dateAttr = $(el).find('.tgme_widget_message_date time').attr('datetime');
      const date = dateAttr ? Math.floor(new Date(dateAttr).getTime() / 1000) : 0;
      const postId = $(el).attr('data-post') ? $(el).attr('data-post').split('/').pop() : '';
      
      if (textHtml || image || embedData) {
        posts.push({ text: textHtml, image, embed: embedData, date, id: postId });
      }
    } catch (e) {
      console.warn('⚠️ Ошибка парсинга поста (web):', e.message);
    }
  });

  return posts.sort((a, b) => b.date - a.date);
}
