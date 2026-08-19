FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /qa
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY visual_qa.mjs ./
ENTRYPOINT ["node", "/qa/visual_qa.mjs"]
