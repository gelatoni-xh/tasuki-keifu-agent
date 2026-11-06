# tasuki-keifu-agent

[![中文](https://img.shields.io/badge/阅读中文-README.md-555?style=flat-square)](README.md) [![English](https://img.shields.io/badge/Read%20English-README.en.md-555?style=flat-square)](README.en.md) [![日本語](https://img.shields.io/badge/日本語で読む-README.ja.md-1677ff?style=flat-square)](README.ja.md)

`tasuki-keifu` のデータ診断に使う、LangGraph ベースの内部エージェントです。

V1 の対象範囲：

- 選手診断グラフ（`person diagnosis graph`）
- 主業務データベース `tasuki_keifu` への読み取り専用アクセス
- 独立した `tasuki_keifu_agent` データベースへの実行データの記録
- 構造化された検出結果と、手動操作の提案
- 選手ごとのアクションバンドルを監査記録に残すガバナンスバッチ
- 標準の `LANGCHAIN_*` 環境変数による LangSmith トレーシング
- 名前の正規化候補に曖昧さがある場合の、任意の GPT-5.4 による人物同定調査
- Wikipedia MediaWiki API によるプロフィール確認。標準 HTTP プロキシ設定と macOS のシステムプロキシに対応

## ローカル設定

```bash
pnpm install
pnpm prisma:generate
cp .env.example .env
```

次の環境変数を設定します。

- `TASUKI_KEIFU_BUSINESS_DATABASE_URL`
- `TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL`：業務データの書き込みを有効にする場合のみ設定
- `TASUKI_KEIFU_AGENT_DATABASE_URL`
- `LANGSMITH_API_KEY`
- `LANGSMITH_WORKSPACE_ID`
- `LANGSMITH_TRACING=true`
- `LANGSMITH_PROJECT=tasuki-keifu-agent-v1`
- 任意の `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`。省略時はローカルの Codex 設定を使用
- Wikipedia API 用の任意の `HTTPS_PROXY` または `HTTP_PROXY`。macOS では未設定の場合、システムプロキシを使用

## 実行

```bash
pnpm diagnose -- --person-slug example-person
pnpm diagnose -- --person-id cmxxxx
pnpm diagnose -- --person-name "選手名"
npm run inspect -- --limit 5
npm run inspect -- --person-slug example-person
```

## スモークチェック

```bash
npm run smoke:diagnosis
npm run smoke:tools
npm run smoke:nodes
```

現在の確認範囲：

- `smoke:diagnosis`：実際のサンプル事例を使ったグラフ出力の一貫した動作確認
- `smoke:tools`：主要な診断ツールが返す検出結果の直接確認
- `smoke:nodes`：重要な解決分岐のグラフノード経路を回帰確認。実際の曖昧な名前を `research_name_identity` で処理する経路も含む
- `inspect`：最近のエージェント実行と診断結果の確認

現在のリリースでは、診断結果、アクションバンドル、リスクによる保留、バッチ監査データをエージェント用データベースに記録します。登録済みの業務書き込み操作は、以下の明示的な書き込み保護条件を満たす場合にのみ利用できます。

## ガバナンスバッチ

```bash
npm run governance:batch -- --limit 20
npm run governance:batch -- --limit 20 --execute
```

バッチは `Person` / `Membership` / `PersonalBest` の最新更新時刻と、その選手について直近で確定したガバナンス実行を比較します。リスクによる保留も確定済みとして扱い、変更のない事例を繰り返し処理しません。

- 既定はドライランです。
- `--execute` を指定しても、`TASUKI_AGENT_WRITE_ENABLED=true` と `TASUKI_KEIFU_BUSINESS_WRITE_DATABASE_URL` の両方を設定しない限り、ドライランのままです。
- `merge_person_duplicate`：LLM が確認し、正規化した名前が一致し、一時的でない正規 slug が明確な選手のペアを統合します。同一トランザクション内で両者をロックし、関連レコードを移動し、名前の表記揺れを保存し、関係キャッシュを消去し、業務 `AuditLog` を記録してから重複レコードを削除します。
- `backfill_profile_from_wikipedia`：完全一致した Wikipedia ページから、欠けているプロフィール項目だけを補完します。
- `upsert_personal_bests_from_wikipedia`：Wikipedia に明記された PB を書き込みます。同じ種目に複数の既存記録がある場合は、段階別の PB を保持します。
- `mark_memberships_conflicting` と `mark_personal_bests_conflicting`：内部で矛盾するレコードを `conflicting` として記録します。レコードの削除や代替情報の推測は行いません。
- 高リスクの選手は保留にし、バッチ内のほかの選手の処理を継続します。
