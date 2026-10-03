# FNO Analyzer V2

V2 is an independent deployment package. It does not import from or modify the V1 directory. The working Python service and vanilla browser client from V1 were reorganized into a smaller application with isolated AOC and Dhan adapters.

The experimental `DHAN_SCRAPER` React/Express project, probe scripts, credential extractor, and captured request material are not part of V2. Dhan scanx access is implemented by one provider module.

## Structure

```text
FNO_ANALYZER_V2/
├── config.json
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── src/fno_analyzer/
│   ├── application.py
│   ├── config.py
│   ├── errors.py
│   ├── http_server.py
│   ├── providers/
│   │   ├── aoc.py
│   │   └── dhan.py
│   └── services/
│       ├── metrics.py
│       └── symbol_map.py
├── data/dhan_map.json
├── scripts/
├── tests/
├── deploy/
│   ├── nginx/
│   ├── systemd/
│   └── fno-analyzer.env.example
├── Dockerfile
├── compose.yml
├── pyproject.toml
└── requirements.txt
```

## Configuration

`config.json` is the only application configuration file. It contains both AOC and Dhan settings, with secrets blank by design. Do not put the V1 token or JWT into source control.

Environment variables override the secret fields:

| Variable | Purpose |
| --- | --- |
| `FNO_AOC_TOKEN` | AOC bearer token |
| `FNO_DHAN_JWT` | Dhan `JWTtoken` from the options-trader session |
| `FNO_DHAN_ENTITY_ID` | Dhan entity id used for symbol searches |
| `FNO_DHAN_CLIENT_ID` | Dhan client id when required by the account |
| `FNO_DATA_DIR` | Writable directory for the generated Dhan map |
| `FNO_SERVER_HOST` | Bind address; keep loopback behind a proxy |
| `FNO_SERVER_PORT` | Application port |

`providers.dhan.authorisation` is sent literally in the Dhan `authorisation` header. The default is `Token`; the JWT is sent separately in the `auth` header. This avoids the duplicated `Token Token` header produced by V1.

## Local development

```bash
cd FNO_ANALYZER_V2
python -m venv .venv
.venv/Scripts/activate
python -m pip install -r requirements.txt
set FNO_AOC_TOKEN=your-aoc-token
set FNO_DHAN_JWT=your-dhan-jwt
set FNO_DHAN_ENTITY_ID=your-entity-id
python run.py
```

On Linux or macOS, use `export` instead of `set`. Open `http://127.0.0.1:8000`.

The V2 symbol map is already present as a generated cache. Rebuild it with:

```bash
python scripts/build_symbol_map.py
```

The map is written atomically to `data/dhan_map.json`. A persistent data directory should be used in production.

## API

The browser API remains compatible with V1:

- `/api/health`, `/api/ready`, `/api/config`
- `/api/tickers`, `/api/expiries`, `/api/data`, `/api/historical`
- `/api/dhan/map`, `/api/dhan/chain`, `/api/dhan/ivpivr`, `/api/dhan/skew`, `/api/dhan/term`
- `/api/sectors`, `/api/sectors/intraday`, `/api/sectors/components`

Errors use HTTP `400`, `404`, `502`, `503`, or `504` as appropriate and return an `error` message plus a stable `code`.

## EC2 deployment with Docker

Install Docker and Docker Compose on the EC2 host, then:

```bash
cd /opt/fno-analyzer
cp deploy/fno-analyzer.env.example .env
chmod 600 .env
```

Put the AOC and Dhan secrets in `.env`, build, and start:

```bash
docker compose build
docker compose up -d
curl http://127.0.0.1:8000/api/health
```

The service is deliberately published on `127.0.0.1:8000`; do not publish the authenticated upstream proxy directly to the internet.

Install Nginx, copy `deploy/nginx/fno-analyzer.conf` to `/etc/nginx/sites-available/fno-analyzer`, replace `fno.example.com` with the actual subdomain, enable the site, and reload Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/fno-analyzer /etc/nginx/sites-enabled/fno-analyzer
sudo nginx -t
sudo systemctl reload nginx
```

For HTTPS, point the DNS record at the EC2 public IP, install Certbot, obtain a certificate, and use `deploy/nginx/fno-analyzer-tls.conf` with the real hostname and certificate paths. Put authentication at Nginx or an identity-aware proxy before exposing the dashboard publicly.

## EC2 deployment with systemd

Create an unprivileged `fno` user, copy V2 to `/opt/fno-analyzer`, and create a virtual environment:

```bash
sudo useradd --system --home /opt/fno-analyzer --shell /usr/sbin/nologin fno || true
sudo python3 -m venv /opt/fno-analyzer/.venv
sudo /opt/fno-analyzer/.venv/bin/pip install -r /opt/fno-analyzer/requirements.txt
sudo install -d -o fno -g fno -m 750 /etc/fno-analyzer
sudo install -d -o fno -g fno -m 750 /var/lib/fno-analyzer
sudo cp /opt/fno-analyzer/deploy/fno-analyzer.env.example /etc/fno-analyzer/fno-analyzer.env
sudo chown root:fno /etc/fno-analyzer/fno-analyzer.env
sudo chmod 640 /etc/fno-analyzer/fno-analyzer.env
sudo cp /opt/fno-analyzer/deploy/systemd/fno-analyzer.service /etc/systemd/system/fno-analyzer.service
sudo systemctl daemon-reload
sudo systemctl enable --now fno-analyzer
```

Edit `/etc/fno-analyzer/fno-analyzer.env`, add the secrets, then run `sudo systemctl restart fno-analyzer`. Use the same Nginx virtual host to proxy to `127.0.0.1:8000`.

## Validation

```bash
python -m compileall -q run.py src tests
node --check frontend/app.js
python -m unittest discover -s tests -v
```

The V2 service is ready when `/api/health` returns `200`. `/api/ready` returns `503` until at least one provider has a secret configured. Rotate any credentials that were present in the V1 files before deploying V2.
