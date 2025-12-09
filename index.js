import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { getCat } from "./cat.js";
import { getWeather } from "./weather.js";
import { showMenu } from "./menu.js";
import { detailedMenu, detailedCloseMenu, fullRecepie, getDetailedMenuKeyboard } from "./innerButtons.js";
import { getBreakFast, getFullRecepie } from "./breakfast.js";
import { getDinner, getFullRecepieDinner } from "./dinner.js";
import { getLunch, getFullRecepieLunch } from "./lunch.js";
import { Pagination } from "telegraf-pagination";

// Хранилище ссылок на рецепты для каждого пользователя: chatId -> { breakfast: url, lunch: url, dinner: url }
const userHrefs = new Map();

const bot = new Telegraf(config.telegramToken, {});

// Хранилище состояний пользователей: chatId -> state
const userStates = new Map();

// Вспомогательные функции для работы с состоянием
const getUserState = (chatId) => {
    return userStates.get(chatId) || 0;
};

const setUserState = (chatId, state) => {
    userStates.set(chatId, state);
};

const resetUserState = (chatId) => {
    userStates.set(chatId, 0);
};

// Вспомогательные функции для работы с hrefOnProduct
const resetUserHrefs = (chatId) => {
    userHrefs.delete(chatId);
};

bot.start((ctx) => {
    const chatId = ctx.chat.id;
    resetUserState(chatId);
    resetUserHrefs(chatId);
    ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️')
    showMenu(bot, chatId);
});

bot.command("playlist", async (ctx) => {
    const data = await getFullRecepie(ctx, userHrefs); // Replace this with your data retrieval logic
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
    const chatId = ctx.chat.id;
    const state = getUserState(chatId);

    if (ctx.message.text == "Завтрак🍏") {
        let breakfast = await getBreakFast(ctx, userHrefs);
        ctx.reply(breakfast + '', getDetailedMenuKeyboard());
        setUserState(chatId, 1);
    } else if (ctx.message.text == "Обед🍜") {
        setUserState(chatId, 2);
        let dinner = await getDinner(ctx, userHrefs);
        ctx.reply(dinner + '', getDetailedMenuKeyboard());
    } else if (ctx.message.text == "Ужин🍝") {
        setUserState(chatId, 3);
        let lunch = await getLunch(ctx, userHrefs);
        ctx.reply(lunch + '', getDetailedMenuKeyboard());
    } else if (ctx.message.text == "Что нужно для приготовления🔎") {
        // Показываем список ингредиентов в зависимости от выбранного типа блюда
        switch (state) {
            case 1:
                await getFullRecepie(ctx, userHrefs);
                break;
            case 2:
                await getFullRecepieDinner(ctx, userHrefs);
                break;
            case 3:
                await getFullRecepieLunch(ctx, userHrefs);
                break;
            default:
                ctx.reply("Сначала выберите завтрак, обед или ужин.");
                break;
        }
        // Клавиатура уже передается в функциях getFullRecepie*
    } else if (ctx.message.text == "Вернуться на главную↩️") {
        resetUserState(chatId);
        resetUserHrefs(chatId);
        showMenu(bot, chatId);
    } else if (ctx.message.text == "Другое блюдо🔁") {
        console.log(`User ${chatId} state:`, state);
        switch (state) {
            case 1:
                let breakfast = await getBreakFast(ctx, userHrefs);
                console.log(breakfast);
                ctx.reply(breakfast + '');
                break;
            case 2:
                let dinner = await getDinner(ctx, userHrefs);
                console.log(dinner);
                ctx.reply(dinner + '');
                break;
            case 3:
                let lunch = await getLunch(ctx, userHrefs);
                console.log(lunch);
                ctx.reply(lunch + '');
                break;
        }
    } else if (ctx.message.text == "Запуск✅") {
        resetUserState(chatId);
        resetUserHrefs(chatId);
        ctx.reply('Добро пожаловать, я помогу вам придумать что приготовить на завтрак, обед и ужин✌️')
        showMenu(bot, chatId);
    } else if (ctx.message.text == "Закрыть❌") {
        detailedCloseMenu(bot, chatId);
    }
})
bot.launch()