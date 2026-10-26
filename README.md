# OpenCode_ProxyRouter

![OpenCode V2](https://img.shields.io/badge/OpenCode-V2-blue)
![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933)
![License MIT](https://img.shields.io/badge/license-MIT-green)

Плагин для **OpenCode V2**, который поднимает локальный reverse-proxy и направляет через внешний
SOCKS5/HTTP-прокси **только выбранные модели**. Остальные модели, LocalAI и прочие провайдеры
продолжают работать напрямую.

Зачем: часть моделей недоступна из отдельных регионов (например, Beam Free и Muse Spark). Глобальный
`HTTP_PROXY` в V2 не помогает — запросы к провайдерам делает фоновый сервис, а не TUI. Плагин решает
это per-model и переключается на лету.

```
OpenCode ──► 127.0.0.1:<port>/<host>/<path> ──► SOCKS5 / HTTP CONNECT ──► <host>
```

## Возможности

- Прокси **только для выбранных моделей**: `provider/model`, `provider/*`, `provider`, `*`.
- Схемы прокси: `http://`, `https://` (TLS до прокси), `socks5://`, `socks5h://`; логин/пароль в URL.
- Включение и выключение без перезапуска: `/proxy on`, `/proxy off`, `/proxy status`.
- Стриминг ответов без буфера — SSE и длинные ответы работают как обычно.
- Пароль прокси маскируется в логах и статусе; заголовки авторизации не логируются.
- Релей слушает только `127.0.0.1` и ходит только на хосты, которые встретились в `baseURL`
  перенаправленных моделей.
- Ноль зависимостей, только `node:`-модули.

## Требования

- OpenCode **V2**.
- Внешний forward-прокси, умеющий `CONNECT` (HTTP/SOCKS5).
- Плагин должен быть доступен сервису по абсолютному пути.

## Установка

Параметры в V2 передаются только через `plugins` в `opencode.json`, поэтому копировать плагин в
`~/.config/opencode/plugins` не нужно — достаточно указать путь.

Откройте `~/.config/opencode/opencode.json` (Windows: `%USERPROFILE%\.config\opencode\opencode.json`)
и добавьте запись:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "E:/DefaultDF/Programming/Qwen/Projects/OpenCodeV2_Plugins/ProxyRouter_OCV2/plugin",
      "options": {
        "proxy": "socks5h://proxy.example.com:1080",
        "models": ["opencode-go/beam-free", "opencode-go/muse-spark-1.3-contributor"],
        "enabled": true
      }
    }
  ]
}
```

Сохраните файл — конфиг перезагрузится сам, релей поднимется сразу. Проверка в TUI:

```
/proxy status
```

```
Proxy Router: ВКЛ
Прокси: socks5h://proxy.example.com:1080
Цели: opencode-go/beam-free, opencode-go/muse-spark-1.3-contributor
Релей: http://127.0.0.1:64388
Перенаправлено: opencode-go/beam-free, opencode-go/muse-spark-1.3-contributor
```

`install.bat` просто печатает готовый фрагмент с правильным путём и открывает конфиг — правку
делаете вы, скрипт ничего не перезаписывает.

## Опции

| Опция | Тип | По умолчанию | Описание |
|---|---|---|---|
| `proxy` | string | — | URL прокси: `http://`, `https://`, `socks5://`, `socks5h://`. Учётные данные можно зашить в URL: `socks5h://user:pass@host:1080`. Обязательна. |
| `models` | string[] | `[]` | Что заворачивать: `"provider/model"`, `"provider/*"`, `"provider"`, `"*"`. |
| `enabled` | boolean | `true` | Поднимать релей при загрузке плагина. |
| `port` | number | `0` | Порт релея; `0` — свободный (рекомендуется). При занятом порте плагин не стартует и пишет ошибку в статус. |
| `upstreams` | object | `{}` | Запасной `baseURL` по провайдеру, если провайдер его не отдаёт: `{ "opencode-go": "https://opencode.ai/inference/go/openai/v1" }`. |
| `log` | boolean | `false` | Писать в лог каждый запрос релея: `METHOD host/path -> status`. |

Переменная окружения `PROXY_ROUTER_DEBUG=<файл>` дублирует лог плагина в файл.

### Схемы прокси

| Схема | Что делает |
|---|---|
| `http://host:port` | HTTP `CONNECT`, учётные данные через `Proxy-Authorization` |
| `https://host:port` | TLS до прокси, дальше `CONNECT` |
| `socks5://host:port` | SOCKS5, имя резолвится локально (IPv4) |
| `socks5h://host:port` | SOCKS5, имя резолвит прокси (лучше для заблокированных хостов) |

## Использование

- Команда в TUI: `/proxy on`, `/proxy off`, `/proxy status`.
- Инструмент агента: `proxy_router` с `action: "on" | "off" | "status"`.

`status` показывает состояние, прокси (пароль скрыт), цели, адрес релея и список моделей, у которых
`baseURL` реально подменён. Если модель попала в «Пропущено» — у неё не нашёлся `baseURL` или
апстрим не `https`.

