# Restream Panel — MediaMTX Monitor

Лёгкий мониторинг ретрансляции для MediaMTX: живые RTMP/SRT-соединения, здоровье
потоков, ивент-лог и графики битрейта в реалтайме. Без редактирования конфигов.

## Context

Рестрим-сервер — Linux x64 (Ubuntu 22/24) с mediamtx. Энкодер публикует поток в
mediamtx (RTMP/SRT), mediamtx раздаёт/форвардит наружу. Панель только наблюдает:

- `ss -itnop` — TCP-сокеты RTMP (рейты, RTT, ретрансмиты, очереди);
- `GET mediamtx /metrics` — SRT-соединения, forward_dests, rtmp_conns;
- `GET mediamtx /v3/paths/get/{name}` — кодеки/треки активного пути + availableTime
  (реальный старт стрима; ready/readyTime deprecated, online — про хуки/сорс);
- `GET mediamtx /v3/paths/forward-dests/get?path=&id=` — remoteAddr активного форварда
  (/metrics его больше не отдаёт даже при forwarding).

## Структура

- `src/monitor/` — `monitor-manager.ts` (единый тик → `MonitorSnapshot` для SSE);
  `collectors/` (`ss-collector.ts` — TCP, `mediamtx-collector.ts` — весь /metrics
  + треки путей, `rtmp-target-resolver.ts`); `grouping/` (`rtmp-grouping.ts`,
  `srt-grouping.ts` — группировка в логические стримы, `merge-streams.ts` —
  слияние rtmp+srt по id на сервере); `event-log.ts`, `bandwidth-log.ts`,
  `net-addr.ts`.
- `src/api/` — `Bun.serve({ routes })`, SSE `GET /api/monitor/stream` (первый кадр —
  полный снапшот, дальше каждые ~5с только дельты: свежие точки bandwidth +
  свежие события; клиент мержит в `Monitor` через `web/lib/monitor-merge.ts`),
  `GET /api/system/status` (auth-проба для Login).
- `src/web/` — страницы `Monitor` (корень `/`) и `Login`.
- `src/core/` — общие типы (`Track`, `BandwidthPoint`, `StreamEvent`).

## Правила

- Группировка логических стримов и парсеры — поведение заморожено тестами
  (`tests/monitor/grouping/`, `tests/monitor/monitor-manager.test.ts`).
  Менять только с обновлением тестов.
- Файлы — kebab-case, код — camelCase. Абстракции тонкие и по необходимости (ponytail).
- Моки только через `bun run dev:mock` (`MOCK=1`); боевой запуск всегда идёт
  в реальный mediamtx, на Windows тоже стартует без ошибок.

## Стэк

Bun (serve/routes/SSE из коробки, в проде — компилированный бинарник), React.
Без веб-фреймворков на бэке.
