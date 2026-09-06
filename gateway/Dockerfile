# Loop GPT web gateway: static landing + reverse proxy to LibreChat
FROM nginx:1.27-alpine

COPY nginx-default.conf /etc/nginx/conf.d/default.conf
COPY site/ /usr/share/nginx/html/

EXPOSE 3000 80
