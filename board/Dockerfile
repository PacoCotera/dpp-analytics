FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY sales_api.py .
COPY product_labels.json .
COPY static ./static
EXPOSE 8080
CMD ["python", "server.py"]
