FROM node:23-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY clients/demo ./clients/demo

RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter './packages/*' build && pnpm --filter @vivd-catalyst/demo build

FROM node:23-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
RUN apk add --no-cache python3 py3-pip \
  && python3 -m pip install --break-system-packages --no-cache-dir 'markitdown[pdf,docx]==0.1.6'

COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/clients/demo ./clients/demo

EXPOSE 4100
CMD ["node", "clients/demo/dist/server.js"]
