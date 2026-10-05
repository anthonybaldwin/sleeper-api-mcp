import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };

const SLEEPER_API_BASE = "https://api.sleeper.app/v1";
// Unofficial endpoints used by the Sleeper web app (undocumented; may change)
const SLEEPER_PROJECTIONS_BASE = "https://api.sleeper.com/projections/nfl";
const SLEEPER_STATS_BASE = "https://api.sleeper.com/stats/nfl";
const SLEEPER_AVATAR_BASE = "https://sleepercdn.com/avatars";
const SLEEPER_AVATAR_THUMB_BASE = "https://sleepercdn.com/avatars/thumbs";

// MCP has a 1MB limit on response size
const MAX_RESPONSE_SIZE = 1048576;

function safeStringify(data: any, replacer?: any, indent: number | string = 2): string {
  let result = JSON.stringify(data, replacer, indent);

  // Check if response is too large
  if (result.length > MAX_RESPONSE_SIZE) {
    // Try without indentation
    result = JSON.stringify(data, replacer);

    if (result.length > MAX_RESPONSE_SIZE) {
      // If still too large, truncate or summarize
      if (Array.isArray(data)) {
        // For arrays, limit the number of items
        const itemsToShow = Math.floor(data.length * (MAX_RESPONSE_SIZE / result.length));
        result = JSON.stringify({
          message: `Response too large. Showing ${itemsToShow} of ${data.length} items`,
          data: data.slice(0, itemsToShow),
          total_items: data.length
        }, replacer, indent);
      } else if (typeof data === 'object' && data !== null) {
        // For objects, try to summarize
        const keys = Object.keys(data);
        result = JSON.stringify({
          message: `Response too large. Object has ${keys.length} keys`,
          keys: keys.slice(0, 100),
          sample: JSON.parse(JSON.stringify(data, replacer, 0).substring(0, 50000))
        }, replacer, indent);
      }
    }
  }

  return result;
}

// Positions requested from the bulk projections endpoint
const PROJECTION_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

function scoringOrderBy(scoringSettings: Record<string, number> = {}): string {
  if (scoringSettings.rec === 0.5) return "half_ppr";
  if (scoringSettings.rec === 0) return "std";
  return "ppr";
}

// Sleeper stat keys match scoring_settings keys, so points = sum(stat * weight).
// Falls back to Sleeper's precomputed totals when no league settings match.
function scoreStats(stats: Record<string, number>, scoringSettings: Record<string, number> = {}): number {
  let points = 0;
  for (const [key, weight] of Object.entries(scoringSettings)) {
    const value = stats[key];
    if (typeof value === "number" && typeof weight === "number") {
      points += value * weight;
    }
  }
  if (points !== 0) return Math.round(points * 100) / 100;

  const fallback = scoringOrderBy(scoringSettings);
  return stats[fallback === "half_ppr" ? "pts_half_ppr" : fallback === "std" ? "pts_std" : "pts_ppr"] || 0;
}

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: safeStringify(data, null, 2) }] };
}

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
  players_points?: Record<string, number>;
  custom_points?: number | null; // Set when a commissioner manually overrides the score
}

