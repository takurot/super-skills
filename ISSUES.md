# Codebase Review & Issue Tracking

本ドキュメントは、コードベースのレビュー結果に基づく改善点・問題点のリスト化、およびそれらを解決するためのタスク計画と各Issueの起票内容をまとめたものです。

## 1. 改善点・問題点のリスト

コードベースを探索・レビューした結果、以下の改善点および問題点が特定されました。

1. **テストディレクトリの混在**
   - プロジェクト内に `test/` と `tests/` の2つのディレクトリが存在しています。命名規則を統一し、片方にまとめる必要があります。
2. **標準テストスクリプトの欠如**
   - `package.json` に `"test"` スクリプトが定義されていません。また、`npm run check` のフローにテストの実行が含まれていません。
3. **重複コードの存在**
   - `scripts/check-drift.js` と `scripts/install-status.mjs` の両方に、ほぼ同じ機能を持つ `readFilesRecursive` 関数が定義されています。メンテナンス性向上のため、共通のユーティリティモジュールへ抽出するべきです。
4. **Linter / Formatter の未導入**
   - JavaScript (`.js`) および ECMAScript Module (`.mjs`) のコードスタイルを統一するための Linter (ESLintなど) や Formatter (Prettierなど) が設定されていません。

---

## 2. タスク計画 (プランニング)

特定された問題を効率よく解決するため、以下の順序でタスクを実行する計画とします。

- **フェーズ 1: ディレクトリ構造と設定の整理**
  - **Task 1:** `tests/` ディレクトリを `test/` ディレクトリに統合する。
  - **Task 2:** `package.json` に `"test"` スクリプトを追加し、`"check"` スクリプト内でテストも実行されるように修正する。
- **フェーズ 2: リファクタリング**
  - **Task 3:** `readFilesRecursive` 関数を共通ライブラリ（例: `scripts/lib/file-utils.js` または既存の `install-lib.mjs` など適切な場所）に抽出し、各スクリプトから呼び出すようにリファクタリングする。
- **フェーズ 3: コード品質の向上（オプショナル）**
  - **Task 4:** ESLint および Prettier を導入し、CI/CD などの検証パイプラインに組み込む。

---

## 3. Issue 起票 (Drafts)

以下は、各タスクをIssueとして起票するためのドラフトです。

### Issue 1: テストディレクトリの統一 (`test/` と `tests/` の統合)
**タイトル:** テストディレクトリを `test/` に統一する
**説明:**
現在、コードベースには `test/` ディレクトリと `tests/` ディレクトリが混在しています（例: `test/skill-metadata.test.js`, `tests/install-installer.test.mjs`）。
命名規則を統一し、テストファイルの配置場所を明確にするため、`tests/` 配下のファイルを `test/` に移動し、`tests/` ディレクトリを削除してください。

**対応内容:**
- `tests/install-installer.test.mjs` を `test/` ディレクトリに移動。
- 空になった `tests/` ディレクトリを削除。
- 関連するインポートパスやドキュメントがあれば修正。

---

### Issue 2: `package.json` への `"test"` スクリプト追加
**タイトル:** `package.json` にテスト実行スクリプトを追加し、`npm run check` に組み込む
**説明:**
現在、`package.json` に `node --test` を実行するための標準の `"test"` スクリプトが存在しません。また、CIやローカルでの検証として実行される `npm run check` にもテストの実行が含まれていません。
品質保証のため、テストの自動実行をコマンド化する必要があります。

**対応内容:**
- `package.json` の `"scripts"` に `"test": "node --test test/*.js test/*.mjs"` を追加（ディレクトリ統一後のパスを想定）。
- `"check"` スクリプトの実行チェーンに `npm run test` を追加。

---

### Issue 3: `readFilesRecursive` の重複コード排除（リファクタリング）
**タイトル:** `readFilesRecursive` 関数の共通モジュールへの抽出
**説明:**
`scripts/check-drift.js` と `scripts/install-status.mjs` の2つのファイル内に、同名の `readFilesRecursive` 関数が重複して定義されています。
DRY (Don't Repeat Yourself) の原則に従い、この関数を共通のユーティリティファイル（または既存のlibファイル）に抽出し、両方のスクリプトからインポートするようにリファクタリングしてください。

**対応内容:**
- 共通のファイル操作関数をまとめるユーティリティモジュールの作成、または既存モジュールへの追加。
- `scripts/check-drift.js` の修正。
- `scripts/install-status.mjs` の修正。
- 修正後、関連するテストおよび `npm run check` が通ることを確認。

---

### Issue 4: コードフォーマッター・リンターの導入
**タイトル:** ESLint / Prettier の導入とフォーマットルールの統一
**説明:**
現在、プロジェクト内の JavaScript (`.js`, `.mjs`) ファイルに対してフォーマッターやリンターが設定されていません。
将来的な機能追加や複数人での開発に備え、コードスタイルを統一するためのツールを導入することが望ましいです。

**対応内容:**
- Prettier および ESLint のインストール。
- プロジェクトルートへの設定ファイル（`.eslintrc`, `.prettierrc` など）の追加。
- `package.json` への `"lint"` および `"format"` スクリプトの追加。
- 必要であれば既存コードのフォーマット実行。
