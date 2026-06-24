FROM mcr.microsoft.com/playwright:v1.40.0-jammy
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/server.js"]
