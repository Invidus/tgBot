import { config } from "./config.js";
import axios from "axios";
import cheerio from "cheerio";
import { detailedMenu, detailedCloseMenu, fullRecepie, getDetailedMenuKeyboard } from "./innerButtons.js";
import { Pagination } from  "telegraf-pagination";

const dataArr = [];
function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min); // Максимум не включается, минимум включается
}

export const getLunch = async (ctx, userHrefs, retryCount = 0) => {
  const MAX_RETRIES = 5; // Максимум 5 попыток, защита от переполнения стека
  try {
    const axiosResponse = await axios.request({
      method: "GET",
      url: config.lunchUrl + "/" + getRandomInt(1, 23),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"
      }
    })

    const $ = cheerio.load(axiosResponse.data);
    var row = "";
    const countCard = $("section#cooking > .cooking-block > .cn-item:not(.ads_enabled)").length;
    const randomCard = getRandomInt(1, countCard);
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
    const scrapedData = {
      dataArr: dataArr
    }

    // const scrapedDataJSON = JSON.stringify(scrapedData);
    if (dataArr.length > 0) {
      dataArr.splice(0, dataArr.length)
    }
    return row;
  } catch(error) {
    console.log(error);
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
  try {
    const axiosResponse = await axios.request({
      method: "GET",
      url: hrefOnProduct,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"
      }
    })
    const $ = cheerio.load(axiosResponse.data);

    var portion = $('#yield_num_input').attr('value') || 'не указано';
    var recepieList = [];
    var stebByStepRecepie = [];
    var imgArray = [];
    $('#recept-list > div.ingredient meta').each((index, element) => {
      recepieList.push($(element).attr("content"));
      // const dataObjRecepie = {
      //   ingredient: element
      //    ingredientName: $(element).find("a.name").text(),
      //    discriptionName: $(element).find("span.ingredient-info").text(),
      //    piece: $(element).find("span.ingredient-info").text(),

      // }

    });
    ctx.reply(`Порций: ${portion}\nЧто потребуется:\n${recepieList.join('\n')}\n`, getDetailedMenuKeyboard())
  } catch(error) {
    console.log(error);
    ctx.reply("Произошла ошибка при получении рецепта. Попробуйте выбрать другое блюдо.");
  }
}


const stepCounter = 0;
// todo метод с картинками
// export const nextStep = function (imgArray, stebByStepRecepie, ctx) {
//   for (var i = 0; i < stebByStepRecepie.length; i++) {
//     ctx.replyWithPhoto({
//       url: imgArray[i] ? imgArray[i] : ''
//      },
//     {
//       caption: stebByStepRecepie[i]
//     });

//   }
// }

