FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY database ./database
COPY src ./src
EXPOSE 3000
# Node runs the TypeScript directly (built-in type stripping), so there is no build step.
CMD ["node", "src/server.ts"]
