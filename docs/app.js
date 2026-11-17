"use strict";
// トピックレポート: docs/data/*.json（GitHub Actions が周期収集）を表示し、
// タグの追加・編集は GitHub API で topics.json に書き戻して定期調査へ反映する。

const $ = (id) => document.getElementById(id);
const PAGE = 30;
const WINDOWS = [
  { hours: 1, label: "1時間", def: 10 },
  { hours: 24, label: "24時間", def: 100 },
  { hours: 168, label: "1週間", def: 300 },
];
const winLabel = (h) => (WINDOWS.find((w) => w.hours === h) || { label: "すべて" }).label;
const LANGS = [["", "指定なし"], ["ja", "日本語"], ["en", "英語"]];
const INTERVALS = [[60, "1時間ごと"], [180, "3時間ごと"], [360, "6時間ごと"], [720, "12時間ごと"], [1440, "24時間ごと"]];

const state = { index: null, data: null, tagId: null, win: 24, view: "rank", shown: PAGE, live: null,
                deleted: new Set(), indexAt: 0, autoTranslate: false };

// ---------------------------------------------------------------- 小道具

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(3)) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
}
// 外部リンクは http(s) のみ許可する
function link(url, props, ...kids) {
  const ok = /^https?:\/\//i.test(url || "");
  return el("a", { ...props, href: ok ? url : null, target: "_blank", rel: "noopener noreferrer" }, ...kids);
}
const num = (n) => (n || 0).toLocaleString("ja-JP");
const fmtDate = (ts) => ts ? new Date(ts * 1000).toLocaleString("ja-JP",
  { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
function ago(ts) {
  if (!ts) return "未収集";
  const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  return m < 1 ? "たった今" : m < 60 ? `${m}分前` : m < 1440 ? `${Math.round(m / 60)}時間前` : `${Math.round(m / 1440)}日前`;
}
const postTime = (ts) => (Date.now() / 1000 - ts < 86400 ? ago(ts) : fmtDate(ts));
const score = (p) => p.likes + p.reposts * 2 + p.quotes * 2 + p.replies;
function excerpt(text, n = 150) {
  const s = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n) + "…";
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 5000);
}

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem("xtr." + key)) ?? fallback; } catch { return fallback; } },
  set(key, v) { try { localStorage.setItem("xtr." + key, JSON.stringify(v)); } catch { /* 保存できない環境では無視 */ } },
};
const token = () => store.get("token", "");
const pending = () => store.get("pending", []);

async function getJSON(path) {
  const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- GitHub（タグの書き戻し）

function repo() {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/);
  const name = location.pathname.split("/")[1];
  return m && name ? `${m[1]}/${name}` : (state.index && state.index.repo) || "";
}

async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${repo()}${path}`, {
    method: opts.method || "GET", body: opts.body, cache: "no-store",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${opts.token || token()}`,
               ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (r.status === 401) throw new Error("トークンが無効です。「設定」から登録し直してください。");
  if (r.status === 403 || r.status === 404) {
    throw new Error("リポジトリに書き込めません。トークンの対象リポジトリと権限（Contents: Read and write）を確認してください。");
  }
  if (!r.ok) throw Object.assign(new Error(`GitHub API エラー (HTTP ${r.status})`), { status: r.status });
  return r.json();
}
const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
const b64encode = (s) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));

// topics.json を読み、mutate で書き換えてコミットする。push により収集ワークフローが走る
async function updateConfig(mutate, message) {
  for (let attempt = 0; ; attempt++) {
    const file = await gh("/contents/topics.json?ref=main");
    const cfg = JSON.parse(b64decode(file.content));
    cfg.topics = cfg.topics || [];
    mutate(cfg);
    try {
      await gh("/contents/topics.json", { method: "PUT", body: JSON.stringify({
        message, sha: file.sha, branch: "main", content: b64encode(JSON.stringify(cfg, null, 2) + "\n") }) });
      return;
    } catch (e) {
      if (e.status !== 409 || attempt) throw e;  // 同時更新は 1 回だけ読み直して再試行
    }
  }
}

// ---------------------------------------------------------------- FxTwitter（ブラウザからのライブ検索）

