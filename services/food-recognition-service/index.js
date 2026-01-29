import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3004;

// ==================== КОНФИГУРАЦИЯ CLARIFAI ====================

const CLARIFAI_API_KEY = process.env.CLARIFAI_API_KEY;

if (!CLARIFAI_API_KEY) {
  console.error('❌ CLARIFAI_API_KEY не указан в переменных окружения!');
  console.error('   Получите токен на https://clarifai.com/settings/security');
}

// Логирование конфигурации
console.log(`🔧 Конфигурация AI провайдера:`);
console.log(`   - Clarifai: ${CLARIFAI_API_KEY ? '✅ настроен' : '❌ не настроен (нужен CLARIFAI_API_KEY)'}`);

// ==================== ЗАГРУЗКА ИЗОБРАЖЕНИЯ ====================

async function loadImage(imageUrl) {
  try {
    console.log(`📥 Загрузка изображения из URL...`);
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 10 * 1024 * 1024, // 10MB максимум
      validateStatus: (status) => status === 200
    });

    if (!imageResponse.data || imageResponse.data.length === 0) {
      throw new Error('Изображение пустое или не загружено');
    }

    console.log(`✅ Изображение загружено, размер: ${imageResponse.data.length} байт`);
    return Buffer.from(imageResponse.data);
  } catch (error) {
    console.error('❌ Ошибка загрузки изображения:', error.message);
    throw new Error(`Не удалось загрузить изображение: ${error.message}`);
  }
}

// ==================== CLARIFAI API ====================

