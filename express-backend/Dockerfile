# Use Node.js LTS version
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application source code
COPY . .

# Create downloads directory
RUN mkdir -p downloads

# Expose the port the app runs on
EXPOSE 4000

# Set environment to production
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', (r) => {let d='';r.on('data', (c) => d+=c);r.on('end', () => {process.exit(JSON.parse(d).ready ? 0 : 1)})}).on('error', () => process.exit(1))"

# Start the application
CMD ["npm", "start"]
