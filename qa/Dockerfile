FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /qa
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY visual_qa.mjs ./
COPY nav_qa.mjs ./
COPY numeric_ui_qa.mjs ./
COPY geography_qa.mjs ./
COPY geography_zoom_qa.mjs ./
COPY order_operations_qa.mjs ./
COPY footer_qa.mjs ./
COPY entrypoint.sh ./
RUN chmod +x /qa/entrypoint.sh
ENTRYPOINT ["/qa/entrypoint.sh"]
