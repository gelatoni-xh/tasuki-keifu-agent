# tasuki-keifu-agent

[![中文](https://img.shields.io/badge/阅读中文-README.md-555?style=flat-square)](README.md) [![English](https://img.shields.io/badge/Read%20English-README.en.md-555?style=flat-square)](README.en.md) [![日本語](https://img.shields.io/badge/日本語で読む-README.ja.md-1677ff?style=flat-square)](README.ja.md)

`tasuki-keifu-agent` は `tasuki-keifu` 内部のデータガバナンスサービスです。現在の処理は大会と区・組を単位に進み、既存の大会データを区・組ごとに投入して治理します。本番の入口は `src/governance-v2/cli.ts` の大会ガバナンスランナーです。旧選手診断とバッチ CLI は互換性のために残していますが、新しい大会取込フローではありません。

## ガバナンスの流れ

1. 大会、開催回、Race、Source はメインサイトの業務データベースに事前登録してください。このサービスは大会の枠を作成せず、旧大会取込の書込処理も呼び出しません。
2. タスクには明示的なバッチを含めます。各バッチに `unitType`（`leg`、`heat`、`group`）、`unitKey`、`sequence`、`raceSlug` とソースデータを指定します。
3. 説明可能な正規化と確定的な照合はルールで処理します。残った同一性の疑問は、全件一括の軽量正規化を経て、予算を設定した調査に進みます。交差検証で組織と選手の判断の矛盾を確認します。独立した組織情報によって対応関係が変わった場合は、影響を受けた選手だけを一度再評価し、グラフを循環させません。
4. 大会タスク内のバッチは順番に実行します。重大な unresolved は根拠とともに保存して通知対象にできますが、確認済みの同一人物として自動確定しません。それ以外の unresolved は、有効な行の処理を妨げません。
5. `dry_run` は業務テーブルを書き換えず、計画とレポートを作成します。内容を確認した後、新しい `requestKey` で `apply` タスクを登録してください。apply は独立した読み取り・書き込み接続と制御されたトランザクションを使います。

入力仕様、復旧動作、デプロイ要件、ロールバック手順は [`docs/governance-v2.md`](docs/governance-v2.md) を参照してください。

## 観測と通知

タスク、バッチ、Agent 実行、モデル呼び出し、ガバナンス変更、unresolved の根拠はメインサイト DB の `governance` スキーマに保存します。観測項目にはキュー待ち、実行・再試行時間、モデルと呼び出し数、入出力 tokens、Web 検索数、推定コスト、resolved/unresolved と計画変更の結果が含まれます。コスト推定にはモデル価格の設定が必要です。

独立したメール worker が永続キューから通知を送信します。大会サマリーの件名には大会名を、アラートには大会名と区・組を含めます。配信失敗は再試行し、安定した Message-ID で重複メールを識別しやすくします。

## ローカル開発

```bash
pnpm install
pnpm typecheck
pnpm test:governance
GOVERNANCE_MAIN_REPO=/path/to/tasuki-keifu bash scripts/test-governance-integration.sh
```

統合テストスクリプトは使い捨てのローカル PostgreSQL を起動し、サイトの全マイグレーションを適用してテスト後に削除します。本番 DB には接続しません。`initdb`、`pg_ctl`、`createdb` が必要です。

ガバナンス CLI の実行前に、以下を設定してください。

- `GOVERNANCE_DATABASE_URL`：`governance` スキーマを含むメインサイト DB の runtime 接続。
- `GOVERNANCE_READ_DATABASE_URL`：読み取り専用接続。apply では別接続が必須です。
- `GOVERNANCE_PAYLOAD_DIR`：バッチ原文を保存する絶対パス。
- `GOVERNANCE_WRITE_ENABLED`：既定は無効。計画を確認した後にのみ apply 書き込みを有効にします。
- `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`GOVERNANCE_RESEARCH_MODEL`：任意の明示的な調査モデル設定。モデルがなくてもルール処理は動作し、調査が必要な重大事項は unresolved のまま残ります。
- `GOVERNANCE_RESEARCH_REQUESTS`、`GOVERNANCE_RESEARCH_TIMEOUT_MS`：バッチごとの調査リクエスト上限とタイムアウト。
- `GOVERNANCE_MAIL_ENABLED`、`MAIL_CONFIG`：メール worker の明示的な有効化と SMTP/Resend 設定。

環境変数テンプレートは [`deploy/governance-v2.env.example`](deploy/governance-v2.env.example) にあります。認証情報や本番接続文字列をコミットしないでください。

## 大会タスクのコマンド

```bash
node --import tsx src/governance-v2/cli.ts adapt eventspec.json > manifest.json
node --import tsx src/governance-v2/cli.ts submit manifest.json
node --import tsx src/governance-v2/cli.ts run TASK_UUID
node --import tsx src/governance-v2/cli.ts status TASK_UUID
node --import tsx src/governance-v2/cli.ts worker
node --import tsx src/governance-v2/cli.ts retry TASK_UUID
```

`adapt` は既存の `RaceImportPayload` を検証済み manifest に変換するだけで、データを書き込みません。まず `dry_run` を実行して計画とレポートを確認します。計画、DB 接続、書き込みスイッチを確認してから `apply` を登録してください。失敗したタスクは原因を確認してから明示的に retry します。先行バッチが失敗すると、後続バッチは停止します。

メール運用コマンド：

```bash
node --import tsx src/governance-v2/cli.ts health
node --import tsx src/governance-v2/cli.ts deliver
node --import tsx src/governance-v2/cli.ts mail-worker
```

checkpoint 初期化、DB 権限、Compose のリソース制限、ロールバックは運用手順書を参照してください。本番の大会処理は担当者が区・組ごとに実施・観測します。この README のローカル例は実大会を実行する許可を意味しません。