function matchupPoints(m: SleeperMatchup): number {
  return m.custom_points ?? m.points ?? 0;
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
  t1: number | null; // team 1 roster_id
  t2: number | null; // team 2 roster_id
  w?: number | null; // winner roster_id
  l?: number | null; // loser roster_id
  t1_from?: { w?: number; l?: number } | null; // t1 comes from winner/loser of matchup m
  t2_from?: { w?: number; l?: number } | null;
  p?: number; // placement decided by this matchup (1 = championship, 3 = 3rd place, ...)
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
  private playersCache: Map<string, SleeperPlayer> = new Map();
  private projectionsCache: Map<string, PlayerProjection> = new Map();
  private users: UserConfig[] = [];
  private currentSeason?: string; // Cached from NFL state
  private currentWeek?: number; // Cached current week
  private playersCacheLoadedAt = 0;
  private nextRequestTime = 0;
  private requestDelay = 100; // 100ms between request starts for rate limiting

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
  // Sleeper asks that /players/nfl (~5MB) be fetched at most once per day
  private readonly PLAYERS_CACHE_DURATION = 24 * 60 * 60 * 1000;

  constructor() {
    // Parse all users and leagues from environment variables
    this.parseEnvironmentConfig();

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
                const leagueInfo = await this.getJson<SleeperLeague>(`${SLEEPER_API_BASE}/league/${league.leagueId}`);
                league.leagueName = leagueInfo.name;
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
              const leagueInfo = await this.getJson<SleeperLeague>(`${SLEEPER_API_BASE}/league/${league.leagueId}`);
              league.leagueName = leagueInfo.name;
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
          const userInfo = await this.getJson<SleeperUser>(`${SLEEPER_API_BASE}/user/${user.username}`);
          user.userId = userInfo.user_id;
        }

        const rosters = await this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/rosters`);

        // First try to find by owner_id
        let roster = rosters.find(r => r.owner_id === user.userId);

        // If not found, try to match by fetching league users
        if (!roster && rosters.length > 0) {
          const leagueUsers = await this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/users`);

          // League users have display_name, not username
          const leagueUser = leagueUsers.find(u =>
            u.display_name === user.username ||
            u.user_id === user.userId
          );

          if (leagueUser) {
            roster = rosters.find(r => r.owner_id === leagueUser.user_id);
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
          const userInfo = await this.getJson<SleeperUser>(`${SLEEPER_API_BASE}/user/${user.username}`);
          user.userId = userInfo.user_id;
        } catch (e) {
          console.error(`Error fetching user ID for ${user.username}:`, e);
        }
      }
    }
  }

  // Space out request start times. Sleeper asks clients to stay under 1000 calls/minute.
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextRequestTime);
    this.nextRequestTime = slot + this.requestDelay;
    if (slot > now) {
      await new Promise(resolve => setTimeout(resolve, slot - now));
    }
  }

  private async getJson<T = any>(url: string): Promise<T> {
    await this.rateLimit();
    const response = await fetch(url, {
      headers: { "User-Agent": `sleeper-api-mcp/${pkg.version}` },
    });
    if (!response.ok) {
      throw new Error(`Sleeper API request failed (${response.status} ${response.statusText}): ${url}`);
    }
    return await response.json() as T;
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

  // Builds an MCP server bound to this instance's shared config and caches
  createServer(): McpServer {
    const server = new McpServer({
      name: "sleeper-api-mcp",
      title: "Sleeper Fantasy Football",
      version: pkg.version,
    });
    this.registerTools(server);
    return server;
  }

  private registerTools(server: McpServer) {
    const tool = <S extends z.ZodRawShape>(
      name: string,
      title: string,
      description: string,
      inputSchema: S,
      handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
    ) => {
      server.registerTool(
        name,
        {
          title,
          description,
          inputSchema: z.object(inputSchema),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        (async (args: z.infer<z.ZodObject<S>>) => {
          try {
            return await handler(args);
          } catch (error: any) {
            return {
              isError: true,
              content: [{ type: "text", text: `Error: ${error.message}` }],
            };
          }
        }) as any,
      );
    };

    const leagueId = z.string().describe("Sleeper league ID");
    const draftId = z.string().describe("Draft ID");
    const week = z.number().int().min(0).max(25).describe("Week number (1-18 regular season, playoffs after)");
    const optionalWeek = week.optional().describe("Week number (optional, defaults to current week)");
    const season = z.string().optional().describe("Season year, e.g. 2025 (defaults to current season)");
    const sport = z.string().optional().describe("Sport (default: nfl)");
    const rosterId = z.number().int().describe("Roster ID");
    const leagueHint = z.string().optional().describe("League name, league ID, or username hint to identify which league (optional)");

    tool("get_user", "Get User", "Get Sleeper user information by username or user ID",
      { username: z.string().describe("Sleeper username or user ID") },
      (a) => this.getUser(a.username));

    tool("get_user_leagues", "Get User Leagues", "Get all leagues for a specific user",
      { user_id: z.string().describe("Sleeper user ID"), sport, season },
      async (a) => this.getUserLeagues(a.user_id, a.sport, a.season || await this.getCurrentSeason()));

    tool("get_league_info", "Get League Info", "Get league information by league ID",
      { league_id: leagueId },
      (a) => this.getLeague(a.league_id));

    tool("get_league_rosters", "Get League Rosters", "Get all rosters in a league",
      { league_id: leagueId },
      (a) => this.getLeagueRosters(a.league_id));

    tool("get_league_members", "Get League Members", "Get all users in a league",
      { league_id: leagueId },
      (a) => this.getLeagueUsers(a.league_id));

    tool("get_week_matchups", "Get Week Matchups", "Get raw matchups for a specific week in a league",
      { league_id: leagueId, week },
      (a) => this.getMatchups(a.league_id, a.week));

    tool("get_week_transactions", "Get Week Transactions", "Get transactions for a specific week (round) in a league",
      { league_id: leagueId, week },
      (a) => this.getTransactions(a.league_id, a.week));

    tool("get_trending_players", "Get Trending Players", "Get trending players being added/dropped",
      {
        sport,
        type: z.enum(["add", "drop"]).describe("Trend type: add or drop"),
        lookback_hours: z.number().int().positive().optional().describe("Hours to look back (default: 24)"),
        limit: z.number().int().positive().optional().describe("Number of results to return (default: 25)"),
      },
      (a) => this.getTrendingPlayers(a.sport, a.type, a.lookback_hours, a.limit));

    tool("get_player_details", "Get Player Details", "Get details for specific players by their IDs",
      { player_ids: z.array(z.string()).describe("Array of player IDs") },
      (a) => this.getPlayerDetails(a.player_ids));

    tool("get_current_week", "Get Current Week", "Get the current NFL state (week, season, season type, etc.)",
      {},
      () => this.getNFLState());

    tool("show_my_teams", "Show My Teams", "Get your configured users, leagues, and roster IDs",
      {},
      () => this.getMyInfo());

    tool("show_my_matchup", "Show My Matchup",
      "Get YOUR matchup for any week - past (shows actual scores) or future (shows projections)",
      { week: optionalWeek, league_hint: leagueHint },
      (a) => this.getMyMatchup(a.week, a.league_hint));

    tool("show_my_season_record", "Show My Season Record",
      "Get your full season matchup history with scores and W/L record",
      { league_hint: leagueHint },
      (a) => this.getMySeasonHistory(a.league_hint));

    tool("show_my_opponent", "Show My Opponent",
      "Get detailed info about your opponent for any week including avatar",
      { week: optionalWeek, league_hint: leagueHint },
      (a) => this.getMyOpponent(a.week, a.league_hint));

    tool("get_user_avatar", "Get User Avatar", "Get avatar URL for any user (full size or thumbnail)",
      {
        username: z.string().optional().describe("Username (optional if user_id provided)"),
        user_id: z.string().optional().describe("User ID (optional if username provided)"),
        thumbnail: z.boolean().optional().describe("Get thumbnail version (default: false)"),
      },
      (a) => this.getAvatarUrl(a.username, a.user_id, a.thumbnail));

    tool("analyze_trade", "Analyze Trade",
      "Evaluate trade fairness with comprehensive player values and positional impact analysis",
      {
        league_id: leagueId,
        roster_id_1: z.number().int().describe("First roster ID in trade"),
        roster_id_2: z.number().int().describe("Second roster ID in trade"),
        players_from_1: z.array(z.string()).describe("Player IDs going from roster 1 to roster 2"),
        players_from_2: z.array(z.string()).describe("Player IDs going from roster 2 to roster 1"),
      },
      (a) => this.analyzeTrade(a.league_id, a.roster_id_1, a.roster_id_2, a.players_from_1, a.players_from_2));

    tool("suggest_waiver_pickups", "Suggest Waiver Pickups", "Get waiver wire recommendations based on team needs",
      {
        league_id: leagueId,
        roster_id: rosterId.describe("Roster ID to get recommendations for"),
        position: z.string().optional().describe("Position to focus on (optional)"),
        limit: z.number().int().positive().optional().describe("Number of recommendations (default: 10)"),
      },
      (a) => this.getWaiverRecommendations(a.league_id, a.roster_id, a.position, a.limit));

    tool("preview_matchup", "Preview Matchup", "Preview upcoming matchup with projections and analysis",
      { league_id: leagueId, week, roster_id: rosterId.describe("Your roster ID") },
      (a) => this.previewMatchup(a.league_id, a.week, a.roster_id));

    tool("get_free_agents", "Get Free Agents", "Get available free agents in a league",
      { league_id: leagueId, position: z.string().optional().describe("Filter by position (optional)") },
      (a) => this.getFreeAgents(a.league_id, a.position));

    tool("optimize_lineup", "Optimize Lineup", "Analyze and optimize lineup for a specific week using projections",
      { league_id: leagueId, roster_id: rosterId.describe("Roster ID to analyze"), week },
      (a) => this.analyzeLineup(a.league_id, a.roster_id, a.week));

    tool("get_weekly_projections", "Get Weekly Projections", "Get player projections for a specific week",
      { season, week, position: z.string().optional().describe("Position filter, e.g. QB (optional)") },
      async (a) => this.getPlayerProjections(a.season || await this.getCurrentSeason(), a.week, a.position));

    // Draft tools
    tool("get_user_drafts", "Get User Drafts", "Get all drafts for a user for a specific sport and season",
      { user_id: z.string().describe("User ID"), sport, season },
      async (a) => this.getUserDrafts(a.user_id, a.sport || "nfl", a.season || await this.getCurrentSeason()));

    tool("get_league_drafts", "Get League Drafts", "Get all drafts for a league",
      { league_id: leagueId },
      (a) => this.getLeagueDrafts(a.league_id));

    tool("get_draft_info", "Get Draft Info", "Get information about a specific draft",
      { draft_id: draftId },
      (a) => this.getDraftInfo(a.draft_id));

    tool("get_draft_picks", "Get Draft Picks", "Get all picks in a draft",
      { draft_id: draftId },
      (a) => this.getDraftPicks(a.draft_id));

    tool("get_draft_traded_picks", "Get Draft Traded Picks", "Get all traded picks in a draft",
      { draft_id: draftId },
      (a) => this.getDraftTradedPicks(a.draft_id));

    // Bracket tools
    tool("get_winners_bracket", "Get Winners Bracket", "Get the playoff winners bracket for a league",
      { league_id: leagueId },
      (a) => this.getWinnersBracket(a.league_id));

    tool("get_losers_bracket", "Get Losers Bracket", "Get the playoff losers bracket for a league",
      { league_id: leagueId },
      (a) => this.getLosersBracket(a.league_id));

    // Traded picks
    tool("get_league_traded_picks", "Get League Traded Picks", "Get all traded picks in a league",
      { league_id: leagueId },
      (a) => this.getLeagueTradedPicks(a.league_id));

    // Advanced analytics
    tool("get_matchup_scores", "Get Matchup Scores", "Get real-time scoring information for matchups in a specific week",
      { league_id: leagueId, week },
      (a) => this.getMatchupScores(a.league_id, a.week));

    tool("analyze_trade_targets", "Analyze Trade Targets",
      "Identify optimal trade targets based on your roster's strengths and weaknesses",
      { league_id: leagueId, roster_id: rosterId.describe("Your roster ID") },
      (a) => this.analyzeTradeTargets(a.league_id, a.roster_id));

    tool("get_player_stats", "Get Player Stats", "Get detailed stats for a specific player",
      {
        player_id: z.string().describe("Player ID"),
        season,
        week: week.optional().describe("Week number (optional, omit for season totals)"),
      },
      async (a) => this.getPlayerStats(a.player_id, a.season || await this.getCurrentSeason(), a.week));
  }

  private async getUser(username: string) {
    const data = await this.getJson<SleeperUser | null>(`${SLEEPER_API_BASE}/user/${encodeURIComponent(username)}`);
    if (!data) throw new Error(`User not found: ${username}`);
    return textResult(data);
  }

  private async getUserLeagues(
    userId: string,
    sport: string = "nfl",
    season: string,
  ) {
    const data = await this.getJson<SleeperLeague[]>(`${SLEEPER_API_BASE}/user/${userId}/leagues/${sport}/${season}`);
    return textResult(data);
  }

  private async getLeague(leagueId: string) {
    const data = await this.getJson<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`);
    return textResult(data);
  }

  private async getLeagueRosters(leagueId: string) {
    const data = await this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${leagueId}/rosters`);
    return textResult(data);
  }

  private async getLeagueUsers(leagueId: string) {
    const data = await this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`);
    return textResult(data);
  }

  private async getMatchups(leagueId: string, week: number) {
    const data = await this.getJson<SleeperMatchup[]>(`${SLEEPER_API_BASE}/league/${leagueId}/matchups/${week}`);
    return textResult(data);
  }

  private async getTransactions(leagueId: string, week: number) {
    await this.loadPlayersCache();

    const [transactions, rosters, users] = await Promise.all([
      this.getJson<SleeperTransaction[]>(`${SLEEPER_API_BASE}/league/${leagueId}/transactions/${week}`),
      this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${leagueId}/rosters`),
      this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
    ]);

    // Create roster ID to team name mapping
    const rosterToTeam = new Map<number, string>();
    rosters.forEach(roster => {
      const user = users.find(u => u.user_id === roster.owner_id);
      if (user) {
        rosterToTeam.set(roster.roster_id, user.display_name || user.username || `Team ${roster.roster_id}`);
      }
    });

    // Format transactions with player and team names
    const formattedTransactions = transactions.map(transaction => {
      const adds: Record<string, string> = {};
      const drops: Record<string, string> = {};

      if (transaction.adds) {
        Object.entries(transaction.adds).forEach(([playerId, rosterId]) => {
          const player = this.playersCache.get(playerId);
          const teamName = rosterToTeam.get(rosterId) || `Roster ${rosterId}`;
          const playerName = player
            ? `${player.first_name} ${player.last_name} (${player.position} - ${player.team || 'FA'})`
            : `Player ${playerId}`;
          adds[playerName] = teamName;
        });
      }

      if (transaction.drops) {
        Object.entries(transaction.drops).forEach(([playerId, rosterId]) => {
          const player = this.playersCache.get(playerId);
          const teamName = rosterToTeam.get(rosterId) || `Roster ${rosterId}`;
          const playerName = player
            ? `${player.first_name} ${player.last_name} (${player.position} - ${player.team || 'FA'})`
            : `Player ${playerId}`;
          drops[playerName] = teamName;
        });
      }

      const involvedTeams = transaction.roster_ids.map(id =>
        rosterToTeam.get(id) || `Roster ${id}`
      );

      // Generate news queries for significant transactions
      const newsQueries: any[] = [];
      if (transaction.adds) {
        Object.keys(transaction.adds).forEach((playerId) => {
          const player = this.playersCache.get(playerId);
          if (player) {
            const playerName = `${player.first_name} ${player.last_name}`;
            newsQueries.push({
              player: playerName,
              action: "added",
              query: `${playerName} NFL fantasy waiver wire pickup ${new Date().getFullYear()}`
            });
          }
        });
      }
      if (transaction.drops) {
        Object.keys(transaction.drops).forEach((playerId) => {
          const player = this.playersCache.get(playerId);
          if (player) {
            const playerName = `${player.first_name} ${player.last_name}`;
            newsQueries.push({
              player: playerName,
              action: "dropped",
              query: `${playerName} NFL injury news fantasy drop ${new Date().getFullYear()}`
            });
          }
        });
      }

      return {
        type: transaction.type,
        status: transaction.status,
        teams_involved: involvedTeams,
        adds: Object.keys(adds).length > 0 ? adds : undefined,
        drops: Object.keys(drops).length > 0 ? drops : undefined,
        waiver_budget: transaction.waiver_budget,
        created: new Date(transaction.created).toLocaleString(),
        news_queries: newsQueries.length > 0 ? newsQueries : undefined
      };
    });

    // Identify high-impact transactions
    const significantTransactions = formattedTransactions.filter(t =>
      (t.adds && Object.keys(t.adds).length > 2) ||
      (t.waiver_budget && t.waiver_budget[0] > 10)
    );

    return textResult({
            week,
            total_transactions: formattedTransactions.length,
            transactions: formattedTransactions,
            requires_news_context: significantTransactions.length > 0,
            news_instruction: significantTransactions.length > 0
              ? "Use Perplexity to search the news_queries for recent player transactions to understand roster moves"
              : undefined
          });
  }

  private async getTrendingPlayers(
    sport: string = "nfl",
    type: string,
    lookbackHours: number | undefined = 24,
    limit: number | undefined = 25,
  ) {
    await this.loadPlayersCache();

    const lookback = lookbackHours || 24;
    const itemLimit = limit || 25;
    const data = await this.getJson(`${SLEEPER_API_BASE}/players/${sport}/trending/${type}?lookback_hours=${lookback}&limit=${itemLimit}`);

    // Format trending players with names
    const formattedTrending = data.map((item: any) => {
      const player = this.playersCache.get(item.player_id);
      return {
        player: player
          ? `${player.first_name} ${player.last_name} (${player.position} - ${player.team || 'FA'})`
          : `Player ${item.player_id}`,
        count: item.count,
        player_id: item.player_id,
        injury_status: player?.injury_status,
        years_exp: player?.years_exp,
        age: player?.age,
      };
    });

    return textResult({
            type: type === 'add' ? 'Most Added' : 'Most Dropped',
            lookback_hours: lookbackHours,
            total: formattedTrending.length,
            players: formattedTrending
          });
  }

  private async loadPlayersCache() {
    if (this.playersCache.size === 0 ||
        Date.now() - this.playersCacheLoadedAt > this.PLAYERS_CACHE_DURATION) {
      try {
        const data = await this.getJson<Record<string, SleeperPlayer>>(`${SLEEPER_API_BASE}/players/nfl`);
        this.playersCache = new Map(Object.entries(data));
        this.playersCacheLoadedAt = Date.now();
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

    return textResult(players);
  }

  private async getMyMatchup(week?: number, leagueHint?: string) {
    await this.loadPlayersCache();

    // Find the appropriate user and league
    const config = await this.findUserAndLeague(leagueHint);
    if (!config) {
      return textResult({
              error: "No league configuration found",
              message: "Please configure at least one user and league in your .env file",
              hint: "Set SLEEPER_USERNAME_A and SLEEPER_LEAGUE_A_ID_1 in .env"
            });
    }

    const { user, league, rosterId } = config;
    if (!rosterId) {
      return textResult({
              error: "Could not find roster for user in this league",
              user: user.username,
              league: league.leagueId
            });
    }

    // Get current week if not specified
    let actualWeek = week;
    let isHistorical = false;
    const nflState = await this.getJson<NFLState>(`${SLEEPER_API_BASE}/state/nfl`);
    this.currentSeason = nflState.season;

    if (!actualWeek) {
      actualWeek = nflState.week;
    } else if (actualWeek < nflState.week) {
      isHistorical = true;
    }

    // Get users for team names
    const users = await this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/users`);
    const rosters = await this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/rosters`);

    // Create roster ID to team name mapping
    const rosterToTeam = new Map<number, string>();
    rosters.forEach(roster => {
      const user = users.find(u => u.user_id === roster.owner_id);
      if (user) {
        rosterToTeam.set(roster.roster_id, user.display_name || user.username || `Team ${roster.roster_id}`);
      }
    });

    // For past weeks, get actual scores instead of projections
    if (isHistorical) {
      const matchups = await this.getJson<SleeperMatchup[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/matchups/${actualWeek}`);

      const myMatchup = matchups.find((m) => m.roster_id === parseInt(rosterId));
      const oppMatchup = matchups.find(
        (m) => m.matchup_id === myMatchup?.matchup_id && m.roster_id !== parseInt(rosterId),
      );

      // Format player names for starters
      const formatPlayers = (playerIds?: string[], points?: number[]) => {
        if (!playerIds) return [];
        return playerIds.map((id, idx) => {
          const player = this.playersCache.get(id);
          const playerName = player
            ? `${player.first_name} ${player.last_name} (${player.position} - ${player.team || 'FA'})`
            : `Player ${id}`;
          return points ? `${playerName}: ${points[idx]?.toFixed(2) || '0.00'} pts` : playerName;
        });
      };

      const opponentName = oppMatchup ? rosterToTeam.get(oppMatchup.roster_id) || `Roster ${oppMatchup.roster_id}` : 'BYE';

      return textResult({
              week: actualWeek,
              type: "historical",
              my_team: user.username,
              opponent: opponentName,
              my_score: myMatchup ? matchupPoints(myMatchup) : 0,
              opponent_score: oppMatchup ? matchupPoints(oppMatchup) : 0,
              result: myMatchup && oppMatchup ?
                (matchupPoints(myMatchup) > matchupPoints(oppMatchup) ? "WON" :
                 matchupPoints(myMatchup) < matchupPoints(oppMatchup) ? "LOST" : "TIED") : "N/A",
              my_starters: formatPlayers(myMatchup?.starters, myMatchup?.starters_points),
              opponent_starters: formatPlayers(oppMatchup?.starters, oppMatchup?.starters_points),
            });
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
      return textResult({
              error: "No league configuration found",
              message: "Please configure at least one user and league in your .env file",
              hint: "Set SLEEPER_USERNAME_A and SLEEPER_LEAGUE_A_ID_1 in .env"
            });
    }

    const { user, league, rosterId } = config;
    if (!rosterId) {
      return textResult({
              error: "Could not find roster for user in this league",
              user: user.username,
              league: league.leagueId
            });
    }

    await this.rateLimit();
    const [nflState, users, rosters] = await Promise.all([
      this.getJson<NFLState>(`${SLEEPER_API_BASE}/state/nfl`),
      this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/users`),
      this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/rosters`),
    ]);
    const currentWeek = nflState.week;

    // Create roster ID to team name mapping
    const rosterToTeam = new Map<number, string>();
    rosters.forEach(roster => {
      const user = users.find(u => u.user_id === roster.owner_id);
      if (user) {
        rosterToTeam.set(roster.roster_id, user.display_name || user.username || `Team ${roster.roster_id}`);
      }
    });

    const history = [];
    for (let week = 1; week < currentWeek; week++) {
      const matchups = await this.getJson<SleeperMatchup[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/matchups/${week}`);

      const myMatchup = matchups.find((m) => m.roster_id === parseInt(rosterId));
      const oppMatchup = matchups.find(
        (m) => m.matchup_id === myMatchup?.matchup_id && m.roster_id !== parseInt(rosterId),
      );

      if (myMatchup && oppMatchup) {
        const opponentName = rosterToTeam.get(oppMatchup.roster_id) || `Roster ${oppMatchup.roster_id}`;
        history.push({
          week,
          opponent: opponentName,
          my_score: matchupPoints(myMatchup),
          opponent_score: matchupPoints(oppMatchup),
          result: matchupPoints(myMatchup) > matchupPoints(oppMatchup) ? "W" :
                  matchupPoints(myMatchup) < matchupPoints(oppMatchup) ? "L" : "T",
          margin: Math.abs(matchupPoints(myMatchup) - matchupPoints(oppMatchup)),
        });
      }
    }

    const wins = history.filter(h => h.result === "W").length;
    const losses = history.filter(h => h.result === "L").length;
    const ties = history.filter(h => h.result === "T").length;

    return textResult({
            season_record: `${wins}-${losses}${ties > 0 ? `-${ties}` : ""}`,
            total_points_for: history.reduce((sum, h) => sum + h.my_score, 0),
            total_points_against: history.reduce((sum, h) => sum + h.opponent_score, 0),
            avg_points_for: history.length ? history.reduce((sum, h) => sum + h.my_score, 0) / history.length : 0,
            avg_points_against: history.length ? history.reduce((sum, h) => sum + h.opponent_score, 0) / history.length : 0,
            matchup_history: history,
          });
  }

  private async getMyOpponent(week?: number, leagueHint?: string) {
    // Find the appropriate user and league
    const config = await this.findUserAndLeague(leagueHint);
    if (!config) {
      return textResult({
              error: "No league configuration found",
              message: "Please configure at least one user and league in your .env file",
              hint: "Set SLEEPER_USERNAME_A and SLEEPER_LEAGUE_A_ID_1 in .env"
            });
    }

    const { user, league, rosterId } = config;
    if (!rosterId) {
      return textResult({
              error: "Could not find roster for user in this league",
              user: user.username,
              league: league.leagueId
            });
    }

    let actualWeek = week;
    if (!actualWeek) {
      const nflState = await this.getJson<NFLState>(`${SLEEPER_API_BASE}/state/nfl`);
      actualWeek = nflState.week;
    }

    // Use sequential requests with rate limiting instead of Promise.all
    const matchups = await this.getJson<SleeperMatchup[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/matchups/${actualWeek}`);
    const rosters = await this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/rosters`);
    const users = await this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${league.leagueId}/users`);

    const myMatchup = matchups.find((m) => m.roster_id === parseInt(rosterId));
    const oppMatchup = matchups.find(
      (m) => m.matchup_id === myMatchup?.matchup_id && m.roster_id !== parseInt(rosterId),
    );

    if (!oppMatchup) {
      return textResult({ message: "No opponent this week (bye week or playoffs)" });
    }

    const oppRoster = rosters.find((r) => r.roster_id === oppMatchup.roster_id);
    const oppUser = users.find((u) => u.user_id === oppRoster?.owner_id);

    return textResult({
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
              points_this_week: matchupPoints(oppMatchup),
              projected_points: "Use preview_matchup for projections",
            },
          });
  }

  private async getAvatarUrl(username?: string, userId?: string, thumbnail: boolean = false) {
    let avatarId: string | null = null;

    if (userId) {
      const userData = await this.getJson<SleeperUser>(`${SLEEPER_API_BASE}/user/${userId}`);
      avatarId = userData.avatar;
    } else if (username) {
      const userData = await this.getJson<SleeperUser>(`${SLEEPER_API_BASE}/user/${username}`);
      avatarId = userData.avatar;
    } else if (this.users.length > 0) {
      // Default to first configured user if no username provided
      const firstUser = this.users[0];
      if (!firstUser.userId) {
        const userData = await this.getJson<SleeperUser>(`${SLEEPER_API_BASE}/user/${firstUser.username}`);
        firstUser.userId = userData.user_id;
        avatarId = userData.avatar;
      } else {
        const userData = await this.getJson<SleeperUser>(`${SLEEPER_API_BASE}/user/${firstUser.userId}`);
        avatarId = userData.avatar;
      }
    }

    if (!avatarId) {
      return textResult({ error: "No avatar found for user" });
    }

    const baseUrl = thumbnail ? SLEEPER_AVATAR_THUMB_BASE : SLEEPER_AVATAR_BASE;
    return textResult({
            avatar_id: avatarId,
            avatar_url: `${baseUrl}/${avatarId}`,
            thumbnail: thumbnail,
          });
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
          const userData = await this.getJson<SleeperUser>(`${SLEEPER_API_BASE}/user/${user.username}`);
          user.userId = userData.user_id;
          userConfig.user_id = user.userId;
          userConfig.avatar = userData.avatar;
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
            const leagueData = await this.getJson<SleeperLeague>(`${SLEEPER_API_BASE}/league/${league.leagueId}`);
            league.leagueName = leagueData.name;
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

    return textResult(info);
  }

  private async analyzeTrade(
    leagueId: string,
    rosterId1: number,
    rosterId2: number,
    playersFrom1: string[],
    playersFrom2: string[],
  ) {
    await this.loadPlayersCache();

    const [league, rosters, users] = await Promise.all([
      this.getJson<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
      this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${leagueId}/rosters`),
      this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
    ]);

    const roster1 = rosters.find((r) => r.roster_id === rosterId1);
    const roster2 = rosters.find((r) => r.roster_id === rosterId2);

    if (!roster1 || !roster2) {
      throw new Error("Invalid roster IDs");
    }

    // Get team names
    const user1 = users.find(u => u.user_id === roster1.owner_id);
    const user2 = users.find(u => u.user_id === roster2.owner_id);
    const team1Name = user1?.display_name || user1?.username || `Team ${rosterId1}`;
    const team2Name = user2?.display_name || user2?.username || `Team ${rosterId2}`;

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
      riskFactors.push(`${team1Name} needs: ${positionalNeeds1.join(", ")}`);
    if (positionalNeeds2.length > 0)
      riskFactors.push(`${team2Name} needs: ${positionalNeeds2.join(", ")}`);

    let recommendation = "Fair trade";
    if (percentDiff > 30) {
      recommendation =
        team1Value > team2Value
          ? `${team1Name} wins significantly`
          : `${team2Name} wins significantly`;
    } else if (percentDiff > 15) {
      recommendation =
        team1Value > team2Value
          ? `${team1Name} has slight advantage`
          : `${team2Name} has slight advantage`;
    }

    const analysis = {
      team1: team1Name,
      team1_gives: playersFrom1.map((id) => {
        const p = this.playersCache.get(id);
        return p ? `${p.first_name} ${p.last_name} (${p.position} - ${p.team || 'FA'})` : id;
      }),
      team2: team2Name,
      team2_gives: playersFrom2.map((id) => {
        const p = this.playersCache.get(id);
        return p ? `${p.first_name} ${p.last_name} (${p.position} - ${p.team || 'FA'})` : id;
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

    return textResult(analysis);
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
      this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${leagueId}/rosters`),
      this.getJson(`${SLEEPER_API_BASE}/players/nfl/trending/add?lookback_hours=24&limit=50`),
      this.getJson<NFLState>(`${SLEEPER_API_BASE}/state/nfl`),
      this.getJson<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
    ]);

    const roster = rosters.find((r) => r.roster_id === rosterId);
    if (!roster) throw new Error("Roster not found");

    const allRosteredPlayers = new Set(
      rosters.flatMap((r) => r.players || []),
    );

    const currentWeek = nflState.week;
    const season = nflState.season;

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
    const rosterPositions = leagueInfo.roster_positions || [];
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
    const trendingPlayerIds = new Set(trending.map((t: any) => t.player_id));

    // First pass: collect available players and basic info (no API calls)
    const availablePlayers: any[] = [];
    for (const [playerId, player] of this.playersCache) {
      if (!allRosteredPlayers.has(playerId) && player.status === "Active") {
        if (!position || player.position === position) {
          const isTrending = trendingPlayerIds.has(playerId);
          const trendingCount = trending.find((t: any) => t.player_id === playerId)?.count || 0;

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

    // Second pass: score top candidates with one bulk projections call
    const projections = await this.getWeekProjections(season, currentWeek, leagueInfo.scoring_settings);
    for (const player of topCandidates) {
      const projection = projections.get(player.player_id) || 0;
      player.avg_projection = projection;
      player.overall_score = (projection * 2) + player.initial_score;
    }

    // Sort by overall score (combination of projections, trending, and need)
    topCandidates.sort((a, b) => b.overall_score - a.overall_score);

    const recommendations = topCandidates
      .slice(0, limit || 10)
      .map((player) => {
        const playerName = `${player.first_name} ${player.last_name}`;
        const trendingAdds = player.trending_add || 0;

        return {
          player: playerName,
          position: player.position,
          team: player.team,
          trending_adds: trendingAdds,
          current_week_projection: player.avg_projection,
          fills_need: rosterNeeds.includes(player.position),
          injury_status: player.injury_status || "Healthy",
          recommendation_score: player.overall_score,
          // Add news context for highly trending players
          news_queries: trendingAdds > 100 ? {
            primary: `${playerName} NFL ${new Date().getFullYear()} injury trade waiver wire news`,
            alternate: [
              `${playerName} fantasy football outlook week ${currentWeek}`,
              `${playerName} ${player.team || 'NFL'} depth chart injury report`,
              `Why is ${playerName} trending fantasy football waiver wire adds`
            ],
            context: `Player has ${trendingAdds} adds this week - check for breaking news, injuries, or trades`
          } : undefined
        };
      });

    const waiverBudget = roster.settings.waiver_budget_total
      ? roster.settings.waiver_budget_total -
        (roster.settings.waiver_budget_used || 0)
      : null;

    const highTrendingPlayers = recommendations.filter(p => p.trending_adds > 100);

    const result = {
      roster_needs: rosterNeeds,
      recommendations,
      waiver_position: roster.settings.waiver_position,
      waiver_budget_remaining: waiverBudget,
      total_moves_made: roster.settings.total_moves,
      analysis_note: "Recommendations based on: upcoming schedule projections, trending adds, and roster needs",
      requires_news_context: highTrendingPlayers.length > 0,
      news_instruction: highTrendingPlayers.length > 0
        ? `Use Perplexity to search news for: ${highTrendingPlayers.map(p => p.player).join(', ')}. Check their news_queries to understand why they're trending.`
        : undefined
    };

    return textResult(result);
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
        matchups = cachedMatchups;
        rosters = cachedRosters;
        // Still fetch users and league info as they don't change often
        [users, leagueInfo] = await Promise.all([
          this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
          this.getJson<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
        ]);
      } else {
        // Fetch and cache
        [matchups, rosters, users, leagueInfo] = await Promise.all([
          this.getJson<SleeperMatchup[]>(`${SLEEPER_API_BASE}/league/${leagueId}/matchups/${week}`),
          this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${leagueId}/rosters`),
          this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
          this.getJson<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
        ]);

        // Cache for current week
        this.currentWeekCache.matchups.set(leagueId, matchups);
        this.currentWeekCache.rosters.set(leagueId, rosters);
        this.currentWeekCache.timestamp = Date.now();
      }
    } else {
      // Don't cache data for other weeks
      [matchups, rosters, users, leagueInfo] = await Promise.all([
        this.getJson<SleeperMatchup[]>(`${SLEEPER_API_BASE}/league/${leagueId}/matchups/${week}`),
        this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${leagueId}/rosters`),
        this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
        this.getJson<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
      ]);
    }

    const myMatchup = matchups.find((m: SleeperMatchup) => m.roster_id === rosterId);
    if (!myMatchup) throw new Error("Matchup not found");

    const opponentMatchup = matchups.find(
      (m: SleeperMatchup) => m.matchup_id === myMatchup.matchup_id && m.roster_id !== rosterId,
    );

    const myRoster = rosters.find((r: SleeperRoster) => r.roster_id === rosterId);
    const opponentRoster = opponentMatchup
      ? rosters.find((r: SleeperRoster) => r.roster_id === opponentMatchup.roster_id)
      : null;

    const myUser = users.find((u) => u.user_id === myRoster?.owner_id);
    const opponentUser = opponentRoster
      ? users.find((u) => u.user_id === opponentRoster.owner_id)
      : null;

    const projectionMap = await this.getWeekProjections(
      leagueInfo.season,
      week,
      leagueInfo.scoring_settings,
      isCurrentWeek ? `${leagueId}` : undefined,
    );

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
        projected_points: Math.round(myProjected * 100) / 100,
        starters: myStarters,
      },
      opponent: opponentUser
        ? {
            name: opponentUser.display_name || opponentUser.username,
            roster_id: opponentRoster?.roster_id,
            record: `${opponentRoster?.settings.wins}-${opponentRoster?.settings.losses}`,
            projected_points: Math.round(oppProjected * 100) / 100,
            starters: opponentStarters,
          }
        : null,
      win_probability: myProjected + oppProjected > 0
        ? ((myProjected / (myProjected + oppProjected)) * 100).toFixed(1) + "%"
        : "N/A (no projections available)",
      injury_concerns: injuryConcerns,
      recommendation:
        myProjected > oppProjected ? "Favored to win" : "Underdog",
    };

    return textResult(preview);
  }

  // Fetch bulk weekly projections and score them with the league's scoring settings.
  // Returns playerId -> projected fantasy points.
  private async getWeekProjections(
    season: string,
    week: number,
    scoringSettings: Record<string, number> = {},
    cacheScope?: string,
  ): Promise<Map<string, number>> {
    const cacheKey = cacheScope ? `${season}-${week}-${cacheScope}` : undefined;
    let projData: any[] | undefined = cacheKey && this.isCacheValid()
      ? this.currentWeekCache.bulkProjections.get(cacheKey)
      : undefined;

    if (!projData) {
      try {
        const positionParams = PROJECTION_POSITIONS.map(p => `position[]=${p}`).join('&');
        projData = await this.getJson<any[]>(
          `${SLEEPER_PROJECTIONS_BASE}/${season}/${week}?season_type=regular&${positionParams}&order_by=${scoringOrderBy(scoringSettings)}`,
        );
        if (cacheKey && Array.isArray(projData)) {
          this.currentWeekCache.bulkProjections.set(cacheKey, projData);
          this.currentWeekCache.timestamp = Date.now();
        }
      } catch (e) {
        console.error('Error fetching projections:', e);
        projData = [];
      }
    }

    const projectionMap = new Map<string, number>();
    for (const proj of Array.isArray(projData) ? projData : []) {
      if (proj?.player_id && proj.stats) {
        projectionMap.set(proj.player_id, scoreStats(proj.stats, scoringSettings));
      }
    }
    return projectionMap;
  }

  private async getFreeAgents(leagueId: string, position?: string) {
    await this.loadPlayersCache();

    const [rosters, trending] = await Promise.all([
      this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${leagueId}/rosters`),
      this.getJson(`${SLEEPER_API_BASE}/players/nfl/trending/add`).catch(() => null),
    ]);

    const allRosteredPlayers = new Set(
      rosters.flatMap((r) => r.players || []),
    );

    // Get trending data
    const trendingAdds = new Map<string, number>();
    if (trending) {
      for (const trend of trending) {
        trendingAdds.set(trend.player_id, trend.count || 0);
      }
    }

    const freeAgents = [];
    for (const [playerId, player] of this.playersCache) {
      if (!allRosteredPlayers.has(playerId) && player.status === "Active") {
        if (!position || player.position === position) {
          const playerName = `${player.first_name} ${player.last_name}`;
          const trendingCount = trendingAdds.get(playerId) || 0;

          freeAgents.push({
            player_id: playerId,
            name: playerName,
            position: player.position,
            team: player.team,
            injury_status: player.injury_status,
            trending_adds: trendingCount,
            // Add news queries for highly trending players
            news_queries: trendingCount > 100 ? {
              primary: `${playerName} NFL ${new Date().getFullYear()} injury trade news`,
              alternate: [
                `${playerName} fantasy football waiver wire trending`,
                `Why is ${playerName} being added fantasy football`
              ],
              context: `Player has ${trendingCount} adds - check for recent news`
            } : undefined
          });
        }
      }
    }

    // Sort by trending adds first, then by name
    freeAgents.sort((a, b) => {
      if (b.trending_adds !== a.trending_adds) {
        return b.trending_adds - a.trending_adds;
      }
      return a.name.localeCompare(b.name);
    });

    const topFreeAgents = freeAgents.slice(0, 100);
    const highTrendingPlayers = topFreeAgents.filter(p => p.trending_adds > 100);

    return textResult({
              total: freeAgents.length,
              position_filter: position || "all",
              free_agents: topFreeAgents,
              requires_news_context: highTrendingPlayers.length > 0,
              news_instruction: highTrendingPlayers.length > 0
                ? `Use Perplexity to search news for trending players: ${highTrendingPlayers.slice(0, 5).map(p => p.name).join(', ')}`
                : undefined
            });
  }

  private async analyzeLineup(
    leagueId: string,
    rosterId: number,
    week: number,
  ) {
    await this.loadPlayersCache();

    const [league, rosters] = await Promise.all([
      this.getJson<SleeperLeague>(`${SLEEPER_API_BASE}/league/${leagueId}`),
      this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${leagueId}/rosters`),
    ]);

    const roster = rosters.find((r) => r.roster_id === rosterId);
    if (!roster) throw new Error("Roster not found");

    const rosterPositions = league.roster_positions || [];
    const starters = roster.starters || [];
    const bench = roster.players.filter((p) => !starters.includes(p));

    const projections = await this.getWeekProjections(league.season, week, league.scoring_settings);

    const getPlayerScore = (playerId: string): number => {
      const player = this.playersCache.get(playerId);
      if (!player) return 0;
      if (player.injury_status && ["Out", "IR", "PUP", "Sus", "NA"].includes(player.injury_status)) return 0;
      return projections.get(playerId) || 0;
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

    return textResult({
              week,
              roster_id: rosterId,
              total_projected: totalProjected,
              lineup: lineupAnalysis,
              optimization_suggestions: suggestions,
            });
  }

  private async getPlayerProjections(
    season: string,
    week: number,
    position?: string,
  ) {
    await this.loadPlayersCache();

    const positions = position ? [position.toUpperCase()] : PROJECTION_POSITIONS;
    const positionParams = positions.map(p => `position[]=${p}`).join('&');
    const projections = await this.getJson<any[]>(
      `${SLEEPER_PROJECTIONS_BASE}/${season}/${week}?season_type=regular&${positionParams}&order_by=ppr`,
    );

    const rows = (Array.isArray(projections) ? projections : [])
      .filter((p) => p?.player_id && p.stats)
      .map((p) => {
        const player = this.playersCache.get(p.player_id);
        return {
          player_id: p.player_id,
          name: player ? `${player.first_name} ${player.last_name}` : p.player?.first_name ? `${p.player.first_name} ${p.player.last_name}` : undefined,
          position: player?.position ?? p.player?.position,
          team: p.team ?? player?.team,
          opponent: p.opponent,
          pts_ppr: p.stats.pts_ppr ?? 0,
          pts_half_ppr: p.stats.pts_half_ppr ?? 0,
          pts_std: p.stats.pts_std ?? 0,
          stats: p.stats,
        };
      })
      .sort((a, b) => b.pts_ppr - a.pts_ppr);

    return textResult({
      season,
      week,
      position_filter: position || "all",
      total: rows.length,
      projections: rows.slice(0, 150),
    });
  }


  // Draft methods
  private async getUserDrafts(userId: string, sport: string, season: string) {
    const data = await this.getJson<SleeperDraft[]>(`${SLEEPER_API_BASE}/user/${userId}/drafts/${sport}/${season}`);
    return textResult(data);
  }

  private async getLeagueDrafts(leagueId: string) {
    const data = await this.getJson<SleeperDraft[]>(`${SLEEPER_API_BASE}/league/${leagueId}/drafts`);
    return textResult(data);
  }

  private async getDraftInfo(draftId: string) {
    const data = await this.getJson<SleeperDraft>(`${SLEEPER_API_BASE}/draft/${draftId}`);
    return textResult(data);
  }

  private async getDraftPicks(draftId: string) {
    const data = await this.getJson<SleeperDraftPick[]>(`${SLEEPER_API_BASE}/draft/${draftId}/picks`);
    return textResult(data);
  }

  private async getDraftTradedPicks(draftId: string) {
    const data = await this.getJson<SleeperTradedPick[]>(`${SLEEPER_API_BASE}/draft/${draftId}/traded_picks`);
    return textResult(data);
  }

  // Bracket methods
  private async getWinnersBracket(leagueId: string) {
    const data = await this.getJson<SleeperBracketMatchup[]>(`${SLEEPER_API_BASE}/league/${leagueId}/winners_bracket`);
    return textResult(data);
  }

  private async getLosersBracket(leagueId: string) {
    const data = await this.getJson<SleeperBracketMatchup[]>(`${SLEEPER_API_BASE}/league/${leagueId}/losers_bracket`);
    return textResult(data);
  }

  // Traded picks
  private async getLeagueTradedPicks(leagueId: string) {
    const data = await this.getJson<SleeperTradedPick[]>(`${SLEEPER_API_BASE}/league/${leagueId}/traded_picks`);
    return textResult(data);
  }

  // Helper to get current season from NFL state
  private async getCurrentSeason(): Promise<string> {
    if (this.currentSeason) {
      return this.currentSeason;
    }

    const data = await this.getJson<NFLState>(`${SLEEPER_API_BASE}/state/nfl`);
    this.currentSeason = data.season;
    return this.currentSeason;
  }

  // NFL State
  private async getNFLState() {
    const data = await this.getJson<NFLState>(`${SLEEPER_API_BASE}/state/nfl`);
    // Cache the season and week
    this.currentSeason = data.season;
    this.currentWeek = data.week;

    // Clear old cache if week changed
    this.clearOldCache();

    return textResult(data);
  }

  // Advanced analytics
  private async getMatchupScores(leagueId: string, week: number) {
    await this.loadPlayersCache();

    const [matchups, rosters, users, nflState] = await Promise.all([
      this.getJson<SleeperMatchup[]>(`${SLEEPER_API_BASE}/league/${leagueId}/matchups/${week}`),
      this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${leagueId}/rosters`),
      this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
      this.getJson<NFLState>(`${SLEEPER_API_BASE}/state/nfl`),
    ]);

    // Create user mapping
    const rosterToUser: Record<number, string> = {};
    rosters.forEach((roster) => {
      const user = users.find((u) => u.user_id === roster.owner_id);
      if (user) {
        rosterToUser[roster.roster_id] = user.display_name || user.username;
      }
    });

    // Group matchups
    const matchupGroups: Record<number, SleeperMatchup[]> = {};
    matchups.forEach((m) => {
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
          points: matchupPoints(team1),
          starters: team1.starters.map((pid) => {
            const player = this.playersCache.get(pid);
            return player ? `${player.first_name} ${player.last_name}` : pid;
          }),
        },
        team2: team2 ? {
          name: rosterToUser[team2.roster_id],
          roster_id: team2.roster_id,
          points: matchupPoints(team2),
          starters: team2.starters.map((pid) => {
            const player = this.playersCache.get(pid);
            return player ? `${player.first_name} ${player.last_name}` : pid;
          }),
        } : null,
        status: nflState.week === week ? "LIVE" : week < nflState.week ? "FINAL" : "UPCOMING",
      };
    });

    return textResult({
              week,
              current_nfl_week: nflState.week,
              matchups: formattedMatchups,
            });
  }

  private async analyzeTradeTargets(leagueId: string, rosterId: number) {
    await this.loadPlayersCache();

    const [rosters, users] = await Promise.all([
      this.getJson<SleeperRoster[]>(`${SLEEPER_API_BASE}/league/${leagueId}/rosters`),
      this.getJson<SleeperUser[]>(`${SLEEPER_API_BASE}/league/${leagueId}/users`),
    ]);

    const myRoster = rosters.find((r) => r.roster_id === rosterId);
    if (!myRoster) throw new Error("Roster not found");

    // Get my team name
    const myUser = users.find(u => u.user_id === myRoster.owner_id);
    const myTeamName = myUser?.display_name || myUser?.username || `Roster ${rosterId}`;

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
    rosters.forEach((roster) => {
      if (roster.roster_id === rosterId) return;

      // Get team name
      const user = users.find(u => u.user_id === roster.owner_id);
      const teamName = user?.display_name || user?.username || `Roster ${roster.roster_id}`;

      const rosterPositions: Record<string, string[]> = {};
      roster.players.forEach((playerId) => {
        const player = this.playersCache.get(playerId);
        if (player && needs.includes(player.position)) {
          if (!rosterPositions[player.position]) {
            rosterPositions[player.position] = [];
          }
          rosterPositions[player.position].push(
            `${player.first_name} ${player.last_name} (${player.team || 'FA'})`,
          );
        }
      });

      if (Object.keys(rosterPositions).length > 0) {
        targets.push({
          team: teamName,
          record: `${roster.settings.wins}-${roster.settings.losses}`,
          potential_targets: rosterPositions,
        });
      }
    });

    return textResult({
              your_team: myTeamName,
              position_needs: needs,
              current_roster: positionCounts,
              trade_targets: targets,
            });
  }

  private async getPlayerStats(playerId: string, season: string, week?: number) {
    const grouping = week ? "week" : "season";
    const data = await this.getJson<any>(
      `${SLEEPER_STATS_BASE}/player/${playerId}?season_type=regular&season=${season}&grouping=${grouping}`,
    );

    // grouping=week returns an object keyed by week number (null on bye weeks)
    if (week) {
      const weekStats = data?.[week.toString()];
      return textResult(weekStats || { message: `No stats for week ${week} (bye week or not yet played)` });
    }

    return textResult(data || { message: `No stats for season ${season}` });
  }


  run() {
    serveStdio(() => this.createServer(), {
      onerror: (error) => console.error("MCP transport error:", error),
    });
    console.error("Sleeper MCP server running on stdio");
  }
}

new SleeperMCPServer().run();