async function recognizeWithClarifai(imageBuffer, imageUrl) {
  if (!CLARIFAI_API_KEY) {
    throw new Error('Clarifai API не настроен. Укажите CLARIFAI_API_KEY в переменных окружения.');
  }

  try {
    console.log(`🤖 Использование Clarifai для распознавания...`);

    // Конвертируем изображение в base64
    const base64Image = imageBuffer.toString('base64');

    // Используем публичную модель Clarifai для распознавания
    // general-image-recognition - более точная модель, лучше распознает блюда целиком
    // food-item-recognition - распознает отдельные компоненты (менее точно для готовых блюд)
    const apiUrl = 'https://api.clarifai.com/v2/users/clarifai/apps/main/models/general-image-recognition/outputs';

    const requestBody = {
      inputs: [
        {
          data: {
            image: {
              base64: base64Image
            }
          }
        }
      ]
    };

    const response = await axios.post(apiUrl, requestBody, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${CLARIFAI_API_KEY}`
      }
    });

    if (!response.data?.outputs?.[0]?.data?.concepts) {
      throw new Error('Пустой ответ от Clarifai API');
    }

    const concepts = response.data.outputs[0].data.concepts;

    // Исключаем нерелевантные термины:
    // 1. Люди и объекты
    // 2. Эпитеты (вкусное, аппетитное и т.д.)
    // 3. Описания времени приема пищи (завтрак, обед, ужин)
    // 4. Общие термины (еда, блюдо, кухня)
    // 5. Абстрактные понятия (питание, традиция, культура и т.д.)
    const excludeTerms = [
      // Люди и объекты
      'no person', 'person', 'people', 'human', 'man', 'woman', 'child',
      // Эпитеты
      'tasty', 'delicious', 'appetizing', 'savory', 'sweet', 'yummy', 'scrumptious',
      'mouthwatering', 'flavorful', 'tempting', 'appealing', 'luscious', 'succulent',
      // Описания времени приема пищи
      'breakfast', 'lunch', 'dinner', 'meal', 'snack', 'brunch', 'supper',
      // Общие термины
      'food', 'dish', 'cuisine', 'cooking', 'meal', 'dining', 'restaurant',
      'kitchen', 'serving', 'plate', 'bowl', 'table', 'indoor', 'outdoor',
      // Абстрактные понятия (не относятся к конкретным блюдам/компонентам)
      'nutrition', 'traditional', 'culture', 'heritage', 'custom', 'style',
      'method', 'technique', 'preparation', 'presentation', 'garnish',
      'decoration', 'garnishing', 'arrangement', 'display', 'layout',
      // Другие нерелевантные
      'refreshment', 'homemade', 'slice', 'piece', 'portion', 'serving size',
      'portion size', 'helping', 'course', 'appetizer', 'main course', 'dessert course'
    ];

    // Фильтруем нерелевантные термины
    const filteredConcepts = concepts.filter(c => {
      const name = (c.name || '').toLowerCase().trim();

      // Список абстрактных понятий, которые всегда исключаем
      const abstractTerms = ['nutrition', 'traditional', 'culture', 'heritage', 'custom', 'style',
        'method', 'technique', 'preparation', 'presentation', 'garnish', 'decoration',
        'arrangement', 'display', 'layout'];

      // Список общих терминов, которые всегда исключаем
      const generalTerms = ['food', 'dish', 'meal', 'cuisine', 'cooking', 'dining'];

      // Проверяем, является ли название одним из исключаемых терминов
      return !excludeTerms.some(term => {
        // Точное совпадение
        if (name === term) return true;

        // Абстрактные понятия - исключаем всегда, если они есть в названии
        if (abstractTerms.includes(term) && name.includes(term)) return true;

        // Общие термины - исключаем всегда, если они есть в названии
        if (generalTerms.includes(term) && name.includes(term)) return true;

        // Если название состоит только из исключаемого термина и пробелов/других слов
        const words = name.split(/\s+/);

        // Если все слова в названии - это исключаемые термины, исключаем
        if (words.every(word => excludeTerms.includes(word))) return true;

        // Если название начинается или заканчивается исключаемым термином
        if (name.startsWith(term + ' ') || name.endsWith(' ' + term)) return true;

        return false;
      });
    });

    // Используем отфильтрованные результаты, если они есть
    // Если после фильтрации ничего не осталось, это ошибка - значит все результаты были нерелевантными
    if (filteredConcepts.length === 0) {
      console.warn('⚠️ Все результаты были отфильтрованы как нерелевантные. Попробуем использовать оригинальные результаты.');
      // В крайнем случае используем оригинальные, но это нежелательно
      const fallbackConcepts = concepts.filter(c => {
        const name = (c.name || '').toLowerCase();
        // Минимальная фильтрация - только люди
        return !['no person', 'person', 'people', 'human'].includes(name);
      });
      if (fallbackConcepts.length === 0) {
        throw new Error('Не удалось определить блюдо через Clarifai API - все результаты нерелевантны');
      }
      var conceptsToUse = fallbackConcepts;
    } else {
      var conceptsToUse = filteredConcepts;
    }

    // Сортируем по уверенности и берем топ результаты
    const topConcepts = conceptsToUse
      .sort((a, b) => (b.value || 0) - (a.value || 0))
      .slice(0, 5);

    if (!topConcepts[0] || !topConcepts[0].name) {
      throw new Error('Не удалось определить блюдо через Clarifai API');
    }

    // Выбираем результат с наивысшей уверенностью
    let selectedConcept = topConcepts[0];
    const topConfidence = topConcepts[0].value || 0;

    // Если уверенность первого результата очень низкая (<40%), ищем более надежный вариант
    if (topConfidence < 0.4 && topConcepts.length > 1) {
      const betterMatch = topConcepts.find(c => (c.value || 0) >= 0.4);
      if (betterMatch) {
        selectedConcept = betterMatch;
        console.log(`🔄 Выбран более надежный вариант: ${betterMatch.name} (уверенность: ${Math.round(betterMatch.value * 100)}%) вместо ${topConcepts[0].name} (${Math.round(topConfidence * 100)}%)`);
      }
    }

    const dishName = selectedConcept.name;
    const confidence = selectedConcept.value || 0.7;

    // Переводим на русский (с поддержкой API для неизвестных слов)
    const dishNameRu = await translateToRussianAsync(dishName);

    console.log(`✅ Clarifai распознал: ${dishNameRu} (уверенность: ${Math.round(confidence * 100)}%)`);

    // Дополнительная фильтрация альтернатив - исключаем абстрактные понятия, прилагательные, глаголы
    const abstractTerms = ['nutrition', 'traditional', 'culture', 'heritage', 'custom', 'style',
      'method', 'technique', 'preparation', 'presentation', 'garnish', 'decoration',
      'arrangement', 'display', 'layout', 'food', 'dish', 'meal', 'cuisine'];

    // Прилагательные (описания вкусовых качеств и характеристик)
    const adjectives = [
      'tasty', 'delicious', 'appetizing', 'savory', 'sweet', 'yummy', 'scrumptious',
      'mouthwatering', 'flavorful', 'tempting', 'appealing', 'luscious', 'succulent',
      'juicy', 'fresh', 'crispy', 'tender', 'soft', 'hard', 'hot', 'cold', 'warm',
      'spicy', 'sour', 'bitter', 'salty', 'bland', 'rich', 'light', 'heavy', 'thick',
      'thin', 'smooth', 'rough', 'creamy', 'crunchy', 'chewy', 'moist', 'dry'
    ];

    // Глаголы и действия
    const verbs = [
      'grow', 'growing', 'plant', 'planting', 'cook', 'cooking', 'eat', 'eating',
      'serve', 'serving', 'prepare', 'preparing', 'cut', 'cutting', 'slice', 'slicing',
      'chop', 'chopping', 'mix', 'mixing', 'stir', 'stirring', 'boil', 'boiling',
      'fry', 'frying', 'bake', 'baking', 'grill', 'grilling', 'roast', 'roasting'
    ];

    // Функция для проверки, является ли название существительным (компонентом/блюдом)
    function isNounOrFoodItem(name) {
      const lowerName = name.toLowerCase().trim();

      // Проверяем на прилагательные
      if (adjectives.some(adj => lowerName === adj || lowerName.startsWith(adj + ' ') || lowerName.endsWith(' ' + adj))) {
        return false;
      }

      // Проверяем на глаголы
      if (verbs.some(verb => lowerName === verb || lowerName.startsWith(verb + ' ') || lowerName.endsWith(' ' + verb))) {
        return false;
      }

      // Проверяем на абстрактные понятия
      if (abstractTerms.some(term => lowerName === term || lowerName.includes(term))) {
        return false;
      }

      return true;
    }

    // Фильтруем и переводим альтернативы асинхронно
    const alternativeConcepts = topConcepts
      .filter(c => {
        // Исключаем уже выбранный вариант
        if (c === selectedConcept) return false;

        // Проверяем, является ли название существительным (компонентом/блюдом)
        const name = (c.name || '').toLowerCase().trim();
        return isNounOrFoodItem(name);
      })
      .slice(0, 5); // Берем больше, чтобы после фильтрации осталось достаточно

    // Переводим все альтернативы параллельно
    const translatedAlternatives = await Promise.all(
      alternativeConcepts.map(async (c) => ({
        name: await translateToRussianAsync(c.name),
        originalName: c.name,
        confidence: c.value || 0.5
      }))
    );

    // Дополнительная фильтрация после перевода на русский
    // Русские прилагательные и глаголы
    const russianAdjectives = [
      'вкусный', 'вкусное', 'вкусная', 'вкусные', 'аппетитный', 'аппетитное', 'аппетитная',
      'сочный', 'сочное', 'сочная', 'сочные', 'свежий', 'свежее', 'свежая', 'свежие',
      'хрустящий', 'хрустящее', 'хрустящая', 'хрустящие', 'нежный', 'нежное', 'нежная',
      'мягкий', 'мягкое', 'мягкая', 'мягкие', 'горячий', 'горячее', 'горячая', 'горячие',
      'холодный', 'холодное', 'холодная', 'холодные', 'теплый', 'теплое', 'теплая', 'теплые',
      'острый', 'острое', 'острая', 'острые', 'сладкий', 'сладкое', 'сладкая', 'сладкие',
      'кислый', 'кислое', 'кислая', 'кислые', 'соленый', 'соленое', 'соленая', 'соленые',
      'жирный', 'жирное', 'жирная', 'жирные', 'легкий', 'легкое', 'легкая', 'легкие',
      'тяжелый', 'тяжелое', 'тяжелая', 'тяжелые', 'густой', 'густое', 'густая', 'густые',
      'жидкий', 'жидкое', 'жидкая', 'жидкие', 'гладкий', 'гладкое', 'гладкая', 'гладкие',
      'шершавый', 'шершавое', 'шершавая', 'шершавые', 'кремовый', 'кремовое', 'кремовая',
      'хрустящий', 'хрустящее', 'хрустящая', 'хрустящие', 'жевательный', 'жевательное',
      'влажный', 'влажное', 'влажная', 'влажные', 'сухой', 'сухое', 'сухая', 'сухие'
    ];

    const russianVerbs = [
      'расти', 'растущий', 'растущее', 'растущая', 'растущие', 'растет', 'растут',
      'готовить', 'готовящий', 'готовящее', 'готовящая', 'готовящие', 'готовит', 'готовят',
      'есть', 'едящий', 'едящее', 'едящая', 'едящие', 'ест', 'едят',
      'подавать', 'подающий', 'подающее', 'подающая', 'подающие', 'подает', 'подают',
      'резать', 'режущий', 'режущее', 'режущая', 'режущие', 'режет', 'режут',
      'нарезать', 'нарезающий', 'нарезающее', 'нарезающая', 'нарезающие',
      'мешать', 'мешающий', 'мешающее', 'мешающая', 'мешающие', 'мешает', 'мешают'
    ];

    // Фильтруем переведенные альтернативы
    const filteredAlternatives = translatedAlternatives
      .filter(alt => {
        const name = alt.name.toLowerCase().trim();

        // Проверяем на русские прилагательные
        if (russianAdjectives.some(adj => name === adj || name.startsWith(adj + ' ') || name.endsWith(' ' + adj))) {
          return false;
        }

        // Проверяем на русские глаголы
        if (russianVerbs.some(verb => name === verb || name.startsWith(verb + ' ') || name.endsWith(' ' + verb))) {
          return false;
        }

        // Проверяем оригинальное английское название еще раз
        return isNounOrFoodItem(alt.originalName);
      })
      .slice(0, 3) // Оставляем максимум 3 альтернативы
      .map(alt => ({
        name: alt.name,
        confidence: alt.confidence
      }));

    return {
      dishName: dishNameRu,
      confidence: confidence,
      provider: 'Clarifai',
      alternatives: filteredAlternatives
    };
  } catch (error) {
    console.error(`❌ Ошибка Clarifai: ${error.message}`);
    if (error.response?.status === 401) {
      console.error(`💡 Ошибка 401: Неверный API ключ. Проверьте CLARIFAI_API_KEY`);
    } else if (error.response?.status === 403) {
      console.error(`💡 Ошибка 403: Недостаточно прав. Убедитесь, что токен имеет scope "Model: Predict"`);
    } else if (error.response?.data) {
      console.error(`   Детали ошибки:`, JSON.stringify(error.response.data));
    }
    throw error;
  }
}

// Кэш переводов для избежания повторных запросов
const translationCache = new Map();

// Асинхронная функция перевода через API (для неизвестных слов)
async function translateToRussianAPI(englishName) {
  try {
    // Проверяем кэш
    if (translationCache.has(englishName)) {
      return translationCache.get(englishName);
    }

    // Используем бесплатный MyMemory Translation API
    const response = await axios.get(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(englishName)}&langpair=en|ru`,
      { timeout: 5000 }
    );

    if (response.data?.responseData?.translatedText) {
      const translated = response.data.responseData.translatedText;
      // Сохраняем в кэш
      translationCache.set(englishName, translated);
      console.log(`🌐 Переведено через API: "${englishName}" → "${translated}"`);
      return translated;
    }
  } catch (error) {
    console.warn(`⚠️ Ошибка перевода через API для "${englishName}": ${error.message}`);
  }

  // Если перевод не удался, возвращаем оригинал
  return englishName;
}

