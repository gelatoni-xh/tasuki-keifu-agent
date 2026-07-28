FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json prisma.config.ts ./
COPY prisma ./prisma

RUN npm ci
RUN npm run prisma:generate

COPY src ./src
COPY README.md ./

EXPOSE 3040

CMD ["npm", "run", "start"]
