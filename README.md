# STX JS Demo

> **This repository is archived.** The maintained JavaScript examples are in [stxapp/stx-api-examples](https://github.com/stxapp/stx-api-examples/tree/main/javascript), which use API-key request signing.

JavaScript examples for the STX API — login, market data, WebSocket streaming, order placement, and latency benchmarking.

## Setup

```bash
git clone https://github.com/stxapp/js-demo.git
cd js-demo
npm install
```

## Configuration

Set credentials for the environment you want to connect to:

### Staging

```bash
export STX_STAGING_EMAIL="your@email.com"
export STX_STAGING_PASSWORD="your_password"
```

### Production

```bash
export STX_PROD_EMAIL="your@email.com"
export STX_PROD_PASSWORD="your_password"
```

## Scripts

### Quickstart — Market Streaming

Logs in, fetches open markets, connects to WebSocket, and streams real-time market updates, order events, and portfolio changes.

```bash
node quickstart.mjs --env=staging
node quickstart.mjs --env=prod
```

### Order Test — Place & Cancel

Logs in, fetches markets, places a limit buy order, waits for WS confirmation, then cancels it. Logs GraphQL round-trip times for latency benchmarking.

```bash
node order-test.mjs --env=staging
node order-test.mjs --env=prod
```

### Market Info — Full Order Book Stream

Streams real-time order book updates (bids, offers, recent trades, volume) via the `market_info` channel. Supports three channel modes for comparison.

```bash
# Default: market_info channel, auto-picks a market with book depth
node market-info.mjs --env=staging

# Specific market
node market-info.mjs --env=staging --market=<marketId>

# Alternative channels
node market-info.mjs --env=staging --channel=markets       # server-side field filtering
node market-info.mjs --env=staging --channel=market_updates # broadcast channel
```

### Market Watch — Top-of-Book via Watch

Subscribes to the `market_updates` channel and pushes a `watch` command for specific markets. Displays order book, latest trade, and volume summary.

```bash
# Auto-pick a market with book depth
node market-watch.mjs --env=staging

# Watch a specific market
node market-watch.mjs --env=staging --market=<marketId>

# Watch multiple markets
node market-watch.mjs --env=staging --market=<id1>,<id2>,<id3>
```

### Latency Test — Round-Trip Benchmarking

Measures end-to-end latency: places a limit order via GraphQL, waits for the WebSocket book update, then cancels. Reports GQL round-trip, WS propagation, and total latency with min/p50/max summary.

```bash
node latency-test.mjs --env=staging
node latency-test.mjs --env=staging --rounds=10
node latency-test.mjs --env=staging --market=<marketId>
```

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| GraphQL | `/api/graphql` | Queries and mutations (login, markets, orders) |
| WebSocket | `/socket` | Phoenix Channels for real-time updates |

### Key WebSocket Channels

| Channel | Description |
|---------|-------------|
| `market_info` | Full order book updates for all markets (bids, offers, trades, volume). No server-side filtering — clients filter by market ID. |
| `markets` | Server-side field filtering via join params (e.g. `fields: ["bids", "offers"]`, `message_types: ["market_updated"]`). |
| `market_updates` | Supports `watch` for specific markets. Join with empty payload, then push `watch` with an array of market UUIDs. Receives `updated` events. |
| `active_orders:<userId>` | Your order events (new, filled, cancelled) |
| `portfolio:<userId>` | Balance and portfolio updates |
| `active_trades:<userId>` | Trade execution updates |
| `active_positions:<userId>` | Position changes |

### WebSocket Latency Characteristics

- **GraphQL mutations**: ~85ms round-trip
- **WebSocket book updates**: pushed on a ~2-second server-side broadcast interval
- **End-to-end** (place order to WS update): ~2.1s, dominated by the broadcast interval

The order book is updated immediately on the server; WebSocket notifications are batched and broadcast approximately every 2 seconds.

## Requirements

- Node.js 18+

## Disclaimer

These scripts are provided as examples for integrating with the STX API. They are not production-ready and are intended for testing and evaluation purposes only. Use at your own risk. STX is not responsible for any losses resulting from the use of these scripts or the API.

## License

MIT — see [LICENSE](LICENSE)
