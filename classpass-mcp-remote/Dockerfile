FROM mcr.microsoft.com/playwright:v1.61.1-jammy
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/server.js"]
