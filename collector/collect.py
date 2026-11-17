"""X トピックレポート 収集スクリプト（標準ライブラリのみ）。

topics.json のトピックごとに FxTwitter(FxEmbed) の公開 API から X の投稿を取得し、
docs/data/ に JSON として保存する。GitHub Actions の cron から周期実行され、
GitHub Pages 上の docs/index.html がその JSON を読んでレポートを表示する。

    python collector/collect.py              # 収集間隔に達したトピックだけ収集
    python collector/collect.py --force      # 間隔を無視して全トピックを収集
    python collector/collect.py --topic ID   # 指定トピックだけ収集
"""
import argparse
import html
import ipaddress
import json
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "topics.json"
DATA = ROOT / "docs" / "data"

FX_API = "https://api.fxtwitter.com/2"
USER_AGENT = "x-topic-report/1.0 (personal non-commercial aggregator)"
FX_MIN_GAP = 1.5           # FxTwitter へのリクエスト間隔（秒）
MIN_INTERVAL_MIN = 15      # トピックごとの最短収集間隔（分）
MAX_PAGES = 5              # 1 回の収集で検索をたどる最大ページ数（1 ページ約 20 件）
MAX_POSTS_PER_TOPIC = 1500
TITLE_FETCH_PER_RUN = 12   # 1 回の収集でタイトルを取りに行くリンク数の上限
DEFAULT_SETTINGS = {"retention_days": 30, "text_limit": 280}


# ---------------------------------------------------------------- FxTwitter

class FxError(Exception):
    pass


_fx_last = 0.0


def fx_get(path, params=None):
    """FxTwitter API を間隔を空けて呼ぶ。失敗は FxError。"""
    global _fx_last
    url = FX_API + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v})
    wait = FX_MIN_GAP - (time.time() - _fx_last)
    if wait > 0:
        time.sleep(wait)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise FxError("FxTwitter のレート制限 (429)。次回の周期で再試行します") from e
        raise FxError(f"FxTwitter API エラー (HTTP {e.code})") from e
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise FxError(f"FxTwitter に接続できません: {e}") from e
    finally:
        _fx_last = time.time()


X_HOSTS = ("x.com", "twitter.com", "t.co")
URL_RE = re.compile(r"https?://[^\s<>\"'　-￿]+")
TRACKING = re.compile(r"^(utm_\w+|fbclid|gclid|ref_src)$")


def clean_url(u):
    u = u.rstrip(".,;:!?)]}")
    try:
        p = urllib.parse.urlsplit(u)
    except ValueError:
        return None
    host = (p.hostname or "").lower()
    if not host or "." not in host:
        return None
    if any(host == h or host.endswith("." + h) for h in X_HOSTS):
        return None
    query = "&".join(kv for kv in p.query.split("&") if kv and not TRACKING.match(kv.split("=")[0]))
    return urllib.parse.urlunsplit((p.scheme, p.netloc, p.path, query, ""))


def normalize_post(r, text_limit):
    if not isinstance(r, dict) or not r.get("id") or r.get("type", "status") != "status":
        return None
    author = r.get("author") or {}
    text = r.get("text") or ""
    links = []
    for m in URL_RE.findall(text):
        u = clean_url(m)
        if u and u not in links:
            links.append(u)
    article = r.get("article") if isinstance(r.get("article"), dict) else {}
    handle = author.get("screen_name") or ""
    return {
        "id": str(r["id"]),
        "url": r.get("url") or f"https://x.com/{handle}/status/{r['id']}",
        "handle": handle,
        "name": author.get("name") or handle,
        "full_text": text,  # キーワード判定用。保存前に取り除く
        "text": text if len(text) <= text_limit else text[:text_limit] + "…",
        "ts": int(r.get("created_timestamp") or 0),
        "lang": r.get("lang") or "",
        "likes": int(r.get("likes") or 0),
        "reposts": int(r.get("reposts") or r.get("retweets") or 0),
        "replies": int(r.get("replies") or 0),
        "quotes": int(r.get("quotes") or 0),
        "views": int(r.get("views") or 0),
        "article_title": article.get("title") or "",
        "links": links,
        "hashtags": list(dict.fromkeys(re.findall(r"[#＃](\w+)", text))),
    }


# ---------------------------------------------------------------- リンク先タイトル

