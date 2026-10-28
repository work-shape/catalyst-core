# Build the package first; context is packages/preview-capture. Also available as the
# deployment kit's preview-capture target from released packages.
FROM node:24-bookworm-slim
WORKDIR /opt/preview-capture
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
COPY package.json schemas.tgz core.tgz ./
RUN node -e "const fs=require('fs');const p=require('./package.json');delete p.devDependencies;p.dependencies['@work-shape/catalyst-asset-schemas']='file:schemas.tgz';p.dependencies['@work-shape/catalyst-core']='file:core.tgz';fs.writeFileSync('package.json',JSON.stringify(p))" \
 && npm install --omit=dev --ignore-scripts \
 && node node_modules/playwright/cli.js install --with-deps --only-shell chromium \
 && apt-get install -y --no-install-recommends fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 capture \
 && useradd --uid 10001 --gid 10001 --home-dir /tmp --no-create-home capture
COPY dist ./dist
USER 10001:10001
ENV HOME=/tmp
EXPOSE 4120
CMD ["node", "dist/cli.js"]
