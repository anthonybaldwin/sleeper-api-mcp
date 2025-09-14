#!/usr/bin/env node

import { config } from "dotenv";
config({ quiet: true }); // Load .env file

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const SLEEPER_API_BASE = "https://api.sleeper.app/v1";
const SLEEPER_PROJECTIONS_BASE = "https://api.sleeper.com/projections/nfl";
const SLEEPER_AVATAR_BASE = "https://sleepercdn.com/avatars";
const SLEEPER_AVATAR_THUMB_BASE = "https://sleepercdn.com/avatars/thumbs";

interface SleeperUser {
  username: string;
  user_id: string;
  display_name: string;
  avatar: string;
}

interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  sport: string;
  status: string;
  total_rosters: number;
  scoring_settings?: any;
  roster_positions?: string[];
  settings?: any;
}

interface SleeperRoster {
  roster_id: number;
  owner_id: string;
  league_id: string;
  starters: string[];
  players: string[];
  reserve?: string[];
  taxi?: string[];
  settings: {
    wins: number;
    losses: number;
    ties: number;
    total_moves: number;
    waiver_position: number;
    waiver_budget_used: number;
    waiver_budget_total?: number;
    fpts?: number;
    fpts_decimal?: number;
    fpts_against?: number;
    fpts_against_decimal?: number;
  };
}

interface SleeperMatchup {
  roster_id: number;
  matchup_id: number;
  points: number;
  starters: string[];
  players: string[];
  starters_points?: number[];
}

interface SleeperPlayer {
  player_id: string;
  first_name: string;
  last_name: string;
  team: string;
  position: string;
  status: string;
  injury_status?: string;
  fantasy_positions?: string[];
  years_exp?: number;
  age?: number;
  weight?: string;
  height?: string;
}

interface SleeperTransaction {
  transaction_id: string;
  type: string;
  status: string;
  roster_ids: number[];
  adds?: Record<string, number>;
  drops?: Record<string, number>;
  waiver_budget?: number[];
  created: number;
  settings?: any;
}

interface PlayerProjection {
  player_id: string;
  stats?: Record<string, number>;
  points?: number;
}

interface SleeperDraft {
  draft_id: string;
  league_id: string;
  season: string;
  status: string;
  type: string;
  settings: any;
  start_time: number;
  draft_order: Record<string, number>;
}

interface SleeperDraftPick {
  round: number;
  pick_no: number;
  player_id: string;
  picked_by: string;
  roster_id: string;
  metadata: any;
}

interface SleeperTradedPick {
  season: string;
  round: number;
  roster_id: number;
  previous_owner_id: number;
  owner_id: number;
}

interface SleeperBracketMatchup {
  r: number; // round
  m: number; // matchup
  t1: number; // team 1 roster_id
  t2: number; // team 2 roster_id
  w?: number; // winner roster_id
  l?: number; // loser roster_id
}

interface NFLState {
  week: number;
  season_type: string;
  season_start_date: string;
  season: string;
  display_week: number;
  leg: number;
}

interface UserConfig {
  username: string;
  userId?: string;
  leagues: Array<{
    leagueId: string;
    leagueName?: string;
    rosterId?: string;
  }>;
}

class SleeperMCPServer {
  private server: Server;
  private playersCache: Map<string, SleeperPlayer> = new Map();
  private projectionsCache: Map<string, PlayerProjection> = new Map();
  private users: UserConfig[] = [];
  private currentSeason?: string; // Cached from NFL state
  private currentWeek?: number; // Cached current week
  private lastRequestTime: number = 0;
  private requestDelay: number = 100; // 100ms between requests for rate limiting

  // Cache for current week data only
  private currentWeekCache: {
    matchups: Map<string, any>; // leagueId -> matchups
    rosters: Map<string, any>; // leagueId -> rosters
    projections: Map<string, number>; // playerId -> projection
    bulkProjections: Map<string, any[]>; // Cache bulk projections by key
    timestamp: number;
  } = {
    matchups: new Map(),
    rosters: new Map(),
    projections: new Map(),
    bulkProjections: new Map(),
    timestamp: 0,
  };

  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  constructor() {
    // Parse all users and leagues from environment variables
    this.parseEnvironmentConfig();

    this.server = new Server(
      {
        name: "sleeper-api-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupHandlers();

    // Log configuration on startup
    console.error(`Loaded ${this.users.length} user(s) configuration:`);
    this.users.forEach((user, idx) => {
      console.error(`  User ${idx + 1}: ${user.username} with ${user.leagues.length} league(s)`);
    });
  }

  private parseEnvironmentConfig() {
    const env = process.env;
    const userMap = new Map<string, UserConfig>();

    // Parse all environment variables
    Object.keys(env).forEach((key) => {
      // Match patterns like SLEEPER_USERNAME_A, SLEEPER_LEAGUE_A_ID_1, etc.
      const usernameMatch = key.match(/^SLEEPER_USERNAME_([A-Z]+)$/);
      const leagueMatch = key.match(/^SLEEPER_LEAGUE_([A-Z]+)_ID_(\d+)$/);

      if (usernameMatch) {
        const userKey = usernameMatch[1];
        if (!userMap.has(userKey)) {
          userMap.set(userKey, {
            username: env[key]!,
            leagues: [],
          });
        } else {
          userMap.get(userKey)!.username = env[key]!;
        }
      }

      if (leagueMatch) {
        const userKey = leagueMatch[1];
        const leagueNum = leagueMatch[2];

        if (!userMap.has(userKey)) {
          userMap.set(userKey, {
            username: '',
            leagues: [],
          });
        }

        userMap.get(userKey)!.leagues.push({
          leagueId: env[key]!,
        });
      }
    });

    // Also support legacy format
    if (env.SLEEPER_USERNAME && !userMap.size) {
      userMap.set('DEFAULT', {
        username: env.SLEEPER_USERNAME,
        userId: env.SLEEPER_USER_ID,
        leagues: env.SLEEPER_LEAGUE_ID ? [{
          leagueId: env.SLEEPER_LEAGUE_ID,
          rosterId: env.SLEEPER_ROSTER_ID,
        }] : [],
      });
    }

    this.users = Array.from(userMap.values()).filter(u => u.username);
  }

  private validateConfiguration() {
    // Validate required environment variables
    if (this.users.length === 0) {
      throw new Error(
        "No Sleeper configuration found! Please set at least SLEEPER_USERNAME_A and SLEEPER_LEAGUE_A_ID_1 in your environment. Edit compose.yaml with your Sleeper username and league ID."
      );
    }

    const firstUser = this.users[0];
    if (!firstUser.username || firstUser.leagues.length === 0) {
      throw new Error(
        "Invalid configuration! SLEEPER_USERNAME_A and SLEEPER_LEAGUE_A_ID_1 must both be set. Edit compose.yaml with your actual Sleeper username and league ID."
      );
    }

    // Check if still using placeholder values
    if (firstUser.username === 'your_sleeper_username' ||
        firstUser.leagues[0].leagueId === 'your_league_id_1') {
      throw new Error(
        "Please update the placeholder values in compose.yaml! Replace 'your_sleeper_username' and 'your_league_id_1' with your actual Sleeper details."
      );
    }
  }

  private async findUserAndLeague(hint?: string): Promise<{user: UserConfig, league: any, rosterId?: string} | null> {
    // Ensure we have at least basic configuration
    if (this.users.length === 0 || this.users[0].leagues.length === 0) {
      return null;
    }

    // If only one user and one league, use that as default
    if (!hint && this.users.length === 1 && this.users[0].leagues.length === 1) {
      const user = this.users[0];
      const league = user.leagues[0];
      await this.ensureRosterId(user, league);
      return { user, league, rosterId: league.rosterId };
    }

    // Try to detect based on hint
    if (hint) {
      const hintLower = hint.toLowerCase();

      // First, try to match username
      for (const user of this.users) {
        if (user.username.toLowerCase().includes(hintLower) ||
            hintLower.includes(user.username.toLowerCase())) {
          // If this user has only one league, use it
          if (user.leagues.length === 1) {
            await this.ensureRosterId(user, user.leagues[0]);
            return { user, league: user.leagues[0], rosterId: user.leagues[0].rosterId };
          }
          // Otherwise, try to find a league name match within this user's leagues
          for (const league of user.leagues) {
            if (!league.leagueName) {
              // Fetch league name if not cached
              try {
                await this.rateLimit();
                const leagueInfo = await axios.get<SleeperLeague>(`${SLEEPER_API_BASE}/league/${league.leagueId}`);
                league.leagueName = leagueInfo.data.name;
              } catch (e) {
                console.error('Error fetching league name:', e);
              }
            }
            if (league.leagueName?.toLowerCase().includes(hintLower) ||
                hintLower.includes(league.leagueName?.toLowerCase() || '')) {
              await this.ensureRosterId(user, league);
              return { user, league, rosterId: league.rosterId };
            }
          }
        }
      }

      // Try to match league name across all users
      for (const user of this.users) {
        for (const league of user.leagues) {
          if (!league.leagueName) {
            try {
              const leagueInfo = await axios.get<SleeperLeague>(`${SLEEPER_API_BASE}/league/${league.leagueId}`);
              league.leagueName = leagueInfo.data.name;
            } catch (e) {
              console.error('Error fetching league name:', e);
            }
          }
          if (league.leagueName?.toLowerCase().includes(hintLower) ||
              hintLower.includes(league.leagueName?.toLowerCase() || '') ||
              league.leagueId === hint) {
            await this.ensureRosterId(user, league);
            return { user, league, rosterId: league.rosterId };
          }
        }
      }
    }

    // Default to first user/league if no match
    const user = this.users[0];
    const league = user.leagues[0];
    await this.ensureRosterId(user, league);
    return { user, league, rosterId: league.rosterId };
  }

  private async ensureRosterId(user: UserConfig, league: any): Promise<void> {
    if (!league.rosterId) {
      try {
        if (!user.userId) {
          await this.rateLimit();
          const userInfo = await axios.get<SleeperUser>(`${SLEEPER_API_BASE}/user/${user.username}`);
          user.userId = userInfo.data.user_id;
        }

        await this.rateLimit();
        const rosters = await axios.get<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/rosters`);

        // First try to find by owner_id
        let roster = rosters.data.find(r => r.owner_id === user.userId);

        // If not found, try to match by fetching league users
        if (!roster && rosters.data.length > 0) {
          await this.rateLimit();
          const leagueUsers = await axios.get<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/users`);
          const leagueUser = leagueUsers.data.find(u => u.username === user.username || u.user_id === user.userId);
          if (leagueUser) {
            roster = rosters.data.find(r => r.owner_id === leagueUser.user_id);
            if (roster) {
              user.userId = leagueUser.user_id; // Update with correct user ID
            }
          }
        }

        if (roster) {
          league.rosterId = roster.roster_id.toString();
        }
      } catch (e) {
        console.error('Error finding roster:', e);
        // Don't throw - let the calling function handle missing roster
      }
    }
  }

