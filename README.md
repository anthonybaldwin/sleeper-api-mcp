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

### Quick Start (Recommended)

1. **Download the executable** for your platform from the [latest release](https://github.com/anthonybaldwin/sleeper-api-mcp/releases/latest):
   - **macOS (Apple Silicon)**: `sleeper-mcp-macos-arm64`
   - **macOS (Intel)**: `sleeper-mcp-macos-x64`
   - **Linux (x64)**: `sleeper-mcp-linux-x64`
   - **Linux (ARM64)**: `sleeper-mcp-linux-arm64`
   - **Windows**: `sleeper-mcp-windows-x64.exe`

2. **Make it executable** (macOS/Linux only):
```bash
chmod +x sleeper-mcp-macos-arm64  # or whichever file you downloaded
```

3. **Configure Claude Desktop**:

Edit your Claude Desktop configuration file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add the following configuration:
```json
{
  "mcpServers": {
    "sleeper": {
      "command": "/path/to/sleeper-mcp-macos-arm64",
      "env": {
        "SLEEPER_USERNAME_A": "your_username",
        "SLEEPER_LEAGUE_A_ID_1": "1234567890123456789"
      }
    }
  }
}
```

Replace `/path/to/sleeper-mcp-macos-arm64` with the actual path to your downloaded executable, and update the environment variables with your Sleeper username and league ID.

4. **Restart Claude Desktop**

## Configuration

### Multi-User/League Support

The server supports multiple users and leagues. Add them to your Claude Desktop config:

```json
{
  "mcpServers": {
    "sleeper": {
      "command": "/path/to/sleeper-mcp",
      "env": {
        "SLEEPER_USERNAME_A": "first_username",
        "SLEEPER_LEAGUE_A_ID_1": "league_id_1",
        "SLEEPER_LEAGUE_A_ID_2": "league_id_2",
        "SLEEPER_USERNAME_B": "second_username",
        "SLEEPER_LEAGUE_B_ID_1": "another_league_id"
      }
    }
  }
}
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

### Prerequisites
- [Bun](https://bun.sh) installed

### Setup

```bash
# Clone the repository
git clone https://github.com/anthonybaldwin/sleeper-api-mcp.git
cd sleeper-api-mcp

# Install dependencies
bun install

# Create .env file with your config (optional, for development)
cp .env.example .env
# Edit .env with your Sleeper credentials

# Run in development mode
bun run dev

# Build executable
bun run build
```

The build command creates a standalone executable (`sleeper-mcp` or `sleeper-mcp.exe`) that includes all dependencies.

## API Reference

This server uses the public Sleeper API v1. No authentication is required. For more details, see the [Sleeper API documentation](https://docs.sleeper.app/).

## Notes

- Real-time data from Sleeper's API
- Projections fetched from Sleeper's projection endpoints
- Smart caching for current week data (5-minute cache)
- Rate limiting to prevent API throttling
- Supports PPR, Half-PPR, and Standard scoring