def is_public_host(host):
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0]).is_global for i in infos)


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        p = urllib.parse.urlsplit(newurl)
        if p.scheme not in ("http", "https") or not is_public_host(p.hostname or ""):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(SafeRedirect)


def fetch_title(url):
    """記事ページの og:title / <title> を取得する。取れなければ空文字。"""
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https") or not is_public_host(p.hostname or ""):
        return ""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; x-topic-report/1.0)", "Accept": "text/html"})
        with _opener.open(req, timeout=8) as r:
            if "html" not in (r.headers.get("Content-Type") or ""):
                return ""
            raw = r.read(150_000)
            charset = r.headers.get_content_charset()
    except Exception:
        return ""
    if not charset:
        m = re.search(rb"charset=[\"']?([\w-]+)", raw[:4000], re.I)
        charset = m.group(1).decode("ascii") if m else "utf-8"
    try:
        doc = raw.decode(charset, "replace")
    except LookupError:
        doc = raw.decode("utf-8", "replace")
    m = (re.search(r"<meta[^>]+property=[\"']og:title[\"'][^>]*content=[\"']([^\"']+)", doc, re.I)
         or re.search(r"<meta[^>]+content=[\"']([^\"']+)[\"'][^>]*property=[\"']og:title", doc, re.I)
         or re.search(r"<title[^>]*>(.*?)</title>", doc, re.I | re.S))
    return re.sub(r"\s+", " ", html.unescape(m.group(1))).strip()[:200] if m else ""


def fetch_missing_titles(state):
    titles = state["titles"]
    todo = []
    for p in sorted(state["posts"], key=lambda p: -(p["likes"] + p["reposts"] * 2)):
        for u in p["links"]:
            if u not in titles and u not in todo:
                todo.append(u)
    for u in todo[:TITLE_FETCH_PER_RUN]:
        titles[u] = fetch_title(u)
        time.sleep(0.5)
    used = {u for p in state["posts"] for u in p["links"]}
    state["titles"] = {u: t for u, t in titles.items() if u in used}


# ---------------------------------------------------------------- 設定

class ConfigError(Exception):
    pass


def as_list(v):
    if isinstance(v, str):
        v = re.split(r"[\s,、]+", v)
    return [str(x).strip() for x in (v or []) if str(x).strip()]


def clean_topic(d):
    tid = str(d.get("id") or "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,39}", tid):
        raise ConfigError(f"id は半角英小文字・数字・ハイフンで指定してください: {tid!r}")
    accounts = []
    for a in as_list(d.get("accounts")):
        a = re.sub(r"^(https?://)?(www\.)?(x|twitter)\.com/", "", a).lstrip("@").split("/")[0]
        if not re.fullmatch(r"\w{1,15}", a, re.A):
            raise ConfigError(f"[{tid}] アカウント名が不正です: {a}")
        accounts.append(a)
    query = str(d.get("query") or "").strip()
    if not query and not accounts:
        raise ConfigError(f"[{tid}] query か accounts のどちらかを指定してください")
    lang = str(d.get("lang") or "").strip().lower()
    if lang and not re.fullmatch(r"[a-z]{2,3}", lang):
        raise ConfigError(f"[{tid}] lang は ja / en などの形式で指定してください")

    def num(key, default, lo, hi):
        try:
            return max(lo, min(hi, int(d.get(key, default))))
        except (TypeError, ValueError):
            raise ConfigError(f"[{tid}] {key} は数値で指定してください")

    return {
        "id": tid, "name": str(d.get("name") or tid)[:80], "query": query[:400],
        "accounts": accounts[:20], "keywords": as_list(d.get("keywords"))[:30], "lang": lang,
        "min_likes": num("min_likes", 0, 0, 1_000_000),
        "feed": "latest" if d.get("feed") == "latest" else "top",
        "include_replies": bool(d.get("include_replies")),
        "interval_min": num("interval_min", 60, MIN_INTERVAL_MIN, 10080),
        "max_pages": num("max_pages", 2, 1, MAX_PAGES),
        "enabled": d.get("enabled", True) is not False,
    }


def load_config():
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ConfigError(f"topics.json を読めません: {e}")
    settings = DEFAULT_SETTINGS | (cfg.get("settings") or {})
    topics = [clean_topic(t) for t in cfg.get("topics") or []]
    ids = [t["id"] for t in topics]
    if len(ids) != len(set(ids)):
        raise ConfigError("トピックの id が重複しています")
    return settings, topics


