// market-watch.mjs
// Subscribe to market_updates channel and watch specific markets for top-of-book updates
//
// Run:
//   node market-watch.mjs --env=staging
//   node market-watch.mjs --env=staging --market=<marketId>
//   node market-watch.mjs --env=staging --market=<id1>,<id2>,<id3>
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

// ── Parse flags ─────────────────────────────────────────────────────
const envArg    = process.argv.find((a) => a.startsWith("--env="));
const marketArg = process.argv.find((a) => a.startsWith("--market="));

const env = envArg ? envArg.split("=")[1] : "staging";
const marketIds = marketArg ? marketArg.split("=")[1].split(",") : null;

if (!ENVS[env]) {
  console.error(`Unknown env "${env}". Use --env=staging or --env=prod`);
  process.exit(1);
}
const { api: API_URL, ws: WS_URL } = ENVS[env];

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

// ── Login ───────────────────────────────────────────────────────────
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

// ── Fetch markets ───────────────────────────────────────────────────
async function getMarkets(token, limit = 5) {
  const data = await gql(`
    query GetMarkets($input: MarketInfosInput) {
      marketInfos(input: $input) {
        marketId
        description
        eventBrief
        status
        bids(limit: 1) { price }
        offers(limit: 1) { price }
      }
    }
  `, { input: { status: ["OPEN"], limit } }, token);
  return data.marketInfos;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== STX Market Watch — Top-of-Book (${env}) ===`);
  console.log(`API: ${API_URL}\n`);

  // 1. Login
  console.log("1. Logging in...");
  const auth = await login(EMAIL, PASSWORD);
  const { token } = auth;
  console.log(`   Logged in as ${auth.userId}\n`);

  // 2. Resolve which markets to watch
  let watchList = marketIds;
  if (!watchList) {
    console.log("2. No --market flag — fetching open markets...");
    const markets = await getMarkets(token);
    if (!markets?.length) {
      console.log("   No open markets found. Exiting.");
      process.exit(0);
    }
    const pick = markets.find((m) => m.bids?.length > 0 || m.offers?.length > 0) || markets[0];
    watchList = [pick.marketId];
    console.log(`   Auto-selected: ${watchList[0]} — ${pick.eventBrief} (has book depth)`);
  } else {
    console.log(`2. Markets to watch: ${watchList.join(", ")}`);
  }

  // 3. Connect WebSocket
  console.log("\n3. Connecting WebSocket...");
  const socket = new Socket(WS_URL, {
    params: { token },
    transport: WebSocket,
  });
  socket.connect();

  socket.onOpen(() => {
    console.log("   WebSocket connected\n");

    // Step 1: Join with empty payload (defaults to level_1, empty watch list)
    const channel = socket.channel("market_updates", {});

    channel.join()
      .receive("ok", () => {
        console.log("4. Joined market_updates channel");

        // Step 2: Push watch with array of UUIDs
        console.log(`   Pushing watch: ${JSON.stringify(watchList)}`);
        channel.push("watch", watchList)
          .receive("ok", () => {
            console.log("   Watch confirmed\n");
            console.log("   Level 1 data: bp/bq (best bid), op/oq (best offer), price, status");
            console.log("   Listening for 'updated' events... (Ctrl+C to stop)\n");
          })
          .receive("error", (err) => {
            console.error("   Watch failed:", err);
            process.exit(1);
          });
      })
      .receive("error", (err) => {
        console.error("   Failed to join market_updates:", err);
        process.exit(1);
      });

    // Step 3: Listen for "updated" events
    let msgCount = 0;
    channel.on("updated", (payload) => {
      msgCount++;
      const ts = new Date().toISOString();
      const mid = payload.id || payload.market_id || "—";
      const latencyMs = payload.timestamp
        ? (new Date(ts) - new Date(payload.timestamp)).toFixed(0)
        : "—";
      console.log(`[${ts}] #${msgCount}  market: ${mid}  latency: ${latencyMs}ms`);

      // Order book
      const bids = payload.bids || [];
      const offers = [...(payload.offers || [])].reverse();
      if (bids.length || offers.length) {
        const depth = Math.max(bids.length, offers.length);
        console.log(`  ${"LEVEL".padEnd(6)} ${"BID".padEnd(14)} ${"OFFER".padEnd(14)}`);
        for (let i = 0; i < depth; i++) {
          const bid   = bids[i]   ? `${bids[i].price} x ${bids[i].quantity}` : "";
          const offer = offers[i] ? `${offers[i].price} x ${offers[i].quantity}` : "";
          console.log(`  ${String(i + 1).padEnd(6)} ${bid.padEnd(14)} ${offer.padEnd(14)}`);
        }
      }

      // Latest trade
      if (payload.recent_trades?.length) {
        const t = payload.recent_trades[0];
        console.log(`  Last trade: ${t.price} x ${t.quantity} (${t.liquidity_taker}) @ ${t.timestamp}`);
      }

      // Summary
      const parts = [];
      if (payload.last_traded_price != null) parts.push(`Last: ${payload.last_traded_price}`);
      if (payload.total_volume != null)      parts.push(`Vol: ${payload.total_volume}`);
      if (payload.volume_24h != null)        parts.push(`24h: ${payload.volume_24h}`);
      if (payload.price_change_24h != null)  parts.push(`Chg: ${payload.price_change_24h}`);
      if (parts.length) console.log(`  ${parts.join("  |  ")}`);

      console.log();
    });
  });

  socket.onError((err) => console.error("WebSocket error:", err));
  socket.onClose(() => {
    console.log("\nWebSocket closed.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
