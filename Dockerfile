FROM node:22-slim

WORKDIR /usr/src/app

COPY package.json package-lock.json ./

# https://probot.github.io/docs/configuration/
ENV NODE_ENV="production"
ENV HUSKY=0

RUN npm ci --omit=dev && npm cache clean --force

COPY . ./

RUN npm run build

CMD [ "npm", "start" ]
