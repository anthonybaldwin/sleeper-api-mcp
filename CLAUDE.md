# Sleeper API MCP Server

## Development

This project uses **bun** for building and development.

### Build the executable

```bash
bun run build
```

This creates `sleeper-mcp.exe` (on Windows) or `sleeper-mcp` (on Unix systems).

### Run in development mode

```bash
bun run dev
```

For development mode, you can use a `.env` file (see `.env.example`).

## Production Usage

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sleeper": {
      "command": "/path/to/sleeper-mcp.exe",
      "env": {
        "SLEEPER_USERNAME_A": "your_username",
        "SLEEPER_LEAGUE_A_ID_1": "1234567890123456789"
      }
    }
  }
}
```

### Environment Variables

Configure user(s) and league(s) via environment variables:

- `SLEEPER_USERNAME_A` - Primary user's Sleeper username
- `SLEEPER_LEAGUE_A_ID_1` - First league ID for user A
- `SLEEPER_LEAGUE_A_ID_2` - (Optional) Second league ID for user A
- `SLEEPER_USERNAME_B` - (Optional) Second user's username
- `SLEEPER_LEAGUE_B_ID_1` - (Optional) First league ID for user B

The server intelligently detects which league you're referring to based on context.

## Project Structure

- `src/index.ts` - Main MCP server implementation
- `package.json` - Bun build configuration
- `.env.example` - Example environment variables for development