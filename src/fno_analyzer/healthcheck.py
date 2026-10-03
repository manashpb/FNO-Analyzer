import json
import os
from urllib.request import urlopen


url = os.getenv("FNO_HEALTHCHECK_URL", "http://127.0.0.1:8000/api/health")
with urlopen(url, timeout=4) as response:
    payload = json.loads(response.read().decode("utf-8"))
    if response.status != 200 or payload.get("status") != "ok":
        raise SystemExit(1)
