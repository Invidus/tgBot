import { chromium } from "playwright";

let browser = null;
let isInitializing = false;

/**
 * Инициализирует браузер (если еще не инициализирован)
 */
export const initBrowser = async () => {
  if (browser) {
    return browser;
  }

  if (isInitializing) {
    // Ждем, пока другой запрос инициализирует браузер
    while (isInitializing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return browser;
  }

  isInitializing = true;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-images', '--disable-css']
    });
    console.log('✅ Браузер Playwright инициализирован');
  } catch (error) {
    console.error('❌ Ошибка инициализации браузера:', error);
    isInitializing = false;
    throw error;
  }
  isInitializing = false;
  return browser;
};

/**
 * Получает новую страницу из переиспользуемого браузера
 */
export const getPage = async () => {
  if (!browser) {
    await initBrowser();
  }

  const page = await browser.newPage();

  // Блокируем загрузку ненужных ресурсов для ускорения
  await page.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    // Блокируем изображения, шрифты, медиа - оставляем только документы, скрипты, стили
    if (['image', 'font', 'media'].includes(resourceType)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  // Устанавливаем User-Agent
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
  });

  return page;
};

/**
 * Закрывает браузер
 */
export const closeBrowser = async () => {
  if (browser) {
    await browser.close();
    browser = null;
    console.log('✅ Браузер Playwright закрыт');
  }
};

