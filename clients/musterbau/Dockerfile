FROM node:23-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY clients/musterbau ./clients/musterbau

RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter './packages/*' build && pnpm --filter @vivd-catalyst/musterbau build

FROM node:23-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/clients/musterbau ./clients/musterbau

EXPOSE 4100
CMD ["node", "clients/musterbau/dist/server.js"]
