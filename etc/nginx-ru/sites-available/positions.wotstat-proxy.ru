server {
  server_name positions.wotstat-proxy.ru;

  location / {
    include /etc/nginx/snippets/positions-cache.conf;
    proxy_pass http://wotstat_main_http$request_uri;
    include /etc/nginx/snippets/main-http-failover.conf;
    proxy_http_version 1.1;

    # Always set standard headers
    proxy_set_header Host positions.wotstat.info;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header CF-Connecting-IP $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket headers
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_redirect https://positions.wotstat.info/ $scheme://$host/;
    proxy_redirect http://positions.wotstat.info/ $scheme://$host/;
  }

  listen 80;
  listen 443 ssl; # managed by Certbot
  ssl_certificate /etc/letsencrypt/live/positions.wotstat-proxy.ru/fullchain.pem; # managed by Certbot
  ssl_certificate_key /etc/letsencrypt/live/positions.wotstat-proxy.ru/privkey.pem; # managed by Certbot
  include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}
