FROM node:22-alpine
WORKDIR /src
COPY app ./app
COPY web ./web
RUN sh app/build.sh && mkdir -p /app && cp app/server.js app/mail.js app/geo.js /app/ && cp -r app/public /app/public && rm -rf /src
WORKDIR /app
ENV DATA_DIR=/data TZ=Europe/London PORT=8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
