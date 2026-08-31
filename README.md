# zorr-websocket

Zorr game bot — WebSocket client, live map server, and game-data extraction pipeline.

## Layout

```
map_server.js           Live map server: HTTP/SSE hub, bot control API, UDP discovery
bot_session.js          Bot session: WS protocol, game logic (methods mixed in from lib/bot/)
account_manager.js      Multi-account launcher (accounts.txt / proxies.txt)
protocol_extractor.js   (removed)

extraction_pipeline.js  Public orchestrator + cache layers
lib/pipeline/stages.js  Stage machinery: fetch, AST, VM, handshake
lib/pipeline/snake.js   Raw mob snake detection

lib/bot/protocol.js     Wire protocol constants, LCG, MinHeap, A* primitives
lib/bot/navigation.js   Path computation, stuck recovery, mob-block handling
lib/bot/autopatrol.js   Auto Patrol state machine
lib/bot/rendering.js    Mob-map PNG rendering + Discord alerts

lib/server/store.js     Persisted config (routes/tracking/ping/biome) + bot push
lib/server/discovery.js UDP control discovery broadcast

normalizers.js          Schema normalizers (rarities/petals/mobs/talents)
shape_classifier.js     Captured-value shape classification
sandbox_factory.js      Node VM sandbox with mocked browser APIs
ast_capture.js          AST-based capture injection
source_fetcher.js       Obfuscated-JS fetcher
vm_worker.js            Worker-thread VM execution (opt-in via ZORR_USE_VM_WORKER=1)

map.html                Map viewer (markup only)
public/map.css|js       Viewer styles and logic
```

## Commands

```bash
npm start          # map server + viewer at http://localhost:3000
npm run bot        # multi-account bot manager
npm run capture    # single-account test session
npm run extract    # dump current extraction result
npm run pathfind   # pathfinding map server (port 3001)

npm test           # node:test unit tests
npm run check      # lint + typecheck + format check + tests
```

## Config files (runtime)

- `routes.json` — patrol routes
- `tracking_config.json` — mob tracking targets
- `ping_rules.json` — Discord ping rules
- `biome_channels.json` — Discord channel per biome
- `.env` — DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, etc.

## Development

- **Lint**: `npm run lint` (ESLint 9 flat config)
- **Types**: `npm run typecheck` (TypeScript checkJs over JSDoc; strict off)
- **Format**: `npm run format` (Prettier, 4-space, width 120)
- **Tests**: `npm test` (node:test, no extra framework)

Rendering note: Discord mob-map images use `C:/Windows/Fonts/arialbd.ttf` via
opentype.js with a 5x7 bitmap-font fallback when unavailable.
