// order-test.mjs
// Login, fetch markets, place a limit order, monitor via WS, cancel order
// Run: node order-test.mjs --env=staging
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

const envArg = process.argv.find((a) => a.startsWith("--env="));
const env = envArg ? envArg.split("=")[1] : "staging";
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
  const start = performance.now();
  const res = await fetch(`${API_URL}/api/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const elapsed = (performance.now() - start).toFixed(1);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  console.log(`  (GraphQL ${elapsed}ms)`);
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

// ── Fetch open markets ──────────────────────────────────────────────
async function getMarkets(token, limit = 10) {
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

// ── Place a limit order ─────────────────────────────────────────────
async function placeOrder(token, { marketId, action, price, quantity }) {
  const data = await gql(`
    mutation PlaceOrder($order: UserOrder!) {
      confirmOrder(userOrder: $order) {
        order {
          id
          action
          price
          quantity
          filled
          status
          time
          marketId
        }
        errors
      }
    }
  `, {
    order: {
      marketId,
      orderType: "LIMIT",
      action,
      price,
      quantity,
    }
  }, token);
  return data.confirmOrder;
}

// ── Cancel an order ─────────────────────────────────────────────────
async function cancelOrder(token, orderId) {
  const data = await gql(`
    mutation CancelOrder($orderId: rID!) {
      cancelOrder(orderId: $orderId) {
        status
      }
    }
  `, { orderId }, token);
  return data.cancelOrder;
}

// ── Connect WS and subscribe to order updates ───────────────────────
function connectWS(token, userId) {
  return new Promise((resolve) => {
    const socket = new Socket(WS_URL, {
      params: { token },
      transport: WebSocket,
    });
    socket.connect();
    socket.onOpen(() => {
      console.log("✓ WebSocket connected");

      const orders = socket.channel(`active_orders:${userId}`, {});
      orders.join()
        .receive("ok", () => console.log("✓ Joined active_orders channel"));

      orders.on("new_open_order", (msg) => {
        console.log("\n>> WS new_open_order:", JSON.stringify(msg, null, 2));
      });
      orders.on("order_cancelled", (msg) => {
        console.log("\n>> WS order_cancelled:", JSON.stringify(msg, null, 2));
      });
      orders.on("order_filled", (msg) => {
        console.log("\n>> WS order_filled:", JSON.stringify(msg, null, 2));
      });

      resolve(socket);
    });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pickMarket(markets) {
  const withBook = markets.find((m) => m.bids?.length > 0 || m.offers?.length > 0);
  return withBook || markets[0];
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== STX Order Test (${env}) ===`);
  console.log(`API: ${API_URL}\n`);

  // 1. Login
  console.log("1. Logging in...");
  const auth = await login(EMAIL, PASSWORD);
  const { token, userId } = auth;
  console.log(`   ✓ User: ${userId} (${auth.userStatus})\n`);

  // 2. Connect WS first so we catch order events
  console.log("2. Connecting WebSocket...");
  const socket = await connectWS(token, userId);
  console.log();

  // 3. Fetch markets
  console.log("3. Fetching open markets...");
  const markets = await getMarkets(token);
  if (!markets?.length) {
    console.log("   No open markets. Exiting.");
    socket.disconnect();
    process.exit(0);
  }
  console.log(`   Found ${markets.length} open markets:`);
  markets.forEach((m) => {
    const bestBid   = m.bids?.[0]?.price ?? "—";
    const bestOffer = m.offers?.[0]?.price ?? "—";
    console.log(`   ${m.marketId}  ${m.eventBrief} — ${m.description}  [bid: ${bestBid} / offer: ${bestOffer}]`);
  });

  // 4. Pick a market and place a limit order at a low price (unlikely to fill)
  const market = pickMarket(markets);
  const testPrice = 5;
  const testQty = 1;
  console.log(`\n4. Placing LIMIT BUY order on ${market.marketId} @ ${testPrice} x ${testQty}...`);
  const result = await placeOrder(token, {
    marketId: market.marketId,
    action: "BUY",
    price: testPrice,
    quantity: testQty,
  });

  if (result.errors?.length) {
    console.log(`   ✗ Order errors: ${result.errors.join(", ")}`);
    socket.disconnect();
    process.exit(1);
  }

  const order = result.order;
  console.log(`   ✓ Order placed!`);
  console.log(`     ID:       ${order.id}`);
  console.log(`     Action:   ${order.action}`);
  console.log(`     Price:    ${order.price}`);
  console.log(`     Quantity: ${order.quantity}`);
  console.log(`     Status:   ${order.status}`);
  console.log(`     Time:     ${order.time}`);

  // 5. Wait for WS events, then cancel
  console.log(`\n5. Waiting 3s for WS events...`);
  await sleep(3000);

  console.log(`\n6. Cancelling order ${order.id}...`);
  const cancelResult = await cancelOrder(token, order.id);
  console.log(`   ✓ Cancel status: ${cancelResult.status}`);

  // 7. Wait for cancel WS event
  console.log(`\n7. Waiting 3s for cancel WS event...`);
  await sleep(3000);

  console.log(`\n=== Done ===\n`);
  socket.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  process.exit(1);
});
