FROM node:20-bookworm

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src

EXPOSE 3001

CMD ["npm", "run", "dev"]