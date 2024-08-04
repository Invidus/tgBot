import { config } from "./config.js";
import axios from "axios";
import cheerio from "cheerio";


const dataArr = [];
var hrefOnProduct;
function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min); // Максимум не включается, минимум включается
}

export const getBreakFast = async (ctx) => {
  try {
    const axiosResponse = await axios.request({
      method: "GET",
      url: config.foodUrl + "/" + getRandomInt(1, 23),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"
      }
    })

    const $ = cheerio.load(axiosResponse.data);
    var row = "";
    const countCard = $("section#cooking > .cooking-block > .cn-item:not(.ads_enabled)").length;
    const randomCard = getRandomInt(1, countCard);
    $("section#cooking > .cooking-block > .cn-item:not(.ads_enabled)").each((index, element) => {
      const dataObj = {
        img: $(element).find("img").attr("src"),
        ccal: $(element).find(".info-preview  .level-left > span").text(),
        timeToCook: $(element).find(".info-preview  .level-right > span").text(),
        productHeader: $(element).find(".info-preview > a.h5").text(),
        hrefOnProduct: "https://1000.menu" + $(element).find(".info-preview > a.h5").attr("href"),
        productDiscription: $(element).find(".info-preview > div.preview-text").text()
      }


      if (index === randomCard) {
        if (dataObj.productHeader == "") {getBreakFast(ctx); return;}
        dataArr.push(dataObj);
        row = dataObj.productHeader  + "\nОписание: " + dataObj.productDiscription + "\n\nВремя приготовления блюда: "
        + dataObj.timeToCook + "\nКалорийность блюда на 100 г: " + dataObj.ccal + "\nСсылка на рецепт: " + dataObj.hrefOnProduct;
        hrefOnProduct = dataObj.hrefOnProduct;
      }
    })
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
    return error;
  }
}

export const getFullRecepie = async () => {
  const axiosResponse = await axios.request({
    method: "GET",
    url: hrefOnProduct,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"
    }
  })
  const $ = cheerio.load(axiosResponse.data);

  var portion = $('#yield_num_input').attr().value;
  var recepieList = [];
  var stebByStepRecepie = [];
  $('#recept-list > div.ingredient meta').each((index, element) => {
    recepieList.push($(element).attr("content"));
    // const dataObjRecepie = {
    //   ingredient: element
    //    ingredientName: $(element).find("a.name").text(),
    //    discriptionName: $(element).find("span.ingredient-info").text(),
    //    piece: $(element).find("span.ingredient-info").text(),

    // }

  });
  $('ol.instructions > li:not(.as-ad-step)').each((index, element) => {
    stebByStepRecepie.push($(element).find('a'))
  })

  return `Порций: ${portion}\n${recepieList.join('\n')} что потребуется\n\n\n
  Пошаговое приготовление\n`;

  // const countCard = $("section#cooking > .cooking-block > .cn-item:not(.ads_enabled)").length;


}

