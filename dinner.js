import { config } from "./config.js";
import axios from "axios";
import cheerio from "cheerio";
import { getPage, releasePage, isBrowserInitialized } from "./browserManager.js";
import { getDetailedMenuKeyboard } from "./innerButtons.js";
import { getCachedRecipe, cacheRecipe } from "./recipeCache.js";


function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min); // Максимум не включается, минимум включается
}

export const getDinner = async (ctx, userHrefs, retryCount = 0) => {
  const dataArr = [];
  const MAX_RETRIES = 5; // Максимум 5 попыток, защита от переполнения стека
  try {
    const axiosResponse = await axios.request({
      method: "GET",
      url: config.dinnerUrl + "/" + getRandomInt(1, 23),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"
      },
      timeout: 10000
    })

    const $ = cheerio.load(axiosResponse.data);
    let row = "";
    const countCard = $("section#cooking > .cooking-block > .cn-item:not(.ads_enabled)").length;
    const randomCard = getRandomInt(0, countCard);
    let foundData = null;

    $("section#cooking > .cooking-block > .cn-item:not(.ads_enabled)").each((index, element) => {
      const dataObj = {
        img: $(element).find("img").attr("src"),
        ccal: $(element).find(".info-preview  .level-left > span").text(),
        timeToCook: $(element).find(".info-preview  .level-right > span").text(),
        hrefOnProduct: "https://1000.menu" + $(element).find(".info-preview > a.h5").attr("href"),
        productHeader: $(element).find(".info-preview > a.h5").text(),
        productDiscription: $(element).find(".info-preview > div.preview-text").text()
      }

      if (index === randomCard) {
        foundData = dataObj;
      }
    })

    if (!foundData || foundData.productHeader == "") {
      if (retryCount < MAX_RETRIES) {
        return await getDinner(ctx, userHrefs, retryCount + 1);
      } else {
        return "К сожалению, не удалось найти подходящее блюдо. Попробуйте позже.";
      }
    }

    dataArr.push(foundData);
    row = foundData.productHeader  + "\nОписание: " + foundData.productDiscription + "\n\nВремя приготовления блюда: "
    + foundData.timeToCook + "\nКалорийность блюда на 100 г: " + foundData.ccal + "\nСсылка на рецепт: " + foundData.hrefOnProduct;

        const chatId = ctx.chat.id;
        if (!userHrefs.has(chatId)) {
          userHrefs.set(chatId, {});
        }
    userHrefs.get(chatId).dinner = foundData.hrefOnProduct;

    if (dataArr.length > 0) {
      dataArr.splice(0, dataArr.length)
    }
    return row;
  } catch(error) {
    console.error('Ошибка при получении рецепта:', error);
    return 'Произошла ошибка при получении рецепта. Попробуйте позже.';
  }
}

