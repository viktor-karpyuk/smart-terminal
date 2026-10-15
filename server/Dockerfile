# The organization server, alone: no dependencies to install, one SQLite file in /data.
# Only shells on the server (off unless set up) need a native module; see SHELLS below.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public
# Shells on the server need node-pty, built here: docker build --build-arg SHELLS=1.
ARG SHELLS=0
RUN if [ "$SHELLS" = "1" ]; then \
      apk add --no-cache --virtual .build python3 make g++ && apk add --no-cache bash \
      && npm install --no-save --omit=dev node-pty@1.1.0 && apk del .build; \
    fi
ENV ORG_DB=/data/org.db ORG_HOST=0.0.0.0 ORG_PORT=8787 NODE_NO_WARNINGS=1
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
ENTRYPOINT ["node", "bin/org-server.js"]
CMD ["serve"]
