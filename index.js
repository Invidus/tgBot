import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { getCat } from "./cat.js";
import { getWeather } from "./weather.js";
import { showMenu } from "./menu.js";
import { detailedMenu, detailedCloseMenu, fullRecepie } from "./innerButtons.js";
import { getBreakFast, getFullRecepie } from "./breakfast.js";
import { getDinner, getFullRecepieDinner } from "./dinner.js";
import { getLunch, getFullRecepieLunch } from "./lunch.js";
import { Pagination } from "telegraf-pagination";


const bot = new Telegraf(config.telegramToken, {});
var chatId;
var state = 0;

bot.start((ctx) => {
    chatId = ctx.chat.id;
    ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️')
    showMenu(bot, chatId);
});

bot.command("playlist", async (ctx) => {
    const data = await getFullRecepie(ctx); // Replace this with your data retrieval logic
    const pagination = new Pagination({
       data: data,
       header: (currentPage, pageSize, total) => `Nəsimi BR: 250* 299k\nPage ${currentPage} of ${total}`,
       format: (item, index) => `${index + 1}. ${item.full_name} - ${item.company}`,
       pageSize: 5,
       rowSize: 5,
       onSelect: (item, index) => {
          // You can perform actions when an item is selected here
          ctx.reply(`You selected ${item.quantity} - ${item.price_usd}`);
       },
    });

    pagination.handleActions(bot);
    let text = await pagination.text();
    let keyboard = await pagination.keyboard();
    ctx.reply(text, keyboard);
 });

bot.on("message", async ctx => {
    if (ctx.message.text == "Завтрак🍏") {
        let breakfast = await getBreakFast(ctx);
        detailedMenu(bot, ctx.chat.id);
        ctx.reply(breakfast + '');
        state = 1;
    } else if (ctx.message.text == "Обед🍜") {
        state = 2;
        let dinner = await getDinner(ctx);
        detailedMenu(bot, ctx.chat.id);
        ctx.reply(dinner + '');
    } else if (ctx.message.text == "Ужин🍝") {
        state = 3;
        let lunch = await getLunch(ctx);
        detailedMenu(bot, ctx.chat.id);
        ctx.reply(lunch + '');
    } else if (ctx.message.text == "Что нужно для приготовления🔎") {
        // Показываем список ингредиентов в зависимости от выбранного типа блюда
        switch (state) {
            case 1:
                await getFullRecepie(ctx);
                break;
            case 2:
                await getFullRecepieDinner(ctx);
                break;
            case 3:
                await getFullRecepieLunch(ctx);
                break;
            default:
                ctx.reply("Сначала выберите завтрак, обед или ужин.");
                break;
        }
        detailedMenu(bot, ctx.chat.id);
    } else if (ctx.message.text == "Вернуться на главную↩️") {
        showMenu(bot, ctx.chat.id);
    } else if (ctx.message.text == "Другое блюдо🔁") {
        console.log(state);
        switch (state) {
            case 1:
                let breakfast = await getBreakFast(ctx);
                console.log(breakfast);
                ctx.reply(breakfast + '');
                break;
            case 2:
                let dinner = await getDinner(ctx);
                console.log(dinner);
                ctx.reply(dinner + '');
                break;
            case 3:
                let lunch = await getLunch(ctx);
                console.log(lunch);
                ctx.reply(lunch + '');
                break;
        }
    } else if (ctx.message.text == "Запуск✅") {
        ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️')
        showMenu(bot, ctx.chat.id);
    } else if (ctx.message.text == "Закрыть❌") {
        detailedCloseMenu(bot, ctx.chat.id);
    }
})
bot.launch()