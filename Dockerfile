FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS verify

WORKDIR /app
COPY package.json server.js ./
COPY api ./api
COPY assets/ai-blue-wall.svg ./assets/ai-blue-wall.svg
COPY data/*.json ./data/
COPY public/index.html ./public/index.html
COPY scripts/render_blue_wall.js ./scripts/render_blue_wall.js
COPY tests/test_api_svg.js tests/test_server.js ./tests/
RUN npm run verify:runtime

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime

ARG APP_COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/ZONGRUICHD/codex-usage-bluewall-github" \
      org.opencontainers.image.revision="${APP_COMMIT}"

ENV NODE_ENV=production \
    APP_COMMIT=${APP_COMMIT} \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node api ./api
COPY --chown=node:node data ./data
COPY --chown=node:node public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)throw new Error(String(r.status))}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
