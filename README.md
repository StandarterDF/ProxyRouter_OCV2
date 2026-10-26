# OpenCode_ProxyRouter

> Плагин для OpenCode V2: держит локальный reverse-proxy и направляет через
> внешний **SOCKS5/HTTP-прокси только выбранные модели**. Остальные модели,
> LocalAI и прочие провайдеры продолжают работать напрямую.

## Описание

Плагин нужен для моделей, которые недоступны из отдельных регионов (например,
Beam Free и Muse Spark). В OpenCode V2 запросы к провайдерам выполняет фоновый
сервис, а не TUI, поэтому `proxy-on` в шелле и `HTTP_PROXY` до него не доходят,
а `opencode service set env` перезапускает сервис и рушит сессию.

Здесь используется другой механизм: плагин поднимает HTTP-сервер на
`127.0.0.1` и подменяет у выбранных моделей `settings.baseURL` на этот сервер.
Подмена живёт в `ctx.model.transform`, поэтому включается и снимается на лету,
без перезапуска и без правки конфига руками.

```
OpenCode ──► 127.0.0.1:<port>/<host>/<path> ──► SOCKS5 / HTTP CONNECT ──► <host>
```

**Возможности:**

- прокси **только для выбранных моделей**: `provider/model`, `provider/*`,
  `provider`, `*`;
- схемы прокси: `http://`, `https://` (TLS до прокси), `socks5://`,
  `socks5h://`, с логином и паролем в URL;
- включение и выключение без перезапуска: `/proxy on`, `/proxy off`,
  `/proxy status`;
- стриминг ответов без буфера — SSE и длинные ответы работают как обычно;
- пароль прокси маскируется в логах и статусе, заголовки авторизации не
  логируются;
- релей слушает только `127.0.0.1` и ходит только на те хосты, что встретились
  в `baseURL` перенаправленных моделей;
- нет внешних зависимостей, только `node:`-модули.

## Требования

- OpenCode **V2**.
- Node.js **18+** (OpenCode уже включает его).
- Внешний forward-прокси, умеющий `CONNECT` (HTTP или SOCKS5).

## Структура

```
ProxyRouter_OCV2/
├── opencode.json          # пустой проектный конфиг (только $schema)
├── install.bat            # печатает готовый фрагмент конфига (Windows)
├── plugin/
│   ├── index.js           # плагин: опции, transform, /proxy, инструмент
│   ├── relay.js           # локальный reverse-proxy
│   ├── dialer.js          # CONNECT / SOCKS5 / TLS
│   └── package.json       # "type": "module"
├── tests/
│   ├── relay.test.mjs     # node --test: фейковые апстрим и прокси
│   ├── helpers.mjs        # тестовые двойники прокси
│   └── integration.mjs    # ручной тест через реальный прокси
├── README.md
├── CHANGES.md
├── AGENTS.md              # описание архитектуры проекта
└── LICENSE                # MIT
```

## Как это работает

1. `setup(ctx)` читает опции и поднимает релей (`plugin/relay.js`).
2. Релей принимает `http://127.0.0.1:<port>/<host>/<path>`, где `<host>` — хост
   провайдера, а `<path>` — исходный путь `baseURL` (пакет провайдера дописывает
   свои `/chat/completions` или `/responses`).
3. `plugin/dialer.js` открывает туннель: `CONNECT` для HTTP-прокси или SOCKS5,
   затем TLS с SNI и проверкой сертификата.
4. Запрос уходит через `https.request` поверх готового TLS-сокета; тело и ответ
   стримятся без буфера.
5. Model transform подменяет `settings.baseURL` только у совпавших моделей и
   разрешает релею ровно те хосты, что встретились в их `baseURL`; остальные
   запросы получают `403`.

### Почему не HTTP_PROXY

В V2 TUI — клиент, а провайдерские запросы делает сервис. Переменные вида
`HTTP_PROXY`, выставленные в PowerShell, действуют только на процесс CLI.
Управляемые переменные сервиса (`opencode service set env`) применяются лишь
при его старте, то есть с перезапуском. Релей же живёт в самом процессе сервиса,
а `baseURL` — обычная настройка модели, поэтому переключение получается
мгновенным.

## Модели с региональными ограничениями

- `opencode/beam-free`, `opencode-go/beam-free` — Beam Free недоступен в ряде
  стран, включая РФ.
- `opencode-go/muse-spark-1.3-contributor`, `opencode-go/muse-spark-1.2-contributor`
  — Muse Spark Contributor ограничен Geo-policy Meta. Дополнительно нужна
  подписка **OpenCode Go** и галочка **Settings › Privacy → Allow paid
  endpoints that train on request data**.
- `opencode/muse-spark-1.3`, `opencode/muse-spark-1.2` — платные модели Console.

