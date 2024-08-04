import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { getCat } from "./cat.js";
import { getWeather } from "./weather.js";
import { showMenu } from "./menu.js";
import { detailedMenu, detailedCloseMenu } from "./innerButtons.js";
import { getBreakFast, getFullRecepie } from "./breakfast.js";


const bot = new Telegraf(config.telegramToken, {});
var chatId;

bot.start((ctx) => {
    chatId = ctx.chat.id;
    ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️')
    showMenu(bot, chatId);
});

bot.on("message", async ctx => {
    if (ctx.message.text == "Завтрак🍏") {
        let breakfast = await getBreakFast(ctx);
        detailedMenu(bot, ctx.chat.id);
        ctx.reply(breakfast + '');
    } else if (ctx.message.text == "Обед🍜") {
        let weather = await getWeather(ctx);
        ctx.reply(weather);
    } else if (ctx.message.text == "Ужин🍝") {
        let cat = await getCat();
        ctx.reply(cat);
    } else if (ctx.message.text == "Получить подробный рецепт🔎") {
        let fullRecepie = await getFullRecepie(ctx);
        ctx.reply(fullRecepie);
    } else if (ctx.message.text == "Вернуться на главную↩️") {
        showMenu(bot, ctx.chat.id);
    } else if (ctx.message.text == "Другое блюдо➡️") {
        let breakfast = await getBreakFast(ctx);
        console.log(breakfast);
        ctx.reply(breakfast + '');
    } else if (ctx.message.text == "Запуск✅") {
        ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️')
        showMenu(bot, ctx.chat.id);
    } else if (ctx.message.text == "Закрыть❌") {
        detailedCloseMenu(bot, ctx.chat.id);
    }
})
bot.launch()