# X トピックレポート

指定したトピックに関する X の投稿を周期的に収集し、記事まとめと各投稿へのリンクをレポートとして表示します。

- **収集**: GitHub Actions が毎時 `collector/collect.py` を実行し、[FxTwitter (FxEmbed)](https://github.com/FxEmbed/FxEmbed) の公開 API から投稿を取得して `docs/data/*.json` にコミット
- **表示**: GitHub Pages が `docs/` を配信。期間・並び順の切り替え、Markdown 保存に対応

## トピックの設定（`topics.json`）

| キー | 内容 |
| --- | --- |
| `id` | 半角英小文字・数字・ハイフンの識別子 |
| `name` | 表示名 |
| `query` | X の検索クエリ（`OR`、`"完全一致"`、`from:` などの演算子が使えます） |
| `accounts` | タイムラインを監視するアカウント |
| `keywords` | 監視アカウントの投稿をこの語のいずれかを含むものに絞る（空なら全件） |
| `lang` / `min_likes` / `include_replies` | 言語・最低いいね数・返信を含めるか（検索に適用） |
| `feed` | `top`（話題順）または `latest`（新着順） |
| `interval_min` | 収集間隔（分、最短 15。Actions の起動は毎時なので実質 60 分単位） |
| `max_pages` | 1 回に取得する検索ページ数（1 ページ約 20 件、最大 5） |

`settings.retention_days` より古い投稿は削除され、本文は `settings.text_limit` 文字までの抜粋のみ保存します。
`topics.json` を push すると収集がすぐに走ります。

## ローカルで試す

```bash
python collector/collect.py --force
python -m http.server 8765 --directory docs
```

## 利用上の注意

- FxTwitter は非公式の公開 API です。リクエストは間隔を空けて最小限にしており、仕様変更や制限で取得できなくなる場合があります。
- 公開リポジトリの GitHub Pages では収集結果が誰でも閲覧できます。個人の情報収集の範囲で利用し、投稿の転載・再配布は避けてください（各投稿の著作権は投稿者に帰属します）。
