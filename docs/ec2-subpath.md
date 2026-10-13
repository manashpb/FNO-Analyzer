# EC2: FNO Analyzer beside the trading journal

Target: `http://52.66.251.235/fnoanalyzer/`, repository
`https://github.com/manashpb/FNO-Analyzer`, branch `main`.
The supplied server output shows Ubuntu, Python 3.14, Nginx on port 80 and the
journal backend on port 5000. FNO uses loopback port 8001. These instructions
use systemd. They do not replace the existing journal server block.

## 1. Publish the local changes

Push the frontend relative-URL changes and the deployment files to `main` before
cloning on EC2. Keep local credentials out of the commit. Review the files being
staged; do not blindly stage the whole local workspace. The server must receive
the updated frontend for subpath routing to work.

## 2. Install on EC2

Run these commands over SSH on the EC2 server:

```bash
sudo apt-get update
sudo apt-get install -y git python3-venv
sudo git clone --branch main https://github.com/manashpb/FNO-Analyzer.git /opt/fno-analyzer
id fno >/dev/null 2>&1 || sudo useradd --system --home /opt/fno-analyzer --shell /usr/sbin/nologin fno
sudo python3 -m venv /opt/fno-analyzer/.venv
sudo /opt/fno-analyzer/.venv/bin/pip install -r /opt/fno-analyzer/requirements.txt
sudo install -d -o root -g fno -m 750 /etc/fno-analyzer
sudo install -d -o fno -g fno -m 750 /var/lib/fno-analyzer
printf '%s\n' '{}' | sudo tee /etc/fno-analyzer/config.json >/dev/null
sudo chmod 644 /etc/fno-analyzer/config.json
sudo install -o root -g fno -m 640 /opt/fno-analyzer/deploy/fno-analyzer-subpath.env.example /etc/fno-analyzer/fno-analyzer.env
sudo nano /etc/fno-analyzer/fno-analyzer.env
```

Fill in the provider credential values in the editor. Do not paste credentials
into chat or commands. `FNO_DHAN_AUTHORISATION` is `Token`, separately from the
JWT. The environment file selects v27 for AOC and uses the empty external JSON
config plus application defaults, so the repository's local config is not used.

Keep the existing generated symbol map for fast startup, if it is in the clone:

```bash
if [ -f /opt/fno-analyzer/data/dhan_map.json ]; then
    sudo install -o fno -g fno -m 640 /opt/fno-analyzer/data/dhan_map.json /var/lib/fno-analyzer/dhan_map.json
fi
```

If the map is absent, transfer your existing `data/dhan_map.json` to this runtime
path and give it ownership `fno:fno`. The app falls back to AOC for its universe
when no saved map exists. Do not unnecessarily rebuild the entire map.
To retain historical OI, stop the local app before copying its SQLite database
(or create a consistent SQLite backup), transfer that backup separately, and
install it as `/var/lib/fno-analyzer/oi_history.sqlite3` owned by `fno:fno`.
Do not copy an actively written database file by itself.

## 3. Start the service

```bash
sudo cp /opt/fno-analyzer/deploy/systemd/fno-analyzer.service /etc/systemd/system/fno-analyzer.service
sudo systemctl daemon-reload
sudo systemctl enable --now fno-analyzer
sudo systemctl status fno-analyzer --no-pager
curl -f http://127.0.0.1:8001/api/health
curl -f http://127.0.0.1:8001/api/ready
```

The supplied service's environment file overrides its default config path with
`FNO_CONFIG=/etc/fno-analyzer/config.json`. Persistent data is in
`/var/lib/fno-analyzer`, which the service permits writing. The code and static
files stay under `/opt/fno-analyzer`.

The existing project tests should also pass with EC2's Python interpreter:

```bash
cd /opt/fno-analyzer
sudo .venv/bin/python -m unittest discover -s tests
```

Python 3.14 on EC2 has not been verified locally; run the suite before exposing
the app. A failing health check or service startup can be investigated with
`sudo journalctl -u fno-analyzer -n 80 --no-pager`. Inspect logs locally; redact
any sensitive material before sharing them.

## 4. Add the Nginx route

Back up the existing configuration outside `conf.d`, since its `*.conf` files
are all loaded by Nginx:

```bash
sudo cp /etc/nginx/conf.d/trading-journal.conf /etc/nginx/trading-journal.conf.before-fno
sudo install -d -m 755 /etc/nginx/snippets
sudo install -m 644 /opt/fno-analyzer/deploy/nginx/fno-analyzer-subpath.conf /etc/nginx/snippets/fno-analyzer-subpath.conf
sudo nano /etc/nginx/conf.d/trading-journal.conf
```

Inside the existing `server { ... }`, add:

```nginx
include /etc/nginx/snippets/fno-analyzer-subpath.conf;
```

The result is:

```nginx
server {
    listen 80 default_server;
    server_name _;

    root /home/ubuntu/DATA/TRADING_JOURNALS/Prop-Journal/client/dist;
    index index.html;

    include /etc/nginx/snippets/fno-analyzer-subpath.conf;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 60m;
    }

    location /snapshots {
        proxy_pass http://127.0.0.1:5000;
    }
}
```

The snippet redirects `/fnoanalyzer` to `/fnoanalyzer/` and strips this prefix
when proxying. The browser requests `/fnoanalyzer/static/...` and
`/fnoanalyzer/api/...`; Nginx forwards `/static/...` and `/api/...` to port 8001.
Your journal's `/api` stays on port 5000.

Validate, reload and check both apps:

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -f http://127.0.0.1/fnoanalyzer/api/health
curl -f http://127.0.0.1/fnoanalyzer/static/app.js -o /dev/null
curl -I http://127.0.0.1/fnoanalyzer
curl -I http://127.0.0.1/dashboard
```

Open the public FNO URL and confirm Live, watchlists and scanner status load.
Frontend requests should stay under `/fnoanalyzer/` in browser Network tools.
No EC2 inbound rule for port 8001 is needed. Keep the backend bound to loopback.
Before exposing the dashboard broadly, apply the repository's Nginx authentication
and HTTPS recommendation. Plain HTTP clipboard copying may be unavailable;
the watchlist export selects the string for manual Ctrl+C in that case.

## 5. Updates and rollback

For later updates (when the checkout is clean):

```bash
sudo git -C /opt/fno-analyzer pull --ff-only origin main
sudo /opt/fno-analyzer/.venv/bin/pip install -r /opt/fno-analyzer/requirements.txt
sudo systemctl restart fno-analyzer
```

Reload the browser after frontend changes. Secrets and persistent data are outside
the checkout. To remove the Nginx integration using the saved original configuration:

```bash
sudo cp /etc/nginx/trading-journal.conf.before-fno /etc/nginx/conf.d/trading-journal.conf
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop fno-analyzer
```
