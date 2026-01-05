import express from 'express';
import { chromium } from 'playwright';
import axios from 'axios';
import cheerio from 'cheerio';
import { config } from '../shared/config.js';
import Redis from 'ioredis';

const app = express();
app.use(express.json());

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

const browserPool = [];
const MAX_BROWSERS = 3;
const MAX_PAGES_PER_BROWSER = 10;
let activePages = 0;

// Инициализация пула браузеров
const initBrowserPool = async () => {
  for (let i = 0; i < MAX_BROWSERS; i++) {
    try {
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-images',
          '--disable-css'
        ]
      });
      browserPool.push({
        browser,
        activePages: 0,
        maxPages: MAX_PAGES_PER_BROWSER
      });
    } catch (error) {
      console.error(`Ошибка создания браузера ${i + 1}:`, error.message);
    }
  }
  console.log(`✅ Пул из ${browserPool.length} браузеров инициализирован`);
};

// Получение доступного браузера
const getAvailableBrowser = () => {
  return browserPool.find(b => b.activePages < b.maxPages) || null;
};

// Парсинг через axios (быстрый метод)
const parseWithAxios = async (url) => {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    timeout: 10000
  });
  return cheerio.load(response.data);
};

// Парсинг завтрака
app.post('/parse/breakfast', async (req, res) => {
  const { chatId } = req.body;

  try {
    // Проверяем кэш
    const cacheKey = `recipe:breakfast:${chatId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // Получаем случайный рецепт
    const pageNum = Math.floor(Math.random() * 23) + 1;
    const $ = await parseWithAxios(`${config.foodUrl}/${pageNum}`);

    const cards = $("section#cooking > .cooking-block > .cn-item:not(.ads_enabled)");

    if (cards.length === 0) {
      return res.status(404).json({ error: 'Рецепты не найдены' });
    }

    const randomCard = Math.floor(Math.random() * cards.length);
    const card = $(cards[randomCard]);

    const href = "https://1000.menu" + card.find(".info-preview > a.h5").attr("href");
    const title = card.find(".info-preview > a.h5").text();
    const description = card.find(".info-preview > div.preview-text").text();
    const time = card.find(".info-preview .level-right > span").text();
    const ccal = card.find(".info-preview .level-left > span").text();

    const recipeText = `${title}\nОписание: ${description}\n\nВремя: ${time}\nКалорийность: ${ccal}\nСсылка: ${href}`;

    const result = {
      url: href,
      recipeText,
      hasPhoto: false,
      photoFileId: null
    };

    // Кэшируем на 1 час
    await redis.setex(cacheKey, 3600, JSON.stringify(result));

    res.json(result);
  } catch (error) {
    console.error('Ошибка парсинга завтрака:', error);
    res.status(500).json({ error: 'Ошибка парсинга' });
  }
});

// Парсинг обеда
app.post('/parse/dinner', async (req, res) => {
  const { chatId } = req.body;

  try {
    const cacheKey = `recipe:dinner:${chatId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const pageNum = Math.floor(Math.random() * 23) + 1;
    const $ = await parseWithAxios(`${config.dinnerUrl}/${pageNum}`);

    const cards = $("section#cooking > .cooking-block > .cn-item:not(.ads_enabled)");

    if (cards.length === 0) {
      return res.status(404).json({ error: 'Рецепты не найдены' });
    }

    const randomCard = Math.floor(Math.random() * cards.length);
    const card = $(cards[randomCard]);

    const href = "https://1000.menu" + card.find(".info-preview > a.h5").attr("href");
    const title = card.find(".info-preview > a.h5").text();
    const description = card.find(".info-preview > div.preview-text").text();
    const time = card.find(".info-preview .level-right > span").text();
    const ccal = card.find(".info-preview .level-left > span").text();

    const recipeText = `${title}\nОписание: ${description}\n\nВремя: ${time}\nКалорийность: ${ccal}\nСсылка: ${href}`;

    const result = {
      url: href,
      recipeText,
      hasPhoto: false,
      photoFileId: null
    };

    await redis.setex(cacheKey, 3600, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    console.error('Ошибка парсинга обеда:', error);
    res.status(500).json({ error: 'Ошибка парсинга' });
  }
});

// Парсинг ужина
app.post('/parse/lunch', async (req, res) => {
  const { chatId } = req.body;

  try {
    const cacheKey = `recipe:lunch:${chatId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const pageNum = Math.floor(Math.random() * 23) + 1;
    const $ = await parseWithAxios(`${config.lunchUrl}/${pageNum}`);

    const cards = $("section#cooking > .cooking-block > .cn-item:not(.ads_enabled)");

    if (cards.length === 0) {
      return res.status(404).json({ error: 'Рецепты не найдены' });
    }

    const randomCard = Math.floor(Math.random() * cards.length);
    const card = $(cards[randomCard]);

    const href = "https://1000.menu" + card.find(".info-preview > a.h5").attr("href");
    const title = card.find(".info-preview > a.h5").text();
    const description = card.find(".info-preview > div.preview-text").text();
    const time = card.find(".info-preview .level-right > span").text();
    const ccal = card.find(".info-preview .level-left > span").text();

    const recipeText = `${title}\nОписание: ${description}\n\nВремя: ${time}\nКалорийность: ${ccal}\nСсылка: ${href}`;

    const result = {
      url: href,
      recipeText,
      hasPhoto: false,
      photoFileId: null
    };

    await redis.setex(cacheKey, 3600, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    console.error('Ошибка парсинга ужина:', error);
    res.status(500).json({ error: 'Ошибка парсинга' });
  }
});

// Парсинг поиска
app.post('/parse/search', async (req, res) => {
  const { chatId, searchQuery } = req.body;

  try {
    if (!searchQuery || searchQuery.length > 200) {
      return res.status(400).json({ error: 'Неверный поисковый запрос' });
    }

    const cacheKey = `recipe:search:${chatId}:${searchQuery}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const searchUrl = `https://1000.menu/search/?q=${encodeURIComponent(searchQuery)}`;
    const $ = await parseWithAxios(searchUrl);

    const cards = $("section#cooking > .cooking-block > .cn-item:not(.ads_enabled)");

    if (cards.length === 0) {
      return res.status(404).json({ error: 'Рецепты не найдены' });
    }

    const randomCard = Math.floor(Math.random() * cards.length);
    const card = $(cards[randomCard]);

    const href = "https://1000.menu" + card.find(".info-preview > a.h5").attr("href");
    const title = card.find(".info-preview > a.h5").text();
    const description = card.find(".info-preview > div.preview-text").text();
    const time = card.find(".info-preview .level-right > span").text();
    const ccal = card.find(".info-preview .level-left > span").text();

    const recipeText = `${title}\nОписание: ${description}\n\nВремя: ${time}\nКалорийность: ${ccal}\nСсылка: ${href}`;

    const result = {
      url: href,
      recipeText,
      hasPhoto: false,
      photoFileId: null
    };

    await redis.setex(cacheKey, 3600, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    console.error('Ошибка парсинга поиска:', error);
    res.status(500).json({ error: 'Ошибка парсинга' });
  }
});

// Парсинг полного рецепта
app.post('/parse/full', async (req, res) => {
  const { url, dishType } = req.body;

  try {
    // Проверяем кэш
    const cacheKey = `recipe:full:${url}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // Пробуем через axios сначала (быстрее)
    try {
      const $ = await parseWithAxios(url);

      const title = $('h1').text() || '';
      const description = $('.recipe-description').text() || '';
      const ingredients = $('.ingredient-item').map((i, el) => $(el).text()).get().join('\n');

      const recipeText = `${title}\n\n${description}\n\nИнгредиенты:\n${ingredients}`;

      const result = {
        recipeText,
        hasPhoto: false,
        photoFileId: null
      };

      await redis.setex(cacheKey, 3600, JSON.stringify(result));
      return res.json(result);
    } catch (axiosError) {
      // Если axios не сработал, используем Playwright
      const browserData = getAvailableBrowser();
      if (!browserData) {
        return res.status(503).json({ error: 'Нет доступных браузеров' });
      }

      browserData.activePages++;
      const page = await browserData.browser.newPage();

      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        });

        const recipeText = await page.evaluate(() => {
          const title = document.querySelector('h1')?.textContent || '';
          const description = document.querySelector('.recipe-description')?.textContent || '';
          const ingredients = Array.from(document.querySelectorAll('.ingredient-item'))
            .map(el => el.textContent)
            .join('\n');

          return `${title}\n\n${description}\n\nИнгредиенты:\n${ingredients}`;
        });

        await page.close();
        browserData.activePages--;

        const result = {
          recipeText,
          hasPhoto: false,
          photoFileId: null
        };

        await redis.setex(cacheKey, 3600, JSON.stringify(result));
        res.json(result);
      } catch (playwrightError) {
        await page.close().catch(() => {});
        browserData.activePages--;
        throw playwrightError;
      }
    }
  } catch (error) {
    console.error('Ошибка парсинга полного рецепта:', error);
    res.status(500).json({ error: 'Ошибка парсинга' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    browsers: browserPool.length,
    activePages: browserPool.reduce((sum, b) => sum + b.activePages, 0)
  });
});

const PORT = process.env.PORT || 3001;

// Инициализация и запуск
initBrowserPool()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Recipe Parser Service запущен на порту ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('❌ Ошибка инициализации Recipe Parser Service:', error);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🔄 Закрытие Recipe Parser Service...');
  await Promise.all(
    browserPool.map(b => b.browser.close().catch(() => {}))
  );
  await redis.quit();
  process.exit(0);
});