Платные модели по умолчанию скрывает
[ModelsDisabler](https://github.com/StandarterDF/ModelsDisabler_OCV2) — id нужно
добавить в его allowlist.

## Установка

Способы ниже равнозначны — выбери любой.

### Вариант 1. Автоматически, силами нейросети (рекомендуется)

Скопируй промт ниже и отправь его OpenCode. Агент сам поставит плагин, поправит
конфиг и проверит результат.

```text
Установи мне плагин OpenCode V2 ProxyRouter из репозитория
https://github.com/StandarterDF/ProxyRouter_OCV2

Мой прокси: PROXY_URL (например, socks5h://proxy.example.com:1080)
Модели, которые нужно завернуть в прокси: MODEL_REFS
(например, opencode-go/beam-free, opencode-go/muse-spark-1.3-contributor)

Что нужно сделать:
1. Определи каталог глобального конфига OpenCode:
   - Windows: %USERPROFILE%\.config\opencode  (или %XDG_CONFIG_HOME%\opencode)
   - Linux/macOS: ~/.config/opencode  (или $XDG_CONFIG_HOME/opencode)
2. Скопируй содержимое папки plugin/ репозитория (index.js, relay.js,
   dialer.js, package.json) в <config>/proxy-router/.
   В <config>/plugins/ НЕ копируй: плагину нужны опции, а автообнаружение
   их не передаёт.
3. В <config>/opencode.json добавь объект в массив "plugins" (сохрани
   существующие записи):

   {
     "package": "<config>/proxy-router",
     "options": {
       "proxy": "PROXY_URL",
       "models": [MODEL_REFS],
       "enabled": true
     }
   }

4. Сохрани конфиг (он перезагрузится сам). Если статус остался «ВЫКЛ»,
   выполни: opencode service restart
5. Проверь: /proxy status должен показать «ВКЛ», адрес релея и список
   моделей в строке «Перенаправлено». Затем сделай пробный запрос:
   opencode run --model <одна из моделей> "Reply with exactly: OK"
   и покажи мне вывод. Если модели попали в «Пропущено» или запрос падает —
   продиагностируй причину и доведи установку до конца.

Действуй автономно, лишних вопросов не задавай. В конце кратко отчитайся: что
установил, какие файлы изменил, какие модели перенаправлены.
```

### Вариант 2. Одной командой через CLI

```bash
opencode plugin add 'github:StandarterDF/ProxyRouter_OCV2#main::path:plugin'
```

CLI скачает плагин и добавит в массив `plugins` строку. Опции он не передаёт,
поэтому замени эту строку объектом с тем же `package`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:StandarterDF/ProxyRouter_OCV2#main::path:plugin",
      "options": {
        "proxy": "socks5h://proxy.example.com:1080",
        "models": ["opencode-go/beam-free"]
      }
    }
  ]
}
```

Сохрани конфиг и проверь `/proxy status`. Если статус «ВЫКЛ» — `opencode
service restart`.

### Вариант 3. Вручную (Windows)

Запусти из корня репозитория:

```bat
install.bat
```

Скрипт покажет готовый фрагмент с правильным путём и откроет конфиг. Дальше:

1. Скопируй `plugin/` в `%USERPROFILE%\.config\opencode\proxy-router\`.
2. Добавь фрагмент в `%USERPROFILE%\.config\opencode\opencode.json`.
3. Замени `proxy` и `models` на свои значения.
4. Проверь статус командой `/proxy status`.

Для Linux / macOS то же самое: `cp plugin/* ~/.config/opencode/proxy-router/`
и тот же фрагмент в `~/.config/opencode/opencode.json`.

### Вариант 4. Только для одного проекта

Положи плагин в проект и подключи его проектной конфигурацией:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugin",
      "options": {
        "proxy": "socks5h://proxy.example.com:1080",
        "models": ["opencode-go/beam-free"]
      }
    }
  ]
}
```

Путь `./plugin` разрешается относительно файла конфига.

## Использование

- Команда в TUI: `/proxy on`, `/proxy off`, `/proxy status`.
- Инструмент агента: `proxy_router` с `action: "on" | "off" | "status"`.

Пример вывода:

```
Proxy Router: ВКЛ
Прокси: socks5h://proxy.example.com:1080
Цели: opencode-go/beam-free, opencode-go/muse-spark-1.3-contributor
Релей: http://127.0.0.1:64388
Перенаправлено: opencode-go/beam-free, opencode-go/muse-spark-1.3-contributor
```

При `off` транформация снимается, модели возвращаются на прямой адрес
провайдера, релей закрывается. Порт релея эфемерный: после перезапуска сервиса
он меняется, `baseURL` пересчитывается автоматически — руками ничего править
не нужно.

## Настройка

### Параметры плагина (`ctx.options`)

Параметры передаются объектной формой в `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugin",
      "options": {
        "proxy": "socks5h://user:pass@proxy.example.com:1080",
        "models": ["opencode-go/beam-free", "opencode-go/*"],
        "enabled": true,
        "port": 0,
        "log": false
      }
    }
  ]
}
```

| Опция | По умолчанию | Описание |
|---|---|---|
| `proxy` | — | URL прокси: `http://`, `https://`, `socks5://`, `socks5h://`. Учётные данные можно зашить в URL. Обязательна. |
| `models` | `[]` | Что заворачивать: `"provider/model"`, `"provider/*"`, `"provider"`, `"*"`. |
| `enabled` | `true` | Поднимать релей при загрузке плагина. |
| `port` | `0` | Порт релея; `0` — свободный. При занятом порте плагин не стартует и пишет ошибку в статус. |
| `upstreams` | `{}` | Запасной `baseURL` по провайдеру, если провайдер его не отдаёт: `{ "opencode-go": "https://opencode.ai/inference/go/openai/v1" }`. |
| `log` | `false` | Писать в лог каждый запрос релея: `METHOD host/path -> status`. |

Модель попадает в «Пропущено», если у провайдера нет `baseURL` (задай
`upstreams`) или апстрим не `https`.

### Схемы прокси

| Схема | Что делает |
|---|---|
| `http://host:port` | HTTP `CONNECT`, учётные данные через `Proxy-Authorization` |
| `https://host:port` | TLS до прокси, дальше `CONNECT` |
| `socks5://host:port` | SOCKS5, имя резолвится локально (IPv4) |
| `socks5h://host:port` | SOCKS5, имя резолвит прокси (лучше для заблокированных хостов) |

### Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PROXY_ROUTER_DEBUG` | — | Путь к файлу, куда дублируется лог плагина. Если не задана — лог идёт только в stdout. |

## Проверка

В TUI выполни `/proxy status`: должно быть «ВКЛ», адрес релея и все нужные
модели в строке «Перенаправлено».

Затем пробный запрос из шелла:

```powershell
# Windows (PowerShell)
opencode run --model opencode-go/beam-free "Reply with exactly: OK"
```

```bash
# Linux / macOS
opencode run --model opencode-go/beam-free "Reply with exactly: OK"
```

Ожидаемый ответ — `OK`. Дополнительно можно дернуть health-эндпоинт релея
(порт берётся из `/proxy status`):

```powershell
curl.exe "http://127.0.0.1:<port>/__relay/health"
```

```json
{"ok":true,"proxy":"socks5h://proxy.example.com:1080","secure":true,"upstreamPort":443,"hosts":["opencode.ai"]}
```

Если что-то не так, проверь по порядку:

1. Плагин загружен: в `opencode.json` есть объект с `package` и `options`.
2. В `models` указаны существующие id (`opencode models | Select-String muse`).
3. В статусе нет «Пропущено» и «Ошибка».
4. Прокси живой: `curl -x <proxy> https://opencode.ai/inference/v1/models`.
5. Включи `"log": true` и повтори запрос — в логе будет строка вида
   `POST opencode.ai/inference/go/openai/v1/responses -> 200`.

## Ограничения

- Только `https`-апстримы: `http://`-провайдеры не переписываются.
- Только HTTP-транспорт: модели с WebSocket-стримингом через релей не пойдут.
- `https://` в опции `proxy` означает TLS **до прокси**, а не «прокси для HTTPS».
- `socks5://` (локальный резолв) умеет только IPv4; для IPv6 используй
  `socks5h://`.
- `opencode plugin add` не умеет передавать опции: после установки строку в
  `plugins` нужно заменить объектом (см. Вариант 2).

## Диагностика

| Симптом | Что проверить |
|---|---|
| `502 relay could not reach ...` | Прокси недоступен или не умеет `CONNECT`. |
| `502 ... HTTP 407` | Неверные логин/пароль прокси. |
| `403 relay host is not allowed` | Модель не попала в `models` или релей перезапущен без применения. |
| Модель в «Пропущено» | Нет `baseURL` у провайдера — задай `upstreams.<provider>`. |
| Осталась ошибка страны | Прокси-выход в запрещённом регионе; проверь exit IP. |
| «ВЫКЛ» сразу после сохранения конфига | Сервис пересоздаёт экземпляр плагина, подожди 1–2 секунды. |

## Удаление

1. Убери объект плагина из массива `plugins` в `opencode.json`.
2. Удали каталог `<config>/proxy-router/` (или `<project>/plugin/`).
3. Проверь: `/proxy status` больше не должен быть доступен, модели идут
   напрямую.

## Ссылки

- [Документация OpenCode V2 — плагины](https://opencode.ai/v2/docs/build/plugins)
- [Конфигурация плагинов OpenCode V2](https://opencode.ai/v2/docs/plugins)
- [Модели и провайдеры OpenCode V2](https://opencode.ai/v2/docs/models)
- [OpenCode V2](https://opencode.ai/v2/docs/)
- [ModelsDisabler для OpenCode V2](https://github.com/StandarterDF/ModelsDisabler_OCV2)

## Лицензия

MIT — см. [LICENSE](LICENSE).
