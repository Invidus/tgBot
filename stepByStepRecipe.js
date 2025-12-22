import { getPage, releasePage, isBrowserInitialized } from "./browserManager.js";
import axios from "axios";
import cheerio from "cheerio";

/**
 * Получает пошаговый рецепт с изображениями и инструкциями
 * @param {string} hrefOnProduct - URL рецепта
 * @returns {Promise<Array>} Массив шагов: [{ stepNumber, imageUrl, instruction }]
 */
export const getStepByStepRecipe = async (hrefOnProduct) => {
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

    // Переходим на страницу
    await page.goto(hrefOnProduct, {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });

    // Ждем загрузки списка инструкций
    await page.waitForSelector('ol.instructions', { timeout: 5000 }).catch(() => {
      console.log('⚠️ Селектор ol.instructions не найден, продолжаем...');
    });

    // Извлекаем все шаги рецепта
    const steps = await page.evaluate(() => {
      const stepsList = [];
      const instructionsList = document.querySelector('ol.instructions');

      if (!instructionsList) {
        return stepsList;
      }

      const listItems = instructionsList.querySelectorAll('li:not(.as-ad-step)');

      listItems.forEach((li, index) => {
        try {
          // Получаем номер шага из h3
          const stepHeading = li.querySelector('h3');
          const stepNumber = stepHeading ? stepHeading.textContent.trim() : `Шаг ${index + 1}:`;

          // Получаем URL изображения
          let imageUrl = null;
          const imageLink = li.querySelector('a[href*="img"]');
          if (imageLink) {
            imageUrl = imageLink.getAttribute('href');
            // Если URL относительный, делаем его абсолютным
            if (imageUrl && !imageUrl.startsWith('http')) {
              imageUrl = 'https:' + imageUrl;
            }
          } else {
            // Пробуем получить из img тега
            const imgTag = li.querySelector('img');
            if (imgTag) {
              imageUrl = imgTag.getAttribute('src');
              if (imageUrl && !imageUrl.startsWith('http')) {
                imageUrl = 'https:' + imageUrl;
              }
            }
          }

          // Получаем текст инструкции
          let instruction = '';
          const instructionPara = li.querySelector('p.instruction');
          if (instructionPara) {
            instruction = instructionPara.textContent.trim();
          } else {
            // Пробуем получить из title атрибута ссылки
            if (imageLink) {
              instruction = imageLink.getAttribute('title') || '';
            }
          }

          if (stepNumber || instruction) {
            stepsList.push({
              stepNumber: stepNumber || `Шаг ${index + 1}:`,
              imageUrl: imageUrl || null,
              instruction: instruction || 'Инструкция не найдена'
            });
          }
        } catch (error) {
          console.error('Ошибка при обработке шага:', error);
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
          timeout: 10000
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

