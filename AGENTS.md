# Веб-Панель для Restream сервера

Это приложение, это небольшой веб дэшбоард для конфигурирования вариантов рестрансляции рестрим сервера. И отображения параметров сетевых соединения потоков в реалтайме.

## Context

Рестрим сервер - это linux x64 (Ubuntu 22 или 24) хост, на котором установлены:

- nginx
- nginx rtmp module
- stunnel
- mediamtx

Пользователь отправляет rtmp/srt поток на сервер, сервер пересылает на выбранные таргет сервера в соотвествии с конфигом. В случае, если нужно пересылать на rtmps, то используется stunnel в качестве прокси.

## Задача приложения

Приложение будет редактировать nginx.conf файл, опеспечит удобный интерфейс в WebUI для этого.
Суть редактирования, добавлять/редактировать/удалять секции `application`, чтобы обеспечивать разные варианты рестрима.
Вторая задача, оторажать параметры сетевых соединений чтобы отслеживать качество потоков в реалтайме.

## Формат nginx.conf

Это шаблон файла, который должен быть всегда, иначе конфиг не будет валидным.
В нём уже присутствую 3 `application`, их нельзя будет удалить и отредактировать. Можно будуте только добалять новые и совершать действия с ними.

### Кофниг

```nginx
user www-data;
worker_processes 1;

pid /run/nginx.pid;
error_log /var/log/nginx/error.log;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 768;
}

rtmp {
    server {
        listen 1935;
        chunk_size 4096;

        # stunnel 19351 - Twitch Stockholm
        # stunnel 19352 - Twitch Frankfurt
        # stunnel 19353 - Twitch Paris

        # Twitch Stockholm
        application twitch_stockholm {
            live on;
            record off;

            push rtmp://127.0.0.1:19351/app;
        }

        # Twitch Frankfurt
        application twitch_frankfurt {
            live on;
            record off;

            push rtmp://127.0.0.1:19352/app;
        }

        # Twitch Paris
        application twitch_paris {
            live on;
            record off;

            push rtmp://127.0.0.1:19353/app;
        }
    }
}
```

### application

В качестве таргет серверов могут быть следующие значения:

1. Twitch (Stockholm) - rtmp://127.0.0.1:19351/app
2. Twitch (Frankfurt) - rtmp://127.0.0.1:19352/app
3. Twitch (Paris) - rtmp://127.0.0.1:19353/app
4. VK - rtmp://vsu.mycdn.me/input

Логика формирования блока `application` следующая:

```
applcation <app_name> {
  live on;
  record off;

  push <twitch_server1>/<twitch_stream_key>;
  push <twitch_server2>/<twitch_stream_key>;
  push <vk_server1>/<vk_stream_key>;
}
```

Набор push серверов может быть различный и задаётся пользователем при создании (вместе с stream keys и названием application).

### Стэк

В качестве рантайма будет использоваться Bun. В проде - это будет компилированный бинарник.
WEB UI должен иметь соврменный, но минималистичный тёмный дизайн.