export const getFullRecepieDinner = async (ctx, userHrefs, loadingMessage = null) => {
  const chatId = ctx.chat.id;
  const hrefOnProduct = userHrefs.get(chatId)?.dinner;

  if (!hrefOnProduct) {
    // Удаляем сообщение о загрузке, если оно было отправлено
    if (loadingMessage) {
      try {
        await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
      } catch (e) {
        // Игнорируем ошибки удаления
      }
    }
    ctx.reply("Сначала выберите блюдо из меню.");
    return;
  }

  // Проверяем кэш
  const cached = getCachedRecipe(hrefOnProduct);
  if (cached) {
    // Редактируем сообщение о загрузке или отправляем новое
    if (loadingMessage) {
      try {
        await ctx.telegram.editMessageText(chatId, loadingMessage.message_id, null, cached, getDetailedMenuKeyboard(true));
        return;
      } catch (e) {
        // Если не удалось отредактировать, удаляем и отправляем новое
        try {
          await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
        } catch (e2) {
          // Игнорируем ошибки удаления
        }
      }
    }
    ctx.reply(cached, getDetailedMenuKeyboard(true));
    return;
  }

  let page = null;
  try {
    // Проверяем, инициализирован ли браузер, и если нет - уведомляем пользователя
    if (!isBrowserInitialized()) {
      try {
        await ctx.reply("⏳ Инициализация браузера... Это займет несколько секунд.");
      } catch (e) {
        // Игнорируем ошибки отправки уведомления
      }
    }

    // Используем переиспользуемый браузер для загрузки страницы
    try {
      page = await getPage();
    } catch (playwrightError) {
      if (playwrightError.message === 'PLAYWRIGHT_UNAVAILABLE') {
        throw new Error('PLAYWRIGHT_UNAVAILABLE');
      }
      throw playwrightError;
    }

    // Переходим на страницу с быстрой стратегией ожидания
    // 'domcontentloaded' - самый быстрый вариант, ждет только загрузки DOM
    await page.goto(hrefOnProduct, {
      waitUntil: 'domcontentloaded',
      timeout: 10000 // Уменьшен таймаут
    });

    // Извлекаем все данные параллельно за один вызов для максимальной скорости
    const [nutritionData, ingredientsData, portion] = await Promise.all([
      // Извлекаем питательные вещества - пробуем все селекторы сразу
      page.evaluate(() => {
        const extractValue = (selector) => {
          let el = document.querySelector(selector);
          if (!el) {
            // Пробуем альтернативные селекторы
            const altSelectors = [
              `.add-nutrition-info .proteins .grams > ${selector}`,
              `.add-nutrition-info .fats .grams > ${selector}`,
              `.add-nutrition-info .carbs .grams > ${selector}`,
              `.add-nutrition-info .calories ${selector}`
            ];
            for (const altSel of altSelectors) {
              el = document.querySelector(altSel);
              if (el) break;
            }
          }
          if (!el) return '';

          // Пробуем разные способы извлечения
          const text1 = el.textContent?.trim();
          if (text1 && text1 !== 'undefined' && text1 !== '') return text1;

          const text2 = el.innerText?.trim();
          if (text2 && text2 !== 'undefined' && text2 !== '') return text2;

          const text3 = el.getAttribute('value')?.trim();
          if (text3 && text3 !== 'undefined' && text3 !== '') return text3;

          const text4 = el.value?.trim();
          if (text4 && text4 !== 'undefined' && text4 !== '') return text4;

          return '';
        };

        return {
          proteins: extractValue('#nutr_p'),
          fat: extractValue('#nutr_f'),
          carbohydrates: extractValue('#nutr_c'),
          ccals: extractValue('#nutr_kcal')
        };
      }),
      // Извлекаем ингредиенты напрямую из DOM
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
      page.$eval('#yield_num_input', el => el?.value || 'не указано').catch(() => 'не указано')
    ]);

    // Ждем заполнения питательных веществ только если они пустые (с коротким таймаутом)
    if (!nutritionData.proteins && !nutritionData.fat && !nutritionData.carbohydrates && !nutritionData.ccals) {
      try {
        await page.waitForFunction(
          () => {
            const p = document.querySelector('#nutr_p');
            return p && p.textContent && p.textContent.trim() !== '' && p.textContent.trim() !== 'undefined';
          },
          { timeout: 2000 } // Короткий таймаут
        );
        // Повторно извлекаем если дождались
        const updatedNutrition = await page.evaluate(() => {
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
        Object.assign(nutritionData, updatedNutrition);
      } catch (e) {
        // Игнорируем, используем то что есть
      }
    }

    const proteins = nutritionData.proteins ? 'Белки: ' + nutritionData.proteins + 'г ' : 'Белки: не указано ';
    const fat = nutritionData.fat ? 'Жиры: ' + nutritionData.fat + 'г ' : 'Жиры: не указано ';
    const carbohydrates = nutritionData.carbohydrates ? 'Углеводы: ' + nutritionData.carbohydrates + 'г ' : 'Углеводы: не указано ';
    const ccals = nutritionData.ccals ? 'Калорийность на 100 г: ' + nutritionData.ccals + ' ккал ' : 'Калорийность на 100г: не указано ';

    const recepieList = ingredientsData;

    // Закрываем страницу, но не браузер (он переиспользуется)
    await page.close();
    releasePage();

    // Формируем сообщение
    const message = `Порций: ${portion}\nЧто потребуется:\n${recepieList.join('\n')}\n━━━━━━━━━━━━━━━━━━━━\n${proteins}${fat}${carbohydrates}\n${ccals}\n`;

    // Кэшируем результат
    cacheRecipe(hrefOnProduct, message);

    // Редактируем сообщение о загрузке или отправляем новое
    if (loadingMessage) {
      try {
        await ctx.telegram.editMessageText(chatId, loadingMessage.message_id, null, message, getDetailedMenuKeyboard(true));
        return;
      } catch (e) {
        // Если не удалось отредактировать, удаляем и отправляем новое
        try {
          await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
        } catch (e2) {
          // Игнорируем ошибки удаления
        }
      }
    }
    // Используем клавиатуру без кнопки "Что нужно для приготовления", так как рецепт уже показан
    ctx.reply(message, getDetailedMenuKeyboard(true))
  } catch(error) {
    if (page) {
      await page.close().catch(() => {}); // Игнорируем ошибки закрытия
      releasePage();
    }

    // Если Playwright недоступен или другая ошибка - используем fallback
    if (error.message === 'PLAYWRIGHT_UNAVAILABLE' || error.message.includes('Browser') || error.message.includes('Target')) {
      console.log('🔄 Playwright недоступен, используем fallback на axios...');
    } else {
      console.error('❌ Ошибка при получении рецепта:', error);
    }

    // Пробуем fallback на axios если Playwright не работает
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
      const portion = $('#yield_num_input').attr('value') || 'не указано';
      const recepieList = [];
      $('#recept-list > div.ingredient meta').each((index, element) => {
        recepieList.push($(element).attr("content"));
      });
      const message = `Порций: ${portion}\nЧто потребуется:\n${recepieList.join('\n')}\n━━━━━━━━━━━━━━━━━━━━\nБелки: не указано Жиры: не указано Углеводы: не указано\nКалорийность на 100г: не указано\n`;

      // Редактируем сообщение о загрузке или отправляем новое
      if (loadingMessage) {
        try {
          await ctx.telegram.editMessageText(chatId, loadingMessage.message_id, null, message, getDetailedMenuKeyboard(true));
          return;
        } catch (e) {
          // Если не удалось отредактировать, удаляем и отправляем новое
          try {
            await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
          } catch (e2) {
            // Игнорируем ошибки удаления
          }
        }
      }
      ctx.reply(message, getDetailedMenuKeyboard(true));
    } catch (fallbackError) {
      console.error('❌ Ошибка fallback:', fallbackError);
      // Удаляем сообщение о загрузке при ошибке
      if (loadingMessage) {
        try {
          await ctx.telegram.deleteMessage(chatId, loadingMessage.message_id);
        } catch (e) {
          // Игнорируем ошибки удаления
        }
      }
      ctx.reply("Произошла ошибка при получении рецепта. Попробуйте выбрать другое блюдо.");
    }
  }
}

