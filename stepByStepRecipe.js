import { getPage, releasePage, isBrowserInitialized } from "./browserManager.js";
import axios from "axios";
import cheerio from "cheerio";

// Кэш для пошаговых рецептов
const stepByStepCache = new Map();
const STEP_CACHE_TTL = 60 * 60 * 1000; // 1 час

/**
 * Получает пошаговый рецепт из кэша
 */
const getCachedStepByStep = (url) => {
  const cached = stepByStepCache.get(url);
  if (cached && Date.now() - cached.timestamp < STEP_CACHE_TTL) {
    return cached.data;
  }
  if (cached) {
    stepByStepCache.delete(url);
  }
  return null;
};

/**
 * Сохраняет пошаговый рецепт в кэш
 */
const cacheStepByStep = (url, data) => {
  stepByStepCache.set(url, {
    data,
    timestamp: Date.now()
  });
};

/**
 * Очищает старый кэш пошаговых рецептов
 */
const cleanupStepByStepCache = () => {
  const now = Date.now();
  for (const [url, cached] of stepByStepCache.entries()) {
    if (now - cached.timestamp > STEP_CACHE_TTL) {
      stepByStepCache.delete(url);
    }
  }
};

// Очистка кэша каждые 30 минут
setInterval(cleanupStepByStepCache, 30 * 60 * 1000);

/**
 * Получает пошаговый рецепт с изображениями и инструкциями
 * @param {string} hrefOnProduct - URL рецепта
 * @returns {Promise<Array>} Массив шагов: [{ stepNumber, imageUrl, instruction }]
 */
export const getStepByStepRecipe = async (hrefOnProduct) => {
  // Проверяем кэш
  const cached = getCachedStepByStep(hrefOnProduct);
  if (cached) {
    console.log('✅ Пошаговый рецепт получен из кэша');
    return cached;
  }
  let page = null;
  try {
    // Проверяем, инициализирован ли браузер
    if (!isBrowserInitialized()) {
      throw new Error('PLAYWRIGHT_UNAVAILABLE');
    }

    // Используем переиспользуемый браузер для загрузки страницы
    // Разрешаем загрузку изображений для пошагового рецепта
    console.log('🔍 Запрос страницы для пошагового рецепта:', hrefOnProduct);
    try {
      page = await getPage(true); // true = разрешить изображения
      console.log('✅ Страница получена для пошагового рецепта');
    } catch (playwrightError) {
      if (playwrightError.message === 'PLAYWRIGHT_UNAVAILABLE') {
        throw new Error('PLAYWRIGHT_UNAVAILABLE');
      }
      throw playwrightError;
    }

    // Переходим на страницу с оптимизированными настройками
    await page.goto(hrefOnProduct, {
      waitUntil: 'domcontentloaded',
      timeout: 8000 // Уменьшен таймаут для ускорения
    });

    // Ждем загрузки списка инструкций с более коротким таймаутом
    // Используем waitForFunction для более быстрой проверки наличия элементов
    try {
      await page.waitForFunction(
        () => document.querySelector('ol.instructions') !== null,
        { timeout: 3000 }
      ).catch(() => {
        // Если не дождались, продолжаем - возможно элементы уже загружены
        console.log('⚠️ Селектор ol.instructions не найден, продолжаем...');
      });
    } catch (e) {
      // Игнорируем ошибки ожидания
    }

    // Извлекаем все шаги рецепта - оптимизированная версия
    const steps = await page.evaluate(() => {
      const stepsList = [];
      const instructionsList = document.querySelector('ol.instructions');

      if (!instructionsList) {
        return stepsList;
      }

      // Используем более быстрый селектор
      const listItems = instructionsList.querySelectorAll('li:not(.as-ad-step)');
      const itemsArray = Array.from(listItems); // Преобразуем в массив для лучшей производительности

      // Обрабатываем все элементы параллельно через map
      itemsArray.forEach((li, index) => {
        try {
          // Получаем номер шага из h3 (более быстрый селектор)
          const stepHeading = li.querySelector('h3');
          const stepNumber = stepHeading?.textContent?.trim() || `Шаг ${index + 1}:`;

          // Получаем URL изображения - оптимизированный поиск
          let imageUrl = null;
          const imageLink = li.querySelector('a[href*="img"]');
          if (imageLink) {
            imageUrl = imageLink.getAttribute('href');
            if (imageUrl && !imageUrl.startsWith('http')) {
              imageUrl = 'https:' + imageUrl;
            }
          } else {
            // Пробуем получить из img тега напрямую
            const imgTag = li.querySelector('img');
            if (imgTag) {
              imageUrl = imgTag.getAttribute('src') || imgTag.getAttribute('data-src');
              if (imageUrl && !imageUrl.startsWith('http')) {
                imageUrl = 'https:' + imageUrl;
              }
            }
          }

          // Получаем текст инструкции - оптимизированный поиск
          let instruction = '';
          const instructionPara = li.querySelector('p.instruction');
          if (instructionPara) {
            instruction = instructionPara.textContent?.trim() || '';
          } else if (imageLink) {
            // Пробуем получить из title атрибута ссылки
            instruction = imageLink.getAttribute('title') || '';
          }

          if (stepNumber || instruction) {
            stepsList.push({
              stepNumber: stepNumber || `Шаг ${index + 1}:`,
              imageUrl: imageUrl || null,
              instruction: instruction || 'Инструкция не найдена'
            });
          }
        } catch (error) {
          // Игнорируем ошибки для отдельных шагов, продолжаем обработку
        }
      });

      return stepsList;
    });

    // Закрываем страницу
    await page.close();
    releasePage();

    if (steps.length === 0) {
      throw new Error('Шаги рецепта не найдены');
    }

    // Кэшируем результат
    cacheStepByStep(hrefOnProduct, steps);

    console.log(`✅ Получено ${steps.length} шагов рецепта`);
    return steps;

  } catch (error) {
    if (page) {
      await page.close().catch(() => {});
      releasePage();
    }

    // Если Playwright недоступен, пробуем fallback на axios
    if (error.message === 'PLAYWRIGHT_UNAVAILABLE' || error.message.includes('Browser') || error.message.includes('Target')) {
      console.log('🔄 Playwright недоступен для пошагового рецепта, используем fallback на axios...');

      try {
        const axiosResponse = await axios.request({
          method: "GET",
          url: hrefOnProduct,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"
          },
          timeout: 8000 // Уменьшен таймаут для ускорения
        });

        const $ = cheerio.load(axiosResponse.data);
        const steps = [];

        $('ol.instructions li:not(.as-ad-step)').each((index, element) => {
          const $li = $(element);

          // Номер шага
          const stepNumber = $li.find('h3').text().trim() || `Шаг ${index + 1}:`;

          // URL изображения
          let imageUrl = $li.find('a[href*="img"]').attr('href');
          if (!imageUrl) {
            imageUrl = $li.find('img').attr('src');
          }
          if (imageUrl && !imageUrl.startsWith('http')) {
            imageUrl = 'https:' + imageUrl;
          }

          // Текст инструкции
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
          // Кэшируем результат fallback
          cacheStepByStep(hrefOnProduct, steps);
          return steps;
        }

        throw new Error('Шаги не найдены в fallback режиме');
      } catch (fallbackError) {
        console.error('❌ Ошибка fallback для пошагового рецепта:', fallbackError);
        throw new Error('Не удалось получить пошаговый рецепт');
      }
    } else {
      console.error('❌ Ошибка при получении пошагового рецепта:', error);
      throw error;
    }
  }
};

