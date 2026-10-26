# Образ с Chromium для браузерного агента (Гермес)
FROM mcr.microsoft.com/playwright:v1.64.1-noble

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# отдельный пользователь без прав для кода, который пишут и запускают агенты
RUN groupadd --system sandbox && useradd --system --gid sandbox --home-dir /data/workspace/.home --shell /bin/bash sandbox

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
COPY . .

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data PIP_BREAK_SYSTEM_PACKAGES=1
EXPOSE 8080
CMD ["node", "src/index.js"]
