FROM node:22

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

ENV TG_TOKEN=
ENV BM_TOKEN=

CMD [ "npm", "start"]