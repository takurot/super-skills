# 2026-04-23 P0a: vcontext LaunchAgent を cat=app 化

外部ファイル(`~/Library/LaunchAgents/*.plist`)は git 管理外のため、本日の変更を本 runbook に記録する。MLX 側の前例(`3356d68`)に続き、vcontext も `.app` ラッパ経由で LaunchServices 管理に切替えた。

## 1. 何が変わったか (What changed)

対象ファイル: `~/Library/LaunchAgents/com.vcontext.server.plist`
変更フィールドは `ProgramArguments` のみ。他は全て現状維持。

```diff
 <key>ProgramArguments</key>
 <array>
-  <string>/bin/bash</string>
-  <string>/Users/mitsuru_nakajima/skills/scripts/vcontext-wrapper.sh</string>
+  <string>/usr/bin/open</string>
+  <string>-W</string>
+  <string>-n</string>
+  <string>-a</string>
+  <string>/Users/mitsuru_nakajima/skills/apps/VContextServer.app</string>
 </array>
```

維持されるフィールド (全て変更なし):

- `KeepAlive = true`
- `ProcessType = Interactive`
- `Nice = -5` (※後述の既知 quirk 参照)
- `ThrottleInterval = 15`
- `ExitTimeOut = 30`
- `StandardOutPath` / `StandardErrorPath`

## 2. なぜ (Why)

- 旧構成では jetsam が `category=daemon, priority=40` を付与し、swap 逼迫時に vcontext が最優先で kill される first-victim だった。
- `/usr/bin/open -W -n -a <.app>` は LaunchServices 経由で起動するため、jetsam が `category=app, priority=100` を自動付与する。
- 昨日の MLX cutover (commit `3356d68`) で同パターンの有効性が実証済み。vcontext も同様の扱いが必要。

## 3. ディスク上の成果物 (Artifacts on disk)

| 種別 | パス |
|---|---|
| 有効 plist | `~/Library/LaunchAgents/com.vcontext.server.plist` |
| バックアップ | `~/Library/LaunchAgents/com.vcontext.server.plist.bak-pre-p0a-20260423-103420` |
| 新 `.app` バンドル | `~/skills/apps/VContextServer.app/` |
| Cutover スクリプト | `~/skills/scripts/p0a-cutover.sh` (committed, `a069e0f`) |
| Rollback スクリプト | `~/skills/scripts/p0a-rollback.sh` (committed, `a069e0f`) |

## 4. Rollback 手順

### 推奨: スクリプト一発

```bash
~/skills/scripts/p0a-rollback.sh
```

### 手動手順 (スクリプトが壊れた場合)

```bash
# 1. 現行 Agent を bootout
launchctl bootout gui/$(id -u)/com.vcontext.server 2>/dev/null

# 2. plist をバックアップから復元
cp ~/Library/LaunchAgents/com.vcontext.server.plist.bak-pre-p0a-20260423-103420 \
   ~/Library/LaunchAgents/com.vcontext.server.plist

# 3. bootstrap
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vcontext.server.plist

# 4. health probe
curl -sS http://127.0.0.1:3150/health
```

## 5. 既知の Quirk (今日学んだ重要教訓)

### 5.1 `kickstart -k` は .app ラッパ済 LaunchAgent を再起動しない

macOS の仕様: `.app` のライフサイクルは LaunchServices が管理し、`launchd` は `open` launcher しか追跡しない (`open` は fork 直後に exit)。
`launchctl kickstart -k` は `open` を再起動するだけで、子プロセス (`.app` 本体) には届かない。

正しい再起動手順:

```bash
launchctl bootout gui/$(id -u)/com.vcontext.server
pkill -f VContextServer  # .app 本体を殺す
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vcontext.server.plist
```

### 5.2 `open -W -n -a` 配下の子 FD は `/dev/null` に固定される

`.app` bash wrapper の stdout/stderr は、明示リダイレクトしない限り `/dev/null` に吸い込まれる。
回避策として `.app/Contents/MacOS/VContextServer` は:

```bash
exec /bin/bash "$WRAPPER_SH" "$@" >> /tmp/vcontext-server.log 2>&1
```

で明示的にログファイルへ向ける。

### 5.3 `Nice=-5` が継承されない

`runningboardd` は `.app` 子プロセスに対して plist の `Nice` を honor しない。
nice=0 の回帰となるが、jetsam pri=100 のメリットが大きいため許容。

### 5.4 `EnvironmentVariables` が継承されない

LaunchAgent plist の `EnvironmentVariables` は `open` までしか届かず、`.app` 子には伝わらない。
そのため `vcontext-wrapper.sh` が内部で `~/skills/data/vcontext.env` を source する構成になっている (wrapper.sh line 33-40, reorder 後)。

## 6. デプロイ後の検証手順 (How to verify)

```bash
# (1) LaunchServices 配下に登録されていることを確認
launchctl list | awk '$3 ~ /^application\.com\.vcontext\.server\./'
# → 1 行出力されるはず

# (2) jetsam が cat=app, pri=100 を付与していることを確認
LABEL=$(launchctl list | awk '$3 ~ /^application\.com\.vcontext\.server\./ {print $3}')
launchctl print gui/$(id -u)/$LABEL | grep -E 'jetsam (priority|properties category)'
# → priority = 100
# → category = app

# (3) HTTP health
curl -sS http://127.0.0.1:3150/health
# → {"status":"healthy", ...}
```

3 つ全て通れば cutover 成功。

## 7. 関連コミット (Related commits)

将来 `git log` で掘り返す際のアンカー:

| commit | 内容 |
|---|---|
| `441fb8c` | P0d watchdog |
| `a069e0f` | P0a cat=app migration (本件) |
| `86f5b7a` | P0b-heap + wrapper.sh env-order fix |
| `907e76b` | P0b-mmap |
| `cc02df9` | M2 phase-1 shadow (本件非関連・同日) |
