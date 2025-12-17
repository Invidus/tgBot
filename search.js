import { config } from "./config.js";
import axios from "axios";
import cheerio from "cheerio";
import { getDetailedMenuKeyboard } from "./innerButtons.js";

const dataArr = [];

function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min);
}

export const search = async (ctx, userHrefs, searchStr, retryCount = 0) => {
  const MAX_RETRIES = 5;

  try {
    if (!searchStr) {
      return "Ошибка: поисковый запрос не передан";
    }

    const searchStrEncoded = searchStr.replace(/\s+/g, '+');
    const searchUrl = `https://1000.menu/cooking/search?ms=1&str=${searchStrEncoded}`;
    console.log('🔍 Search URL:', searchUrl);

    const axiosResponse = await axios.request({
      method: "GET",
      url: searchUrl,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"
      },
      timeout: 10000
    });

    const $ = cheerio.load(axiosResponse.data);
    var row = "";
    const countCard = $(".cooking-block > .cn-item:not(.ads_enabled)").length;

    if (countCard === 0) {
      return `По запросу "${searchStr}" ничего не найдено. Попробуйте другой запрос.`;
    }

    const randomCard = getRandomInt(0, countCard);
    let foundData = null;

    $(".cooking-block > .cn-item:not(.ads_enabled)").each((index, element) => {
      const dataObj = {
        img: $(element).find("img").attr("src"),
        ccal: $(element).find(".info-preview  .level-left > span").text(),
        timeToCook: $(element).find(".info-preview  .level-right > span").text(),
        productHeader: $(element).find(".info-preview > a.h5").text(),
        hrefOnProduct: "https://1000.menu" + $(element).find(".info-preview > a.h5").attr("href"),
        productDiscription: $(element).find(".info-preview > div.preview-text").text()
      }

      if (index === randomCard) {
        foundData = dataObj;
      }
    });

    if (!foundData || foundData.productHeader == "") {
      if (retryCount < MAX_RETRIES) {
        return await search(ctx, userHrefs, searchStr, retryCount + 1);
      } else {
        return `К сожалению, не удалось найти подходящее блюдо по запросу "${searchStr}". Попробуйте другой запрос.`;
      }
    }

    dataArr.push(foundData);
    row = foundData.productHeader + "\nОписание: " + foundData.productDiscription + "\n\nВремя приготовления блюда: "
    + foundData.timeToCook + "\nКалорийность блюда на 100 г: " + foundData.ccal + "\nСсылка на рецепт: " + foundData.hrefOnProduct;

    // Сохраняем hrefOnProduct в Map для текущего пользователя
    const chatId = ctx.chat.id;
    if (!userHrefs.has(chatId)) {
      userHrefs.set(chatId, {});
    }
    userHrefs.get(chatId).search = foundData.hrefOnProduct;

    if (dataArr.length > 0) {
      dataArr.splice(0, dataArr.length);
    }

    return row;
  } catch(error) {
    console.error('Ошибка при поиске:', error);
    return 'Произошла ошибка при поиске рецепта. Попробуйте позже.';
  }
}

export const getFullRecepieSearch = async (ctx, userHrefs) => {
  const chatId = ctx.chat.id;
  const hrefOnProduct = userHrefs.get(chatId)?.search;

  if (!hrefOnProduct) {
    ctx.reply("Сначала выберите блюдо из результатов поиска.");
    return;
  }

  try {
    const axiosResponse = await axios.request({
      method: "GET",
      url: hrefOnProduct,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"
      }
    });

    const $ = cheerio.load(axiosResponse.data);

    var portion = $('#yield_num_input').attr('value') || 'не указано';
    var recepieList = [];

    $('#recept-list > div.ingredient meta').each((index, element) => {
      recepieList.push($(element).attr("content"));
    });

    ctx.reply(`Порций: ${portion}\nЧто потребуется:\n${recepieList.join('\n')}\n`, getDetailedMenuKeyboard());
  } catch(error) {
    console.error('Ошибка при получении рецепта:', error);
    ctx.reply("Произошла ошибка при получении рецепта. Попробуйте выбрать другое блюдо.");
  }
}

