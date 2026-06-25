# ClassPass Remote MCP Server

This is a remote HTTP MCP server for ClassPass. It exposes ClassPass browser automation tools over Streamable HTTP at:

```text
https://<host>/mcp
```

## Environment variables

- `PORT` - HTTP port for the server. Defaults to `3000`.
- `AUTH_PASSWORD` - password shown in the OAuth authorization form. Required for Claude/Cursor OAuth login.
- `MCP_AUTH_TOKEN` - optional legacy static bearer token for direct MCP requests. Generate one with:

  ```sh
  openssl rand -hex 32
  ```

- `CLASSPASS_EMAIL` - optional ClassPass email for automatic login.
- `CLASSPASS_PASSWORD` - optional ClassPass password for automatic login.
- `CLASSPASS_STORAGE_STATE` - Playwright storage-state path for a persisted ClassPass session. Defaults to `./data/state.json`.
- `HEADFUL` - set to `1` to launch Chromium with a visible window.

Always set `AUTH_PASSWORD`; ClassPass credentials live on the host when automatic login is enabled.

## Recommended: run locally + Cloudflare Tunnel

ClassPass is protected by Cloudflare bot checks that often block datacenter IPs. The strongest workaround is to run this MCP server on your own computer, complete a one-time manual login from your residential IP, and expose the local server through a Cloudflare Tunnel.

1. Install dependencies and Chromium:

   ```sh
   npm install
   npx playwright install chromium
   ```

2. Complete the one-time manual ClassPass login:

   ```sh
   npm run login
   ```

   A visible Chromium window opens at ClassPass. Log in manually and solve any Cloudflare "Just a moment" challenge. When login is detected, the script saves the authenticated session to `./data/state.json`.

3. Start the local MCP server:

   ```sh
   export AUTH_PASSWORD="choose-a-local-authorization-password"
   export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
   npm start
   ```

   The server listens on `http://localhost:3000` and keeps the OAuth layer enabled. It loads `./data/state.json` automatically, verifies the saved session against `https://classpass.com/account/credits`, and only falls back to `CLASSPASS_EMAIL` / `CLASSPASS_PASSWORD` if no valid saved session exists.

4. Expose it with a quick Cloudflare Tunnel:

   ```sh
   cloudflared tunnel --url http://localhost:3000
   ```

   Cloudflared prints a public `https://...trycloudflare.com` URL. Your MCP endpoint is:

   ```text
   https://<tunnel-url>/mcp
   ```

5. For a stable hostname, create a named tunnel:

   ```sh
   cloudflared tunnel login
   cloudflared tunnel create classpass-mcp
   cloudflared tunnel route dns classpass-mcp classpass-mcp.example.com
   cloudflared tunnel run --url http://localhost:3000 classpass-mcp
   ```

   Your stable MCP endpoint is:

   ```text
   https://classpass-mcp.example.com/mcp
   ```

6. Add the `/mcp` URL as a custom connector in Claude. Claude discovers the OAuth metadata, opens the authorize screen, and asks for `AUTH_PASSWORD`.

Your computer must stay awake and the local server plus tunnel must keep running for Claude/Cursor to use the connector. The `./data/state.json` file contains an authenticated ClassPass browser session; keep it private and never commit it.

## OAuth endpoints

The MCP endpoint is protected by OAuth 2.1 with PKCE and dynamic client registration:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /register`
- `GET /authorize`
- `POST /authorize`
- `POST /token`

The authorization endpoint renders a simple password form. Enter `AUTH_PASSWORD` to approve the OAuth client. The server stores OAuth clients, authorization codes, and tokens in memory, which is intended for a single-user personal service.

## Claude custom connector

Add a custom connector with the MCP URL:

```text
https://<host>/mcp
```

Claude discovers OAuth metadata from the server, dynamically registers a public PKCE client, and opens the authorization page. Enter the `AUTH_PASSWORD` value in the form.

## Cursor `mcp.json`

For OAuth-capable Cursor clients, add the remote MCP URL and complete the authorization flow in the browser:

```json
{
  "mcpServers": {
    "classpass": {
      "url": "https://<host>/mcp"
    }
  }
}
```

For legacy static-token clients, `MCP_AUTH_TOKEN` is still accepted:

```json
{
  "mcpServers": {
    "classpass": {
      "url": "https://<host>/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

## Caveats

ClassPass does not provide a public API, so this server drives a headless Chromium browser with Playwright. Host it on a paid tier that supports long-running browser processes. Browser automation against ClassPass may violate ClassPass terms of service or break when the website changes. Protect the endpoint with OAuth and `AUTH_PASSWORD`, and add `CLASSPASS_EMAIL` / `CLASSPASS_PASSWORD` only in a trusted host dashboard.
