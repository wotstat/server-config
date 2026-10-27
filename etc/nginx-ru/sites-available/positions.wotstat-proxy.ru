map $uri $no_cache {
  default 0;
  ~^/api/ 1;
}

map $http_upgrade $is_websocket {
  default 0;
  websocket 1;
}

map $http_upgrade $connection_upgrade {
  default close;
  websocket upgrade;
}

server {
  server_name positions.wotstat-proxy.ru;

  location / {
    proxy_pass http://wotstat_main_http$request_uri;
    include /etc/nginx/snippets/main-http-failover.conf;
    proxy_http_version 1.1;

    # Always set standard headers
    proxy_set_header Host positions.wotstat.info;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket headers
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    # Only these should affect bypass/store:
    proxy_cache_bypass $is_websocket;
    proxy_no_cache $no_cache $is_websocket;

    proxy_cache wotstat_cache_positions;
    proxy_cache_key "$scheme$request_method$host$request_uri";
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_cache_background_update on;
    proxy_cache_lock on;
    proxy_redirect https://positions.wotstat.info/ https://positions.wotstat-proxy.ru/;

    add_header X-Cache-Status $x_cache_status_pretty always;
  }

  listen 80;
  listen 443 ssl; # managed by Certbot
  ssl_certificate /etc/letsencrypt/live/positions.wotstat-proxy.ru/fullchain.pem; # managed by Certbot
  ssl_certificate_key /etc/letsencrypt/live/positions.wotstat-proxy.ru/privkey.pem; # managed by Certbot
  include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}
