// Скрипт для ручного создания таблицы favorites
// Использование: node createTable.js

import { initTables, testConnection, checkTableExists } from './dataBase.js';

async function main() {
  console.log('🚀 Запуск скрипта создания таблицы...\n');

  // Проверяем подключение
  console.log('1. Проверка подключения к БД...');
  const connected = await testConnection();

  if (!connected) {
    console.error('❌ Не удалось подключиться к БД!');
    console.error('Проверьте настройки в .env файле:');
    console.error('  - DB_HOST');
    console.error('  - DB_PORT');
    console.error('  - DB_NAME');
    console.error('  - DB_USER');
    console.error('  - DB_PASSWORD');
    process.exit(1);
  }

  console.log('\n2. Создание таблицы favorites...');
  const success = await initTables();

  if (success) {
    console.log('\n3. Проверка создания таблицы...');
    const exists = await checkTableExists('favorites');

    if (exists) {
      console.log('\n✅ УСПЕХ! Таблица favorites успешно создана!');
      process.exit(0);
    } else {
      console.log('\n❌ ОШИБКА! Таблица не была создана.');
      console.log('Возможные причины:');
      console.log('  - Пользователь БД не имеет прав CREATE TABLE');
      console.log('  - Ошибка в SQL запросе');
      console.log('  - Проблемы с подключением');
      process.exit(1);
    }
  } else {
    console.log('\n❌ ОШИБКА! Не удалось создать таблицу.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Критическая ошибка:', error);
  process.exit(1);
});

