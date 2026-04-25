FROM node:20-slim

WORKDIR /app

# Install only deps first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Render / Fly / Railway inject PORT; default to 3000 for local
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
