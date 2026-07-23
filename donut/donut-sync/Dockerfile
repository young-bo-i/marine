FROM node:22-alpine AS builder

WORKDIR /build
COPY donut-sync/package.json donut-sync/package-lock.json donut-sync/tsconfig.json donut-sync/tsconfig.build.json ./
COPY donut-sync/src/ src/
# `npm ci` installs the EXACT versions from package-lock.json. This is what
# stops a rebuild from silently upgrading the aws-sdk (the upgrade to a version
# that hoists x-amz-meta-* is what broke presigned uploads against MinIO).
# --include=dev because the build needs @nestjs/cli (`nest`), a devDependency,
# and this builder stage must get it regardless of any production npm default.
RUN npm ci --include=dev
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine

WORKDIR /app
COPY --from=builder /build/package.json .
COPY --from=builder /build/dist/ dist/
COPY --from=builder /build/node_modules/ node_modules/

ENV NODE_ENV=production
EXPOSE 12342

USER node
CMD ["node", "dist/main"]
