# wa-portal — Node 20 slim. Pure JS deps (pg, bcryptjs, express, openai).
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 4200
CMD ["node", "src/server.js"]
