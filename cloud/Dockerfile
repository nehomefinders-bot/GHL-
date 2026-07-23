# Headless-Chromium image for the realtor.com cloud scraper.
FROM python:3.12-slim

# Chromium + driver + fonts (Debian ships matching versions, so no driver downloads).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium chromium-driver \
    fonts-liberation libnss3 libxss1 libasound2 libatk-bridge2.0-0 \
    libgtk-3-0 libgbm1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium \
    CHROMEDRIVER=/usr/bin/chromedriver \
    OUTPUT_DIR=/data \
    PYTHONUNBUFFERED=1

RUN mkdir -p /data

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Hugging Face Spaces expects the app on port 7860 (also honored by $PORT elsewhere).
EXPOSE 7860
# One worker + threads so the background scrape thread keeps running.
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-7860} --workers 1 --threads 8 --timeout 0 app:app"]