def build_query(t):
    q = t["query"]
    if not q:
        return ""
    if t["lang"] and "lang:" not in q:
        q += f" lang:{t['lang']}"
    if t["min_likes"] and "min_faves:" not in q:
        q += f" min_faves:{t['min_likes']}"
    if not t["include_replies"] and "filter:replies" not in q:
        q += " -filter:replies"
    return q


# ---------------------------------------------------------------- 収集

def load_state(tid):
    try:
        s = json.loads((DATA / f"{tid}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        s = {}
    return {"posts": s.get("posts") or [], "titles": s.get("titles") or {}, "runs": s.get("runs") or [],
            "last_run_at": s.get("last_run_at") or 0, "last_status": s.get("last_status") or ""}


def collect(topic, state, settings):
    started = int(time.time())
    by_id = {p["id"]: p for p in state["posts"]}
    found = new = 0
    errors = []

    def save(results, source, keywords=()):
        nonlocal found, new
        for p in filter(None, (normalize_post(r, settings["text_limit"]) for r in results or [])):
            full = p.pop("full_text").lower()
            if keywords and not any(k.lower() in full for k in keywords):
                continue
            found += 1
            old = by_id.get(p["id"])
            if old:
                p["first_seen"], p["source"] = old["first_seen"], old["source"]
            else:
                p["first_seen"], p["source"] = started, source
                new += 1
            by_id[p["id"]] = p

    q = build_query(topic)
    if q:
        cursor = None
        try:
            for _ in range(topic["max_pages"]):
                d = fx_get("/search", {"q": q, "feed": topic["feed"], "cursor": cursor})
                save(d.get("results"), "search")
                cursor = (d.get("cursor") or {}).get("bottom")
                if not d.get("results") or not cursor:
                    break
        except FxError as e:
            errors.append(f"検索: {e}")
    for handle in topic["accounts"]:
        try:
            save(fx_get(f"/profile/{handle}/statuses").get("results"), f"@{handle}", topic["keywords"])
        except FxError as e:
            errors.append(f"@{handle}: {e}")

    cutoff = started - settings["retention_days"] * 86400
    posts = [p for p in by_id.values() if not p["ts"] or p["ts"] >= cutoff]
    posts.sort(key=lambda p: -p["ts"])
    state["posts"] = posts[:MAX_POSTS_PER_TOPIC]
    fetch_missing_titles(state)

    error = " / ".join(errors)
    now = int(time.time())
    state["runs"] = [{"started_at": started, "finished_at": now, "found": found, "new": new,
                      "error": error}] + state["runs"][:19]
    state["last_run_at"] = now
    state["last_status"] = error or f"OK: {found} 件取得 / 新規 {new} 件"
    return not error


def write_json(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--force", action="store_true", help="収集間隔を無視して収集する")
    ap.add_argument("--topic", help="このトピック id だけ収集する")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        settings, topics = load_config()
    except ConfigError as e:
        sys.exit(f"設定エラー: {e}")
    DATA.mkdir(parents=True, exist_ok=True)

    index = []
    for t in topics:
        state = load_state(t["id"])
        due = time.time() - state["last_run_at"] >= t["interval_min"] * 60 - 300  # cron の揺れを 5 分許容
        selected = args.topic == t["id"] if args.topic else (t["enabled"] and (due or args.force))
        if selected:
            ok = collect(t, state, settings)
            print(f"[{t['id']}] {'' if ok else 'ERROR '}{state['last_status']}")
        else:
            print(f"[{t['id']}] skip")
        public = t | {"built_query": build_query(t)}
        write_json(DATA / f"{t['id']}.json", {"topic": public, **state})
        index.append(public | {"post_count": len(state["posts"]), "last_run_at": state["last_run_at"],
                               "last_status": state["last_status"]})
    keep = {f"{t['id']}.json" for t in topics} | {"index.json"}
    for f in DATA.glob("*.json"):
        if f.name not in keep:
            f.unlink()  # topics.json から消されたトピックのデータ
    write_json(DATA / "index.json", {"generated_at": int(time.time()), "settings": settings, "topics": index})


if __name__ == "__main__":
    main()
