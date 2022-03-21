FROM arm32v7/node:16-alpine3.12 as base

WORKDIR /app
RUN apk add -X http://mirrors.aliyun.com/alpine/v3.12/main -X http://mirrors.aliyun.com/alpine/v3.12/community --no-cache tzdata eudev tini

# Dependencies and build
FROM base as dependencies_and_build

RUN apk add -X http://mirrors.aliyun.com/alpine/v3.12/main -X http://mirrors.aliyun.com/alpine/v3.12/community --no-cache --virtual .buildtools make gcc g++ python3 linux-headers

COPY package.json npm-shrinkwrap.json tsconfig.json index.js ./
COPY lib ./lib

RUN npm ci --no-audit --no-optional --no-update-notifier && \
    npm run build && \
    rm -rf node_modules && \
    npm ci --production --no-audit --no-optional --no-update-notifier && \
    apk del .buildtools

# Release
FROM base as release

COPY --from=dependencies_and_build /app/node_modules ./node_modules
COPY --from=dependencies_and_build /app/dist ./dist
COPY package.json LICENSE index.js ./
COPY data ./data

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]

