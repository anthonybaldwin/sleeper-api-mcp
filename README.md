# Sleeper API MCP Server

A comprehensive Model Context Protocol (MCP) server for Sleeper fantasy football with advanced features for trade analysis, matchup previews, and waiver recommendations.

## Features

### Core Features
- Get user information and leagues
- Access league details, rosters, and matchups
- View transactions and trending players
- Get current NFL season state
- Query player details

### Advanced Features
- **Trade Analysis**: Analyze trade risk, value, and positional impact
- **Matchup Preview**: Get projections and win probability for upcoming matchups
- **Waiver Recommendations**: Get personalized waiver wire suggestions based on team needs
- **Lineup Optimization**: Analyze and optimize your starting lineup
- **Free Agent Search**: Find available players by position

## Available Tools

### Basic Tools
- `get_user` - Get Sleeper user information by username
- `get_user_leagues` - Get all leagues for a specific user
- `get_league` - Get league information by league ID
- `get_league_rosters` - Get all rosters in a league
- `get_league_users` - Get all users in a league
- `get_matchups` - Get matchups for a specific week
- `get_transactions` - Get transactions for a specific week
- `get_trending_players` - Get trending players (adds/drops)
- `get_player_details` - Get details for specific players
- `get_nfl_state` - Get current NFL season state

### Advanced Tools
- `analyze_trade` - Analyze trade risk and value between two teams
- `preview_matchup` - Preview upcoming matchup with projections
- `get_waiver_recommendations` - Get waiver wire recommendations
- `get_free_agents` - Get available free agents
- `analyze_lineup` - Analyze and optimize lineup
- `get_player_projections` - Get player projections for a week

## Installation

### Prerequisites
- Docker (or Docker Desktop)
- Claude Desktop App

### Setup

1. **Clone this repository** (or just download `compose.yaml`):
```bash
git clone https://github.com/anthonybaldwin/sleeper-api-mcp.git
cd sleeper-api-mcp
```

2. **Configure your Sleeper account details**:

Edit `compose.yaml` with your Sleeper username and league IDs:
```yaml
environment:
  SLEEPER_USERNAME_A: your_username
  SLEEPER_LEAGUE_A_ID_1: your_league_id
```

3. **Start the container**:
```bash
docker-compose up -d
# Pulls image from GitHub Container Registry
# Container will be named 'sleeper-api-mcp'
```

#### Building Locally (Optional)

If you want to build the image locally instead of using the pre-built one:

1. Edit `compose.yaml` to use local build:
```yaml
# Comment out: image: ghcr.io/anthonybaldwin/sleeper-api-mcp:latest
# Uncomment: build: .
```

2. Build and run:
```bash
docker-compose up -d --build
```

4. **Configure Claude Desktop**:

Edit your Claude Desktop configuration file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add the following configuration:
```json
{
  "mcpServers": {
    "sleeper": {
      "command": "docker",
      "args": ["exec", "-i", "sleeper-api-mcp", "node", "dist/index.js"]
    }
  }
}
```
**Note**: Make sure the container is running first with `docker-compose up -d`

5. **Restart Claude Desktop**

### Alternative: Using npm directly (no Docker)

If you prefer to run without Docker:

1. **Prerequisites**: Node.js 20+ installed

2. **Setup**:
```bash
git clone https://github.com/anthonybaldwin/sleeper-api-mcp.git
cd sleeper-api-mcp
npm install
npm run build

# Create .env file with your config
echo "SLEEPER_USERNAME_A=your_username" > .env
echo "SLEEPER_LEAGUE_A_ID_1=your_league_id" >> .env
```

3. **Configure Claude Desktop**:
```json
{
  "mcpServers": {
    "sleeper": {
      "command": "node",
      "args": ["/path/to/sleeper-api-mcp/dist/index.js"]
    }
  }
}
```

## Configuration

### Multi-User/League Support

The server supports multiple users and leagues. Configure them using environment variables with this pattern:

```env
# User A
SLEEPER_USERNAME_A=first_username
SLEEPER_LEAGUE_A_ID_1=league_id_1
SLEEPER_LEAGUE_A_ID_2=league_id_2

# User B
SLEEPER_USERNAME_B=second_username
SLEEPER_LEAGUE_B_ID_1=another_league_id

# Add more users (C, D, E...) as needed
```

The server will intelligently detect which league you're referring to based on context clues in your queries.

## Usage Examples

### Basic Queries
- "Get my Sleeper user info for username 'johndoe'"
- "Show me all my leagues for the 2024 season"
- "Get the current NFL week"

### Trade Analysis
- "Analyze a trade: Team 1 gives [player IDs] for Team 2's [player IDs]"
- "What's the trade value difference between these players?"
- "Show me the injury risks in this trade"

### Matchup Preview
- "Preview my week 10 matchup in league [league_id]"
- "What's my win probability this week?"
- "Show me projected scores for both teams"

### Waiver Wire
- "Get waiver recommendations for my team"
- "Show me trending RBs available on waivers"
- "What's my waiver priority and budget?"

### Lineup Optimization
- "Analyze my lineup for week 10"
- "Should I make any lineup changes?"
- "Who should I start at FLEX?"

## Trade Analysis Features

The trade analyzer evaluates:
- **Value Balance**: Calculates relative player values
- **Injury Risk**: Flags injured players in the trade
- **Positional Impact**: Analyzes how trade affects depth
- **Team Records**: Considers team standings
- **Recommendations**: Provides trade verdict

## Development

For developers who want to modify the code:

### Option 1: npm (Fastest for development)
```bash
# Install dependencies
npm install

# Create .env file with your config
cp .env.example .env
# Edit .env with your Sleeper credentials

# Build and run
npm run build
npm start

# Or use watch mode for auto-rebuild
npm run dev
```

### Option 2: Docker (Production-like)
```bash
# Edit compose.yaml with your credentials
# Then build and run
docker-compose up --build
```

## API Reference

This server uses the public Sleeper API v1. No authentication is required. For more details, see the [Sleeper API documentation](https://docs.sleeper.app/).

## Notes

- Real-time data from Sleeper's API
- Projections fetched from Sleeper's projection endpoints
- Smart caching for current week data (5-minute cache)
- Rate limiting to prevent API throttling
- Supports PPR, Half-PPR, and Standard scoring