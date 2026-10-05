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

All tools are read-only (annotated with `readOnlyHint`).

### Your Teams (uses configured users/leagues)
- `show_my_teams` - Show configured users, leagues, and roster IDs
- `show_my_matchup` - Your matchup for any week (actual scores for past weeks, projections otherwise)
- `show_my_opponent` - Details about your opponent for a week
- `show_my_season_record` - Season matchup history and W/L record

### Users & Leagues
- `get_user` - Get Sleeper user information by username or user ID
- `get_user_avatar` - Get a user's avatar URL (full size or thumbnail)
- `get_user_leagues` - Get all leagues for a user
- `get_league_info` - Get league information
- `get_league_rosters` - Get all rosters in a league
- `get_league_members` - Get all users in a league
- `get_week_matchups` - Get raw matchups for a week
- `get_matchup_scores` - Get formatted scores for every matchup in a week
- `get_week_transactions` - Get transactions for a week
- `get_league_traded_picks` - Get traded picks in a league
- `get_winners_bracket` / `get_losers_bracket` - Get playoff brackets

### Drafts
- `get_user_drafts` - Get a user's drafts for a season
- `get_league_drafts` - Get a league's drafts
- `get_draft_info` - Get a draft
- `get_draft_picks` - Get all picks in a draft
- `get_draft_traded_picks` - Get traded picks in a draft

### Players & NFL
- `get_current_week` - Get current NFL season state
- `get_player_details` - Get details for specific players
- `get_trending_players` - Get trending players (adds/drops)
- `get_player_stats` - Get a player's season or weekly stats
- `get_weekly_projections` - Get weekly projections (optionally by position)

### Analysis
- `analyze_trade` - Analyze trade value, injury risk, and positional impact
- `analyze_trade_targets` - Find trade targets for your roster's needs
- `preview_matchup` - Preview a matchup with projections scored using your league's settings
- `optimize_lineup` - Compare starters to bench using weekly projections
- `suggest_waiver_pickups` - Waiver recommendations based on needs, trends, and projections
- `get_free_agents` - Get available free agents

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

# Typecheck
bun run typecheck

# Build executable
bun run build
```

The build command creates a standalone executable (`sleeper-mcp` or `sleeper-mcp.exe`) that includes all dependencies.

## API Reference

This server uses the public, read-only Sleeper API v1 (no authentication required); see the [Sleeper API documentation](https://docs.sleeper.com/). Stats and projections come from undocumented `api.sleeper.com` endpoints used by the Sleeper app, which may change without notice.

## Notes

- Real-time data from Sleeper's API
- Projections are scored with your league's `scoring_settings` (falls back to PPR / Half-PPR / Standard totals)
- Commissioner score overrides (`custom_points`) are respected
- Player database (`/players/nfl`, ~5MB) is cached for 24 hours, per Sleeper's guidance
- Current-week data cached for 5 minutes
- Requests are spaced out to stay well under Sleeper's 1000 calls/minute limit