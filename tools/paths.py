"""Where the secrets folder is on this machine. MIDKNIGHT_SECRETS wins, then ~/.cloudflare."""
import os

SECRETS = os.environ.get("MIDKNIGHT_SECRETS") or os.path.join(os.path.expanduser("~"), ".cloudflare")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "tools", "out")


def _desk():
    """The hosted desk's address, from tools/desk-url.txt. DESK_URL wins when set."""
    url = os.environ.get("DESK_URL")
    if not url:
        with open(os.path.join(REPO, "tools", "desk-url.txt"), encoding="utf-8") as f:
            url = f.read()
    return url.strip().rstrip("/")


DESK = _desk()
