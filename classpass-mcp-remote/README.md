# ClassPass Remote MCP Server

This is a local HTTP MCP server for ClassPass. It drives a real Playwright Chromium browser from your machine, reuses a saved ClassPass browser session, and exposes the MCP endpoint through a public tunnel at an unguessable secret path:

```text
https://<tunnel-host>/<MCP_SECRET>/mcp
```

Claude connector OAuth fields should be left blank. The endpoint privacy comes from the unguessable `MCP_SECRET` path.

## Environment variables

- `PORT` - HTTP port for the server. Defaults to `3000`.
- `MCP_SECRET` - unguessable path segment for the MCP URL. If unset, the server generates one at startup and logs it.
- `CLASSPASS_STORAGE_STATE` - Playwright storage-state path for a persisted ClassPass session. Defaults to `./data/state.json`.
- `HEADFUL` - set to `1` to launch Chromium with a visible window.
- `CLASSPASS_EMAIL` / `CLASSPASS_PASSWORD` - optional fallback login credentials. The recommended path is saved browser session state, not password login.

## Recommended: one-command local + tunnel setup

From the repository root:

```sh
bash classpass-mcp-remote/deploy-classpass-mcp.sh
```

The script:

1. Installs dependencies and Playwright Chromium.
2. Generates an unguessable `MCP_SECRET`.
3. Runs `npm run login` so you can manually log in to ClassPass in a visible browser and solve any Cloudflare "Just a moment" challenge.
4. Saves the authenticated browser session to `./data/state.json`.
5. Starts the local MCP server.
6. Starts a public tunnel with `cloudflared`, falling back to `localhost.run` over SSH if `cloudflared` is unavailable.
7. Self-tests MCP initialize through the public tunnel.
8. Prints the final connector URL:

```text
https://<tunnel-host>/<MCP_SECRET>/mcp
```

Add that URL to Claude as a custom connector and leave OAuth fields blank.

Keep the script terminal open. The local server and tunnel stop when the script exits. Free tunnel URLs rotate when restarted.

## Stable URL (optional, recommended for keep-it-running)

Quick tunnels are zero-config, but their public URLs rotate when restarted. For a stable connector URL, use a Cloudflare named tunnel. This requires a domain that is already on Cloudflare. If you do not have one, keep using the quick tunnel path above.

Authenticate cloudflared and create the named tunnel:

```sh
cloudflared tunnel login
cloudflared tunnel create classpass-mcp
cloudflared tunnel route dns classpass-mcp classpass-mcp.<their-domain>
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-uuid-or-classpass-mcp>
credentials-file: /Users/<you>/.cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: classpass-mcp.<their-domain>
    service: http://localhost:8080
  - service: http_status:404
```

Run the named tunnel:

```sh
cloudflared tunnel run classpass-mcp
```

For a background service that can survive reboots:

```sh
cloudflared service install
```

With the local MCP server running, the permanent connector URL is:

```text
https://classpass-mcp.<their-domain>/<MCP_SECRET>/mcp
```

OAuth fields stay blank. The one-command script detects an existing `classpass-mcp` named tunnel and a configured hostname in `~/.cloudflared/config.yml`; if found, it uses the stable URL automatically. Otherwise it falls back to a quick tunnel or localhost.run.

## Manual local setup

If you prefer to run each step yourself:

```sh
cd classpass-mcp-remote
npm install
npx playwright install chromium
npm run login
```

Then start the server:

```sh
export MCP_SECRET="$(openssl rand -hex 16)"
export PORT=3000
npm start
```

Expose it with a quick Cloudflare Tunnel:

```sh
cloudflared tunnel --url http://localhost:3000
```

Or use `localhost.run` if you do not have `cloudflared`:

```sh
ssh -o StrictHostKeyChecking=accept-new -R 80:localhost:3000 nokey@localhost.run
```

Your connector URL is:

```text
https://<tunnel-host>/<MCP_SECRET>/mcp
```

## Claude custom connector

Add a custom connector with the secret MCP URL:

```text
https://<tunnel-host>/<MCP_SECRET>/mcp
```

Leave OAuth fields blank.

## Cursor `mcp.json`

Add the secret URL directly:

```json
{
  "mcpServers": {
    "classpass": {
      "url": "https://<tunnel-host>/<MCP_SECRET>/mcp"
    }
  }
}
```

## Caveats

ClassPass does not provide a public API, so this server drives Chromium with Playwright. ClassPass is also behind Cloudflare bot protection. Render and other datacenter deployments cannot reliably pass that challenge, so the old Render-hosted flow is deprecated for actual ClassPass use. Run this locally from your residential IP, complete the manual login once, and keep `./data/state.json` private because it contains an authenticated ClassPass browser session.
