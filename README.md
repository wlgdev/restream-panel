<!--suppress HtmlUnknownAnchorTarget, HtmlDeprecatedAttribute -->
<div id="top"></div>

<h1 align="center">
  Restream Panel
</h1>

<p align="center">
   Live health monitoring for a MediaMTX restream server.
</p>

<!-- TABLE OF CONTENT -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#-description">📃 Description</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#-getting-started">🪧 Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation & Build</a></li>
      </ul>
    </li>
    <li>
      <a href="#%EF%B8%8F-how-to-use">⚠️ How to use</a></li>
    <li>
      <a href="#%EF%B8%8F-deployment">⬆️ Deployment</a></li>
  </ol>
</details>

<br>

## 📃 Description

A lightweight web dashboard for real-time monitoring of RTMP/SRT streams relayed
through [MediaMTX](https://github.com/bluenviron/mediamtx): per-connection health
(throughput, RTT, loss/retransmits, buffers), logical streams grouped by path,
event log and bitrate charts, streamed to the UI over SSE.

The panel is read-only: it never edits server configuration.

<p align="right">(<a href="#top">back to top</a>)</p>

### Built With

- [Bun](https://bun.sh/) (built-in serve, routes and SSE — no backend framework)
- [React](https://react.dev/)

## 🪧 Getting Started

### Prerequisites

- [Bun](https://bun.sh/) version 1.4+
- A local or remote MediaMTX with API enabled (`/metrics`, `/v3/paths/list`).
  On Linux, `ss -itnop` is used for RTMP TCP metrics.

### Installation

1. Clone the repository:
   ```sh
   git clone <repository_url>
   cd restream-panel
   ```

2. Install dependencies:
   ```sh
   bun install
   ```

3. Run against the real MediaMTX:
   ```sh
   bun run dev
   ```

4. Run with mock fixtures (no `ss`/MediaMTX needed):
   ```sh
   bun run dev:mock
   ```

5. Build:
   ```sh
   bun run build:frontend
   bun run build:prod
   ```
   Platform-specific scripts are also available: `build:windows` and `build:linux`.
   Run tests with `bun test`.

<p align="right">(<a href="#top">back to top</a>)</p>

## ⚠️ How to use

Open the panel (default `http://localhost:16969`), log in (`admin / restream`
unless overridden via `--user/--password` or `RESTREAM_USER/RESTREAM_PASSWORD`)
and watch the Monitor page: active streams, unassociated connections, event log.

<p align="right">(<a href="#top">back to top</a>)</p>

## ⬆️ Deployment

Currently, there is no automated CI/CD pipeline for deployment.

To deploy on a production server:
1. Compile the Linux binary: `bun run build:linux`.
2. Copy the resulting binary to your restream server (static assets are embedded).
3. Run the binary manually or as a background service (e.g., via systemd).

<p align="right">(<a href="#top">back to top</a>)</p>
