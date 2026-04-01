const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CACHE_TTL = 10 * 60 * 1000;
const POSTS_LIMIT = 5;
const CACHE_VERSION = 'v8'; // 🔁 Новая версия

let cachedData = {  null, timestamp: 0, version: CACHE_VERSION };

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
    // 🔥 ИСПОЛЬЗУЕМ RSSHUB ВМЕСТО ПРЯМОГО ПАРСИНГА
    const rssUrl = `https://rsshub.app/telegram/channel/${channel}`;
    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) throw new Error(`RSSHub: ${response.status}`);
    
    const rssText = await response.text();
    const $ = cheerio.load(rssText, { xmlMode: true });
    const posts = [];

    $('item').each((i, el) => {
      const title = $(el).find('title').text().trim();
      const description = $(el).find('description').text();
      const link = $(el).find('link').text();
      const pubDate = $(el).find('pubDate').text();
      const guid = link.split('/').pop();
      
      // 🔥 ВАЖНО: извлекаем ПОЛНЫЙ текст из description
      // RSSHub иногда добавляет цитату в <blockquote> — убираем её
      const $desc = cheerio.load(description, { xmlMode: false });
      
      // Удаляем блок с обрезанной цитатой
      $desc('blockquote').remove();
      $desc('.rsshub-quote').remove();
      
      // Получаем очищенный HTML
      let textHtml = $desc.root().html() || title;
      
      // Очищаем от лишних обёрток
      textHtml = textHtml
        .replace(/^<p>/, '').replace(/<\/p>$/, '')
        .trim();

      // 🔍 Ищем картинку в description
      let image = null;
      const imgMatch = description.match(/<img[^>]+src="([^"]+)"/);
      if (imgMatch) {
        image = imgMatch[1];
      }

      // 🔍 Ищем YouTube-ссылки для эмбеда
      let embedData = null;
      if (!image) {
        const youtubeMatch = description.match(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/[^\s<"]+/);
        if (youtubeMatch) {
          embedData = {
            type: 'youtube',
            link: youtubeMatch[0],
            title: 'YouTube',
            image: null
          };
        }
      }

      // Дата
      const date = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : 0;

      if (textHtml || image || embedData) {
        posts.push({ 
          text: textHtml, 
          image, 
          embed: embedData, 
          date, 
          id: guid 
        });
      }
    });

    // Сортировка: новые сверху
    posts.sort((a, b) => b.date - a.date);

    cachedData = {  posts, timestamp: now, version: CACHE_VERSION };

    return res.status(200).json(posts.slice(offset, offset + limit));
  } catch (e) {
    console.error('❌ Ошибка:', e.message);
    if (cachedData.data) {
      return res.status(200).json(cachedData.data.slice(offset, offset + limit));
    }
    return res.status(500).json({ error: e.message });
  }
};
