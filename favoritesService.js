import { query } from './dataBase.js';

// Добавление рецепта в избранное
export const addToFavorites = async (chatId, recipeData) => {
  const { url, title, text, dishType, hasPhoto, photoFileId } = recipeData;

  if (!url || !title) {
    throw new Error('URL и название рецепта обязательны');
  }

  try {
    const result = await query(
      `INSERT INTO favorites (chat_id, recipe_url, recipe_title, recipe_text, dish_type, has_photo, photo_file_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (chat_id, recipe_url) DO NOTHING
       RETURNING id`,
      [
        chatId,
        url,
        title,
        text || '',
        dishType || null,
        hasPhoto || false,
        photoFileId || null
      ]
    );

    return result.rows.length > 0;
  } catch (error) {
    console.error('❌ Ошибка добавления в избранное:', error);
    throw error;
  }
};

// Проверка, есть ли рецепт в избранном
export const isInFavorites = async (chatId, recipeUrl) => {
  try {
    const result = await query(
      `SELECT id FROM favorites WHERE chat_id = $1 AND recipe_url = $2`,
      [chatId, recipeUrl]
    );
    return result.rows.length > 0;
  } catch (error) {
    console.error('❌ Ошибка проверки избранного:', error);
    return false;
  }
};

// Получение всех избранных рецептов пользователя
export const getFavorites = async (chatId, limit = 50, offset = 0) => {
  try {
    const result = await query(
      `SELECT id, recipe_url, recipe_title, recipe_text, dish_type, has_photo, photo_file_id, added_at
       FROM favorites
       WHERE chat_id = $1
       ORDER BY added_at DESC
       LIMIT $2 OFFSET $3`,
      [chatId, limit, offset]
    );
    return result.rows;
  } catch (error) {
    console.error('❌ Ошибка получения избранного:', error);
    throw error;
  }
};

// Получение количества избранных рецептов
export const getFavoritesCount = async (chatId) => {
  try {
    const result = await query(
      `SELECT COUNT(*) as count FROM favorites WHERE chat_id = $1`,
      [chatId]
    );
    return parseInt(result.rows[0].count);
  } catch (error) {
    console.error('❌ Ошибка подсчета избранного:', error);
    return 0;
  }
};

// Удаление рецепта из избранного по URL
export const removeFromFavorites = async (chatId, recipeUrl) => {
  try {
    const result = await query(
      `DELETE FROM favorites WHERE chat_id = $1 AND recipe_url = $2`,
      [chatId, recipeUrl]
    );
    return result.rowCount > 0;
  } catch (error) {
    console.error('❌ Ошибка удаления из избранного:', error);
    throw error;
  }
};

// Удаление рецепта из избранного по ID
export const removeFromFavoritesById = async (chatId, favoriteId) => {
  try {
    const result = await query(
      `DELETE FROM favorites WHERE id = $1 AND chat_id = $2`,
      [favoriteId, chatId]
    );
    return result.rowCount > 0;
  } catch (error) {
    console.error('❌ Ошибка удаления из избранного по ID:', error);
    throw error;
  }
};

// Получение одного рецепта из избранного по ID
export const getFavoriteById = async (chatId, favoriteId) => {
  try {
    const result = await query(
      `SELECT id, recipe_url, recipe_title, recipe_text, dish_type, has_photo, photo_file_id, added_at
       FROM favorites
       WHERE id = $1 AND chat_id = $2`,
      [favoriteId, chatId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('❌ Ошибка получения избранного по ID:', error);
    return null;
  }
};

// Извлечение названия рецепта из текста (первая строка до \n)
const extractTitle = (text) => {
  if (!text) return 'Рецепт без названия';
  const firstLine = text.split('\n')[0];
  return firstLine.length > 100 ? firstLine.substring(0, 100) + '...' : firstLine;
};