function normalizePost(r) {
  if (!r || !r.id || (r.type && r.type !== "status")) return null;
  const a = r.author || {}, text = r.text || "";
  const links = [...new Set((text.match(/https?:\/\/[^\s<>"'　-￿]+/g) || [])
    .map((u) => u.replace(/[.,;:!?)\]}]+$/, ""))
    .filter((u) => !/(^|\.)(x\.com|twitter\.com|t\.co)$/.test(hostOf(u))))];
  return {
    id: String(r.id), url: r.url || `https://x.com/${a.screen_name}/status/${r.id}`,
    handle: a.screen_name || "", name: a.name || a.screen_name || "", text,
    ts: r.created_timestamp || 0, lang: r.lang || "", likes: r.likes || 0, reposts: r.reposts || r.retweets || 0,
    replies: r.replies || 0, quotes: r.quotes || 0, views: r.views || 0,
    article_title: (r.article && r.article.title) || "", links,
    hashtags: [...new Set((text.match(/[#＃][\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1)))],
    source: "search", first_seen: 0,
  };
}

async function runLive() {
  const L = state.live;
  if (!L || !L.q) return;
  const seq = (L.seq = (L.seq || 0) + 1);
  L.loading = true; L.error = "";
  render();
  const q = [L.q, L.lang && `lang:${L.lang}`, "-filter:replies", L.minFaves > 0 && `min_faves:${L.minFaves}`,
             `within_time:${L.hours}h`].filter(Boolean).join(" ");
  try {
    const r = await fetch(`https://api.fxtwitter.com/2/search?feed=top&q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(r.status === 429 ? "アクセスが集中しています。少し待って再度お試しください。" : `検索に失敗しました (HTTP ${r.status})`);
    const since = Date.now() / 1000 - L.hours * 3600;
    const posts = ((await r.json()).results || []).map(normalizePost)
      .filter((p) => p && p.likes >= L.minFaves && p.ts >= since);
    if (state.live !== L || L.seq !== seq) return;
    L.posts = posts;
  } catch (e) {
    if (state.live !== L || L.seq !== seq) return;
    L.posts = []; L.error = e.message || "検索に失敗しました";
  }
  L.loading = false;
  render();
}

// ---------------------------------------------------------------- 翻訳
// ブラウザ内蔵の Translator API（Chrome / Edge）を使う。翻訳は端末内で行われ、無料で API キーも不要。
// 非対応のブラウザでは Google 翻訳を開くリンクを代わりに出す。

const TARGET = (navigator.language || "ja").split("-")[0].toLowerCase();
const canTranslate = "Translator" in self;
const NO_LANG = new Set(["", "und", "zxx", "art", "qme", "qam", "qct", "qht", "qst"]);  // X が言語を判定できなかった投稿
const LANG_FIX = { in: "id", iw: "he", "zh-cn": "zh", "zh-tw": "zh-Hant" };
function srcLang(p) {
  const l = (p.lang || "").toLowerCase();
  return NO_LANG.has(l) ? "" : LANG_FIX[l] || l;
}
const isForeign = (p) => { const l = srcLang(p); return !!l && l !== TARGET; };
function langName(code) {
  try { return new Intl.DisplayNames(["ja"], { type: "language" }).of(code) || code; } catch { return code; }
}

let translatorDown = false;      // 内蔵翻訳が応答しない環境だと分かったら true
const translators = new Map();   // 言語コード -> Promise<Translator>
const translations = new Map();  // 投稿 id -> 訳文
function getTranslator(lang) {
  if (!translators.has(lang)) {
    const ready = (async () => {
      const pair = { sourceLanguage: lang, targetLanguage: TARGET };
      // API はあっても応答しない環境があるので、一定時間で見切ってリンクでの翻訳に切り替える
      const status = await Promise.race([Translator.availability(pair),
        new Promise((resolve) => setTimeout(() => { translatorDown = true; resolve("unavailable"); }, 8000))]);
      if (status === "unavailable") throw new Error(`このブラウザでは${langName(lang)}を翻訳できません`);
      if (status !== "available") toast(`${langName(lang)}の翻訳モデルを準備しています（初回のみ）`);
      return Translator.create(pair);
    })();
    ready.catch(() => translators.delete(lang));
    translators.set(lang, ready);
  }
  return translators.get(lang);
}
async function translatePost(p) {
  if (!translations.has(p.id)) {
    translations.set(p.id, await (await getTranslator(srcLang(p))).translate(p.text));
  }
  return translations.get(p.id);
}

// 投稿 1 件ぶんの翻訳ボタン。body は本文の要素で、訳文と原文を差し替える
function translateControl(p, body) {
  if (!isForeign(p)) return null;
  const external = () => link(
    `https://translate.google.com/?sl=auto&tl=${TARGET}&op=translate&text=${encodeURIComponent(p.text)}`,
    { class: "tr-btn" }, "Google 翻訳で開く");
  if (!canTranslate || translatorDown) return external();
  const btn = el("button", { type: "button", class: "tr-btn" }, "翻訳");
  let shown = false;
  const toggle = async (quiet) => {
    if (shown) {
      shown = false; body.textContent = p.text; btn.textContent = "翻訳";
      return;
    }
    btn.disabled = true; btn.textContent = "翻訳中…";
    try {
      body.textContent = await translatePost(p);
      shown = true; btn.textContent = `原文を表示（${langName(srcLang(p))}から翻訳）`;
    } catch (e) {
      if (e.name === "NotAllowedError") {  // モデルの初回ダウンロードにはユーザー操作が必要
        btn.textContent = "翻訳";
        if (!quiet) toast("翻訳モデルの準備が必要です。もう一度「翻訳」を押してください");
      } else {
        btn.replaceWith(external());  // 内蔵翻訳が使えない言語・環境では外部の翻訳ページへ
        if (!quiet) toast(e.message || "翻訳できませんでした");
        return;
      }
    }
    btn.disabled = false;
  };
  btn.addEventListener("click", () => toggle(false));
  if (state.autoTranslate) toggle(true);
  return btn;
}

// ---------------------------------------------------------------- フィルター
// 表示中の投稿を「含むワード」「除外ワード」で絞り込む。タグごとにこのブラウザへ保存する

const splitWords = (s) => (s || "").split(/[\s,、]+/).map((w) => w.toLowerCase()).filter(Boolean);
function getFilter() {
  return (state.live ? state.live.filter : store.get("filters", {})[state.tagId]) || { include: "", exclude: "" };
}
function setFilter(f) {
  if (state.live) state.live.filter = f;
  else store.set("filters", { ...store.get("filters", {}), [state.tagId]: f });
}
const filterWords = () => splitWords(getFilter().include).length + splitWords(getFilter().exclude).length;
function applyFilter(posts) {
  const inc = splitWords(getFilter().include), exc = splitWords(getFilter().exclude);
  if (!inc.length && !exc.length) return posts;
  return posts.filter((p) => {
    const hay = `${p.text} @${p.handle} ${p.name}`.toLowerCase();
    return (!inc.length || inc.some((w) => hay.includes(w))) && !exc.some((w) => hay.includes(w));
  });
}

function filterSheet() {
  const cur = getFilter();
  const inc = el("input", { type: "text", id: "f-inc", placeholder: "例: 発表 リリース", value: cur.include });
  const exc = el("input", { type: "text", id: "f-exc", placeholder: "例: PR 懸賞 @spam_account", value: cur.exclude });
  const body = [
    group("抽出", row("含むワード", inc, "f-inc")),
    el("p", { class: "hint" }, "いずれかのワードを含む投稿だけを表示します。"),
    group("除外", row("除外ワード", exc, "f-exc")),
    el("p", { class: "hint" }, "いずれかのワードを含む投稿を非表示にします。ワードはスペースかカンマで区切り、大文字と小文字は区別しません。本文のほか投稿者名・@アカウント名にも一致します。"),
    filterWords() > 0 && el("button", { type: "button", class: "btn block destructive",
      onclick: () => { setFilter({ include: "", exclude: "" }); $("sheet").close(); state.shown = PAGE; render(); } }, "フィルターを解除"),
  ];
  openSheet({ title: "フィルター", confirm: "適用", body, onConfirm: async () => {
    setFilter({ include: inc.value.trim(), exclude: exc.value.trim() });
    state.shown = PAGE;
    render();
  } });
}

function toolButtons() {
  const n = filterWords();
  return el("div", { class: "tools" },
    el("button", { type: "button", class: "btn", "aria-pressed": String(n > 0), onclick: filterSheet },
      n ? `フィルター ${n}` : "フィルター"),
    canTranslate && el("button", { type: "button", class: "btn", "aria-pressed": String(state.autoTranslate),
      title: "外国語の投稿を自動で翻訳して表示します",
      onclick: () => { state.autoTranslate = !state.autoTranslate; store.set("autoTranslate", state.autoTranslate); render(); } },
      "自動翻訳"));
}

function filterNote(total, shown) {
  if (!filterWords()) return null;
  return el("p", { class: "note" }, `フィルター適用中：${num(total)} 件中 ${num(shown)} 件を表示`);
}

// ---------------------------------------------------------------- 集計

function buildReport(posts, titles, lastStart) {
  posts = posts.map((p) => ({ ...p, score: score(p), isNew: lastStart > 0 && p.first_seen >= lastStart }));
  const tags = new Map(), authors = new Map(), articles = new Map();
  for (const p of posts) {
    for (const t of p.hashtags) tags.set(t, (tags.get(t) || 0) + 1);
    const a = authors.get(p.handle) || { handle: p.handle, name: p.name, posts: 0, likes: 0 };
    a.posts++; a.likes += p.likes; authors.set(p.handle, a);
    const refs = p.links.map((u) => [u, titles[u] || "", "link"]);
    if (p.article_title) refs.push([p.url, p.article_title, "x_article"]);
    for (const [url, title, kind] of refs) {
      const art = articles.get(url) || { url, title, kind, likes: 0, score: 0, posts: [] };
      art.likes += p.likes; art.score += p.score; art.posts.push(p); articles.set(url, art);
    }
  }
  const artList = [...articles.values()];
  for (const a of artList) a.posts.sort((x, y) => y.score - x.score);
  artList.sort((a, b) => b.posts.length - a.posts.length || b.score - a.score);
  posts.sort((a, b) => b.score - a.score);
  return {
    posts, articles: artList,
    hashtags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    authors: [...authors.values()].sort((a, b) => b.posts - a.posts || b.likes - a.likes).slice(0, 10),
    stats: { posts: posts.length, articles: artList.length, authors: authors.size,
             likes: posts.reduce((s, p) => s + p.likes, 0), fresh: posts.filter((p) => p.isNew).length },
  };
}

// 期間内かつ、その調査項目の最低いいね数を満たす投稿。基準時刻は最終収集時点
function windowPosts(data, hours) {
  const ref = data.last_run_at || Date.now() / 1000;
  const w = (data.topic.windows || []).find((x) => x.hours === hours);
  return data.posts.filter((p) => (!hours || p.ts >= ref - hours * 3600) &&
    (!w || p.source !== "search" || p.likes >= w.min_faves));
}

function markdown(title, period, rep) {
  const out = [`# ${title} — トピックレポート`, "", `- 期間: ${period}`,
    `- 投稿 ${rep.stats.posts} 件 / 記事 ${rep.stats.articles} 件 / 投稿者 ${rep.stats.authors} 人`, "",
    "## 人気の投稿ランキング", ""];
  rep.posts.forEach((p, i) => out.push(
    `${i + 1}. [@${p.handle} ${fmtDate(p.ts)}](${p.url}) ♥${p.likes} RP${p.reposts} — ${excerpt(p.text, 120)}`));
  out.push("", "## 記事まとめ", "");
  for (const a of rep.articles) {
    out.push(`### [${a.title || a.url}](${a.url})`,
      `${hostOf(a.url)} ・ 言及 ${a.posts.length} 件 ・ いいね計 ${a.likes}`, `> ${excerpt(a.posts[0].text)}`,
      "投稿: " + a.posts.slice(0, 8).map((p) => `[@${p.handle}](${p.url})`).join(" / "), "");
  }
  return out.join("\n") + "\n";
}
function download(name, text) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/markdown" })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- 描画

// 配列や false を含む子要素をまとめて main に描画する
function setMain(...kids) {
  $("main").replaceChildren(...el("div", null, ...kids).childNodes);
}

function allTags() {
  const collected = state.index.topics.filter((t) => !state.deleted.has(t.id));
  const ids = new Set(state.index.topics.map((t) => t.id));
  return [...collected, ...pending().filter((p) => !ids.has(p.id)).map((p) => ({ ...p, pending: true }))];
}

function renderSidebar() {
  const current = state.live ? state.live.pendingId : state.tagId;
  $("sidebar").replaceChildren(
    el("p", { class: "side-title" }, "タグ"),
    el("ul", { class: "tag-list" },
      allTags().map((t) => el("li", null,
        el("button", { type: "button", class: "tag-row", "aria-current": String(t.id === current),
                       onclick: () => selectTag(t.id) },
          el("span", { class: "hash" }, "#"), el("span", { class: "name" }, t.name),
          el("span", { class: "count" }, t.pending ? "収集待ち" : num(t.post_count))))),
      el("li", null, el("button", { type: "button", class: "tag-row add-row", onclick: () => tagSheet() },
        el("span", { class: "name" }, "＋ タグを追加")))));
}

function seg(options, value, onPick, label) {
  return el("div", { class: "seg", role: "group", "aria-label": label },
    options.map(([v, text]) => el("button", { type: "button", "aria-pressed": String(v === value),
      onclick: () => onPick(v) }, text)));
}

function postItem(p, rank) {
  const body = el("p", { class: "p-text" }, p.text);
  return el("li", null,
    el("div", { class: "rank-no", "aria-label": `${rank}位` }, String(rank)),
    el("div", null,
      el("div", { class: "p-head" }, el("b", null, p.name), el("span", null, `@${p.handle} ・ ${postTime(p.ts)}`),
        p.isNew && el("span", { class: "badge" }, "NEW")),
      body,
      el("div", { class: "p-foot" },
        el("span", { class: "likes" }, `♥ ${num(p.likes)}`), el("span", null, `リポスト ${num(p.reposts)}`),
        el("span", null, `返信 ${num(p.replies)}`), p.views > 0 && el("span", null, `表示 ${num(p.views)}`),
        translateControl(p, body), link(p.url, { class: "open" }, "X で開く"))));
}

function rankList(posts, emptyText) {
  if (!posts.length) return el("p", { class: "placeholder" }, emptyText);
  return [
    el("div", { class: "card" }, el("ol", { class: "list rank" }, posts.slice(0, state.shown).map((p, i) => postItem(p, i + 1)))),
    posts.length > state.shown && el("button", { type: "button", class: "btn more",
      onclick: () => { state.shown += PAGE; render(); } }, `さらに表示（残り ${posts.length - state.shown} 件）`),
  ];
}

function articleList(articles) {
  if (!articles.length) return el("p", { class: "placeholder" }, "この期間に記事へのリンクを含む投稿はありません。");
  return el("div", { class: "card" }, el("ul", { class: "list" }, articles.slice(0, 40).map((a) => el("li", null,
    link(a.url, { class: "a-title" }, a.title || a.url),
    el("p", { class: "a-meta" }, el("b", null, `言及 ${a.posts.length} 件`),
      ` ・ ${a.kind === "x_article" ? "X の記事" : hostOf(a.url)} ・ ♥ ${num(a.likes)}`),
    el("p", { class: "a-excerpt" }, `@${a.posts[0].handle}：${excerpt(a.posts[0].text)}`),
    el("div", { class: "chips" }, a.posts.slice(0, 8).map((p) => link(p.url, null, `@${p.handle}`)))))));
}

function kvCard(title, rows) {
  return el("section", null, el("h2", { class: "group-title" }, title),
    el("div", { class: "card" }, rows.length
      ? el("ul", { class: "list kv" }, rows.map(([a, b]) => el("li", null, el("span", null, a), el("span", null, b))))
      : el("p", { class: "placeholder" }, "データがありません")));
}

const footer = () => el("footer", null,
  "投稿データは ", link("https://github.com/FxEmbed/FxEmbed", null, "FxTwitter (FxEmbed)"),
  " の公開 API から取得しています。本文は抜粋のみを保持し、各投稿は X 上の元投稿へリンクしています。投稿の著作権は各投稿者に帰属します。");

function renderTag() {
  const data = state.data, t = data.topic;
  const hours = [...t.windows.map((w) => w.hours), 0];
  if (!hours.includes(state.win)) state.win = hours.includes(24) ? 24 : hours[0];
  const inWindow = windowPosts(data, state.win), visible = applyFilter(inWindow);
  const rep = buildReport(visible, data.titles, data.runs.length ? data.runs[0].started_at : 0);
  const failed = !!(data.runs[0] && data.runs[0].error);
  const period = state.win ? `直近${winLabel(state.win)}` : "保存中のすべての投稿";
  const set = (key) => (v) => { state[key] = v; state.shown = PAGE; saveHash(); render(); };

  setMain(
    el("div", { class: "title-row" },
      el("div", null, el("p", { class: "eyebrow" }, "定期調査中のタグ"), el("h1", null, t.name)),
      el("div", { class: "actions" },
        el("button", { type: "button", class: "btn", onclick: () => tagSheet(t) }, "編集"),
        el("button", { type: "button", class: "btn",
          onclick: () => download(`report-${t.id}.md`, markdown(t.name, period, rep)) }, "書き出し"),
        repo() && link(`https://github.com/${repo()}/actions/workflows/collect.yml`, { class: "btn" }, "今すぐ収集"))),
    el("p", { class: "sub" + (failed ? " err" : "") },
      failed ? `最終収集 ${ago(data.last_run_at)} ・ 一部取得に失敗しました（${data.last_status}）`
             : `最終収集 ${ago(data.last_run_at)} ・ ${t.interval_min >= 60 ? t.interval_min / 60 + "時間" : t.interval_min + "分"}ごとに調査`),
    el("ul", { class: "conds", "aria-label": "調査条件" },
      t.query && el("li", null, "キーワード ", el("b", null, t.query)),
      t.lang && el("li", null, "言語 ", el("b", null, t.lang)),
      t.query && t.windows.map((w) => el("li", null, `${winLabel(w.hours)} `, el("b", null, `♥ ${num(w.min_faves)} 以上`))),
      t.accounts.length > 0 && el("li", null, "アカウント ", el("b", null, t.accounts.map((a) => "@" + a).join(" ")))),
    el("div", { class: "toolbar" },
      seg(hours.map((h) => [h, winLabel(h)]), state.win, set("win"), "期間"),
      seg([["rank", "ランキング"], ["articles", "記事まとめ"], ["insights", "インサイト"]], state.view, set("view"), "表示"),
      toolButtons()),
    filterNote(inWindow.length, visible.length),
    el("div", { class: "stats" },
      [["投稿", rep.stats.posts], ["新着", rep.stats.fresh], ["記事", rep.stats.articles], ["投稿者", rep.stats.authors],
       ["いいね合計", rep.stats.likes]].map(([label, v]) => el("div", { class: "stat" }, el("b", null, num(v)), el("span", null, label)))),
    state.view === "rank" ? rankList(rep.posts, `${period}に条件を満たす投稿はありません。期間を広げるか、「編集」で最低いいね数を下げてみてください。`)
      : state.view === "articles" ? articleList(rep.articles)
      : el("div", { class: "insights" },
          kvCard("ハッシュタグ", rep.hashtags.map(([tag, n]) => ["#" + tag, `${n} 件`])),
          kvCard("よく登場する投稿者", rep.authors.map((a) => [`${a.name} @${a.handle}`, `${a.posts} 件`])),
          kvCard("収集履歴", data.runs.slice(0, 8).map((r) => [fmtDate(r.started_at), r.error ? "一部失敗" : `${r.found} 件 / 新規 ${r.new}`]))),
    footer());
}

function renderLive() {
  const L = state.live;
  const rep = buildReport(applyFilter(L.posts || []), {}, 0);
  const pick = (h) => { L.hours = h; L.minFaves = (WINDOWS.find((w) => w.hours === h) || {}).def || 0; state.shown = PAGE; runLive(); };
  const faves = el("input", { type: "number", min: "0", step: "10", value: String(L.minFaves), id: "live-faves",
    onchange: (e) => { L.minFaves = Math.max(0, Number(e.target.value) || 0); runLive(); } });

  setMain(
    el("div", { class: "title-row" },
      el("div", null, el("p", { class: "eyebrow" }, L.pendingId ? "収集待ちのタグ" : "検索結果"), el("h1", null, L.name || L.q)),
      !L.pendingId && el("div", { class: "actions" },
        el("button", { type: "button", class: "btn primary",
          onclick: () => tagSheet(null, { query: L.q, lang: L.lang, hours: L.hours, minFaves: L.minFaves }) }, "タグに追加して定期調査"))),
    el("p", { class: "sub" }, L.pendingId
      ? "初回の収集を待っています（通常 1〜2 分）。それまでは現在の検索結果を表示します。"
      : "いまの X の人気投稿です。タグに追加すると、この条件で定期的に調査して記録します。"),
    L.q && el("div", { class: "toolbar" },
      seg(WINDOWS.map((w) => [w.hours, w.label]), L.hours, pick, "期間"),
      el("label", { class: "field-inline", for: "live-faves" }, "最低いいね数", faves),
      !L.pendingId && el("label", { class: "field-inline", for: "live-lang" }, "言語",
        el("select", { id: "live-lang", onchange: (e) => { L.lang = e.target.value; runLive(); } },
          LANGS.map(([v, l]) => el("option", { value: v, selected: L.lang === v }, l)))), toolButtons()),
    L.q && !L.loading && filterNote((L.posts || []).length, rep.posts.length),
    !L.q ? el("p", { class: "placeholder" }, "収集が完了すると、ここに結果が表示されます。")
      : L.loading ? el("p", { class: "placeholder" }, "検索中…")
      : L.error ? el("p", { class: "placeholder" }, el("b", null, "検索できませんでした"), L.error)
      : rankList(rep.posts, `直近${winLabel(L.hours)}に ♥ ${num(L.minFaves)} 以上の投稿は見つかりませんでした。期間を広げるか、最低いいね数を下げてみてください。`),
    footer());
}

function render() {
  if (!state.index) return;
  renderSidebar();
  if (state.live) renderLive();
  else if (state.data) renderTag();
  else setMain(el("p", { class: "placeholder" }, el("b", null, "タグがありません"),
    "上の検索欄にキーワードを入力するか、「＋ タグを追加」から調査したいタグを登録してください。"));
}

function saveHash() {
  if (state.tagId && !state.live) {
    history.replaceState(null, "", `#tag=${encodeURIComponent(state.tagId)}&win=${state.win}&view=${state.view}`);
  }
}

async function selectTag(id) {
  const p = pending().find((x) => x.id === id);
  state.shown = PAGE;
  if (p && !state.index.topics.some((t) => t.id === id)) {
    const w = (p.windows || [])[0] || { hours: 24, min_faves: 0 };
    state.live = { q: p.query, name: p.name, lang: p.lang, hours: w.hours, minFaves: w.min_faves, pendingId: id, posts: [] };
    render();
    return runLive();
  }
  state.live = null; state.tagId = id;
  try {
    state.data = await getJSON(`data/${encodeURIComponent(id)}.json`);
  } catch (e) {
    state.data = null;
    renderSidebar();
    setMain(el("p", { class: "placeholder" }, el("b", null, "読み込めませんでした"), `データの取得に失敗しました（${e.message}）`));
    return;
  }
  saveHash();
  render();
}

// ---------------------------------------------------------------- シート

function openSheet({ title, confirm, body, onConfirm }) {
  const sheet = $("sheet");
  const err = el("p", { class: "form-error", hidden: true, role: "alert" });
  const ok = el("button", { type: "button", class: "text-btn" }, confirm);
  ok.addEventListener("click", async () => {
    ok.disabled = true; err.hidden = true;
    try { await onConfirm(); sheet.close(); }
    catch (e) { err.textContent = e.message || "保存できませんでした"; err.hidden = false; }
    finally { ok.disabled = false; }
  });
  sheet.replaceChildren(
    el("div", { class: "sheet-bar" },
      el("button", { type: "button", class: "text-btn", onclick: () => sheet.close() }, "キャンセル"),
      el("h2", null, title), ok),
    el("div", { class: "sheet-body" }, body, err));
  sheet.showModal();
}
$("sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

const row = (label, control, forId) => el("div", { class: "form-row" }, el("label", { for: forId }, label), control);
const group = (title, ...rows) => [el("h3", { class: "group-title" }, title), el("div", { class: "form-group" }, rows)];

function settingsSheet(after) {
  const input = el("input", { type: "password", id: "f-token", placeholder: "github_pat_…", autocomplete: "off",
                              value: token() });
  const body = [
    group("GitHub 連携",
      el("div", { class: "form-row" }, el("span", { class: "lbl" }, "リポジトリ"), el("span", { class: "grow" }), el("span", { class: "unit" }, repo() || "不明")),
      row("トークン", input, "f-token")),
    el("div", { class: "hint" },
      "タグを定期調査に追加・編集するには、このリポジトリに書き込める GitHub のアクセストークンが必要です。トークンはこのブラウザにのみ保存され、GitHub 以外には送信されません。",
      el("ol", null,
        el("li", null, link("https://github.com/settings/personal-access-tokens/new", null, "Fine-grained トークンの作成ページ"), "を開く"),
        el("li", null, "Repository access で「Only select repositories」を選び、このリポジトリだけを指定"),
        el("li", null, "Permissions の Contents を「Read and write」にして作成し、ここに貼り付け"))),
    token() && el("button", { type: "button", class: "btn block destructive",
      onclick: () => { store.set("token", ""); $("sheet").close(); toast("トークンを削除しました"); } }, "トークンを削除"),
  ];
  openSheet({ title: "設定", confirm: "保存", body, onConfirm: async () => {
    const value = input.value.trim();
    if (!value) throw new Error("トークンを入力してください。");
    if (!repo()) throw new Error("リポジトリを特定できません。GitHub Pages 上で開いてください。");
    const info = await gh("", { token: value });
    if (!info.permissions || !info.permissions.push) throw new Error("このトークンにはリポジトリへの書き込み権限がありません。");
    store.set("token", value);
    toast("GitHub と連携しました");
    if (after) setTimeout(after, 0);
  } });
}

function tagSheet(existing, preset) {
  if (!token()) {
    toast("タグを定期調査に追加するには、最初に GitHub 連携の設定が必要です");
    return settingsSheet(() => tagSheet(existing, preset));
  }
  const t = existing || {};
  const f = {
    query: el("input", { type: "text", id: "f-query", placeholder: "例: 生成AI", value: t.query || (preset && preset.query) || "" }),
    name: el("input", { type: "text", id: "f-name", placeholder: "キーワードと同じ", value: existing ? t.name : "" }),
    lang: el("select", { id: "f-lang" }, LANGS.map(([v, l]) => el("option", { value: v, selected: (t.lang || (preset && preset.lang) || "") === v }, l))),
    interval: el("select", { id: "f-interval" }, INTERVALS.map(([v, l]) => el("option", { value: v, selected: (t.interval_min || 60) === v }, l))),
    replies: el("input", { type: "checkbox", class: "switch", id: "f-replies", checked: !!t.include_replies }),
    accounts: el("input", { type: "text", id: "f-accounts", placeholder: "任意: OpenAI, AnthropicAI", value: (t.accounts || []).join(", ") }),
  };
  const wins = WINDOWS.map((w) => {
    const cur = existing ? (t.windows || []).find((x) => x.hours === w.hours)
      : preset ? (preset.hours === w.hours ? { min_faves: preset.minFaves } : null)
      : (w.hours !== 1 ? { min_faves: w.def } : null);
    return { hours: w.hours,
      on: el("input", { type: "checkbox", class: "switch", id: `f-w${w.hours}`, checked: !!cur, "aria-label": `直近${w.label}を調査` }),
      faves: el("input", { type: "number", class: "mini", min: "0", step: "10", value: String(cur ? cur.min_faves : w.def),
                           "aria-label": `直近${w.label}の最低いいね数` }) };
  });
  const body = [
    group("タグ", row("キーワード", f.query, "f-query"), row("表示名", f.name, "f-name"), row("言語", f.lang, "f-lang")),
    el("p", { class: "hint" }, "キーワードには X の検索演算子も使えます（例: ChatGPT OR Claude、\"完全一致\"、from:アカウント名）。"),
    group("調査項目（人気投稿ランキング）",
      wins.map((w) => el("div", { class: "form-row" },
        el("label", { for: `f-w${w.hours}` }, `直近${winLabel(w.hours)}`), el("span", { class: "grow" }),
        el("span", { class: "unit" }, "♥"), w.faves, el("span", { class: "unit" }, "以上"), w.on))),
    el("p", { class: "hint" }, "オンにした期間ごとに、最低いいね数を満たす人気の投稿を定期的に収集してランキングにします。"),
    group("定期調査", row("収集間隔", f.interval, "f-interval"), row("返信も含める", [el("span", { class: "grow" }), f.replies], "f-replies"),
      row("アカウント", f.accounts, "f-accounts")),
    el("p", { class: "hint" }, "アカウントを指定すると、その公式アカウントの投稿もこのタグに集めます。"),
    existing && el("button", { type: "button", class: "btn block destructive", onclick: () => deleteTag(existing) }, "このタグを削除"),
  ];

  openSheet({ title: existing ? "タグを編集" : "タグを追加", confirm: existing ? "保存" : "追加", body, onConfirm: async () => {
    const query = f.query.value.trim();
    const accounts = f.accounts.value.split(/[\s,、]+/).map((a) => a.replace(/^@/, "")).filter(Boolean);
    if (!query && !accounts.length) throw new Error("キーワードを入力してください。");
    const bad = accounts.find((a) => !/^\w{1,15}$/.test(a));
    if (bad) throw new Error(`アカウント名が正しくありません: ${bad}`);
    const windows = wins.filter((w) => w.on.checked)
      .map((w) => ({ hours: w.hours, min_faves: Math.max(0, Math.floor(Number(w.faves.value) || 0)) }));
    if (query && !windows.length) throw new Error("調査項目を 1 つ以上オンにしてください。");
    const values = { name: f.name.value.trim() || query || "@" + accounts[0], query, lang: f.lang.value, windows,
      interval_min: Number(f.interval.value), include_replies: f.replies.checked, accounts };
    if (existing) {
      await updateConfig((cfg) => {
        const target = cfg.topics.find((x) => x.id === existing.id);
        if (!target) throw new Error("このタグは既に削除されています。");
        Object.assign(target, values);
        delete target.min_likes; delete target.feed;
      }, `tags: update ${values.name}`);
      toast("保存しました。まもなく新しい条件で収集されます（1〜2 分）");
    } else {
      const id = "t" + Date.now().toString(36);
      await updateConfig((cfg) => { cfg.topics.push({ id, ...values, enabled: true }); }, `tags: add ${values.name}`);
      store.set("pending", [...pending(), { id, ...values }]);
      toast("タグを追加しました。初回の収集結果は 1〜2 分で反映されます");
      $("q").value = "";
      selectTag(id);
    }
  } });
}

async function deleteTag(t) {
  if (!confirm(`タグ「${t.name}」を削除しますか？\n収集済みのデータも削除され、元に戻せません。`)) return;
  try {
    await updateConfig((cfg) => { cfg.topics = cfg.topics.filter((x) => x.id !== t.id); }, `tags: remove ${t.name}`);
  } catch (e) {
    return toast(e.message);
  }
  state.deleted.add(t.id);
  store.set("pending", pending().filter((p) => p.id !== t.id));
  $("sheet").close();
  toast("タグを削除しました");
  state.data = null; state.tagId = null;
  const next = allTags()[0];
  if (next) selectTag(next.id); else render();
}

// ---------------------------------------------------------------- 起動

$("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  state.live = { q, lang: "", hours: 24, minFaves: 100, posts: [] };
  state.shown = PAGE;
  $("q").blur();
  runLive();
});
$("btn-settings").addEventListener("click", () => settingsSheet());

async function refreshIndex() {
  const idx = await getJSON("data/index.json");
  state.indexAt = Date.now();
  if (state.index && idx.generated_at === state.index.generated_at) return false;
  state.index = idx;
  const ids = new Set(idx.topics.map((t) => t.id));
  store.set("pending", pending().filter((p) => !ids.has(p.id)));
  for (const id of [...state.deleted]) if (!ids.has(id)) state.deleted.delete(id);
  return true;
}

async function init() {
  state.autoTranslate = canTranslate && store.get("autoTranslate", false);
  try {
    await refreshIndex();
  } catch {
    setMain(el("p", { class: "placeholder" }, el("b", null, "まだデータがありません"),
      "GitHub Actions の「Collect X posts」が一度実行されると、ここにレポートが表示されます。"));
    return;
  }
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has("win") && [0, 1, 24, 168].includes(Number(h.get("win")))) state.win = Number(h.get("win"));
  if (["rank", "articles", "insights"].includes(h.get("view"))) state.view = h.get("view");
  const tags = allTags();
  if (!tags.length) return render();
  await selectTag(tags.some((t) => t.id === h.get("tag")) ? h.get("tag") : tags[0].id);
}
init();

// 収集待ちのタグがある間は 20 秒ごと、それ以外は 5 分ごとに新しい収集結果を確認する
setInterval(async () => {
  if (!state.index || document.hidden) return;
  const waiting = pending().length > 0 || state.deleted.size > 0;
  if (!waiting && Date.now() - state.indexAt < 5 * 60 * 1000) return;
  try {
    if (!(await refreshIndex())) return;
    const live = state.live;
    if (live && live.pendingId && state.index.topics.some((t) => t.id === live.pendingId)) await selectTag(live.pendingId);
    else if (!live && state.tagId && state.index.topics.some((t) => t.id === state.tagId)) await selectTag(state.tagId);
    else render();
  } catch { /* 次回に再試行 */ }
}, 20000);