// Улучшенная функция перевода с поддержкой большего количества блюд
function translateToRussian(englishName) {
  const translations = {
    // Основные блюда
    'pizza': 'пицца',
    'burger': 'бургер',
    'pasta': 'паста',
    'macaroni': 'макароны',
    'noodle': 'лапша',
    'spaghetti': 'спагетти',
    'salad': 'салат',
    'soup': 'суп',
    'rice': 'рис',
    'chicken': 'курица',
    'fish': 'рыба',
    'bread': 'хлеб',
    'cake': 'торт',
    'pastry': 'пирожное',
    'pie': 'пирог',
    'dessert': 'десерт',
    'sandwich': 'сэндвич',
    'sushi': 'суши',
    'steak': 'стейк',
    'pasta dish': 'паста',
    // Фрукты и овощи
    'apple': 'яблоко',
    'banana': 'банан',
    'orange': 'апельсин',
    'vegetable': 'овощ',
    'fruit': 'фрукт',
    'strawberry': 'клубника',
    'grape': 'виноград',
    'cherry': 'вишня',
    'peach': 'персик',
    'pear': 'груша',
    'plum': 'слива',
    'lemon': 'лимон',
    'lime': 'лайм',
    'grapefruit': 'грейпфрут',
    'carrot': 'морковь',
    'potato': 'картофель',
    'cucumber': 'огурец',
    'pepper': 'перец',
    'garlic': 'чеснок',
    'onion': 'лук',
    'tomato': 'помидор',
    'lettuce': 'салат',
    'cabbage': 'капуста',
    'broccoli': 'брокколи',
    'cauliflower': 'цветная капуста',
    'spinach': 'шпинат',
    'corn': 'кукуруза',
    'pea': 'горох',
    'bean': 'фасоль',
    // Молочные продукты
    'cheese': 'сыр',
    'milk': 'молоко',
    'yogurt': 'йогурт',
    'butter': 'масло',
    'cream': 'сливки',
    'sour cream': 'сметана',
    'cottage cheese': 'творог',
    // Мясо
    'meat': 'мясо',
    'sausage': 'колбаса',
    'beef': 'говядина',
    'pork': 'свинина',
    'lamb': 'баранина',
    'turkey': 'индейка',
    'duck': 'утка',
    'bacon': 'бекон',
    'ham': 'ветчина',
    // Рыба и морепродукты
    'fish': 'рыба',
    'salmon': 'лосось',
    'tuna': 'тунец',
    'shrimp': 'креветка',
    'crab': 'краб',
    'lobster': 'омар',
    'seafood': 'морепродукты',
    // Другое
    'egg': 'яйцо',
    'coffee': 'кофе',
    'tea': 'чай',
    'mushroom': 'гриб',
    // Дополнительные компоненты
    'mayonnaise': 'майонез',
    'sauce': 'соус',
    'herb': 'зелень',
    'spice': 'специя',
    'salt': 'соль',
    'sugar': 'сахар',
    'honey': 'мед',
    'oil': 'масло',
    'vinegar': 'уксус',
    'mustard': 'горчица',
    'ketchup': 'кетчуп',
    // Злаки и крупы
    'rice': 'рис',
    'wheat': 'пшеница',
    'oats': 'овес',
    'barley': 'ячмень',
    'buckwheat': 'гречка',
    'quinoa': 'киноа',
    // Орехи
    'nut': 'орех',
    'almond': 'миндаль',
    'walnut': 'грецкий орех',
    'peanut': 'арахис',
    'hazelnut': 'фундук'
  };

  const lower = englishName.toLowerCase();

  // Сначала проверяем точные совпадения
  if (translations[lower]) {
    return translations[lower];
  }

  // Затем проверяем частичные совпадения
  for (const [en, ru] of Object.entries(translations)) {
    if (lower.includes(en)) {
      return ru;
    }
  }

  // Если это комбинация (например, "pasta with meat"), пытаемся определить основное блюдо
  if (lower.includes('pasta') || lower.includes('macaroni') || lower.includes('noodle')) {
    if (lower.includes('meat') || lower.includes('beef') || lower.includes('pork')) {
      return 'макароны с мясом';
    }
    return 'паста';
  }

  // Если нет перевода в словаре, возвращаем оригинал (будет переведено через API в асинхронной функции)
  return englishName;
}

