// latency-test.mjs
// Measure round-trip latency: place order -> WebSocket book update received
//
// Run:
//   node latency-test.mjs --env=staging
//   node latency-test.mjs --env=staging --market=<marketId>
//   node latency-test.mjs --env=staging --rounds=10
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
const roundsArg = process.argv.find((a) => a.startsWith("--rounds="));

const env    = envArg ? envArg.split("=")[1] : "staging";
const rounds = roundsArg ? parseInt(roundsArg.split("=")[1], 10) : 5;

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
async function getMarkets(token, limit = 10) {
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

// ── Place a limit order ─────────────────────────────────────────────
async function placeOrder(token, { marketId, action, price, quantity }) {
  const data = await gql(`
    mutation PlaceOrder($order: UserOrder!) {
      confirmOrder(userOrder: $order) {
        order { id status }
        errors
      }
    }
  `, {
    order: { marketId, orderType: "LIMIT", action, price, quantity }
  }, token);
  return data.confirmOrder;
}

// ── Cancel an order ─────────────────────────────────────────────────
async function cancelOrder(token, orderId) {
  const data = await gql(`
    mutation CancelOrder($orderId: rID!) {
      cancelOrder(orderId: $orderId) { status }
    }
  `, { orderId }, token);
  return data.cancelOrder;
}

// ── Wait for WS update with timeout ─────────────────────────────────
function waitForUpdate(channel, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`No WS update within ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(payload) {
      cleanup();
      resolve(payload);
    }

    function cleanup() {
      clearTimeout(timer);
      channel.off("updated", handler);
    }

    channel.on("updated", handler);
  });
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== STX Latency Test (${env}) — ${rounds} rounds ===`);
  console.log(`API: ${API_URL}\n`);

  // 1. Login
  console.log("1. Logging in...");
  const auth = await login(EMAIL, PASSWORD);
  const { token } = auth;
  console.log(`   Logged in as ${auth.userId}\n`);

  // 2. Pick market
  let targetMarketId = marketArg ? marketArg.split("=")[1] : null;
  if (!targetMarketId) {
    console.log("2. Fetching open markets...");
    const markets = await getMarkets(token);
    const pick = markets.find((m) => m.bids?.length > 0 || m.offers?.length > 0) || markets[0];
    if (!pick) {
      console.log("   No open markets. Exiting.");
      process.exit(0);
    }
    targetMarketId = pick.marketId;
    console.log(`   Selected: ${targetMarketId} — ${pick.eventBrief}\n`);
  } else {
    console.log(`2. Using market: ${targetMarketId}\n`);
  }

  // 3. Connect WS and join market_updates
  console.log("3. Connecting WebSocket...");
  const socket = await new Promise((resolve) => {
    const s = new Socket(WS_URL, { params: { token }, transport: WebSocket });
    s.connect();
    s.onOpen(() => resolve(s));
  });
  console.log("   Connected\n");

  const channel = socket.channel("market_updates", {});
  await new Promise((resolve, reject) => {
    channel.join()
      .receive("ok", resolve)
      .receive("error", reject);
  });

  await new Promise((resolve, reject) => {
    channel.push("watch", [targetMarketId])
      .receive("ok", resolve)
      .receive("error", reject);
  });
  console.log("4. Watching market via market_updates\n");

  // 4. Run latency rounds
  const testPrice = 1; // low price, won't fill
  const results = [];

  console.log(`   ${"ROUND".padEnd(8)} ${"ACTION".padEnd(10)} ${"GQL (ms)".padEnd(12)} ${"WS (ms)".padEnd(12)} ${"TOTAL (ms)".padEnd(12)}`);
  console.log(`   ${"─".repeat(54)}`);

  for (let i = 0; i < rounds; i++) {
    // Place order and measure
    const t0 = performance.now();
    const wsPromise = waitForUpdate(channel);

    const result = await placeOrder(token, {
      marketId: targetMarketId,
      action: "BUY",
      price: testPrice,
      quantity: 1,
    });
    const tGql = performance.now();

    if (result.errors?.length) {
      console.log(`   ${String(i + 1).padEnd(8)} PLACE      ERROR: ${result.errors.join(", ")}`);
      break;
    }

    await wsPromise;
    const tWs = performance.now();

    const gqlMs = (tGql - t0).toFixed(1);
    const wsMs  = (tWs - tGql).toFixed(1);
    const total = (tWs - t0).toFixed(1);

    console.log(`   ${String(i + 1).padEnd(8)} ${"PLACE".padEnd(10)} ${gqlMs.padStart(8)}    ${wsMs.padStart(8)}    ${total.padStart(8)}`);
    results.push({ action: "PLACE", gql: tGql - t0, ws: tWs - tGql, total: tWs - t0 });

    // Cancel and measure
    const t2 = performance.now();
    const wsPromise2 = waitForUpdate(channel);

    await cancelOrder(token, result.order.id);
    const tGql2 = performance.now();

    await wsPromise2;
    const tWs2 = performance.now();

    const gqlMs2 = (tGql2 - t2).toFixed(1);
    const wsMs2  = (tWs2 - tGql2).toFixed(1);
    const total2 = (tWs2 - t2).toFixed(1);

    console.log(`   ${String(i + 1).padEnd(8)} ${"CANCEL".padEnd(10)} ${gqlMs2.padStart(8)}    ${wsMs2.padStart(8)}    ${total2.padStart(8)}`);
    results.push({ action: "CANCEL", gql: tGql2 - t2, ws: tWs2 - tGql2, total: tWs2 - t2 });
  }

  // 5. Summary
  if (results.length) {
    console.log(`\n   ${"─".repeat(54)}`);
    const avgGql   = results.reduce((s, r) => s + r.gql, 0) / results.length;
    const avgWs    = results.reduce((s, r) => s + r.ws, 0) / results.length;
    const avgTotal = results.reduce((s, r) => s + r.total, 0) / results.length;
    const minTotal = Math.min(...results.map((r) => r.total));
    const maxTotal = Math.max(...results.map((r) => r.total));
    const p50      = [...results.map((r) => r.total)].sort((a, b) => a - b)[Math.floor(results.length / 2)];

    console.log(`\n   Summary (${results.length} samples):`);
    console.log(`     Avg GQL round-trip:  ${avgGql.toFixed(1)}ms`);
    console.log(`     Avg WS propagation:  ${avgWs.toFixed(1)}ms`);
    console.log(`     Avg total:           ${avgTotal.toFixed(1)}ms`);
    console.log(`     Min / p50 / Max:     ${minTotal.toFixed(1)} / ${p50.toFixed(1)} / ${maxTotal.toFixed(1)}ms`);
    console.log(`\n   "WS propagation" = time from GQL response to WS update arrival.`);
    console.log(`   This is the server processing + WS push latency.\n`);
  }

  socket.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
