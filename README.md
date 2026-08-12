# Jambo 📖

A tiny self-hosted audiobook player for two people. Each of you logs in with a
profile + PIN, listens in the browser (installable as a home-screen app on
iPhone and Android), and sees the other person's bookmark on the timeline.

The repo is laid out as a Home Assistant add-on repository: the app itself
lives in [`jambo/`](jambo/), with `repository.yaml` at the root.

## Running it locally

```
cd jambo
npm install
npm start
```

Then open http://localhost:3000. The first visit asks you to create the two
profiles (name, PIN, colour). Everything is stored in `jambo/data/` — back
that folder up if you care about your positions.

## Adding books

One folder per book inside `jambo/books/` (or wherever `BOOKS_DIR` points):

```
books/
  Ursula K. Le Guin - A Wizard of Earthsea/
    cover.jpg
    01.mp3
    02.mp3
    ...
```

- Folder name `Author - Title` fills in the author automatically (falls back
  to the files' embedded tags).
- Tracks are ordered by filename (natural sort, so `2` comes before `10`).
- `cover.jpg` / `cover.png` (or any image in the folder) becomes the artwork.
- Supported audio: mp3, wav, m4a, m4b, aac, ogg, opus, flac.

Tap the ↻ button in the app (or restart the server) after adding books.

A generated sample book ships in `books/Jambo Demo - Sample Book/` so you can
try the player immediately — delete that folder whenever you like.

## Hosting it for the two of you

The server is plain HTTP on port 3000 (`PORT` env var to change). PINs are
hashed and login is rate-limited, but you should still put HTTPS in front of
it. Two good options:

### Option A — your PC + Tailscale (free)

1. Install [Tailscale](https://tailscale.com) on this PC and on both phones,
   signed into the same tailnet.
2. Run the app: `npm start`
3. Expose it with automatic HTTPS:
   `tailscale serve --bg 3000`
4. Open the printed `https://<your-pc>.<tailnet>.ts.net` URL on the phones and
   "Add to Home Screen".

Nobody outside your tailnet can reach it. The PC needs to be on to listen.

### Option A½ — Home Assistant add-on (always on, sidebar panel)

If you run Home Assistant OS (or Supervised), Jambo can run on the HA box as a
local add-on with its own sidebar panel, and each of you is signed in
automatically from your HA account:

1. In HA: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add this
   repo's GitHub URL, and refresh. (Alternative without GitHub: copy the
   `jambo/` folder to `/addons/jambo` via Samba/SSH and check for updates.)
2. Install **Jambo Audiobooks** and start it.
3. **Jambo** appears in the sidebar. Both phones must be logged into the HA
   companion app with their *own* HA user accounts.
4. That's it — no setup, no login. The first two HA accounts that open the
   panel each get a profile automatically (named after their HA display name).
   A demo book is generated so there's something to play immediately; it
   removes itself once real books appear in the library.
5. Put books in `/share/jambo/books/` (one folder per book, via Samba), then
   tap ↻ in the app.

**Books on a USB thumb drive:** plug the drive into the HA box and point the
add-on's `books_dir` option (Configuration tab) at wherever it's mounted —
typically `/media/<drive-label>` once HA has mounted it. If HA OS doesn't show
the drive under `/media`, the community "Samba NAS" add-on can mount USB
partitions, or just copy the files onto `/share/jambo/books` once. Keep each
book in its own folder either way.

Progress data lives in the add-on's `/data` (backed up by HA snapshots).

**Heads-up on locked-screen listening:** audio playing inside the HA app's
panel may pause when the phone locks (a webview limitation, worst on iOS). If
that bothers you, enable the optional port 3000 in the add-on's configuration
and add `http://<ha-ip>:3000` to each phone's home screen as a PWA — same
server, same progress, proper lock-screen controls. On that screen you pick
your profile and enter a PIN; profiles created via HA have none yet, so the
first PIN you enter becomes your PIN. The port also makes Jambo
reachable to anyone on your LAN with a PIN, so only enable it if that's okay
with you (remotely it's still only reachable through your HA/Tailscale setup).

### Option B — a small VPS (~$5/mo, always on)

1. Copy the project to the server, `npm install --omit=dev`, and run it under
   a process manager (`systemd`, `pm2`, etc.).
2. Put [Caddy](https://caddyserver.com) in front for automatic HTTPS:
   ```
   yourdomain.example {
     reverse_proxy localhost:3000
   }
   ```
3. Upload books into `books/` (e.g. with `scp` or `rsync`) and tap rescan.

## Notes

- Progress saves every few seconds while playing and on every pause/seek, so
  positions survive closed tabs and dead batteries.
- The other person's marker updates every ~10 s while you're in the player; a
  pulsing dot means they're listening right now.
- On iOS, open the site in Safari and use Share → Add to Home Screen to get
  the full-screen app with lock-screen controls.
