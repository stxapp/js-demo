// market-info.mjs
// Real-time order book streaming via STX WebSocket channels
//
// Channel modes (--channel flag):
//   market_info    — full order book updates: bids, offers, trades, volume (default)
//   markets        — server-side field filtering via join params
//   market_updates — broadcast channel, watch specific markets
//
// Run:
//   node market-info.mjs --env=staging
//   node market-info.mjs --env=staging --market=<marketId>
//   node market-info.mjs --env=staging --channel=markets
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
const envArg     = process.argv.find((a) => a.startsWith("--env="));
const channelArg = process.argv.find((a) => a.startsWith("--channel="));
const marketArg  = process.argv.find((a) => a.startsWith("--market="));

const env       = envArg ? envArg.split("=")[1] : "staging";
const mode      = channelArg ? channelArg.split("=")[1] : "market_info";
const marketId  = marketArg ? marketArg.split("=")[1] : null;

if (!ENVS[env]) {
  console.error(`Unknown env "${env}". Use --env=staging or --env=prod`);
  process.exit(1);
}
if (!["markets", "market_updates", "market_info"].includes(mode)) {
  console.error(`Unknown channel "${mode}". Use market_info, markets, or market_updates`);
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
        bids(limit: 5) { price quantity }
        offers(limit: 5) { price quantity }
      }
    }
  `, { input: { status: ["OPEN"], limit } }, token);
  return data.marketInfos;
}

// ── Logging helpers ─────────────────────────────────────────────────
let msgCount = 0;

function pad(str, len) {
  str = String(str);
  return str + " ".repeat(Math.max(0, len - str.length));
}

function printBook(label, bids, offers) {
  console.log(`\n  ${label}`);
  console.log(`  ${pad("LEVEL", 6)} ${pad("BID", 14)} ${pad("OFFER", 14)}`);
  const depth = Math.max(bids?.length ?? 0, offers?.length ?? 0);
  for (let i = 0; i < depth; i++) {
    const bid   = bids?.[i]  ? `${bids[i].price} x ${bids[i].quantity}` : "";
    const offer = offers?.[i] ? `${offers[i].price} x ${offers[i].quantity}` : "";
    console.log(`  ${pad(i + 1, 6)} ${pad(bid, 14)} ${pad(offer, 14)}`);
  }
}

function logUpdate(marketData) {
  msgCount++;
  const ts = new Date().toISOString();
  const serverTs = marketData.timestamp || "";
  console.log(`\n[${ts}] #${msgCount}  market: ${marketData.market_id}`);

  if (marketData.bids?.length || marketData.offers?.length) {
    printBook("Order Book:", marketData.bids || [], [...(marketData.offers || [])].reverse());
  }

  if (marketData.recent_trades?.length) {
    const latest = marketData.recent_trades[0];
    console.log(`\n  Latest trade: ${latest.price} x ${latest.quantity} (${latest.liquidity_taker}) @ ${latest.timestamp}`);
  }

  if (marketData.total_volume != null) {
    console.log(`  Volume: ${marketData.total_volume}  24h: ${marketData.volume_24h ?? "—"}  OI: ${marketData.open_interest ?? "—"}`);
  }
}

// ── Channel setup functions ─────────────────────────────────────────

// "market_info" — full payload, all markets (filter client-side by --market)
function joinMarketInfo(socket, targetMarketId) {
  console.log(`4. Joining "market_info" channel...`);
  const channel = socket.channel("market_info", {});

  channel.join()
    .receive("ok", () => {
      console.log(`   Joined "market_info"`);
      if (targetMarketId) {
        console.log(`   Filtering to market: ${targetMarketId}`);
      }
      console.log("   Listening for order book updates... (Ctrl+C to stop)");
    })
    .receive("error", (err) => {
      console.error('   Failed to join "market_info":', err);
      process.exit(1);
    });

  channel.onMessage = (event, payload, _ref) => {
    if (event === "phx_reply" || event === "phx_close") return payload;
    if (event === "market_updated" && payload) {
      for (const [id, data] of Object.entries(payload)) {
        if (targetMarketId && id !== targetMarketId) continue;
        if (!data.bids?.length && !data.offers?.length) continue;
        logUpdate(data);
      }
    }
    return payload;
  };
}

// "markets" — server-side field filtering
function joinMarkets(socket) {
  console.log(`4. Joining "markets" channel with field filtering...`);
  const channel = socket.channel("markets", {
    fields: ["bids", "offers", "market_id", "timestamp"],
    message_types: ["market_updated"],
  });

  channel.join()
    .receive("ok", () => {
      console.log(`   Joined "markets" — server filters to bids/offers only`);
      console.log("   Listening... (Ctrl+C to stop)");
    })
    .receive("error", (err) => {
      console.error('   Failed to join "markets":', err);
      process.exit(1);
    });

  channel.onMessage = (event, payload, _ref) => {
    if (event === "phx_reply" || event === "phx_close") return payload;
    msgCount++;
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] #${msgCount} event="${event}"`);
    if (payload) console.log(JSON.stringify(payload, null, 2));
    return payload;
  };
}

// "market_updates" — watch specific markets
function joinMarketUpdates(socket, targetMarketId) {
  const joinParams = targetMarketId ? { watch: [targetMarketId] } : {};
  console.log(`4. Joining "market_updates" channel...`);
  const channel = socket.channel("market_updates", joinParams);

  channel.join()
    .receive("ok", () => {
      if (targetMarketId) {
        console.log(`   Joined "market_updates" — watching: ${targetMarketId}`);
      } else {
        console.log(`   Joined "market_updates" — all markets`);
      }
      console.log("   Listening... (Ctrl+C to stop)");
    })
    .receive("error", (err) => {
      console.error('   Failed to join "market_updates":', err);
      process.exit(1);
    });

  channel.onMessage = (event, payload, _ref) => {
    if (event === "phx_reply" || event === "phx_close") return payload;
    msgCount++;
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] #${msgCount} event="${event}"`);
    if (payload) console.log(JSON.stringify(payload, null, 2));
    return payload;
  };
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== STX Order Book Stream (${env}) — channel: ${mode} ===`);
  console.log(`API: ${API_URL}\n`);

  // 1. Login
  console.log("1. Logging in...");
  const auth = await login(EMAIL, PASSWORD);
  const { token } = auth;
  console.log(`   Logged in as ${auth.userId}\n`);

  // 2. Fetch a market for context
  console.log("2. Fetching open markets...");
  const markets = await getMarkets(token);
  if (!markets?.length) {
    console.log("   No open markets found. Exiting.");
    process.exit(0);
  }
  const pick = markets.find((m) => m.bids?.length > 0 || m.offers?.length > 0) || markets[0];
  const targetMarketId = marketId || pick.marketId;
  console.log(`   Target market: ${targetMarketId} — ${pick.eventBrief} — ${pick.description}`);
  printBook("Initial book snapshot (via GraphQL):", pick.bids, pick.offers);

  // 3. Connect WebSocket
  console.log("\n3. Connecting WebSocket...");
  const socket = new Socket(WS_URL, {
    params: { token },
    transport: WebSocket,
  });
  socket.connect();

  socket.onOpen(() => {
    console.log("   WebSocket connected\n");

    switch (mode) {
      case "market_info":    joinMarketInfo(socket, targetMarketId); break;
      case "markets":        joinMarkets(socket); break;
      case "market_updates": joinMarketUpdates(socket, targetMarketId); break;
    }
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