При `off` транформация снимается, модели возвращаются на прямой адрес провайдера, релей закрывается.

## Как это работает

1. `setup(ctx)` читает опции и поднимает релей (`plugin/relay.js`).
2. Релей принимает `http://127.0.0.1:<port>/<host>/<path>`, где `<host>` — хост провайдера, а `<path>` —
   исходный путь `baseURL` (пакет провайдера дописывает свои `/chat/completions` или `/responses`).
3. Для каждого запроса `plugin/dialer.js` открывает туннель: `CONNECT`/SOCKS5 → TLS с SNI и проверкой
   сертификата.
4. Запрос уходит через `https.request` поверх готового TLS-сокета; тело и ответ стримятся.
5. Model transform подменяет `settings.baseURL` только у совпавших моделей и разрешает релею ровно те
   хосты, что встретились в их `baseURL`; остальные получают `403`.

Подмена делается через `ctx.model.transform` + `ctx.model.reload()`, поэтому применяется и снимается
без рестарта сервиса и без правки `opencode.json`.

## Модели с региональными ограничениями

- `opencode/beam-free`, `opencode-go/beam-free` — Beam Free недоступен в ряде стран, включая РФ.
- `opencode-go/muse-spark-1.3-contributor`, `opencode-go/muse-spark-1.2-contributor` — Muse Spark
  Contributor ограничен Geo-policy Meta. Дополнительно нужна подписка **OpenCode Go** и включённая
  галочка **Settings › Privacy → Allow paid endpoints that train on request data**.
- `opencode/muse-spark-1.3`, `opencode/muse-spark-1.2` — платные модели Console.

Платные модели по умолчанию скрывает [ModelsDisabler](https://github.com/StandarterDF/ModelsDisabler_OCV2) —
id нужно добавить в его allowlist.

## Ограничения

- Только `https`-апстримы: `http://`-провайдеры не переписываются (причина будет в «Пропущено»).
- Только HTTP-транспорт. Модели, которые стримят через WebSocket, через релей не пойдут.
- Прокси должен поддерживать `CONNECT`; `https://` означает TLS **до прокси**, а не «прокси для HTTPS».
- `socks5://` (локальный резолв) умеет только IPv4; для IPv6 используйте `socks5h://`.
- Релей живёт в процессе сервиса: после перезапуска сервиса при `enabled: true` он поднимется сам,
  но с новым эфемерным портом (это нормально, `baseURL` пересчитывается).

## Диагностика

| Симптом | Что проверить |
|---|---|
| `502 relay could not reach ...` | Прокси недоступен или не умеет `CONNECT`: `curl -x <proxy> https://opencode.ai/inference/v1/models`. |
| `502 ... HTTP 407` | Неверные логин/пароль прокси. |
| `403 relay host is not allowed` | Модель не попала в `models`. Смотрите `/proxy status`. |
| Модель в «Пропущено» | Нет `baseURL` у провайдера — задайте `upstreams.<provider>`. |
| Осталась ошибка страны | Прокси-выход в запрещённом регионе; проверьте exit IP. |
| Статус «ВЫКЛ» сразу после сохранения конфига | Сервис пересоздаёт экземпляр плагина, подождите 1–2 секунды. |

Подробный лог: `"log": true` и/или `PROXY_ROUTER_DEBUG=<файл>`.

## Безопасность

- Релей слушает только `127.0.0.1` и принимает только разрешённые хосты. Это не аутентификация:
  любой локальный процесс может обратиться к разрешённым хостам. Выключайте `/proxy off`, когда не нужно.
- Пароль прокси хранится в `opencode.json`; в логах и статусе он маскируется (`***`).
- Заголовки авторизации провайдера передаются как есть и не логируются.

## Разработка и тесты

```powershell
cd ProxyRouter_OCV2
node --test
```

Юнит-тесты поднимают фейковый апстрим и фейковые HTTP/SOCKS5-прокси. Хост в тестах
(`relay.invalid`) не резолвится специально: если релей попробует соединиться напрямую, тест упадёт.

Ручной интеграционный тест через реальный прокси:

```powershell
$env:PROXY_ROUTER_TEST_PROXY = "http://proxy.example.com:8080"
node tests/integration.mjs
```

## Структура

```
ProxyRouter_OCV2/
├── plugin/
│   ├── index.js        # плагин: опции, transform, /proxy, инструмент
│   ├── relay.js        # локальный reverse-proxy
│   ├── dialer.js       # CONNECT / SOCKS5 / TLS
│   └── package.json
├── tests/              # node --test + интеграционный скрипт
├── opencode.json       # маркер проекта ($schema)
├── install.bat         # печатает фрагмент конфига
├── AGENTS.md           # правила проекта
├── CHANGES.md
├── LICENSE
└── README.md
```

## Лицензия

MIT — см. [LICENSE](LICENSE).
