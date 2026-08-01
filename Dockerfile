# Shopkeep — single app image: Ktor serves the API and the built SPA (vault: D4).
# Published to ghcr.io for amd64 + arm64 by .github/workflows/ci.yml.

FROM node:22-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM eclipse-temurin:21-jdk-noble AS server
WORKDIR /build
COPY gradlew settings.gradle.kts ./
COPY gradle/ gradle/
COPY server/ server/
RUN ./gradlew :server:installDist --no-daemon

FROM eclipse-temurin:21-jre-noble
RUN useradd --system --create-home shopkeep
USER shopkeep
WORKDIR /app
COPY --from=server /build/server/build/install/server/ server/
COPY --from=web /build/dist/ web/
ENV WEB_DIST=/app/web
EXPOSE 8080
ENTRYPOINT ["/app/server/bin/server"]
