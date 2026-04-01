const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 10 * 60 * 1000; // 10 минут
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v16';

// Исправлено: корректная инициализация объекта
let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

/**
 * Вспомогательная функция для fetch с таймаутом
 */
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
  // CORS заголовки
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });

  const channel = req.query.channel;
  const limit = parseInt(req.query.limit) || POSTS_LIMIT;
  const offset = parseInt(req.query.offset) || 0;

  if (!channel) return res.status(400).json({ error: 'No channel provided' });

  const now = Date.now();
  
  // Проверка версии кэша
  if (cachedData.version !== CACHE_VERSION) {
    cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
  }

  // Возврат из кэша, если данные свежие
  if (cachedData.data && (now - cachedData.timestamp < CACHE_TTL)) {
    console.log('✅ Отдаю из кэша');
    return res.status(200).json(cachedData.data.slice(offset, offset + limit));
  }

  try {
    console.log(`🔄 Запрос для канала: ${channel}`);
    const posts = await fetchFromRSSHub(channel);
    
    if (posts && posts.length > 0) {
      cachedData = { data: posts, timestamp: now, version: CACHE_VERSION };
      return res.status(200).json(posts.slice(offset, offset + limit));
    }
    
    throw new Error('RSSHub вернул пустой список');

  } catch (e) {
    console.error('❌ RSSHub ошибка:', e.message);
    
    // Фоллбэк на прямой парсинг
    try {
      console.log('🔄 Пробуем прямой парсинг t.me/s/...');
      const posts = await fetchFromTelegramWeb(channel);
      
      if (posts && posts.length > 0) {
        cachedData = { data: posts, timestamp: now, version: CACHE_VERSION };
        return res.status(200).json(posts.slice(offset, offset + limit));
      }
    } catch (e2) {
      console.error('❌ Прямой парсинг тоже упал:', e2.message);
    }
    
    // Если есть старый кэш — отдаем его при любой ошибке
    if (cachedData.data) {
      console.warn('⚠️ Ошибка получения новых данных. Отдаю старый кэш');
      return res.status(200).json(cachedData.data.slice(offset, offset + limit));
    }
    
    return res.status(500).json({ error: 'Не удалось получить данные: ' + e.message });
  }
};

async function fetchFromRSSHub(channel) {
  const rssUrl = `https://rsshub.app/telegram/channel/${channel}`;
  const response = await fetchWithTimeout(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  
  if (!response.ok) throw new Error(`RSSHub status: ${response.status}`);
  
  const rssText = await response.text();
  const $ = cheerio.load(rssText, { xmlMode: true });
  const posts = [];

  $('item').each((i, el) => {
    const title = $(el).find('title').text().trim();
    let description = $(el).find('description').text() || '';
    const link = $(el).find('link').text();
    const pubDate = $(el).find('pubDate').text();
    const guid = link.split('/').pop() || i.toString();
    
    // Очистка HTML
    let cleanHtml = description
      .replace(/<div class="rsshub-quote">[\s\S]*?<\/div>/gi, '')
      .replace(/<blockquote>[\s\S]*?<\/blockquote>/gi, '')
      .replace(/^<p>/i, '').replace(/<\/p>$/i, '')
      .trim();
    
    // Поиск изображения
    let image = null;
    const imgMatch = description.match(/<img[^>]+src="([^"]+)"/i);
    if (imgMatch) image = imgMatch[1];
    
    // Поиск YouTube
    let embedData = null;
    const ytMatch = description.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"]+/i);
    if (ytMatch && !image) {
      embedData = { type: 'youtube', link: ytMatch[0], title: 'YouTube' };
    }
    
    const date = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : 0;
    
    posts.push({
      id: guid,
      text: cleanHtml || title,
      image,
      embed: embedData,
      date
    });
  });

  return posts.sort((a, b) => b.date - a.date);
}

async function fetchFromTelegramWeb(channel) {
  const response = await fetchWithTimeout(`https://t.me/s/${channel}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  
  if (!response.ok) throw new Error(`Telegram Web status: ${response.status}`);
  
  const html = await response.text();
  const $ = cheerio.load(html);
  const posts = [];

  $('.tgme_widget_message').each((i, el) => {
    const $el = $(el);
    const textHtml = $el.find('.tgme_widget_message_text').html() || '';
    
    let image = null;
    const imageStyle = $el.find('.tgme_widget_message_photo_wrap').attr('style');
    if (imageStyle) {
      const match = imageStyle.match(/url\(['"]?(.+?)['"]?\)/i);
      if (match) image = match[1];
    }
    
    const dateAttr = $el.find('.tgme_widget_message_date time').attr('datetime');
    const date = dateAttr ? Math.floor(new Date(dateAttr).getTime() / 1000) : 0;
    const postId = $el.attr('data-post') ? $el.attr('data-post').split('/').pop() : i.toString();
    
    if (textHtml || image) {
      posts.push({
        id: postId,
        text: textHtml,
        image: image,
        date: date
      });
    }
  });

  return posts.sort((a, b) => b.date - a.date);
}
