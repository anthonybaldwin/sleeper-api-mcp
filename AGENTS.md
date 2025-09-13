# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development

#### Quick Development with npm
For fastest iteration:
```bash
# Install and build
npm install
npm run build

# Create .env file
echo "SLEEPER_USERNAME_A=your_username" > .env
echo "SLEEPER_LEAGUE_A_ID_1=your_league_id" >> .env

# Run
npm start
```

#### Docker Development
For production-like environment:
```bash
# Edit compose.yaml with your credentials, then:
docker-compose up --build

# Or standalone Docker
docker build -t sleeper-api-mcp .
docker run --rm -i sleeper-api-mcp
```

## Environment Configuration

### Multi-User/League Support
Environment variables are configured in `compose.yaml`:
- `SLEEPER_USERNAME_A=your_username`
- `SLEEPER_LEAGUE_A_ID_1=your_league_id`
- Add more users (B, C, D...) and leagues as needed

**For Claude Desktop config.json:**

### Docker Compose (Recommended):
```json
"sleeper": {
  "command": "docker",
  "args": ["exec", "-i", "sleeper-api-mcp", "node", "dist/index.js"]
}
```

### Standalone Docker:
```json
"sleeper": {
  "command": "docker",
  "args": ["run", "--rm", "-i", "sleeper-api-mcp"]
}
```

## Architecture

This is a Model Context Protocol (MCP) server that provides access to the Sleeper Fantasy Football API. The server:

1. **MCP Server Implementation** (`src/index.ts`):
   - Built on `@modelcontextprotocol/sdk` for MCP protocol handling
   - Uses StdioServerTransport for communication via standard input/output
   - Implements tool handlers for all Sleeper API endpoints

2. **API Integration**:
   - All API calls go through Sleeper's public API at `https://api.sleeper.app/v1`
   - No authentication required (public API)
   - Caches player data locally for performance (`playersCache` Map)

3. **Advanced Features**:
   - **Trade Analysis** (`analyzeTrade` method): Calculates player values, injury risks, and positional impacts
   - **Matchup Preview** (`previewMatchup` method): Projects scores and win probability
   - **Waiver Recommendations** (`getWaiverRecommendations` method): Suggests players based on trending data
   - **Lineup Optimization** (`analyzeLineup` method): Analyzes starting lineups and suggests improvements

4. **Configuration**:
   - Supports environment variables for defaults:
     - `SLEEPER_USERNAME` - Default username
     - `SLEEPER_LEAGUE_ID` - Default league ID
     - `SLEEPER_USER_ID` - Default user ID

## Key Implementation Details

- The server maintains a player cache that loads all NFL players on first player-related request
- Player value calculations use simplified position-based scoring (QB=100, RB=80, WR=70, TE=60)
- **Projections**: Real projections are fetched from `api.sleeper.com` using bulk endpoints for all positions, then cached for 5 minutes.
- All tools return JSON-formatted responses wrapped in MCP content blocks
- Error handling wraps all tool executions and returns error messages as text content