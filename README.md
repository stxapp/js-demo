# STX JS Demo

JavaScript examples for the STX API — login, market data, WebSocket streaming, and order placement.

## Setup

```bash
git clone https://github.com/stxapp/js-demo.git
cd js-demo
npm install
```

## Configuration

Set credentials for the environment you want to connect to:

### Staging

```powershell
$env:STX_STAGING_EMAIL = "your@email.com"
$env:STX_STAGING_PASSWORD = "your_password"
```

### Production

```powershell
$env:STX_PROD_EMAIL = "your@email.com"
$env:STX_PROD_PASSWORD = "your_password"
```

## Scripts

### Quickstart — Market Streaming

Logs in, fetches open markets, connects to WebSocket, and streams real-time market updates, order events, and portfolio changes.

```powershell
node quickstart.mjs --env=staging
node quickstart.mjs --env=prod
```

### Order Test — Place & Cancel

Logs in, fetches markets, places a limit buy order, waits for WS confirmation, then cancels it. Logs GraphQL round-trip times for latency benchmarking.

```powershell
node order-test.mjs --env=staging
node order-test.mjs --env=prod
```

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| GraphQL | `/api/graphql` | Queries and mutations (login, markets, orders) |
| WebSocket | `/socket` | Phoenix Channels for real-time updates |

### Key WebSocket Channels

| Channel | Description |
|---------|-------------|
| `market_updates` | Real-time market price/status changes |
| `active_orders:<userId>` | Your order events (new, filled, cancelled) |
| `portfolio:<userId>` | Balance and portfolio updates |
| `active_trades:<userId>` | Trade execution updates |
| `active_positions:<userId>` | Position changes |

## Requirements

- Node.js 18+

## Disclaimer

These scripts are provided as examples for integrating with the STX API. They are not production-ready and are intended for testing and evaluation purposes only. Use at your own risk. STX is not responsible for any losses resulting from the use of these scripts or the API.

## License

MIT — see [LICENSE](LICENSE)
