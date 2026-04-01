const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 10 * 60 * 1000; 
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v16';

// Исправлено: ключ "data" теперь на месте
let cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };

/**
 * Вспомогательная функция для fetch с таймаутом (AbortController)
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET' });

  const channel = req.query.channel;
  const limit = parseInt(req.query.limit) || POSTS_LIMIT;
  const offset = parseInt(req.query.offset) || 0;

  if (!channel) return res.status(400).json({ error: 'No channel provided' });

  const now = Date.now();
  
  // Сброс кэша при обновлении версии
  if (cachedData.version !== CACHE_VERSION) {
    cachedData = { data: null, timestamp: 0, version: CACHE_VERSION };
  }

  // Проверка актуальности кэша
  if (cachedData.data && (now - cachedData.timestamp < CACHE_TTL)) {
    return res.status(200).json(cachedData.data.slice(offset, offset + limit));
  }

  try {
    const posts = await fetchFromRSSHub(channel);
    
    if (posts && posts.length > 0) {
      cachedData = { data: posts, timestamp: now, version: CACHE_VERSION };
      return res.status(200).json(posts.slice(offset, offset + limit));
    }
    
    throw new Error('Empty from RSSHub');

  } catch (e) {
    console.error('RSSHub error:', e.message);
    
    try {
      const posts = await fetchFromTelegramWeb(channel);
      if (posts && posts.length > 0) {
        cachedData = { data: posts, timestamp: now, version: CACHE_VERSION };
        return res.status(200).json(posts.slice(offset, offset + limit));
      }
    } catch (e2) {
      console.error('Web parse error:', e2.message);
    }
    
    // Если всё упало, но в кэше хоть что-то есть — отдаем старое
    if (cachedData.data) {
      return res.status(200).json(cachedData.data.slice(offset, offset + limit));
    }
    
    return res.status(500).json({ error: 'Failed to fetch posts' });
  }
};

async function fetchFromRSSHub(channel) {
  const rssUrl = `https://rsshub.app/telegram/channel/${channel}`;
  const response = await fetchWithTimeout(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  
  if (!response.ok) throw new Error(`Status: ${response.status}`);
  
  const rssText = await response.text();
  const $ = cheerio.load(rssText, { xmlMode: true });
  const posts = [];

  $('item').each((i, el) => {
    const title = $(el).find('title').text().trim();
    const description = $(el).find('description').text() || '';
    const link = $(el).find('link').text();
    const pubDate = $(el).find('pubDate').text();
    const guid = link.split('/').pop() || i.toString();
    
    let cleanHtml = description
      .replace(/<div class="rsshub-quote">[\s\S]*?<\/div>/gi, '')
      .replace(/<blockquote>[\s\S]*?<\/blockquote>/gi, '')
      .trim();
    
    let image = null;
    const imgMatch = description.match(/<img[^>]+src="([^"]+)"/i);
    if (imgMatch) image = imgMatch[1];
    
    const date = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : 0;
    
    posts.push({ id: guid, text: cleanHtml || title, image, date });
  });

  return posts.sort((a, b) => b.date - a.date);
}

async function fetchFromTelegramWeb(channel) {
  const response = await fetchWithTimeout(`https://t.me/s/${channel}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  
  const html = await response.text();
  const $ = cheerio.load(html);
  const posts = [];

  $('.tgme_widget_message').each((i, el) => {
    const textHtml = $(el).find('.tgme_widget_message_text').html() || '';
    const dateAttr = $(el).find('.tgme_widget_message_date time').attr('datetime');
    const date = dateAttr ? Math.floor(new Date(dateAttr).getTime() / 1000) : 0;
    const postId = $(el).attr('data-post') ? $(el).attr('data-post').split('/').pop() : i.toString();
    
    if (textHtml) {
      posts.push({ id: postId, text: textHtml, date });
    }
  });

  return posts.sort((a, b) => b.date - a.date);
}
