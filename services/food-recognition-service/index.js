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
    
    // Используем публичную модель Clarifai для распознавания еды
    // food-item-recognition - распознает более 1000 видов еды
    const apiUrl = 'https://api.clarifai.com/v2/users/clarifai/apps/main/models/food-item-recognition/outputs';
    
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
    
    // Фильтруем слишком общие понятия, которые не являются конкретными блюдами
    const generalTerms = ['food', 'dish', 'meal', 'cuisine', 'cooking', 'recipe', 'ingredient'];
    const filteredConcepts = concepts.filter(c => {
      const name = (c.name || '').toLowerCase();
      // Исключаем слишком общие термины, если есть более конкретные варианты
      return !generalTerms.some(term => name === term || name.includes(term + ' '));
    });
    
    // Используем отфильтрованные результаты, если они есть, иначе оригинальные
    const conceptsToUse = filteredConcepts.length > 0 ? filteredConcepts : concepts;
    
    // Сортируем по уверенности и берем топ результаты
    const topConcepts = conceptsToUse
      .sort((a, b) => (b.value || 0) - (a.value || 0))
      .slice(0, 5);

    if (!topConcepts[0] || !topConcepts[0].name) {
      throw new Error('Не удалось определить блюдо через Clarifai API');
    }

    // Улучшенная логика выбора: если уверенность первого результата очень низкая (<30%),
    // ищем первый результат с уверенностью выше 30%
    let selectedConcept = topConcepts[0];
    const topConfidence = topConcepts[0].value || 0;
    
    // Если уверенность первого результата очень низкая, ищем более надежный вариант
    if (topConfidence < 0.3 && topConcepts.length > 1) {
      const betterMatch = topConcepts.find(c => (c.value || 0) >= 0.3);
      if (betterMatch) {
        selectedConcept = betterMatch;
        console.log(`🔄 Выбран более надежный вариант: ${betterMatch.name} (уверенность: ${Math.round(betterMatch.value * 100)}%) вместо ${topConcepts[0].name} (${Math.round(topConfidence * 100)}%)`);
      }
    }

    const dishName = selectedConcept.name;
    const confidence = selectedConcept.value || 0.7;

    // Переводим на русский, если нужно
    const dishNameRu = translateToRussian(dishName);

    console.log(`✅ Clarifai распознал: ${dishNameRu} (уверенность: ${Math.round(confidence * 100)}%)`);
    
    return {
      dishName: dishNameRu,
      confidence: confidence,
      provider: 'Clarifai',
      alternatives: topConcepts
        .filter(c => c !== selectedConcept) // Исключаем уже выбранный вариант
        .slice(0, 3)
        .map(c => ({
          name: translateToRussian(c.name),
          confidence: c.value || 0.5
        }))
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
    'sandwich': 'сэндвич',
    'sushi': 'суши',
    'steak': 'стейк',
    'pasta dish': 'паста',
    'food': 'еда',
    'dish': 'блюдо',
    'meal': 'блюдо',
    // Фрукты и овощи
    'apple': 'яблоко',
    'banana': 'банан',
    'orange': 'апельсин',
    'vegetable': 'овощ',
    'fruit': 'фрукт',
    // Молочные продукты
    'cheese': 'сыр',
    'milk': 'молоко',
    // Мясо
    'meat': 'мясо',
    'sausage': 'колбаса',
    'beef': 'говядина',
    'pork': 'свинина',
    // Другое
    'egg': 'яйцо',
    'coffee': 'кофе',
    'tea': 'чай',
    'mushroom': 'гриб'
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
  
  return englishName; // Возвращаем оригинал, если нет перевода
}

// ==================== ОСНОВНАЯ ФУНКЦИЯ РАСПОЗНАВАНИЯ ====================

async function recognizeFood(imageUrl) {
  const imageBuffer = await loadImage(imageUrl);
  return await recognizeWithClarifai(imageBuffer, imageUrl);
}

// ==================== ПОЛУЧЕНИЕ КАЛОРИЙ ====================

async function getCalories(dishName) {
  try {
    // Пробуем найти продукт в базе Open Food Facts
    const searchUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(dishName)}&search_simple=1&action=process&json=1&page_size=5`;

    const response = await axios.get(searchUrl, {
      timeout: 20000, // Увеличено с 10000 до 20000ms для избежания timeout
      validateStatus: (status) => status === 200
    });

    if (response.data && response.data.products && response.data.products.length > 0) {
      const product = response.data.products[0];
      const nutriments = product.nutriments || {};

      return {
        calories: Math.round(nutriments['energy-kcal_100g'] || nutriments['energy-kcal'] || 0),
        protein: Math.round((nutriments['proteins_100g'] || nutriments.proteins || 0) * 10) / 10,
        carbs: Math.round((nutriments['carbohydrates_100g'] || nutriments.carbohydrates || 0) * 10) / 10,
        fats: Math.round((nutriments['fat_100g'] || nutriments.fat || 0) * 10) / 10,
        source: 'Open Food Facts',
        productName: product.product_name || dishName
      };
    }

    return getEstimatedCalories(dishName);
  } catch (error) {
    // Улучшенная обработка ошибок - не логируем timeout как критическую ошибку
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      console.warn(`⚠️ Timeout при получении калорий для "${dishName}", используем примерные значения`);
    } else {
      console.error('❌ Ошибка получения калорий:', error.message);
    }
    return getEstimatedCalories(dishName);
  }
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
    'cheese': { calories: 363, protein: 25, carbs: 0, fats: 30 }
  };

  for (const [key, value] of Object.entries(calorieDatabase)) {
    if (dishNameLower.includes(key)) {
      return {
        ...value,
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