  private async ensureUserIds(): Promise<void> {
    for (const user of this.users) {
      if (!user.userId) {
        try {
          await this.rateLimit();
          const userInfo = await axios.get<SleeperUser>(`${SLEEPER_API_BASE}/user/${user.username}`);
          user.userId = userInfo.data.user_id;
        } catch (e) {
          console.error(`Error fetching user ID for ${user.username}:`, e);
        }
      }
    }
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.requestDelay) {
      await new Promise(resolve => setTimeout(resolve, this.requestDelay - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  private isCacheValid(): boolean {
    return Date.now() - this.currentWeekCache.timestamp < this.CACHE_DURATION;
  }

  private clearOldCache(): void {
    if (!this.isCacheValid()) {
      this.currentWeekCache.matchups.clear();
      this.currentWeekCache.rosters.clear();
      this.currentWeekCache.projections.clear();
      this.currentWeekCache.bulkProjections.clear();
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Validate configuration on first actual request
        if (this.users.length === 0 ||
            (this.users.length === 1 && this.users[0].username === 'your_sleeper_username')) {
          this.validateConfiguration();
        }
        switch (name) {
          case "get_user":
            return await this.getUser(args?.username as string);
          case "get_user_leagues":
            const season1 = args?.season as string || await this.getCurrentSeason();
            return await this.getUserLeagues(
              args?.user_id as string,
              args?.sport as string | undefined,
              season1,
            );
          case "get_league_info":
            return await this.getLeague(args?.league_id as string);
          case "get_league_rosters":
            return await this.getLeagueRosters(args?.league_id as string);
          case "get_league_members":
            return await this.getLeagueUsers(args?.league_id as string);
          case "get_week_matchups":
            return await this.getMatchups(
              args?.league_id as string,
              args?.week as number,
            );
          case "get_week_transactions":
            return await this.getTransactions(
              args?.league_id as string,
              args?.week as number,
            );
          case "get_trending_players":
            return await this.getTrendingPlayers(
              args?.sport as string | undefined,
              args?.type as string,
              args?.lookback_hours as number | undefined,
              args?.limit as number | undefined,
            );
          case "get_player_details":
            return await this.getPlayerDetails(args?.player_ids as string[]);
          case "get_current_week":
            return await this.getNFLState();
          case "analyze_trade":
            return await this.analyzeTrade(
              args?.league_id as string,
              args?.roster_id_1 as number,
              args?.roster_id_2 as number,
              args?.players_from_1 as string[],
              args?.players_from_2 as string[],
            );
          case "suggest_waiver_pickups":
            return await this.getWaiverRecommendations(
              args?.league_id as string,
              args?.roster_id as number,
              args?.position as string | undefined,
              args?.limit as number | undefined,
            );
          case "preview_matchup":
            return await this.previewMatchup(
              args?.league_id as string,
              args?.week as number,
              args?.roster_id as number,
            );
          case "get_free_agents":
            return await this.getFreeAgents(
              args?.league_id as string,
              args?.position as string | undefined,
            );
          case "optimize_lineup":
            return await this.analyzeLineup(
              args?.league_id as string,
              args?.roster_id as number,
              args?.week as number,
            );
          case "get_weekly_projections":
            const season2 = args?.season as string || await this.getCurrentSeason();
            return await this.getPlayerProjections(
              season2,
              args?.week as number,
              args?.position as string | undefined,
            );
          case "show_my_teams":
            return await this.getMyInfo();
          case "show_my_matchup":
            return await this.getMyMatchup(
              args?.week as number | undefined,
              args?.league_hint as string | undefined
            );
          case "show_my_season_record":
            return await this.getMySeasonHistory(args?.league_hint as string | undefined);
          case "show_my_opponent":
            return await this.getMyOpponent(
              args?.week as number | undefined,
              args?.league_hint as string | undefined
            );
          case "get_user_avatar":
            return await this.getAvatarUrl(
              args?.username as string | undefined,
              args?.user_id as string | undefined,
              args?.thumbnail as boolean | undefined,
            );
          // Draft tools
          case "get_user_drafts":
            const season3 = args?.season as string || await this.getCurrentSeason();
            return await this.getUserDrafts(
              args?.user_id as string,
              args?.sport as string || "nfl",
              season3,
            );
          case "get_league_drafts":
            return await this.getLeagueDrafts(args?.league_id as string);
          case "get_draft_info":
            return await this.getDraftInfo(args?.draft_id as string);
          case "get_draft_picks":
            return await this.getDraftPicks(args?.draft_id as string);
          case "get_draft_traded_picks":
            return await this.getDraftTradedPicks(args?.draft_id as string);
          // Bracket tools
          case "get_winners_bracket":
            return await this.getWinnersBracket(args?.league_id as string);
          case "get_losers_bracket":
            return await this.getLosersBracket(args?.league_id as string);
          // Traded picks
          case "get_league_traded_picks":
            return await this.getLeagueTradedPicks(args?.league_id as string);
          // NFL State
          case "get_current_week":
            return await this.getNFLState();
          // Advanced analytics
          case "get_matchup_scores":
            return await this.getMatchupScores(
              args?.league_id as string,
              args?.week as number,
            );
          case "analyze_trade_targets":
            return await this.analyzeTradeTargets(
              args?.league_id as string,
              args?.roster_id as number,
            );
          case "get_player_stats":
            const season4 = args?.season as string || await this.getCurrentSeason();
            return await this.getPlayerStats(
              args?.player_id as string,
              season4,
              args?.week as number | undefined,
            );
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  private getTools(): Tool[] {
    return [
      {
        name: "get_user",
        description: "Get Sleeper user information by username",
        inputSchema: {
          type: "object",
          properties: {
            username: {
              type: "string",
              description: "Sleeper username",
            },
          },
          required: ["username"],
        },
      },
      {
        name: "get_user_leagues",
        description: "Get all leagues for a specific user",
        inputSchema: {
          type: "object",
          properties: {
            user_id: {
              type: "string",
              description: "Sleeper user ID",
            },
            sport: {
              type: "string",
              description: "Sport (e.g., nfl)",
              default: "nfl",
            },
            season: {
              type: "string",
              description: "Season year (e.g., 2024)",
            },
          },
          required: ["user_id", "season"],
        },
      },
      {
        name: "get_league_info",
        description: "Get league information by league ID",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "Sleeper league ID",
            },
          },
          required: ["league_id"],
        },
      },
      {
        name: "get_league_rosters",
        description: "Get all rosters in a league",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "Sleeper league ID",
            },
          },
          required: ["league_id"],
        },
      },
      {
        name: "get_league_members",
        description: "Get all users in a league",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "Sleeper league ID",
            },
          },
          required: ["league_id"],
        },
      },
      {
        name: "get_week_matchups",
        description: "Get matchups for a specific week in a league",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "Sleeper league ID",
            },
            week: {
              type: "number",
              description: "Week number (1-18 for NFL)",
            },
          },
          required: ["league_id", "week"],
        },
      },
      {
        name: "get_week_transactions",
        description: "Get transactions for a specific week in a league",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "Sleeper league ID",
            },
            week: {
              type: "number",
              description: "Week number (1-18 for NFL)",
            },
          },
          required: ["league_id", "week"],
        },
      },
      {
        name: "get_trending_players",
        description: "Get trending players being added/dropped",
        inputSchema: {
          type: "object",
          properties: {
            sport: {
              type: "string",
              description: "Sport (e.g., nfl)",
              default: "nfl",
            },
            type: {
              type: "string",
              description: "Trend type: add or drop",
              enum: ["add", "drop"],
            },
            lookback_hours: {
              type: "number",
              description: "Hours to look back (e.g., 24)",
              default: 24,
            },
            limit: {
              type: "number",
              description: "Number of results to return",
              default: 25,
            },
          },
          required: ["type"],
        },
      },
      {
        name: "get_player_details",
        description: "Get details for specific players by their IDs",
        inputSchema: {
          type: "object",
          properties: {
            player_ids: {
              type: "array",
              items: {
                type: "string",
              },
              description: "Array of player IDs",
            },
          },
          required: ["player_ids"],
        },
      },
      {
        name: "get_current_week",
        description: "Get current NFL season state including week",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "show_my_teams",
        description:
          "Get your configured default settings (username, league ID, user ID)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "show_my_matchup",
        description:
          "Get YOUR matchup for any week - past (shows actual scores) or future (shows projections)",
        inputSchema: {
          type: "object",
          properties: {
            week: {
              type: "number",
              description: "Week number 1-18 (optional, defaults to current week)",
            },
            league_hint: {
              type: "string",
              description: "League name or username hint to identify which league (optional)",
            },
          },
        },
      },
      {
        name: "show_my_season_record",
        description:
          "Get your full season matchup history with scores and W/L record",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "show_my_opponent",
        description:
          "Get detailed info about your opponent for any week including avatar",
        inputSchema: {
          type: "object",
          properties: {
            week: {
              type: "number",
              description: "Week number (optional, defaults to current week)",
            },
          },
        },
      },
      {
        name: "get_user_avatar",
        description:
          "Get avatar URL for any user (full size or thumbnail)",
        inputSchema: {
          type: "object",
          properties: {
            username: {
              type: "string",
              description: "Username (optional if user_id provided)",
            },
            user_id: {
              type: "string",
              description: "User ID (optional if username provided)",
            },
            thumbnail: {
              type: "boolean",
              description: "Get thumbnail version (default: false)",
            },
          },
        },
      },
      {
        name: "analyze_trade",
        description: "Evaluate trade fairness with comprehensive player values and positional impact analysis",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "Sleeper league ID",
            },
            roster_id_1: {
              type: "number",
              description: "First roster ID in trade",
            },
            roster_id_2: {
              type: "number",
              description: "Second roster ID in trade",
            },
            players_from_1: {
              type: "array",
              items: { type: "string" },
              description: "Player IDs going from roster 1 to roster 2",
            },
            players_from_2: {
              type: "array",
              items: { type: "string" },
              description: "Player IDs going from roster 2 to roster 1",
            },
          },
          required: [
            "league_id",
            "roster_id_1",
            "roster_id_2",
            "players_from_1",
            "players_from_2",
          ],
        },
      },
      {
        name: "suggest_waiver_pickups",
        description: "Get waiver wire recommendations based on team needs",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "Sleeper league ID",
            },
            roster_id: {
              type: "number",
              description: "Roster ID to get recommendations for",
            },
            position: {
              type: "string",
              description: "Position to focus on (optional)",
            },
            limit: {
              type: "number",
              description: "Number of recommendations",
              default: 10,
            },
          },
          required: ["league_id", "roster_id"],
        },
      },
      {
        name: "preview_matchup",
        description: "Preview upcoming matchup with projections and analysis",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "Sleeper league ID",
            },
            week: {
              type: "number",
              description: "Week number",
            },
            roster_id: {
              type: "number",
              description: "Your roster ID",
            },
          },
          required: ["league_id", "week", "roster_id"],
        },
      },
      {
        name: "get_free_agents",
        description: "Get available free agents in a league",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "Sleeper league ID",
            },
            position: {
              type: "string",
              description: "Filter by position (optional)",
            },
          },
          required: ["league_id"],
        },
      },
      {
        name: "optimize_lineup",
        description: "Analyze and optimize lineup for a specific week",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "Sleeper league ID",
            },
            roster_id: {
              type: "number",
              description: "Roster ID to analyze",
            },
            week: {
              type: "number",
              description: "Week number",
            },
          },
          required: ["league_id", "roster_id", "week"],
        },
      },
      {
        name: "get_weekly_projections",
        description: "Get player projections for a specific week",
        inputSchema: {
          type: "object",
          properties: {
            season: {
              type: "string",
              description: "Season year",
            },
            week: {
              type: "number",
              description: "Week number",
            },
            position: {
              type: "string",
              description: "Position filter (optional)",
            },
          },
          required: ["season", "week"],
        },
      },
      // Draft tools
      {
        name: "get_user_drafts",
        description: "Get all drafts for a user for a specific sport and season",
        inputSchema: {
          type: "object",
          properties: {
            user_id: {
              type: "string",
              description: "User ID",
            },
            sport: {
              type: "string",
              description: "Sport (default: nfl)",
            },
            season: {
              type: "string",
              description: "Season year (defaults to current season)",
            },
          },
          required: ["user_id"],
        },
      },
      {
        name: "get_league_drafts",
        description: "Get all drafts for a league",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "League ID",
            },
          },
          required: ["league_id"],
        },
      },
      {
        name: "get_draft_info",
        description: "Get information about a specific draft",
        inputSchema: {
          type: "object",
          properties: {
            draft_id: {
              type: "string",
              description: "Draft ID",
            },
          },
          required: ["draft_id"],
        },
      },
      {
        name: "get_draft_picks",
        description: "Get all picks in a draft",
        inputSchema: {
          type: "object",
          properties: {
            draft_id: {
              type: "string",
              description: "Draft ID",
            },
          },
          required: ["draft_id"],
        },
      },
      {
        name: "get_draft_traded_picks",
        description: "Get all traded picks in a draft",
        inputSchema: {
          type: "object",
          properties: {
            draft_id: {
              type: "string",
              description: "Draft ID",
            },
          },
          required: ["draft_id"],
        },
      },
      // Bracket tools
      {
        name: "get_winners_bracket",
        description: "Get the playoff winners bracket for a league",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "League ID",
            },
          },
          required: ["league_id"],
        },
      },
      {
        name: "get_losers_bracket",
        description: "Get the playoff losers bracket for a league",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "League ID",
            },
          },
          required: ["league_id"],
        },
      },
      // Traded picks
      {
        name: "get_league_traded_picks",
        description: "Get all traded picks in a league",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "League ID",
            },
          },
          required: ["league_id"],
        },
      },
      // NFL State
      {
        name: "get_current_week",
        description: "Get the current NFL state (week, season, etc.)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      // Advanced analytics
      {
        name: "get_matchup_scores",
        description: "Get real-time scoring information for matchups in a specific week",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "League ID",
            },
            week: {
              type: "number",
              description: "Week number",
            },
          },
          required: ["league_id", "week"],
        },
      },
      {
        name: "analyze_trade_targets",
        description: "Identify optimal trade targets based on your roster's strengths and weaknesses",
        inputSchema: {
          type: "object",
          properties: {
            league_id: {
              type: "string",
              description: "League ID",
            },
            roster_id: {
              type: "number",
              description: "Your roster ID",
            },
          },
          required: ["league_id", "roster_id"],
        },
      },
      {
        name: "get_player_stats",
        description: "Get detailed stats for a specific player",
        inputSchema: {
          type: "object",
          properties: {
            player_id: {
              type: "string",
              description: "Player ID",
            },
            season: {
              type: "string",
              description: "Season year (defaults to current season)",
            },
            week: {
              type: "number",
              description: "Week number (optional, omit for season totals)",
            },
          },
          required: ["player_id"],
        },
      },
    ];
  }

  private async getUser(username: string) {
    const response = await axios.get<SleeperUser>(
      `${SLEEPER_API_BASE}/user/${username}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getUserLeagues(
    userId: string,
    sport: string = "nfl",
    season: string,
  ) {
    const response = await axios.get<SleeperLeague[]>(
      `${SLEEPER_API_BASE}/user/${userId}/leagues/${sport}/${season}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getLeague(leagueId: string) {
    const response = await axios.get<SleeperLeague>(
      `${SLEEPER_API_BASE}/league/${leagueId}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getLeagueRosters(leagueId: string) {
    const response = await axios.get<SleeperRoster[]>(
      `${SLEEPER_API_BASE}/league/${leagueId}/rosters`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getLeagueUsers(leagueId: string) {
    const response = await axios.get<SleeperUser[]>(
      `${SLEEPER_API_BASE}/league/${leagueId}/users`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getMatchups(leagueId: string, week: number) {
    const response = await axios.get<SleeperMatchup[]>(
      `${SLEEPER_API_BASE}/league/${leagueId}/matchups/${week}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getTransactions(leagueId: string, week: number) {
    const response = await axios.get<SleeperTransaction[]>(
      `${SLEEPER_API_BASE}/league/${leagueId}/transactions/${week}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getTrendingPlayers(
    sport: string = "nfl",
    type: string,
    lookbackHours: number | undefined = 24,
    limit: number | undefined = 25,
  ) {
    const response = await axios.get(
      `${SLEEPER_API_BASE}/players/${sport}/trending/${type}`,
      {
        params: {
          lookback_hours: lookbackHours || 24,
          limit: limit || 25,
        },
      },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async loadPlayersCache() {
    if (this.playersCache.size === 0) {
      try {
        const response = await axios.get<Record<string, SleeperPlayer>>(
          `${SLEEPER_API_BASE}/players/nfl`,
        );
        Object.entries(response.data).forEach(([id, player]) => {
          this.playersCache.set(id, player);
        });
      } catch (error) {
        console.error("Failed to load players cache:", error);
      }
    }
  }

  private async getPlayerDetails(playerIds: string[]) {
    await this.loadPlayersCache();

    const players = playerIds.map((id) => {
      const player = this.playersCache.get(id);
      return player ? { [id]: player } : { [id]: null };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(players, null, 2),
        },
      ],
    };
  }

  private async getMyMatchup(week?: number, leagueHint?: string) {
    // Find the appropriate user and league
    const config = await this.findUserAndLeague(leagueHint);
    if (!config) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No league configuration found",
              message: "Please configure at least one user and league in your .env file",
              hint: "Set SLEEPER_USERNAME_A and SLEEPER_LEAGUE_A_ID_1 in .env"
            }, null, 2),
          },
        ],
      };
    }

    const { user, league, rosterId } = config;
    if (!rosterId) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Could not find roster for user in this league",
              user: user.username,
              league: league.leagueId
            }, null, 2),
          },
        ],
      };
    }

    // Get current week if not specified
    let actualWeek = week;
    let isHistorical = false;
    const nflState = await axios.get<NFLState>(`${SLEEPER_API_BASE}/state/nfl`);
    this.currentSeason = nflState.data.season;

    if (!actualWeek) {
      actualWeek = nflState.data.week;
    } else if (actualWeek < nflState.data.week) {
      isHistorical = true;
    }

    // For past weeks, get actual scores instead of projections
    if (isHistorical) {
      const matchups = await axios.get<SleeperMatchup[]>(
        `${SLEEPER_API_BASE}/league/${league.leagueId}/matchups/${actualWeek}`,
      );

      const myMatchup = matchups.data.find((m) => m.roster_id === parseInt(rosterId));
      const oppMatchup = matchups.data.find(
        (m) => m.matchup_id === myMatchup?.matchup_id && m.roster_id !== parseInt(rosterId),
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              week: actualWeek,
              type: "historical",
              my_score: myMatchup?.points || 0,
              opponent_score: oppMatchup?.points || 0,
              result: myMatchup && oppMatchup ?
                (myMatchup.points > oppMatchup.points ? "WON" :
                 myMatchup.points < oppMatchup.points ? "LOST" : "TIED") : "N/A",
              my_starters: myMatchup?.starters,
              my_starters_points: myMatchup?.starters_points,
              opponent_starters: oppMatchup?.starters,
              opponent_starters_points: oppMatchup?.starters_points,
            }, null, 2),
          },
        ],
      };
    }

    // For current/future weeks, show projections
    return await this.previewMatchup(
      league.leagueId,
      actualWeek,
      parseInt(rosterId),
    );
  }

  private async getMySeasonHistory(leagueHint?: string) {
    // Find the appropriate user and league
    const config = await this.findUserAndLeague(leagueHint);
    if (!config) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No league configuration found",
              message: "Please configure at least one user and league in your .env file",
              hint: "Set SLEEPER_USERNAME_A and SLEEPER_LEAGUE_A_ID_1 in .env"
            }, null, 2),
          },
        ],
      };
    }

    const { user, league, rosterId } = config;
    if (!rosterId) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Could not find roster for user in this league",
              user: user.username,
              league: league.leagueId
            }, null, 2),
          },
        ],
      };
    }

    await this.rateLimit();
    const nflState = await axios.get<NFLState>(`${SLEEPER_API_BASE}/state/nfl`);
    const currentWeek = nflState.data.week;

    const history = [];
    for (let week = 1; week < currentWeek; week++) {
      await this.rateLimit();
      const matchups = await axios.get<SleeperMatchup[]>(
        `${SLEEPER_API_BASE}/league/${league.leagueId}/matchups/${week}`,
      );

      const myMatchup = matchups.data.find((m) => m.roster_id === parseInt(rosterId));
      const oppMatchup = matchups.data.find(
        (m) => m.matchup_id === myMatchup?.matchup_id && m.roster_id !== parseInt(rosterId),
      );

      if (myMatchup && oppMatchup) {
        history.push({
          week,
          my_score: myMatchup.points,
          opponent_score: oppMatchup.points,
          opponent_roster_id: oppMatchup.roster_id,
          result: myMatchup.points > oppMatchup.points ? "W" :
                  myMatchup.points < oppMatchup.points ? "L" : "T",
          margin: Math.abs(myMatchup.points - oppMatchup.points),
        });
      }
    }

    const wins = history.filter(h => h.result === "W").length;
    const losses = history.filter(h => h.result === "L").length;
    const ties = history.filter(h => h.result === "T").length;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            season_record: `${wins}-${losses}${ties > 0 ? `-${ties}` : ""}`,
            total_points_for: history.reduce((sum, h) => sum + h.my_score, 0),
            total_points_against: history.reduce((sum, h) => sum + h.opponent_score, 0),
            avg_points_for: (history.reduce((sum, h) => sum + h.my_score, 0) / history.length),
            avg_points_against: (history.reduce((sum, h) => sum + h.opponent_score, 0) / history.length),
            matchup_history: history,
          }, null, 2),
        },
      ],
    };
  }

  private async getMyOpponent(week?: number, leagueHint?: string) {
    // Find the appropriate user and league
    const config = await this.findUserAndLeague(leagueHint);
    if (!config) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No league configuration found",
              message: "Please configure at least one user and league in your .env file",
              hint: "Set SLEEPER_USERNAME_A and SLEEPER_LEAGUE_A_ID_1 in .env"
            }, null, 2),
          },
        ],
      };
    }

    const { user, league, rosterId } = config;
    if (!rosterId) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Could not find roster for user in this league",
              user: user.username,
              league: league.leagueId
            }, null, 2),
          },
        ],
      };
    }

    let actualWeek = week;
    if (!actualWeek) {
      await this.rateLimit();
      const nflState = await axios.get<NFLState>(`${SLEEPER_API_BASE}/state/nfl`);
      actualWeek = nflState.data.week;
    }

    // Use sequential requests with rate limiting instead of Promise.all
    await this.rateLimit();
    const matchups = await axios.get<SleeperMatchup[]>(
      `${SLEEPER_API_BASE}/league/${league.leagueId}/matchups/${actualWeek}`,
    );
    await this.rateLimit();
    const rosters = await axios.get<SleeperRoster[]>(
      `${SLEEPER_API_BASE}/league/${league.leagueId}/rosters`,
    );
    await this.rateLimit();
    const users = await axios.get<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/users`);

    const myMatchup = matchups.data.find((m) => m.roster_id === parseInt(rosterId));
    const oppMatchup = matchups.data.find(
      (m) => m.matchup_id === myMatchup?.matchup_id && m.roster_id !== parseInt(rosterId),
    );

    if (!oppMatchup) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ message: "No opponent this week (bye week or playoffs)" }, null, 2),
          },
        ],
      };
    }

    const oppRoster = rosters.data.find((r) => r.roster_id === oppMatchup.roster_id);
    const oppUser = users.data.find((u) => u.user_id === oppRoster?.owner_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            week: actualWeek,
            opponent: {
              username: oppUser?.username,
              display_name: oppUser?.display_name,
              user_id: oppUser?.user_id,
              avatar_id: oppUser?.avatar,
              avatar_url: oppUser?.avatar ? `${SLEEPER_AVATAR_BASE}/${oppUser.avatar}` : null,
              avatar_thumbnail: oppUser?.avatar ? `${SLEEPER_AVATAR_THUMB_BASE}/${oppUser.avatar}` : null,
              roster_id: oppMatchup.roster_id,
              record: `${oppRoster?.settings.wins}-${oppRoster?.settings.losses}`,
              points_this_week: oppMatchup.points,
              projected_points: "Use preview_matchup for projections",
            },
          }, null, 2),
        },
      ],
    };
  }

  private async getAvatarUrl(username?: string, userId?: string, thumbnail: boolean = false) {
    let avatarId: string | null = null;

    if (userId) {
      await this.rateLimit();
      const userResponse = await axios.get<SleeperUser>(
        `${SLEEPER_API_BASE}/user/${userId}`,
      );
      avatarId = userResponse.data.avatar;
    } else if (username) {
      await this.rateLimit();
      const userResponse = await axios.get<SleeperUser>(
        `${SLEEPER_API_BASE}/user/${username}`,
      );
      avatarId = userResponse.data.avatar;
    } else if (this.users.length > 0) {
      // Default to first configured user if no username provided
      const firstUser = this.users[0];
      if (!firstUser.userId) {
        await this.rateLimit();
        const userResponse = await axios.get<SleeperUser>(
          `${SLEEPER_API_BASE}/user/${firstUser.username}`,
        );
        firstUser.userId = userResponse.data.user_id;
        avatarId = userResponse.data.avatar;
      } else {
        await this.rateLimit();
        const userResponse = await axios.get<SleeperUser>(
          `${SLEEPER_API_BASE}/user/${firstUser.userId}`,
        );
        avatarId = userResponse.data.avatar;
      }
    }

    if (!avatarId) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "No avatar found for user" }, null, 2),
          },
        ],
      };
    }

    const baseUrl = thumbnail ? SLEEPER_AVATAR_THUMB_BASE : SLEEPER_AVATAR_BASE;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            avatar_id: avatarId,
            avatar_url: `${baseUrl}/${avatarId}`,
            thumbnail: thumbnail,
          }, null, 2),
        },
      ],
    };
  }

  private async getMyInfo() {
    const info: any = {
      configured_users: this.users.length,
      total_leagues: this.users.reduce((sum, u) => sum + u.leagues.length, 0),
      configurations: [],
    };

    // Show all configured users and their leagues
    for (const user of this.users) {
      const userConfig: any = {
        username: user.username,
        user_id: user.userId,
        leagues: [],
      };

      // Fetch user details if not cached
      if (!user.userId) {
        try {
          const userResponse = await axios.get<SleeperUser>(
            `${SLEEPER_API_BASE}/user/${user.username}`,
          );
          user.userId = userResponse.data.user_id;
          userConfig.user_id = user.userId;
          userConfig.avatar = userResponse.data.avatar;
        } catch (error) {
          userConfig.error = "Failed to fetch user details";
        }
      }

      // Fetch league details for each league
      for (const league of user.leagues) {
        const leagueInfo: any = {
          league_id: league.leagueId,
          roster_id: league.rosterId,
        };

        try {
          if (!league.leagueName) {
            const leagueResponse = await axios.get<SleeperLeague>(
              `${SLEEPER_API_BASE}/league/${league.leagueId}`,
            );
            league.leagueName = leagueResponse.data.name;
          }
          leagueInfo.name = league.leagueName;

          // Get roster ID if not cached
          if (!league.rosterId) {
            await this.ensureRosterId(user, league);
          }
          leagueInfo.roster_id = league.rosterId;
        } catch (error) {
          leagueInfo.error = "Failed to fetch league details";
        }

        userConfig.leagues.push(leagueInfo);
      }

      info.configurations.push(userConfig);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(info, null, 2),
        },
      ],
    };
  }

  private async analyzeTrade(
    leagueId: string,
    rosterId1: number,
    rosterId2: number,
    playersFrom1: string[],
    playersFrom2: string[],
  ) {
    await this.loadPlayersCache();

    const [league, rosters] = await Promise.all([
      axios.get<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
      axios.get<SleeperRoster[]>(
        `${SLEEPER_API_BASE}/league/${leagueId}/rosters`,
      ),
    ]);

    const roster1 = rosters.data.find((r) => r.roster_id === rosterId1);
    const roster2 = rosters.data.find((r) => r.roster_id === rosterId2);

    if (!roster1 || !roster2) {
      throw new Error("Invalid roster IDs");
    }

    const getPlayerValue = (playerId: string): number => {
      const player = this.playersCache.get(playerId);
      if (!player) return 0;

      let value = 50;
      if (player.position === "QB") value = 100;
      if (player.position === "RB") value = 80;
      if (player.position === "WR") value = 70;
      if (player.position === "TE") value = 60;

      if (player.injury_status) value *= 0.7;

      return value;
    };

    const team1Value = playersFrom1.reduce(
      (sum, id) => sum + getPlayerValue(id),
      0,
    );
    const team2Value = playersFrom2.reduce(
      (sum, id) => sum + getPlayerValue(id),
      0,
    );

    const valueDiff = Math.abs(team1Value - team2Value);
    const percentDiff = (valueDiff / Math.max(team1Value, team2Value)) * 100;

    const riskFactors = [];

    for (const playerId of [...playersFrom1, ...playersFrom2]) {
      const player = this.playersCache.get(playerId);
      if (player?.injury_status) {
        riskFactors.push(
          `${player.first_name} ${player.last_name} has injury status: ${player.injury_status}`,
        );
      }
    }

    const positionalNeeds1 = this.analyzePositionalNeeds(
      roster1,
      playersFrom1,
      playersFrom2,
    );
    const positionalNeeds2 = this.analyzePositionalNeeds(
      roster2,
      playersFrom2,
      playersFrom1,
    );

    if (positionalNeeds1.length > 0)
      riskFactors.push(`Team 1 needs: ${positionalNeeds1.join(", ")}`);
    if (positionalNeeds2.length > 0)
      riskFactors.push(`Team 2 needs: ${positionalNeeds2.join(", ")}`);

    let recommendation = "Fair trade";
    if (percentDiff > 30) {
      recommendation =
        team1Value > team2Value
          ? "Team 1 wins significantly"
          : "Team 2 wins significantly";
    } else if (percentDiff > 15) {
      recommendation =
        team1Value > team2Value
          ? "Team 1 has slight advantage"
          : "Team 2 has slight advantage";
    }

    const analysis = {
      team1_gives: playersFrom1.map((id) => {
        const p = this.playersCache.get(id);
        return p ? `${p.first_name} ${p.last_name} (${p.position})` : id;
      }),
      team2_gives: playersFrom2.map((id) => {
        const p = this.playersCache.get(id);
        return p ? `${p.first_name} ${p.last_name} (${p.position})` : id;
      }),
      team1_value: team1Value,
      team2_value: team2Value,
      value_difference: valueDiff,
      percent_difference: percentDiff.toFixed(1) + "%",
      risk_factors: riskFactors,
      recommendation: recommendation,
      team1_record: `${roster1.settings.wins}-${roster1.settings.losses}`,
      team2_record: `${roster2.settings.wins}-${roster2.settings.losses}`,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(analysis, null, 2),
        },
      ],
    };
  }

  private analyzePositionalNeeds(
    roster: SleeperRoster,
    giving: string[],
    receiving: string[],
  ): string[] {
    const needs = [];
    const positions = ["QB", "RB", "WR", "TE"];

    for (const pos of positions) {
      const current = roster.players.filter((id) => {
        const player = this.playersCache.get(id);
        return player?.position === pos;
      }).length;

      const losing = giving.filter((id) => {
        const player = this.playersCache.get(id);
        return player?.position === pos;
      }).length;

      const gaining = receiving.filter((id) => {
        const player = this.playersCache.get(id);
        return player?.position === pos;
      }).length;

      const after = current - losing + gaining;

      if (pos === "RB" && after < 4) needs.push("RB depth");
      if (pos === "WR" && after < 5) needs.push("WR depth");
      if (pos === "QB" && after < 2) needs.push("QB backup");
    }

    return needs;
  }

  private async getWaiverRecommendations(
    leagueId: string,
    rosterId: number,
    position?: string,
    limit: number | undefined = 10,
  ) {
    await this.loadPlayersCache();

    const [rosters, trending, nflState, leagueInfo] = await Promise.all([
      axios.get<SleeperRoster[]>(
        `${SLEEPER_API_BASE}/league/${leagueId}/rosters`,
      ),
      axios.get(
        `${SLEEPER_API_BASE}/players/nfl/trending/add?lookback_hours=24&limit=50`,
      ),
      axios.get<NFLState>(`${SLEEPER_API_BASE}/state/nfl`),
      axios.get<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
    ]);

    const roster = rosters.data.find((r) => r.roster_id === rosterId);
    if (!roster) throw new Error("Roster not found");

    const allRosteredPlayers = new Set(
      rosters.data.flatMap((r) => r.players || []),
    );

    const currentWeek = nflState.data.week;
    const season = nflState.data.season;

    // Analyze roster needs based on current roster
    const rosterNeeds: string[] = [];
    const positionCounts: Record<string, number> = {};

    roster.players.forEach((playerId) => {
      const player = this.playersCache.get(playerId);
      if (player) {
        positionCounts[player.position] = (positionCounts[player.position] || 0) + 1;
      }
    });

    // Determine needs based on actual league roster requirements
    const rosterPositions = leagueInfo.data.roster_positions || [];
    const positionRequirements: Record<string, number> = {};

    // Count required positions from league settings
    for (const pos of rosterPositions) {
      if (pos && pos !== "BN" && pos !== "FLEX" && pos !== "SUPER_FLEX") {
        positionRequirements[pos] = (positionRequirements[pos] || 0) + 1;
      }
    }

    // Add some bench depth recommendations (but only for positions the league uses)
    for (const pos in positionRequirements) {
      const required = positionRequirements[pos];
      const current = positionCounts[pos] || 0;

      // Recommend having at least 1.5x the starters for depth (minimum 1 backup)
      const recommended = Math.max(required + 1, Math.ceil(required * 1.5));

      if (current < recommended) {
        rosterNeeds.push(pos);
      }
    }

    // Get trending player IDs for prioritization
    const trendingPlayerIds = new Set(trending.data.map((t: any) => t.player_id));

    // First pass: collect available players and basic info (no API calls)
    const availablePlayers: any[] = [];
    for (const [playerId, player] of this.playersCache) {
      if (!allRosteredPlayers.has(playerId) && player.status === "Active") {
        if (!position || player.position === position) {
          const isTrending = trendingPlayerIds.has(playerId);
          const trendingCount = trending.data.find((t: any) => t.player_id === playerId)?.count || 0;

          availablePlayers.push({
            ...player,
            player_id: playerId,
            trending_add: trendingCount,
            is_trending: isTrending,
            need_score: rosterNeeds.includes(player.position) ? 10 : 0,
            // Initial score without projections
            initial_score: (trendingCount / 10) + (rosterNeeds.includes(player.position) ? 10 : 0),
            avg_projection: 0, // Initialize
            overall_score: 0, // Initialize
          });
        }
      }
    }

    // Sort by initial score and take top candidates
    availablePlayers.sort((a, b) => b.initial_score - a.initial_score);
    const topCandidates = availablePlayers.slice(0, Math.min(50, limit ? limit * 3 : 30));

    // Second pass: get projections only for top candidates
    for (const player of topCandidates) {
      let avgProjection = 0;

      // Only fetch projections for trending players or those filling needs
      if (player.is_trending || player.need_score > 0) {
        try {
          await this.rateLimit();
          // Get just current week projection as indicator
          const projResponse = await axios.get(
            `${SLEEPER_PROJECTIONS_BASE}/player/${player.player_id}?season_type=regular&season=${season}&week=${currentWeek}`,
            { timeout: 1000 }
          );
          if (projResponse.data?.stats?.pts_ppr) {
            avgProjection = projResponse.data.stats.pts_ppr;
          }
        } catch (e) {
          // Use 0 if no projection available
        }
      }

      player.avg_projection = avgProjection;
      player.overall_score = (avgProjection * 2) + player.initial_score;
    }

    // Sort by overall score (combination of projections, trending, and need)
    topCandidates.sort((a, b) => b.overall_score - a.overall_score);

    const recommendations = topCandidates
      .slice(0, limit || 10)
      .map((player) => ({
        player: `${player.first_name} ${player.last_name}`,
        position: player.position,
        team: player.team,
        trending_adds: player.trending_add,
        current_week_projection: player.avg_projection,
        fills_need: rosterNeeds.includes(player.position),
        injury_status: player.injury_status || "Healthy",
        recommendation_score: player.overall_score,
      }));

    const waiverBudget = roster.settings.waiver_budget_total
      ? roster.settings.waiver_budget_total -
        (roster.settings.waiver_budget_used || 0)
      : null;

    const result = {
      roster_needs: rosterNeeds,
      recommendations,
      waiver_position: roster.settings.waiver_position,
      waiver_budget_remaining: waiverBudget,
      total_moves_made: roster.settings.total_moves,
      analysis_note: "Recommendations based on: upcoming schedule projections, trending adds, and roster needs",
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async previewMatchup(
    leagueId: string,
    week: number,
    rosterId: number,
  ) {
    await this.loadPlayersCache();

    // Check if we should use cache (only for current week)
    const isCurrentWeek = week === this.currentWeek;
    let matchups, rosters, users, leagueInfo;

    if (isCurrentWeek && this.isCacheValid()) {
      // Try to use cached data for current week
      const cachedMatchups = this.currentWeekCache.matchups.get(leagueId);
      const cachedRosters = this.currentWeekCache.rosters.get(leagueId);

      if (cachedMatchups && cachedRosters) {
        matchups = { data: cachedMatchups };
        rosters = { data: cachedRosters };
        // Still fetch users and league info as they don't change often
        [users, leagueInfo] = await Promise.all([
          axios.get<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
          axios.get<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
        ]);
      } else {
        // Fetch and cache
        [matchups, rosters, users, leagueInfo] = await Promise.all([
          axios.get<SleeperMatchup[]>(
            `${SLEEPER_API_BASE}/league/${leagueId}/matchups/${week}`,
          ),
          axios.get<SleeperRoster[]>(
            `${SLEEPER_API_BASE}/league/${leagueId}/rosters`,
          ),
          axios.get<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
          axios.get<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
        ]);

        // Cache for current week
        this.currentWeekCache.matchups.set(leagueId, matchups.data);
        this.currentWeekCache.rosters.set(leagueId, rosters.data);
        this.currentWeekCache.timestamp = Date.now();
      }
    } else {
      // Don't cache data for other weeks
      [matchups, rosters, users, leagueInfo] = await Promise.all([
        axios.get<SleeperMatchup[]>(
          `${SLEEPER_API_BASE}/league/${leagueId}/matchups/${week}`,
        ),
        axios.get<SleeperRoster[]>(
          `${SLEEPER_API_BASE}/league/${leagueId}/rosters`,
        ),
        axios.get<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
        axios.get<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
      ]);
    }

    const myMatchup = matchups.data.find((m: SleeperMatchup) => m.roster_id === rosterId);
    if (!myMatchup) throw new Error("Matchup not found");

    const opponentMatchup = matchups.data.find(
      (m: SleeperMatchup) => m.matchup_id === myMatchup.matchup_id && m.roster_id !== rosterId,
    );

    const myRoster = rosters.data.find((r: SleeperRoster) => r.roster_id === rosterId);
    const opponentRoster = opponentMatchup
      ? rosters.data.find((r: SleeperRoster) => r.roster_id === opponentMatchup.roster_id)
      : null;

    const myUser = users.data.find((u) => u.user_id === myRoster?.owner_id);
    const opponentUser = opponentRoster
      ? users.data.find((u) => u.user_id === opponentRoster.owner_id)
      : null;

    // Get season stats for better projections
    const season = leagueInfo.data.season;
    const currentWeek = week;

    // Fetch bulk projections like Sleeper does
    const fetchBulkProjections = async () => {
      const cacheKey = `${season}-${currentWeek}-${leagueId}`;

      // Check cache first
      if (isCurrentWeek && this.currentWeekCache.bulkProjections.has(cacheKey)) {
        return this.currentWeekCache.bulkProjections.get(cacheKey)!;
      }

      try {
        await this.rateLimit();

        // Fetch bulk projections using the same endpoint pattern as Sleeper
        // Include all flex-eligible positions
        const positions = ['QB', 'RB', 'WR', 'TE', 'FLEX'];
        const positionParams = positions.map(p => `position[]=${p}`).join('&');

        // Determine scoring type from league settings
        const scoringSettings = leagueInfo.data.scoring_settings;
        let orderBy = 'ppr'; // Default to PPR like Sleeper
        if (scoringSettings.rec === 0.5) {
          orderBy = 'half_ppr';
        } else if (scoringSettings.rec === 0) {
          orderBy = 'std';
        }

        const projResponse = await axios.get(
          `${SLEEPER_PROJECTIONS_BASE}/${season}/${currentWeek}?season_type=regular&${positionParams}&order_by=${orderBy}`,
        );

        if (projResponse.data) {
          // Cache for current week only
          if (isCurrentWeek) {
            this.currentWeekCache.bulkProjections.set(cacheKey, projResponse.data);
            this.currentWeekCache.timestamp = Date.now();
          }
          return projResponse.data;
        }
      } catch (e) {
        // Projections not available
      }

      return [];
    };

    // Get all projections in bulk
    const allProjections = await fetchBulkProjections();
    const projectionMap = new Map();

    // Build projection map
    for (const proj of allProjections) {
      if (proj.player_id && proj.stats) {
        const stats = proj.stats;
        const scoringSettings = leagueInfo.data.scoring_settings;

        // Calculate fantasy points based on league's specific scoring settings
        let points = 0;

        // Common scoring categories - calculate from raw stats
        if (stats.pass_yd && scoringSettings.pass_yd) points += (stats.pass_yd * scoringSettings.pass_yd);
        if (stats.pass_td && scoringSettings.pass_td) points += (stats.pass_td * scoringSettings.pass_td);
        if (stats.pass_int && scoringSettings.pass_int) points += (stats.pass_int * scoringSettings.pass_int);
        if (stats.pass_2pt && scoringSettings.pass_2pt) points += (stats.pass_2pt * scoringSettings.pass_2pt);

        if (stats.rush_yd && scoringSettings.rush_yd) points += (stats.rush_yd * scoringSettings.rush_yd);
        if (stats.rush_td && scoringSettings.rush_td) points += (stats.rush_td * scoringSettings.rush_td);
        if (stats.rush_2pt && scoringSettings.rush_2pt) points += (stats.rush_2pt * scoringSettings.rush_2pt);

        if (stats.rec && scoringSettings.rec) points += (stats.rec * scoringSettings.rec);
        if (stats.rec_yd && scoringSettings.rec_yd) points += (stats.rec_yd * scoringSettings.rec_yd);
        if (stats.rec_td && scoringSettings.rec_td) points += (stats.rec_td * scoringSettings.rec_td);
        if (stats.rec_2pt && scoringSettings.rec_2pt) points += (stats.rec_2pt * scoringSettings.rec_2pt);

        if (stats.fum_lost && scoringSettings.fum_lost) points += (stats.fum_lost * scoringSettings.fum_lost);
        if (stats.fum && scoringSettings.fum) points += (stats.fum * scoringSettings.fum);
        if (stats.fum_rec && scoringSettings.fum_rec) points += (stats.fum_rec * scoringSettings.fum_rec);
        if (stats.fum_rec_td && scoringSettings.fum_rec_td) points += (stats.fum_rec_td * scoringSettings.fum_rec_td);

        // If no custom calculation, use pre-calculated values
        if (points === 0) {
          // Check for PPR, Half-PPR, or Standard scoring
          if (scoringSettings.rec === 1) {
            points = stats.pts_ppr || 0;
          } else if (scoringSettings.rec === 0.5) {
            points = stats.pts_half_ppr || 0;
          } else {
            points = stats.pts_std || 0;
          }
        }

        projectionMap.set(proj.player_id, points);

        // Also cache individual projections for current week
        if (isCurrentWeek) {
          this.currentWeekCache.projections.set(proj.player_id, points);
        }
      }
    }

    // Helper to get projection for a player
    const getPlayerProjection = (playerId: string) => {
      return projectionMap.get(playerId) || 0;
    };

    const analyzeStarters = (starters: string[]) => {
      return starters.map((playerId) => {
        const player = this.playersCache.get(playerId);
        if (!player)
          return { player_id: playerId, name: "Unknown", projected: 0 };

        const projected = getPlayerProjection(playerId);

        return {
          name: `${player.first_name} ${player.last_name}`,
          position: player.position,
          team: player.team,
          projected: projected,
          injury_status: player.injury_status,
        };
      });
    };

    const myStarters = analyzeStarters(myMatchup.starters);
    const opponentStarters = opponentMatchup
      ? analyzeStarters(opponentMatchup.starters)
      : [];

    const myProjected = myStarters.reduce(
      (sum, p) => sum + (typeof p.projected === 'number' ? p.projected : parseFloat(p.projected)),
      0,
    );
    const oppProjected = opponentStarters.reduce(
      (sum, p) => sum + (typeof p.projected === 'number' ? p.projected : parseFloat(p.projected)),
      0,
    );

    const injuryConcerns = [...myStarters, ...opponentStarters]
      .filter((p) => p.injury_status)
      .map((p) => `${p.name}: ${p.injury_status}`);

    const preview = {
      week,
      my_team: {
        name: myUser?.display_name || myUser?.username,
        roster_id: rosterId,
        record: `${myRoster?.settings.wins}-${myRoster?.settings.losses}`,
        projected_points: myProjected,
        starters: myStarters,
      },
      opponent: opponentUser
        ? {
            name: opponentUser.display_name || opponentUser.username,
            roster_id: opponentRoster?.roster_id,
            record: `${opponentRoster?.settings.wins}-${opponentRoster?.settings.losses}`,
            projected_points: oppProjected,
            starters: opponentStarters,
          }
        : null,
      win_probability:
        ((myProjected / (myProjected + oppProjected)) * 100).toFixed(1) + "%",
      injury_concerns: injuryConcerns,
      recommendation:
        myProjected > oppProjected ? "Favored to win" : "Underdog",
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(preview, null, 2),
        },
      ],
    };
  }

  private async getFreeAgents(leagueId: string, position?: string) {
    await this.loadPlayersCache();

    const rosters = await axios.get<SleeperRoster[]>(
      `${SLEEPER_API_BASE}/league/${leagueId}/rosters`,
    );
    const allRosteredPlayers = new Set(
      rosters.data.flatMap((r) => r.players || []),
    );

    const freeAgents = [];
    for (const [playerId, player] of this.playersCache) {
      if (!allRosteredPlayers.has(playerId) && player.status === "Active") {
        if (!position || player.position === position) {
          freeAgents.push({
            player_id: playerId,
            name: `${player.first_name} ${player.last_name}`,
            position: player.position,
            team: player.team,
            injury_status: player.injury_status,
          });
        }
      }
    }

    freeAgents.sort((a, b) => a.name.localeCompare(b.name));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total: freeAgents.length,
              position_filter: position || "all",
              free_agents: freeAgents.slice(0, 100),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async analyzeLineup(
    leagueId: string,
    rosterId: number,
    week: number,
  ) {
    await this.loadPlayersCache();

    const [league, rosters] = await Promise.all([
      axios.get<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
      axios.get<SleeperRoster[]>(
        `${SLEEPER_API_BASE}/league/${leagueId}/rosters`,
      ),
    ]);

    const roster = rosters.data.find((r) => r.roster_id === rosterId);
    if (!roster) throw new Error("Roster not found");

    const rosterPositions = league.data.roster_positions || [];
    const starters = roster.starters || [];
    const bench = roster.players.filter((p) => !starters.includes(p));

    const getPlayerScore = (playerId: string): number => {
      const player = this.playersCache.get(playerId);
      if (!player) return 0;

      let score = 8;
      if (player.position === "QB") score = 18;
      if (player.position === "RB") score = 13;
      if (player.position === "WR") score = 11;
      if (player.position === "TE") score = 9;
      if (player.position === "K") score = 8;
      if (player.position === "DEF") score = 8;
      if (player.injury_status) score *= 0.5;

      return score;
    };

    const lineupAnalysis = starters.map((playerId, idx) => {
      const player = this.playersCache.get(playerId);
      const position = rosterPositions[idx];
      const score = getPlayerScore(playerId);

      const betterOptions = bench
        .filter((benchId) => {
          const benchPlayer = this.playersCache.get(benchId);
          return (
            benchPlayer?.position === player?.position &&
            getPlayerScore(benchId) > score
          );
        })
        .map((benchId) => {
          const benchPlayer = this.playersCache.get(benchId);
          return `${benchPlayer?.first_name} ${benchPlayer?.last_name}`;
        });

      return {
        slot: position,
        current: player ? `${player.first_name} ${player.last_name}` : "Empty",
        position: player?.position,
        projected: score,
        injury_status: player?.injury_status,
        better_options: betterOptions,
      };
    });

    const totalProjected = lineupAnalysis.reduce(
      (sum, p) => sum + p.projected,
      0,
    );
    const suggestions = lineupAnalysis
      .filter((p) => p.better_options.length > 0)
      .map(
        (p) =>
          `Consider starting ${p.better_options[0]} over ${p.current} at ${p.slot}`,
      );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              week,
              roster_id: rosterId,
              total_projected: totalProjected,
              lineup: lineupAnalysis,
              optimization_suggestions: suggestions,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getPlayerProjections(
    season: string,
    week: number,
    position?: string,
  ) {
    const projections = await axios.get(
      `${SLEEPER_API_BASE}/projections/nfl/${season}/${week}?season_type=regular&position=${position || ""}`,
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(projections.data, null, 2),
        },
      ],
    };
  }

  // Draft methods
  private async getUserDrafts(userId: string, sport: string, season: string) {
    const response = await axios.get<SleeperDraft[]>(
      `${SLEEPER_API_BASE}/user/${userId}/drafts/${sport}/${season}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getLeagueDrafts(leagueId: string) {
    const response = await axios.get<SleeperDraft[]>(
      `${SLEEPER_API_BASE}/league/${leagueId}/drafts`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getDraftInfo(draftId: string) {
    const response = await axios.get<SleeperDraft>(
      `${SLEEPER_API_BASE}/draft/${draftId}`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getDraftPicks(draftId: string) {
    const response = await axios.get<SleeperDraftPick[]>(
      `${SLEEPER_API_BASE}/draft/${draftId}/picks`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getDraftTradedPicks(draftId: string) {
    const response = await axios.get<SleeperTradedPick[]>(
      `${SLEEPER_API_BASE}/draft/${draftId}/traded_picks`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  // Bracket methods
  private async getWinnersBracket(leagueId: string) {
    const response = await axios.get<SleeperBracketMatchup[]>(
      `${SLEEPER_API_BASE}/league/${leagueId}/winners_bracket`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  private async getLosersBracket(leagueId: string) {
    const response = await axios.get<SleeperBracketMatchup[]>(
      `${SLEEPER_API_BASE}/league/${leagueId}/losers_bracket`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  // Traded picks
  private async getLeagueTradedPicks(leagueId: string) {
    const response = await axios.get<SleeperTradedPick[]>(
      `${SLEEPER_API_BASE}/league/${leagueId}/traded_picks`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  // Helper to get current season from NFL state
  private async getCurrentSeason(): Promise<string> {
    if (this.currentSeason) {
      return this.currentSeason;
    }

    const response = await axios.get<NFLState>(
      `${SLEEPER_API_BASE}/state/nfl`,
    );
    this.currentSeason = response.data.season;
    return this.currentSeason;
  }

  // NFL State
  private async getNFLState() {
    const response = await axios.get<NFLState>(
      `${SLEEPER_API_BASE}/state/nfl`,
    );
    // Cache the season and week
    this.currentSeason = response.data.season;
    this.currentWeek = response.data.week;

    // Clear old cache if week changed
    this.clearOldCache();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  // Advanced analytics
  private async getMatchupScores(leagueId: string, week: number) {
    await this.loadPlayersCache();

    const [matchups, rosters, users, nflState] = await Promise.all([
      axios.get<SleeperMatchup[]>(
        `${SLEEPER_API_BASE}/league/${leagueId}/matchups/${week}`,
      ),
      axios.get<SleeperRoster[]>(
        `${SLEEPER_API_BASE}/league/${leagueId}/rosters`,
      ),
      axios.get<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
      axios.get<NFLState>(`${SLEEPER_API_BASE}/state/nfl`),
    ]);

    // Create user mapping
    const rosterToUser: Record<number, string> = {};
    rosters.data.forEach((roster) => {
      const user = users.data.find((u) => u.user_id === roster.owner_id);
      if (user) {
        rosterToUser[roster.roster_id] = user.display_name || user.username;
      }
    });

    // Group matchups
    const matchupGroups: Record<number, SleeperMatchup[]> = {};
    matchups.data.forEach((m) => {
      if (!matchupGroups[m.matchup_id]) {
        matchupGroups[m.matchup_id] = [];
      }
      matchupGroups[m.matchup_id].push(m);
    });

    const formattedMatchups = Object.values(matchupGroups).map((teams) => {
      const [team1, team2] = teams;
      return {
        matchup_id: team1.matchup_id,
        team1: {
          name: rosterToUser[team1.roster_id],
          roster_id: team1.roster_id,
          points: team1.points,
          starters: team1.starters.map((pid) => {
            const player = this.playersCache.get(pid);
            return player ? `${player.first_name} ${player.last_name}` : pid;
          }),
        },
        team2: team2 ? {
          name: rosterToUser[team2.roster_id],
          roster_id: team2.roster_id,
          points: team2.points,
          starters: team2.starters.map((pid) => {
            const player = this.playersCache.get(pid);
            return player ? `${player.first_name} ${player.last_name}` : pid;
          }),
        } : null,
        status: nflState.data.week === week ? "LIVE" : week < nflState.data.week ? "FINAL" : "UPCOMING",
      };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              week,
              current_nfl_week: nflState.data.week,
              matchups: formattedMatchups,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async analyzeTradeTargets(leagueId: string, rosterId: number) {
    await this.loadPlayersCache();

    const [rosters, matchups] = await Promise.all([
      axios.get<SleeperRoster[]>(
        `${SLEEPER_API_BASE}/league/${leagueId}/rosters`,
      ),
      axios.get<SleeperMatchup[]>(
        `${SLEEPER_API_BASE}/league/${leagueId}/matchups/1`,
      ),
    ]);

    const myRoster = rosters.data.find((r) => r.roster_id === rosterId);
    if (!myRoster) throw new Error("Roster not found");

    // Analyze position needs
    const positionCounts: Record<string, number> = {};
    myRoster.players.forEach((playerId) => {
      const player = this.playersCache.get(playerId);
      if (player) {
        positionCounts[player.position] = (positionCounts[player.position] || 0) + 1;
      }
    });

    const needs: string[] = [];
    if ((positionCounts["RB"] || 0) < 4) needs.push("RB");
    if ((positionCounts["WR"] || 0) < 4) needs.push("WR");
    if ((positionCounts["QB"] || 0) < 2) needs.push("QB");
    if ((positionCounts["TE"] || 0) < 2) needs.push("TE");

    // Find trade targets from other rosters
    const targets: any[] = [];
    rosters.data.forEach((roster) => {
      if (roster.roster_id === rosterId) return;

      const rosterPositions: Record<string, string[]> = {};
      roster.players.forEach((playerId) => {
        const player = this.playersCache.get(playerId);
        if (player && needs.includes(player.position)) {
          if (!rosterPositions[player.position]) {
            rosterPositions[player.position] = [];
          }
          rosterPositions[player.position].push(
            `${player.first_name} ${player.last_name}`,
          );
        }
      });

      if (Object.keys(rosterPositions).length > 0) {
        targets.push({
          roster_id: roster.roster_id,
          record: `${roster.settings.wins}-${roster.settings.losses}`,
          potential_targets: rosterPositions,
        });
      }
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              your_roster_id: rosterId,
              position_needs: needs,
              current_roster: positionCounts,
              trade_targets: targets,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async getPlayerStats(playerId: string, season: string, week?: number) {
    const endpoint = week
      ? `${SLEEPER_API_BASE}/stats/nfl/player/${playerId}?season_type=regular&season=${season}&grouping=week`
      : `${SLEEPER_API_BASE}/stats/nfl/player/${playerId}?season_type=regular&season=${season}`;

    const response = await axios.get(endpoint);

    // If week specified, return just that week's stats
    if (week && response.data) {
      const weekStats = response.data[week.toString()];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(weekStats || { message: "No stats for this week" }, null, 2),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response.data, null, 2),
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Sleeper MCP server running on stdio");
  }
}

const server = new SleeperMCPServer();
server.run().catch(console.error);
