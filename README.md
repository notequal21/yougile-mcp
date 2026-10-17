# yougile-mcp

Локальный MCP-сервер (stdio) для [YouGile](https://yougile.com) на базе REST API v2. Он позволяет LLM-клиенту
(Claude Desktop, Claude Code, Cursor и др.) читать и редактировать данные компании: проекты, доски, колонки, задачи,
стикеры, чаты, сотрудников, отделы, роли и вебхуки. Работает с облаком YouGile и с on-prem установками.

> Статус: реализованы все 66 инструментов (25 чтение, 29 запись, 12 деструктивные). Живая проверка против реального
> YouGile ещё не выполнялась — см. [`docs/implementation-report.md`](docs/implementation-report.md).
> Проектное решение: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Требования

- Node.js **20 или новее**
- npm
- API-ключ YouGile (см. ниже)

## Установка и сборка

```sh
git clone <repo-url> yougile-mcp
cd yougile-mcp
npm install
npm run build
```

Проверка качества: `npm run check` (`tsc --noEmit`, `eslint`, `vitest run`). Тесты не используют сеть.
Интерактивная отладка через MCP Inspector: `npm run inspect` (нужны переменные окружения, см. ниже).

## Получение API-ключа

Сервер **никогда не принимает и не хранит пароль**. Ключ создаётся один раз вручную, пароль вводится только в этих двух
командах `curl` и не передаётся серверу.

1. Найдите `id` компании (поле `name` — необязательный фильтр по названию):

   ```sh
   curl -s -X POST https://yougile.com/api-v2/auth/companies \
     -H 'Content-Type: application/json' \
     -d '{"login":"you@example.com","password":"<пароль>","name":"Моя компания"}'
   ```

   В ответе (`content`) найдите нужную компанию и её `id`. `id` также можно скопировать в интерфейсе: Ctrl+Alt+Q
   (Ctrl+Option+Q на Mac).

2. Создайте ключ:

   ```sh
   curl -s -X POST https://yougile.com/api-v2/auth/keys \
     -H 'Content-Type: application/json' \
     -d '{"login":"you@example.com","password":"<пароль>","companyId":"<id компании>"}'
   ```

   Ответ: `{"key":"..."}`. Это значение — `YOUGILE_API_KEY`. Ключ не истекает; на аккаунт действует лимит числа ключей
   (около 30). Не коммитьте ключ в репозиторий. Чтобы пароль не попал в историю shell, начните команду с пробела
   или читайте тело запроса из файла.

Для on-prem замените `https://yougile.com` на адрес вашего сервера.

## Переменные окружения

| Переменная                   | Обязательна | По умолчанию          | Описание                                                                                                     |
| ---------------------------- | ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `YOUGILE_API_KEY`            | да          | —                     | Bearer-ключ API                                                                                              |
| `YOUGILE_BASE_URL`           | нет         | `https://yougile.com` | Только origin; `/api-v2` добавляется автоматически. Только `https:` (кроме `http://localhost` / `127.0.0.1`) |
| `YOUGILE_ALLOW_WRITES`       | нет         | `false`               | Без `true` изменяющие инструменты не регистрируются (режим только чтения)                                    |
| `YOUGILE_ALLOW_DESTRUCTIVE`  | нет         | `false`               | Регистрирует «мягкое» удаление и удаление пользователя/роли. Требует `YOUGILE_ALLOW_WRITES=true`             |
| `YOUGILE_RATE_LIMIT_PER_MIN` | нет         | `40`                  | Клиентский бюджет запросов в минуту, 1–50                                                                    |
| `YOUGILE_TIMEOUT_MS`         | нет         | `15000`               | Таймаут одной попытки HTTP, 1000–60000                                                                       |
| `YOUGILE_MAX_ITEMS`          | нет         | `500`                 | Максимум элементов при автопостраничном чтении, 1–5000                                                       |
| `YOUGILE_LOG_LEVEL`          | нет         | `info`                | `error` / `warn` / `info` / `debug`; логи только в stderr                                                    |

При неверной конфигурации сервер завершается с кодом 2 и печатает одну строку в stderr (без значения ключа).

## Подключение к клиентам

Замените `/абсолютный/путь/к/yougile-mcp` на путь к вашей копии репозитория (после `npm run build`).

### Claude Desktop

Файл `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "yougile": {
      "command": "node",
      "args": ["/абсолютный/путь/к/yougile-mcp/dist/index.js"],
      "env": {
        "YOUGILE_API_KEY": "<ключ>",
        "YOUGILE_ALLOW_WRITES": "true"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add yougile \
  --env YOUGILE_API_KEY=<ключ> \
  --env YOUGILE_ALLOW_WRITES=true \
  -- node /абсолютный/путь/к/yougile-mcp/dist/index.js
```

### Cursor / другие клиенты с `mcpServers` JSON

Cursor: `~/.cursor/mcp.json` или `.cursor/mcp.json` в проекте. Формат тот же:

```json
{
  "mcpServers": {
    "yougile": {
      "command": "node",
      "args": ["/абсолютный/путь/к/yougile-mcp/dist/index.js"],
      "env": { "YOUGILE_API_KEY": "<ключ>" }
    }
  }
}
```

> Пакет пока не опубликован в npm: используйте абсолютный путь к локальному `dist/index.js`.

## Уровни безопасности

| Уровень                                | Включается                                          | Что доступно                                                                                                |
| -------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Чтение (по умолчанию, 25 инструментов) | —                                                   | Только инструменты чтения (`get`/`list`)                                                                    |
| Запись (+29, всего 54)                 | `YOUGILE_ALLOW_WRITES=true`                         | Создание и обновление объектов, отправка сообщений, восстановление удалённого                               |
| Деструктивный (+12, всего 66)          | `YOUGILE_ALLOW_DESTRUCTIVE=true` (вместе с записью) | «Мягкое» удаление (доски, колонки, проекты, задачи, сообщения, вебхуки и др.), удаление пользователя и роли |

Недоступные инструменты не регистрируются — модель их не видит. Деструктивные инструменты дополнительно требуют
параметр `confirm: true`. Обновления отправляют только переданные поля. Универсального инструмента «вызвать любой URL»
нет, пароль серверу не передаётся.

## Ограничение частоты запросов

YouGile допускает не более **50 запросов в минуту на компанию**. Сервер использует единый клиентский лимитер
(по умолчанию 40 запросов в минуту, `YOUGILE_RATE_LIMIT_PER_MIN`), ставит запросы в очередь и при ответе 429 делает паузу.
Если ключ используется ещё и другими интеграциями той же компании, уменьшите значение.

## Разработка

См. [`AGENTS.md`](AGENTS.md) и [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).

### Date and response behavior

Task deadlines and chat timestamps accept epoch milliseconds or ISO dates. Sprint sticker `begin` and `end` accept epoch **seconds** or ISO dates and send seconds to YouGile. Datetimes must include `Z` or a numeric timezone offset; date-only `YYYY-MM-DD` means UTC. `YOUGILE_LOG_LEVEL` is reserved for future diagnostics; runtime request diagnostics are suppressed to avoid leaking secrets.
