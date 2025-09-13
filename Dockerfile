FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Add labels for Docker MCP Gateway
LABEL mcp.name="sleeper"
LABEL mcp.version="1.0.0"
LABEL mcp.description="Sleeper Fantasy Football API integration with trade analysis"

# The MCP server communicates via stdio
ENTRYPOINT ["node", "/app/dist/index.js"]
