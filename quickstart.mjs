// quickstart.mjs
// Login, fetch markets, stream real-time WebSocket updates
// Run: node quickstart.mjs --env=staging
import { Socket } from "phoenix";
import WebSocket from "ws";

const ENVS = {
  staging: {
    api: "https://api-staging.on.sportsxapp.com",
    ws:  "wss://api-staging.on.sportsxapp.com/socket",
  },
  prod: {
    api: "https://api.on.stxapp.ca",
    ws:  "wss://api.on.stxapp.ca/socket",
  },
};

// ── Parse --env flag ────────────────────────────────────────────────
const envArg = process.argv.find((a) => a.startsWith("--env="));
const env = envArg ? envArg.split("=")[1] : "staging";
if (!ENVS[env]) {
  console.error(`Unknown env "${env}". Use --env=staging or --env=prod`);
  process.exit(1);
}
const { api: API_URL, ws: WS_URL } = ENVS[env];

// ── Credentials per env ─────────────────────────────────────────────
const suffix = env.toUpperCase();
const EMAIL    = process.env[`STX_${suffix}_EMAIL`];
const PASSWORD = process.env[`STX_${suffix}_PASSWORD`];

if (!EMAIL || !PASSWORD) {
  console.error(`Set STX_${suffix}_EMAIL and STX_${suffix}_PASSWORD env vars`);
  process.exit(1);
}

// ── GraphQL helper ──────────────────────────────────────────────────
async function gql(query, variables = {}, token = null) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/api/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

// ── 1. Login ────────────────────────────────────────────────────────
async function login(email, password) {
  const data = await gql(`
    mutation Login($creds: LoginCredentials!) {
      login(credentials: $creds) {
        token
        refreshToken
        userId
        userStatus
      }
    }
  `, { creds: { email, password } });
  return data.login;
}

// ── 2. Fetch open markets ───────────────────────────────────────────
async function getMarkets(token, limit = 5) {
  const data = await gql(`
    query GetMarkets($input: MarketInfosInput) {
      marketInfos(input: $input) {
        marketId
        description
        eventBrief
        status
        bids(limit: 3) { price quantity }
        offers(limit: 3) { price quantity }
      }
    }
  `, { input: { status: ["OPEN"], limit } }, token);
  return data.marketInfos;
}

// ── 3. Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`Environment: ${env} (${API_URL})\n`);

  // Step 1: Login
  console.log("Logging in...");
  const auth = await login(EMAIL, PASSWORD);
  const { token, userId } = auth;
  console.log(`✓ Logged in as ${userId} (status: ${auth.userStatus})`);

  // Step 2: Fetch available markets
  console.log("\nFetching open markets...");
  const markets = await getMarkets(token);
  markets.forEach((m) => {
    const bestBid   = m.bids?.[0]?.price ?? "—";
    const bestOffer = m.offers?.[0]?.price ?? "—";
    console.log(`  ${m.marketId}  ${m.eventBrief} — ${m.description}  [bid: ${bestBid} / offer: ${bestOffer}]`);
  });

  const marketId = markets[0]?.marketId;
  if (!marketId) {
    console.log("No open markets found.");
    process.exit(0);
  }
  console.log(`\nUsing market: ${marketId}`);

  // Step 3: Connect WebSocket
  console.log("\nConnecting WebSocket...");
  const socket = new Socket(WS_URL, {
    params: { token },
    transport: WebSocket,
  });
  socket.connect();
  socket.onOpen(() => console.log("✓ WebSocket connected"));
  socket.onError((err) => console.error("✗ WebSocket error:", err));

  // Step 4: Subscribe to market updates
  const marketUpdates = socket.channel("market_updates", {});
  marketUpdates.join()
    .receive("ok", () => console.log("✓ Joined market_updates"))
    .receive("error", (err) => console.error("✗ market_updates join failed:", err));

  marketUpdates.on("market_update", (msg) => {
    console.log("Market update:", JSON.stringify(msg).slice(0, 200));
  });

  // Step 5: Subscribe to your active orders
  const orders = socket.channel(`active_orders:${userId}`, {});
  orders.join()
    .receive("ok", () => console.log("✓ Joined active_orders"))
    .receive("error", (err) => console.error("✗ active_orders join failed:", err));

  orders.on("new_open_order", (msg) => {
    console.log("New order:", JSON.stringify(msg).slice(0, 200));
  });

  // Step 6: Subscribe to portfolio
  const portfolio = socket.channel(`portfolio:${userId}`, {});
  portfolio.join()
    .receive("ok", () => console.log("✓ Joined portfolio"))
    .receive("error", (err) => console.error("✗ portfolio join failed:", err));

  portfolio.on("portfolio_update", (msg) => {
    console.log("Portfolio:", JSON.stringify(msg).slice(0, 200));
  });

  console.log("\nListening for real-time updates... (Ctrl+C to stop)\n");
}

main().catch(console.error);
