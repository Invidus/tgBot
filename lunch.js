import { config } from "./config.js";
import axios from "axios";
import cheerio from "cheerio";
import { getPage, releasePage } from "./browserManager.js";
import { getDetailedMenuKeyboard } from "./innerButtons.js";
import { getCachedRecipe, cacheRecipe } from "./recipeCache.js";


function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min); // Максимум не включается, минимум включается
}

export const getLunch = async (ctx, userHrefs, retryCount = 0) => {
  const dataArr = [];
  const MAX_RETRIES = 5; // Максимум 5 попыток, защита от переполнения стека
  try {
    const axiosResponse = await axios.request({
      method: "GET",
      url: config.lunchUrl + "/" + getRandomInt(1, 23),
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

    // Проверяем найденные данные после цикла
    if (!foundData || foundData.productHeader == "") {
      if (retryCount < MAX_RETRIES) {
        return await getLunch(ctx, userHrefs, retryCount + 1);
      } else {
        return "К сожалению, не удалось найти подходящее блюдо. Попробуйте позже.";
      }
    }

    dataArr.push(foundData);
    row = foundData.productHeader  + "\nОписание: " + foundData.productDiscription + "\n\nВремя приготовления блюда: "
    + foundData.timeToCook + "\nКалорийность блюда на 100 г: " + foundData.ccal + "\nСсылка на рецепт: " + foundData.hrefOnProduct;

    // Сохраняем hrefOnProduct в Map для текущего пользователя
    const chatId = ctx.chat.id;
    if (!userHrefs.has(chatId)) {
      userHrefs.set(chatId, {});
    }
    userHrefs.get(chatId).lunch = foundData.hrefOnProduct;

    if (dataArr.length > 0) {
      dataArr.splice(0, dataArr.length)
    }
    return row;
  } catch(error) {
    console.error('Ошибка при получении рецепта:', error);
    return 'Произошла ошибка при получении рецепта. Попробуйте позже.';
  }
}

export const getFullRecepieLunch = async (ctx, userHrefs) => {
  const chatId = ctx.chat.id;
  const hrefOnProduct = userHrefs.get(chatId)?.lunch;

  if (!hrefOnProduct) {
    ctx.reply("Сначала выберите блюдо из меню.");
    return;
  }

  // Проверяем кэш
  const cached = getCachedRecipe(hrefOnProduct);
  if (cached) {
    ctx.reply(cached, getDetailedMenuKeyboard(true));
    return;
  }

  let page = null;
  try {
    // Используем переиспользуемый браузер для загрузки страницы
    page = await getPage();

    // Переходим на страницу с быстрой стратегией ожидания
    // 'domcontentloaded' - самый быстрый вариант, ждет только загрузки DOM
    await page.goto(hrefOnProduct, {
      waitUntil: 'domcontentloaded',
      timeout: 15000 // Уменьшен таймаут для снижения нагрузки
    });

    // Минимальная задержка для выполнения JavaScript
    await page.waitForTimeout(1000);

    // Ждем появления элементов с питательными веществами (уменьшаем таймаут)
    try {
      // Ждем элемент с коротким таймаутом
      await page.waitForSelector('#nutr_p', { timeout: 5000 });

      // Ждем, пока значения заполнятся (не пустые и не undefined) с коротким таймаутом
      await page.waitForFunction(
        () => {
          const p = document.querySelector('#nutr_p');
          return p && p.textContent && p.textContent.trim() !== '' && p.textContent.trim() !== 'undefined';
        },
        { timeout: 5000 }
      );
    } catch (e) {
      // Небольшая задержка и пробуем еще раз
      await page.waitForTimeout(2000);
    }

    // Извлекаем данные напрямую через Playwright API
    const portion = await page.$eval('#yield_num_input', el => el?.value || 'не указано').catch(() => 'не указано');

    // Извлекаем питательные вещества напрямую через Playwright
    // Пробуем разные способы: textContent, innerText, value
    let proteinsText = '';
    let fatText = '';
    let carbohydratesText = '';
    let ccalsText = '';

    // Функция для извлечения текста через page.evaluate (выполняется в контексте браузера)
    const extractText = async (selector) => {
      try {
        const result = await page.evaluate((sel) => {
          const el = document.querySelector(sel);

          if (!el) {
            return { found: false, value: '', debug: 'элемент не найден' };
          }

          // Пробуем разные способы извлечения
          const text1 = el.textContent?.trim();
          if (text1 && text1 !== 'undefined') {
            return { found: true, value: text1, method: 'textContent' };
          }

          const text2 = el.innerText?.trim();
          if (text2 && text2 !== 'undefined') {
            return { found: true, value: text2, method: 'innerText' };
          }

          const text3 = el.getAttribute('value')?.trim();
          if (text3 && text3 !== 'undefined') {
            return { found: true, value: text3, method: 'value' };
          }

          const text4 = el.value?.trim();
          if (text4 && text4 !== 'undefined') {
            return { found: true, value: text4, method: 'value' };
          }

          return { found: false, value: '', debug: 'все методы вернули пустое значение' };
        }, selector);

        return result?.value || '';
      } catch (e) {
        return '';
      }
    };

    proteinsText = await extractText('#nutr_p');
    fatText = await extractText('#nutr_f');
    carbohydratesText = await extractText('#nutr_c');
    ccalsText = await extractText('#nutr_kcal');

    // Если не нашли, пробуем через селектор с родительскими элементами
    if (!proteinsText) {
      proteinsText = await extractText('.add-nutrition-info .proteins .grams > #nutr_p');
    }
    if (!fatText) {
      fatText = await extractText('.add-nutrition-info .fats .grams > #nutr_f');
    }
    if (!carbohydratesText) {
      carbohydratesText = await extractText('.add-nutrition-info .carbs .grams > #nutr_c');
    }
    if (!ccalsText) {
      ccalsText = await extractText('.add-nutrition-info .calories #nutr_kcal');
    }


    const proteins = proteinsText ? 'Белки: ' + proteinsText + 'г ' : 'Белки: не указано ';
    const fat = fatText ? 'Жиры: ' + fatText + 'г ' : 'Жиры: не указано ';
    const carbohydrates = carbohydratesText ? 'Углеводы: ' + carbohydratesText + 'г ' : 'Углеводы: не указано ';
    const ccals = ccalsText ? 'Калорийность на 100 г: ' + ccalsText + ' ккал ' : 'Калорийность на 100г: не указано ';

    // Извлекаем ингредиенты через cheerio (они статичны)
    const html = await page.content();
    const $ = cheerio.load(html);
    const recepieList = [];
    $('#recept-list > div.ingredient meta').each((index, element) => {
      recepieList.push($(element).attr("content"));
    });

    // Закрываем страницу, но не браузер (он переиспользуется)
    await page.close();
    releasePage();

    // Формируем сообщение
    const message = `Порций: ${portion}\nЧто потребуется:\n${recepieList.join('\n')}\n━━━━━━━━━━━━━━━━━━━━\n${proteins}${fat}${carbohydrates}\n${ccals}\n`;

    // Кэшируем результат
    cacheRecipe(hrefOnProduct, message);

    // Используем клавиатуру без кнопки "Что нужно для приготовления", так как рецепт уже показан
    ctx.reply(message, getDetailedMenuKeyboard(true))
  } catch(error) {
    if (page) {
      await page.close().catch(() => {}); // Игнорируем ошибки закрытия
      releasePage();
    }
    console.error('Ошибка при получении рецепта:', error);
    ctx.reply("Произошла ошибка при получении рецепта. Попробуйте выбрать другое блюдо.");
  }
}

