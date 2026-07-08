<!--suppress HtmlUnknownAnchorTarget, HtmlDeprecatedAttribute -->
<div id="top"></div>

<h1 align="center">
  Restream Panel
</h1>

<p align="center">
   A web dashboard for managing and configuring a Restream Server.
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
    <li><a href="#%EF%B8%8F-how-to-use">⚠️ How to use</a></li>
    <li><a href="#%EF%B8%8F-deployment">⬆️ Deployment</a></li>
  </ol>
</details>

<br>

## 📃 Description

This is a lightweight web dashboard designed to configure re-translation options for RTMP/SRT streams and monitor network connections in real-time.

The application provides a user-friendly WebUI for editing the `nginx.conf` file. It allows you to add, edit, and delete `application` blocks within the nginx RTMP module configuration to manage various restream targets (e.g., Twitch, VK Video, and other platforms).

The restream server receives an incoming stream from the user and forwards it to the selected target servers. For sending streams via the RTMPS protocol, `stunnel` is used as a proxy.

<p align="right">(<a href="#top">back to top</a>)</p>

### Built With

- [Bun](https://bun.sh/)
- [ElysiaJS](https://elysiajs.com/)
- [React](https://react.dev/)

## 🪧 Getting Started

### Prerequisites

For development and building the project, you need:
- [Bun](https://bun.sh/) version 1.0+

The target restream server (where the panel will be installed) must run on **Linux x64 (Ubuntu 22 or 24)** with the following components installed:
- `nginx`
- `nginx rtmp module`
- `stunnel`
- `mediamtx`

### Installation & Build

1. Clone the repository:
   ```sh
   git clone <repository_url>
   cd restream-panel
   ```

2. Install dependencies:
   ```sh
   bun install
   ```

3. Run in development mode:
   ```sh
   bun run dev
   ```

4. To build the frontend and backend:
   ```sh
   bun run build:frontend
   bun run build:prod
   ```
   Platform-specific scripts are also available: `build:windows` and `build:linux`.

<p align="right">(<a href="#top">back to top</a>)</p>

## ⚠️ How to use

The panel is designed to manage your `nginx.conf` file. Through the web interface, you can create new RTMP applications (`application`), specifying the target push servers and stream keys (for example, Twitch servers in Stockholm, Frankfurt, Paris, or VK servers).

Note that 3 basic `application` blocks from the default Nginx template are locked and cannot be deleted or modified. They must remain in the configuration at all times.

<p align="right">(<a href="#top">back to top</a>)</p>

## ⬆️ Deployment

Currently, there is no automated CI/CD pipeline for deployment.

To deploy on a production server:
1. Compile the Linux binary: `bun run build:linux` (make sure to build the frontend first with `bun run build:frontend`).
2. Copy the resulting binary file (along with necessary static files, if they are not bundled within the binary) to your restream server.
3. Run the binary manually or configure it as a background service (e.g., via systemd). Ensure that the process has read and write permissions to the Nginx configuration file (usually `/etc/nginx/nginx.conf`).

<p align="right">(<a href="#top">back to top</a>)</p>
