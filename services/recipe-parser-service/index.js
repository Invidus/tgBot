import express from 'express';
import { chromium } from 'playwright';
import axios from 'axios';
import * as cheerio from 'cheerio';
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
  },
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false
});

// Обработка ошибок Redis
redis.on('error', (err) => {
  console.error('⚠️ Redis ошибка:', err.message);
});

redis.on('connect', () => {
  console.log('✅ Redis подключен');
});

const browserPool = [];
const MAX_BROWSERS = 2;
const MAX_PAGES_PER_BROWSER = 5;
let activePages = 0;

// Инициализация пула браузеров
const initBrowserPool = async () => {
  // Определяем путь к системному Chromium
  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
                       '/usr/bin/chromium-browser';

  for (let i = 0; i < MAX_BROWSERS; i++) {
    try {
      const browser = await chromium.launch({
        headless: true,
        executablePath: chromiumPath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-images',
          '--disable-css',
          '--single-process' // Важно для Alpine Linux
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

  if (browserPool.length === 0) {
    console.warn('⚠️ Не удалось создать ни одного браузера, будет использоваться только axios');
  } else {
    console.log(`✅ Пул из ${browserPool.length} браузеров инициализирован`);
  }
};

// Получение доступного браузера
const getAvailableBrowser = () => {
  return browserPool.find(b => b.activePages < b.maxPages) || null;
};

// Парсинг через axios (быстрый метод)
const parseWithAxios = async (url, isSearch = false) => {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
  };

  if (isSearch) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await axios.get(url, {
    headers,
    timeout: 10000
  });
  return cheerio.load(response.data);
};

// Парсинг завтрака
app.post('/parse/breakfast', async (req, res) => {
  const { chatId, forceRefresh } = req.body;

  try {
    // Проверяем кэш только если не требуется принудительное обновление
    const cacheKey = `recipe:breakfast:${chatId}`;
    if (!forceRefresh) {
      let cached = null;
      try {
        cached = await redis.get(cacheKey);
      } catch (redisError) {
        console.warn('⚠️ Ошибка чтения из Redis:', redisError.message);
      }
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    } else {
      // Удаляем старый кэш при принудительном обновлении
      try {
        await redis.del(cacheKey);
      } catch (redisError) {
        console.warn('⚠️ Ошибка удаления кэша:', redisError.message);
      }
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
    try {
      await redis.setex(cacheKey, 3600, JSON.stringify(result));
    } catch (redisError) {
      console.warn('⚠️ Ошибка записи в Redis:', redisError.message);
    }

    res.json(result);
  } catch (error) {
    console.error('Ошибка парсинга завтрака:', error);
    res.status(500).json({ error: 'Ошибка парсинга' });
  }
});

// Парсинг обеда
app.post('/parse/dinner', async (req, res) => {
  const { chatId, forceRefresh } = req.body;

  try {
    const cacheKey = `recipe:dinner:${chatId}`;
    if (!forceRefresh) {
      let cached = null;
      try {
        cached = await redis.get(cacheKey);
      } catch (redisError) {
        console.warn('⚠️ Ошибка чтения из Redis:', redisError.message);
      }
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    } else {
      try {
        await redis.del(cacheKey);
      } catch (redisError) {
        console.warn('⚠️ Ошибка удаления кэша:', redisError.message);
      }
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

    try {
      await redis.setex(cacheKey, 3600, JSON.stringify(result));
    } catch (redisError) {
      console.warn('⚠️ Ошибка записи в Redis:', redisError.message);
    }
    res.json(result);
  } catch (error) {
    console.error('Ошибка парсинга обеда:', error);
    res.status(500).json({ error: 'Ошибка парсинга' });
  }
});

// Парсинг ужина
app.post('/parse/lunch', async (req, res) => {
  const { chatId, forceRefresh } = req.body;

  try {
    const cacheKey = `recipe:lunch:${chatId}`;
    if (!forceRefresh) {
      let cached = null;
      try {
        cached = await redis.get(cacheKey);
      } catch (redisError) {
        console.warn('⚠️ Ошибка чтения из Redis:', redisError.message);
      }
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    } else {
      try {
        await redis.del(cacheKey);
      } catch (redisError) {
        console.warn('⚠️ Ошибка удаления кэша:', redisError.message);
      }
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

    try {
      await redis.setex(cacheKey, 3600, JSON.stringify(result));
    } catch (redisError) {
      console.warn('⚠️ Ошибка записи в Redis:', redisError.message);
    }
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

    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery.length === 0) {
      return res.status(400).json({ error: 'Поисковый запрос не может быть пустым' });
    }

    const cacheKey = `recipe:search:${chatId}:${trimmedQuery}`;
    let cached = null;
    try {
      cached = await redis.get(cacheKey);
    } catch (redisError) {
      console.warn('⚠️ Ошибка чтения из Redis:', redisError.message);
    }
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // Используем правильный URL и кодировку: кириллица кодируется, пробелы заменяются на +
    // Сначала кодируем через encodeURIComponent (кодирует кириллицу и спецсимволы)
    // Затем заменяем %20 (закодированные пробелы) на + как требует сайт
    const searchStrEncoded = encodeURIComponent(trimmedQuery).replace(/%20/g, '+');
    const searchUrl = `https://1000.menu/cooking/search?ms=1&str=${searchStrEncoded}`;
    console.log('🔍 Search URL:', searchUrl);

    const $ = await parseWithAxios(searchUrl, true);

    // Используем правильный селектор как в оригинальном search.js
    const cards = $(".cooking-block > .cn-item:not(.ads_enabled)");

    if (cards.length === 0) {
      return res.status(404).json({ error: `По запросу "${trimmedQuery}" ничего не найдено. Попробуйте другой запрос.` });
    }

    const randomCard = Math.floor(Math.random() * cards.length);
    const card = $(cards[randomCard]);

    const href = "https://1000.menu" + card.find(".info-preview > a.h5").attr("href");
    const title = card.find(".info-preview > a.h5").text();
    const description = card.find(".info-preview > div.preview-text").text();
    const time = card.find(".info-preview .level-right > span").text();
    const ccal = card.find(".info-preview .level-left > span").text();

    // Проверяем, что данные валидны
    if (!title || title.trim() === '') {
      // Если данные пустые, возвращаем ошибку
      return res.status(404).json({ error: `К сожалению, не удалось найти подходящее блюдо по запросу "${trimmedQuery}". Попробуйте другой запрос.` });
    }

    // Форматируем текст как в оригинале
    const recipeText = `${title}\nОписание: ${description}\n\nВремя приготовления блюда: ${time}\nКалорийность блюда на 100 г: ${ccal}\nСсылка на рецепт: ${href}`;

    const result = {
      url: href,
      recipeText,
      hasPhoto: false,
      photoFileId: null
    };

    try {
      await redis.setex(cacheKey, 3600, JSON.stringify(result));
    } catch (redisError) {
      console.warn('⚠️ Ошибка записи в Redis:', redisError.message);
    }
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
    let cached = null;
    try {
      cached = await redis.get(cacheKey);
    } catch (redisError) {
      console.warn('⚠️ Ошибка чтения из Redis:', redisError.message);
    }
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // Пробуем через axios сначала (быстрее)
    try {
      const $ = await parseWithAxios(url);

      const title = $('h1').text() || '';

      // Парсим ингредиенты правильным селектором
      const ingredients = [];
      $('#recept-list > div.ingredient meta').each((index, element) => {
        const content = $(element).attr('content');
        if (content) ingredients.push(content);
      });

      // Парсим порции
      const portion = $('#yield_num_input').val() || $('#yield_num_input').text() || 'не указано';

      // Парсим питательные вещества
      const proteins = $('#nutr_p').text() || $('#nutr_p').val() || 'не указано';
      const fat = $('#nutr_f').text() || $('#nutr_f').val() || 'не указано';
      const carbohydrates = $('#nutr_c').text() || $('#nutr_c').val() || 'не указано';
      const ccals = $('#nutr_kcal').text() || $('#nutr_kcal').val() || 'не указано';

      const ingredientsText = ingredients.length > 0 ? ingredients.join('\n') : 'Ингредиенты не указаны';
      const recipeText = `${title}\n\nПорций: ${portion}\nЧто потребуется:\n${ingredientsText}\n━━━━━━━━━━\nБелки: ${proteins}г Жиры: ${fat}г Углеводы: ${carbohydrates}г\nКалорийность на 100г: ${ccals} ккал`;

      const result = {
        recipeText,
        hasPhoto: false,
        photoFileId: null
      };

      try {
        await redis.setex(cacheKey, 3600, JSON.stringify(result));
      } catch (redisError) {
        console.warn('⚠️ Ошибка записи в Redis:', redisError.message);
      }
      return res.json(result);
    } catch (axiosError) {
      console.log('⚠️ Axios не сработал, пробуем Playwright:', axiosError.message);
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

        // Извлекаем данные параллельно
        const [ingredientsData, portion, nutritionData] = await Promise.all([
          // Извлекаем ингредиенты
          page.evaluate(() => {
            const ingredients = [];
            const metaElements = document.querySelectorAll('#recept-list > div.ingredient meta');
            metaElements.forEach(el => {
              const content = el.getAttribute('content');
              if (content) ingredients.push(content);
            });
            return ingredients;
          }),
          // Извлекаем порции
          page.$eval('#yield_num_input', el => el?.value || 'не указано').catch(() => 'не указано'),
          // Извлекаем питательные вещества
          page.evaluate(() => {
            const extractValue = (selector) => {
              let el = document.querySelector(selector);
              if (!el) return '';
              const text = el.textContent?.trim() || el.innerText?.trim() || el.getAttribute('value')?.trim() || el.value?.trim() || '';
              return (text && text !== 'undefined' && text !== '') ? text : '';
            };
            return {
              proteins: extractValue('#nutr_p'),
              fat: extractValue('#nutr_f'),
              carbohydrates: extractValue('#nutr_c'),
              ccals: extractValue('#nutr_kcal')
            };
          })
        ]);

        // Ждем заполнения питательных веществ только если они пустые
        let finalNutrition = nutritionData;
        if (!nutritionData.proteins && !nutritionData.fat && !nutritionData.carbohydrates && !nutritionData.ccals) {
          try {
            await page.waitForFunction(
              () => {
                const p = document.querySelector('#nutr_p');
                return p && p.textContent && p.textContent.trim() !== '' && p.textContent.trim() !== 'undefined';
              },
              { timeout: 2000 }
            );
            // Повторно извлекаем если дождались
            finalNutrition = await page.evaluate(() => {
              const extractValue = (selector) => {
                const el = document.querySelector(selector);
                if (!el) return '';
                const text = el.textContent?.trim() || el.innerText?.trim() || el.getAttribute('value')?.trim() || el.value?.trim() || '';
                return (text && text !== 'undefined' && text !== '') ? text : '';
              };
              return {
                proteins: extractValue('#nutr_p'),
                fat: extractValue('#nutr_f'),
                carbohydrates: extractValue('#nutr_c'),
                ccals: extractValue('#nutr_kcal')
              };
            });
          } catch (e) {
            // Игнорируем, используем то что есть
          }
        }

        // Получаем заголовок
        const title = await page.$eval('h1', el => el?.textContent || '').catch(() => '');

        // Формируем текст рецепта
        const ingredientsText = ingredientsData.length > 0 ? ingredientsData.join('\n') : 'Ингредиенты не указаны';
        const proteins = finalNutrition.proteins ? `Белки: ${finalNutrition.proteins}г ` : 'Белки: не указано ';
        const fat = finalNutrition.fat ? `Жиры: ${finalNutrition.fat}г ` : 'Жиры: не указано ';
        const carbohydrates = finalNutrition.carbohydrates ? `Углеводы: ${finalNutrition.carbohydrates}г ` : 'Углеводы: не указано ';
        const ccals = finalNutrition.ccals ? `Калорийность на 100 г: ${finalNutrition.ccals} ккал ` : 'Калорийность на 100г: не указано ';

        const recipeText = `${title}\n\nПорций: ${portion}\nЧто потребуется:\n${ingredientsText}\n━━━━━━━━━━\n${proteins}${fat}${carbohydrates}\n${ccals}`;

        await page.close();
        browserData.activePages--;

        const result = {
          recipeText,
          hasPhoto: false,
          photoFileId: null
        };

        // Проверяем, что получили данные
        if (!recipeText || recipeText.trim() === '' || recipeText === '\n\nПорций: не указано\nЧто потребуется:\nИнгредиенты не указаны') {
          console.warn('⚠️ Получен пустой рецепт для URL:', url);
          return res.status(500).json({ error: 'Не удалось получить данные рецепта' });
        }

        try {
          await redis.setex(cacheKey, 3600, JSON.stringify(result));
        } catch (redisError) {
          console.warn('⚠️ Ошибка записи в Redis:', redisError.message);
        }
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

// Парсинг пошагового рецепта
app.post('/parse/step-by-step', async (req, res) => {
  const { url } = req.body;

  try {
    // Проверяем кэш
    const cacheKey = `recipe:steps:${url}`;
    let cached = null;
    try {
      cached = await redis.get(cacheKey);
    } catch (redisError) {
      console.warn('⚠️ Ошибка чтения из Redis:', redisError.message);
    }
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // Пробуем через axios сначала
    try {
      const $ = await parseWithAxios(url);
      const steps = [];

      // Парсим шаги
      $('ol.instructions li:not(.as-ad-step)').each((index, element) => {
        const $li = $(element);
        const stepNumber = $li.find('h3').text().trim() || `Шаг ${index + 1}:`;

        let imageUrl = $li.find('a[href*="img"]').attr('href');
        if (!imageUrl) {
          imageUrl = $li.find('img').attr('src');
        }
        if (imageUrl && !imageUrl.startsWith('http')) {
          imageUrl = 'https:' + imageUrl;
        }

        let instruction = $li.find('p.instruction').text().trim();
        if (!instruction) {
          instruction = $li.find('a[href*="img"]').attr('title') || '';
        }

        if (stepNumber || instruction) {
          steps.push({
            stepNumber: stepNumber || `Шаг ${index + 1}:`,
            imageUrl: imageUrl || null,
            instruction: instruction || 'Инструкция не найдена'
          });
        }
      });

      if (steps.length > 0) {
        const result = { steps };
        try {
          await redis.setex(cacheKey, 3600, JSON.stringify(result));
        } catch (redisError) {
          console.warn('⚠️ Ошибка записи в Redis:', redisError.message);
        }
        return res.json(result);
      }
    } catch (axiosError) {
      console.log('⚠️ Axios не сработал для пошагового рецепта, пробуем Playwright');
    }

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

      // Ждем загрузки списка инструкций
      try {
        await page.waitForFunction(
          () => document.querySelector('ol.instructions') !== null,
          { timeout: 5000 }
        );
      } catch (e) {
        // Игнорируем, продолжаем
      }

      const steps = await page.evaluate(() => {
        const stepsList = [];
        const instructionsList = document.querySelector('ol.instructions');

        if (!instructionsList) {
          return stepsList;
        }

        const listItems = instructionsList.querySelectorAll('li:not(.as-ad-step)');
        listItems.forEach((li, index) => {
          const stepHeading = li.querySelector('h3');
          const stepNumber = stepHeading?.textContent?.trim() || `Шаг ${index + 1}:`;

          let imageUrl = null;
          const imageLink = li.querySelector('a[href*="img"]');
          if (imageLink) {
            imageUrl = imageLink.getAttribute('href');
            if (imageUrl && !imageUrl.startsWith('http')) {
              imageUrl = 'https:' + imageUrl;
            }
          } else {
            const imgTag = li.querySelector('img');
            if (imgTag) {
              imageUrl = imgTag.getAttribute('src') || imgTag.getAttribute('data-src');
              if (imageUrl && !imageUrl.startsWith('http')) {
                imageUrl = 'https:' + imageUrl;
              }
            }
          }

          let instruction = '';
          const instructionPara = li.querySelector('p.instruction');
          if (instructionPara) {
            instruction = instructionPara.textContent?.trim() || '';
          } else if (imageLink) {
            instruction = imageLink.getAttribute('title') || '';
          }

          if (stepNumber || instruction) {
            stepsList.push({
              stepNumber: stepNumber || `Шаг ${index + 1}:`,
              imageUrl: imageUrl || null,
              instruction: instruction || 'Инструкция не найдена'
            });
          }
        });

        return stepsList;
      });

      await page.close();
      browserData.activePages--;

      if (steps.length === 0) {
        return res.status(404).json({ error: 'Шаги рецепта не найдены' });
      }

      const result = { steps };
      try {
        await redis.setex(cacheKey, 3600, JSON.stringify(result));
      } catch (redisError) {
        console.warn('⚠️ Ошибка записи в Redis:', redisError.message);
      }
      res.json(result);
    } catch (playwrightError) {
      await page.close().catch(() => {});
      browserData.activePages--;
      throw playwrightError;
    }
  } catch (error) {
    console.error('Ошибка парсинга пошагового рецепта:', error);
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
    // Запускаем сервис даже если браузеры не инициализированы
    // Будет работать через axios
    app.listen(PORT, () => {
      console.log(`⚠️ Recipe Parser Service запущен на порту ${PORT} (только axios)`);
    });
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

