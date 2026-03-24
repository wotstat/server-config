
server {
  server_name wotstat-proxy.ru;

  proxy_cache wotstat_cache_main;
  proxy_cache_key "$scheme$request_method$host$request_uri";
  proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
  proxy_cache_background_update on;
  proxy_cache_lock on;

  location / {
    proxy_pass https://$main_server_ip$request_uri;
    proxy_method $request_method;
    proxy_set_header Host wotstat.info;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    add_header X-Cache-Status $upstream_cache_status always;
    add_header X-Cache-Age $upstream_http_age always;
  }


  listen 443 ssl; # managed by Certbot
  ssl_certificate /etc/letsencrypt/live/wotstat-proxy.ru/fullchain.pem; # managed by Certbot
  ssl_certificate_key /etc/letsencrypt/live/wotstat-proxy.ru/privkey.pem; # managed by Certbot
  include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}

server {
  listen 80;
  server_name wotstat-proxy.ru;

  # Allow HTTP (no redirect) for /api
  location ^~ /api {
    proxy_pass https://$main_server_ip$request_uri;
    proxy_method $request_method;

    proxy_set_header Host wotstat.info;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto http;

    # (optional) if you want caching on /api over HTTP too
    proxy_cache wotstat_cache_main;
    proxy_cache_key "http$request_method$host$request_uri";
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_cache_background_update on;
    proxy_cache_lock on;

    add_header X-Cache-Status $upstream_cache_status always;
    add_header X-Cache-Age $upstream_http_age always;
  }

  # Redirect everything else to HTTPS
  location / {
    return 301 https://$host$request_uri;
  }
}