// Асинхронная обертка для перевода с поддержкой API
async function translateToRussianAsync(englishName) {
  // Сначала пробуем словарь
  const dictTranslation = translateToRussian(englishName);

  // Если перевод из словаря отличается от оригинала, значит нашли перевод
  if (dictTranslation !== englishName) {
    return dictTranslation;
  }

  // Если нет в словаре, используем API
  return await translateToRussianAPI(englishName);
}

// ==================== ОСНОВНАЯ ФУНКЦИЯ РАСПОЗНАВАНИЯ ====================

async function recognizeFood(imageUrl) {
  const imageBuffer = await loadImage(imageUrl);
  return await recognizeWithClarifai(imageBuffer, imageUrl);
}

// ==================== ОБРАТНЫЙ ПЕРЕВОД (РУССКИЙ -> АНГЛИЙСКИЙ) ====================

function translateToEnglish(russianName) {
  const translations = {
    'яйцо': 'egg', 'яйца': 'egg',
    'пицца': 'pizza', 'бургер': 'burger', 'паста': 'pasta', 'макароны': 'macaroni',
    'салат': 'salad', 'суп': 'soup', 'рис': 'rice', 'курица': 'chicken', 'рыба': 'fish',
    'хлеб': 'bread', 'торт': 'cake', 'суши': 'sushi', 'мясо': 'meat', 'сыр': 'cheese',
    'молоко': 'milk', 'яблоко': 'apple', 'банан': 'banana', 'апельсин': 'orange',
    'кофе': 'coffee', 'чай': 'tea', 'гриб': 'mushroom', 'колбаса': 'sausage',
    'говядина': 'beef', 'свинина': 'pork',
    // Дополнительные для русских блюд и ингредиентов
    'авокадо': 'avocado', 'брускета': 'bruschetta', 'брускетта': 'bruschetta',
    'тост': 'toast', 'креветки': 'shrimp', 'лосось': 'salmon', 'тунец': 'tuna',
    'огурец': 'cucumber', 'помидор': 'tomato', 'томат': 'tomato', 'базилик': 'basil',
    'моцарелла': 'mozzarella', 'оливки': 'olives', 'масло': 'oil', 'оливковое': 'olive',
    'ветчина': 'ham', 'бекон': 'bacon', 'индейка': 'turkey', 'утка': 'duck',
    'творог': 'cottage cheese', 'йогурт': 'yogurt', 'сметана': 'sour cream',
    'гречка': 'buckwheat', 'овсянка': 'oatmeal', 'овёс': 'oats',
    'клубника': 'strawberry', 'виноград': 'grape', 'вишня': 'cherry', 'персик': 'peach',
    'груша': 'pear', 'слива': 'plum', 'лимон': 'lemon', 'лайм': 'lime',
    'капуста': 'cabbage', 'брокколи': 'broccoli', 'морковь': 'carrot',
    'лук': 'onion', 'чеснок': 'garlic', 'перец': 'pepper', 'картофель': 'potato',
    'фасоль': 'beans', 'горох': 'pea', 'чечевица': 'lentils',
    'шоколад': 'chocolate', 'мёд': 'honey', 'мед': 'honey', 'орех': 'nut',
    'миндаль': 'almond', 'арахис': 'peanut'
  };

  const lower = russianName.toLowerCase().trim();

  if (translations[lower]) {
    return translations[lower];
  }

  for (const [ru, en] of Object.entries(translations)) {
    if (lower.includes(ru)) {
      return en;
    }
  }

  return russianName;
}

// ==================== ПОЛУЧЕНИЕ КАЛОРИЙ ИЗ OPEN FOOD FACTS ====================

function parseProductNutriments(product, dishName) {
  const nutriments = product.nutriments || {};
  const calories = Math.round(nutriments['energy-kcal_100g'] || nutriments['energy-kcal'] || 0);
  if (calories <= 0) return null;
  return {
    calories,
    protein: Math.round((nutriments['proteins_100g'] || nutriments.proteins || 0) * 10) / 10,
    carbs: Math.round((nutriments['carbohydrates_100g'] || nutriments.carbohydrates || 0) * 10) / 10,
    fats: Math.round((nutriments['fat_100g'] || nutriments.fat || 0) * 10) / 10,
    source: 'Open Food Facts',
    productName: product.product_name || dishName
  };
}

async function searchOpenFoodFacts(searchTerm, pageSize = 10) {
  const searchUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(searchTerm)}&search_simple=1&action=process&json=1&page_size=${pageSize}`;
  const response = await axios.get(searchUrl, {
    timeout: 15000,
    validateStatus: (status) => status === 200
  });
  return response.data?.products || [];
}

async function getCaloriesFromOpenFoodFacts(dishName) {
  try {
    // 1. Поиск полной фразы на русском
    let products = await searchOpenFoodFacts(dishName);
    for (const product of products) {
      const result = parseProductNutriments(product, dishName);
      if (result) {
        console.log(`✅ Open Food Facts (RU): "${dishName}" → ${result.calories} ккал`);
        return result;
      }
    }

    // 2. Поиск на английском (перевод)
    const englishName = translateToEnglish(dishName);
    if (englishName !== dishName) {
      console.log(`🔄 Open Food Facts (EN): "${englishName}"`);
      products = await searchOpenFoodFacts(englishName);
      for (const product of products) {
        const result = parseProductNutriments(product, dishName);
        if (result) {
          console.log(`✅ Open Food Facts (EN): ${result.calories} ккал`);
          return result;
        }
      }
    }

    // 3. Поиск по ключевым словам (русский): "брускета с авокадо" → ["брускета", "авокадо"]
    const stopWords = /\s+(с|и|из|на|в|по|для)\s+/gi;
    const keyParts = dishName.replace(stopWords, ' ').split(/\s+/).filter(w => w.length > 1);
    for (const part of keyParts) {
      if (part.length < 2) continue;
      products = await searchOpenFoodFacts(part);
      for (const product of products) {
        const result = parseProductNutriments(product, dishName);
        if (result) {
          console.log(`✅ Open Food Facts (ключ "${part}"): ${result.calories} ккал`);
          return result;
        }
      }
    }

    // 4. То же по ключевым словам на английском
    for (const part of keyParts) {
      const enPart = translateToEnglish(part);
      if (enPart === part) continue;
      products = await searchOpenFoodFacts(enPart);
      for (const product of products) {
        const result = parseProductNutriments(product, dishName);
        if (result) {
          console.log(`✅ Open Food Facts (ключ EN "${enPart}"): ${result.calories} ккал`);
          return result;
        }
      }
    }

    return null;
  } catch (error) {
    if (error.code !== 'ECONNABORTED' && !error.message.includes('timeout')) {
      console.warn(`⚠️ Ошибка Open Food Facts для "${dishName}": ${error.message}`);
    }
    return null;
  }
}

// ==================== ПОЛУЧЕНИЕ КАЛОРИЙ ИЗ USDA FOODDATA CENTRAL ====================

function translateToEnglishPhrase(russianName) {
  const stopWords = ['с', 'и', 'из', 'на', 'в', 'по', 'для'];
  const words = russianName.toLowerCase().trim().split(/\s+/).filter(w => w.length > 0);
  const translated = words
    .filter(w => !stopWords.includes(w))
    .map(w => translateToEnglish(w));
  return translated.filter((v, i, a) => a.indexOf(v) === i).join(' ');
}

async function getCaloriesFromUSDA(dishName) {
  try {
    // USDA — англоязычный API: переводим фразу или по ключевым словам
    let englishQuery = translateToEnglish(dishName);
    if (englishQuery === dishName) {
      englishQuery = translateToEnglishPhrase(dishName) || dishName;
    }
    if (!englishQuery || englishQuery.length < 2) return null;

    let searchUrl = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(englishQuery)}&pageSize=5&api_key=DEMO_KEY`;
    let response = await axios.get(searchUrl, {
      timeout: 15000,
      validateStatus: (status) => status === 200
    });

    let foods = response.data?.foods || [];

    // Если не нашли — пробуем по первому ключевому слову (например "avocado")
    if (foods.length === 0 && englishQuery.includes(' ')) {
      const firstWord = englishQuery.split(/\s+/)[0];
      if (firstWord.length >= 2) {
        searchUrl = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(firstWord)}&pageSize=5&api_key=DEMO_KEY`;
        response = await axios.get(searchUrl, { timeout: 15000, validateStatus: (status) => status === 200 });
        foods = response.data?.foods || [];
      }
    }

    if (foods.length > 0) {
      const food = foods[0];
      const nutrients = food.foodNutrients || [];
      const getNutrient = (id) => {
        const n = nutrients.find(x => x.nutrientId === id || x.nutrient?.id === id);
        return n?.value || 0;
      };
      const calories = Math.round(getNutrient(1008) || getNutrient(208) || 0);
      if (calories > 0) {
        return {
          calories,
          protein: Math.round((getNutrient(1003) || getNutrient(203) || 0) * 10) / 10,
          carbs: Math.round((getNutrient(1005) || getNutrient(205) || 0) * 10) / 10,
          fats: Math.round((getNutrient(1004) || getNutrient(204) || 0) * 10) / 10,
          source: 'USDA FoodData Central',
          productName: food.description || dishName
        };
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

// ==================== ПОЛУЧЕНИЕ КАЛОРИЙ ====================

async function getCalories(dishName) {
  // Пробуем несколько источников по очереди

  // 1. Open Food Facts
  let result = await getCaloriesFromOpenFoodFacts(dishName);
  if (result && result.calories > 0) {
    console.log(`✅ Калории получены из Open Food Facts: ${result.calories} ккал`);
    return result;
  }

  // 2. USDA FoodData Central
  result = await getCaloriesFromUSDA(dishName);
  if (result && result.calories > 0) {
    console.log(`✅ Калории получены из USDA: ${result.calories} ккал`);
    return result;
  }

  // 3. Примерные значения из базы
  console.log(`⚠️ Не найдено в внешних источниках, используем примерные значения`);
  return getEstimatedCalories(dishName);
}

function getEstimatedCalories(dishName) {
  const dishNameLower = dishName.toLowerCase();

  const calorieDatabase = {
    // Основные блюда
    'пицца': { calories: 266, protein: 11, carbs: 33, fats: 10 },
    'pizza': { calories: 266, protein: 11, carbs: 33, fats: 10 },
    'бургер': { calories: 295, protein: 15, carbs: 30, fats: 14 },
    'burger': { calories: 295, protein: 15, carbs: 30, fats: 14 },
    'паста': { calories: 131, protein: 5, carbs: 25, fats: 1 },
    'pasta': { calories: 131, protein: 5, carbs: 25, fats: 1 },
    'макароны': { calories: 131, protein: 5, carbs: 25, fats: 1 },
    'macaroni': { calories: 131, protein: 5, carbs: 25, fats: 1 },
    'макароны с мясом': { calories: 180, protein: 10, carbs: 25, fats: 5 },
    'pasta with meat': { calories: 180, protein: 10, carbs: 25, fats: 5 },
    'салат': { calories: 20, protein: 1, carbs: 4, fats: 0 },
    'salad': { calories: 20, protein: 1, carbs: 4, fats: 0 },
    'суп': { calories: 50, protein: 2, carbs: 8, fats: 1 },
    'soup': { calories: 50, protein: 2, carbs: 8, fats: 1 },
    'рис': { calories: 130, protein: 2.7, carbs: 28, fats: 0.3 },
    'rice': { calories: 130, protein: 2.7, carbs: 28, fats: 0.3 },
    'курица': { calories: 239, protein: 27, carbs: 0, fats: 14 },
    'chicken': { calories: 239, protein: 27, carbs: 0, fats: 14 },
    'рыба': { calories: 206, protein: 22, carbs: 0, fats: 12 },
    'fish': { calories: 206, protein: 22, carbs: 0, fats: 12 },
    'хлеб': { calories: 265, protein: 9, carbs: 49, fats: 3 },
    'bread': { calories: 265, protein: 9, carbs: 49, fats: 3 },
    'торт': { calories: 367, protein: 5, carbs: 53, fats: 15 },
    'cake': { calories: 367, protein: 5, carbs: 53, fats: 15 },
    'суши': { calories: 150, protein: 5, carbs: 30, fats: 1 },
    'sushi': { calories: 150, protein: 5, carbs: 30, fats: 1 },
    // Мясо
    'мясо': { calories: 250, protein: 26, carbs: 0, fats: 15 },
    'meat': { calories: 250, protein: 26, carbs: 0, fats: 15 },
    'сыр': { calories: 363, protein: 25, carbs: 0, fats: 30 },
    'cheese': { calories: 363, protein: 25, carbs: 0, fats: 30 },
    // Яйца
    'яйцо': { calories: 155, protein: 13, carbs: 1.1, fats: 11 },
    'яйца': { calories: 155, protein: 13, carbs: 1.1, fats: 11 },
    'egg': { calories: 155, protein: 13, carbs: 1.1, fats: 11 },
    'eggs': { calories: 155, protein: 13, carbs: 1.1, fats: 11 },
    // Молочные продукты
    'молоко': { calories: 42, protein: 3.2, carbs: 4.7, fats: 1 },
    'milk': { calories: 42, protein: 3.2, carbs: 4.7, fats: 1 },
    // Фрукты
    'яблоко': { calories: 52, protein: 0.3, carbs: 14, fats: 0.2 },
    'apple': { calories: 52, protein: 0.3, carbs: 14, fats: 0.2 },
    'банан': { calories: 89, protein: 1.1, carbs: 23, fats: 0.3 },
    'banana': { calories: 89, protein: 1.1, carbs: 23, fats: 0.3 },
    'апельсин': { calories: 47, protein: 0.9, carbs: 12, fats: 0.1 },
    'orange': { calories: 47, protein: 0.9, carbs: 12, fats: 0.1 },
    // Напитки
    'кофе': { calories: 2, protein: 0.1, carbs: 0, fats: 0 },
    'coffee': { calories: 2, protein: 0.1, carbs: 0, fats: 0 },
    'чай': { calories: 2, protein: 0, carbs: 0.3, fats: 0 },
    'tea': { calories: 2, protein: 0, carbs: 0.3, fats: 0 },
    // Другое
    'гриб': { calories: 22, protein: 3.1, carbs: 3.3, fats: 0.3 },
    'mushroom': { calories: 22, protein: 3.1, carbs: 3.3, fats: 0.3 },
    'колбаса': { calories: 301, protein: 13, carbs: 1.5, fats: 27 },
    'sausage': { calories: 301, protein: 13, carbs: 1.5, fats: 27 },
    // Русские блюда и ингредиенты
    'авокадо': { calories: 160, protein: 2, carbs: 9, fats: 15 },
    'avocado': { calories: 160, protein: 2, carbs: 9, fats: 15 },
    'брускета': { calories: 220, protein: 6, carbs: 22, fats: 12 },
    'брускетта': { calories: 220, protein: 6, carbs: 22, fats: 12 },
    'брускета с авокадо': { calories: 280, protein: 5, carbs: 25, fats: 18 },
    'bruschetta': { calories: 220, protein: 6, carbs: 22, fats: 12 },
    'тост': { calories: 130, protein: 4, carbs: 24, fats: 1 },
    'toast': { calories: 130, protein: 4, carbs: 24, fats: 1 },
    'креветки': { calories: 99, protein: 24, carbs: 0.2, fats: 0.3 },
    'shrimp': { calories: 99, protein: 24, carbs: 0.2, fats: 0.3 },
    'лосось': { calories: 208, protein: 20, carbs: 0, fats: 13 },
    'salmon': { calories: 208, protein: 20, carbs: 0, fats: 13 },
    'тунец': { calories: 132, protein: 28, carbs: 0, fats: 1 },
    'tuna': { calories: 132, protein: 28, carbs: 0, fats: 1 },
    'огурец': { calories: 15, protein: 0.7, carbs: 3.6, fats: 0.1 },
    'cucumber': { calories: 15, protein: 0.7, carbs: 3.6, fats: 0.1 },
    'помидор': { calories: 18, protein: 0.9, carbs: 3.9, fats: 0.2 },
    'томат': { calories: 18, protein: 0.9, carbs: 3.9, fats: 0.2 },
    'tomato': { calories: 18, protein: 0.9, carbs: 3.9, fats: 0.2 },
    'моцарелла': { calories: 280, protein: 28, carbs: 3, fats: 17 },
    'mozzarella': { calories: 280, protein: 28, carbs: 3, fats: 17 },
    'оливки': { calories: 115, protein: 0.8, carbs: 6, fats: 11 },
    'olives': { calories: 115, protein: 0.8, carbs: 6, fats: 11 },
    'шоколад': { calories: 546, protein: 5, carbs: 61, fats: 31 },
    'chocolate': { calories: 546, protein: 5, carbs: 61, fats: 31 },
    'творог': { calories: 121, protein: 17, carbs: 3.4, fats: 5 },
    'cottage cheese': { calories: 121, protein: 17, carbs: 3.4, fats: 5 },
    'йогурт': { calories: 59, protein: 10, carbs: 3.5, fats: 0.4 },
    'yogurt': { calories: 59, protein: 10, carbs: 3.5, fats: 0.4 },
    'клубника': { calories: 32, protein: 0.7, carbs: 8, fats: 0.3 },
    'strawberry': { calories: 32, protein: 0.7, carbs: 8, fats: 0.3 },
    'гречка': { calories: 343, protein: 12.6, carbs: 72, fats: 3.3 },
    'buckwheat': { calories: 343, protein: 12.6, carbs: 72, fats: 3.3 },
    'овсянка': { calories: 389, protein: 16.9, carbs: 66, fats: 6.9 },
    'oatmeal': { calories: 389, protein: 16.9, carbs: 66, fats: 6.9 }
  };

  // Сначала проверяем точные и длинные совпадения (например "брускета с авокадо")
  const sortedKeys = Object.keys(calorieDatabase).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (dishNameLower.includes(key)) {
      return {
        ...calorieDatabase[key],
        source: 'Примерные значения',
        productName: dishName
      };
    }
  }

  return {
    calories: 200,
    protein: 10,
    carbs: 25,
    fats: 8,
    source: 'Примерные значения',
    productName: dishName
  };
}

// ==================== API ENDPOINTS ====================

app.post('/recognize', async (req, res) => {
  try {
    const { imageUrl, chatId } = req.body;

    console.log(`\n📸 Получен запрос на распознавание от пользователя ${chatId}`);
    console.log(`📋 Параметры запроса:`, { imageUrl: imageUrl ? 'указан' : 'отсутствует', chatId });

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        error: 'imageUrl обязателен'
      });
    }

    // Распознаем блюдо
    let recognitionResult;
    try {
      recognitionResult = await recognizeFood(imageUrl);
      console.log(`✅ Блюдо распознано: ${recognitionResult.dishName} (уверенность: ${Math.round(recognitionResult.confidence * 100)}%, провайдер: ${recognitionResult.provider})`);
    } catch (recognitionError) {
      console.error('❌ Ошибка на этапе распознавания:', recognitionError);
      return res.status(500).json({
        success: false,
        error: recognitionError.message || 'Ошибка распознавания блюда'
      });
    }

    // Получаем калории
    let nutritionInfo;
    try {
      nutritionInfo = await getCalories(recognitionResult.dishName);
      console.log(`✅ Калории получены: ${nutritionInfo.calories} ккал (источник: ${nutritionInfo.source})`);
    } catch (caloriesError) {
      console.error('❌ Ошибка получения калорий, используем примерные значения:', caloriesError);
      nutritionInfo = getEstimatedCalories(recognitionResult.dishName);
    }

    const result = {
      success: true,
      dishName: recognitionResult.dishName,
      confidence: Math.round(recognitionResult.confidence * 100),
      calories: nutritionInfo.calories,
      protein: nutritionInfo.protein,
      carbs: nutritionInfo.carbs,
      fats: nutritionInfo.fats,
      source: nutritionInfo.source,
      provider: recognitionResult.provider,
      alternatives: recognitionResult.alternatives || []
    };

    console.log(`✅ Распознавание завершено успешно: ${result.dishName} (${result.calories} ккал, провайдер: ${result.provider})\n`);

    res.json(result);
  } catch (error) {
    console.error('❌ Критическая ошибка обработки запроса:', {
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      error: error.message || 'Неожиданная ошибка при распознавании блюда'
    });
  }
});

// Поиск БЖУ по названию блюда (Open Food Facts, USDA, примерные значения)
app.get('/nutrition', async (req, res) => {
  try {
    const query = (req.query.query || req.query.name || '').trim();
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Укажите название блюда (query или name)'
      });
    }

    console.log(`🔍 Поиск БЖУ по названию: "${query}"`);

    let nutritionInfo;
    try {
      nutritionInfo = await getCalories(query);
    } catch (err) {
      console.warn(`⚠️ Ошибка getCalories для "${query}":`, err.message);
      nutritionInfo = getEstimatedCalories(query);
    }

    res.json({
      success: true,
      dishName: nutritionInfo.productName || query,
      calories: nutritionInfo.calories,
      protein: nutritionInfo.protein ?? 0,
      carbs: nutritionInfo.carbs ?? 0,
      fats: nutritionInfo.fats ?? 0,
      source: nutritionInfo.source || 'Примерные значения'
    });
  } catch (error) {
    console.error('❌ Ошибка /nutrition:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Ошибка поиска БЖУ'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'food-recognition-service',
    provider: 'clarifai',
    clarifai: !!CLARIFAI_API_KEY
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Food Recognition Service запущен на порту ${PORT}`);
  console.log(`📋 Используется провайдер: Clarifai`);
});
