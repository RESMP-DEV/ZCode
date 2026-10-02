# 个人定制构建管线（Preview 身份桌面构建）

## 背景与目标

本仓库的使用者在本机同时运行官方发行版 `/Applications/ZCode.app`（production 身份，`dev.zcode.app`），并像维护个人 Codex fork（`~/codex` 的 `alphaheng/main` 分支加 `build_and_link_codex.sh` 快照管线）那样，从源码构建自用版 ZCode。本 spec 定义这条个人构建管线的唯一行为契约；`scripts/build-and-link-zcode.sh` 与 `scripts/smoke-test-zcode-preview.sh` 是唯一实现，不引入第二条安装或升级路径。

选择 Preview 身份（`dev.zcode.app.preview` / "ZCode Preview"）是本管线的安全前提：

- 自动更新在编译期按 product flavor 关闭（`packages/desktop/src/main/index.ts` 的 `initAutoUpdater({ enabled: ZCODE_PRODUCT_FLAVOR === "production" })`），自建 Preview 永远不会被官方更新通道覆盖。
- Preview 使用独立 Electron userData（`ZCode Preview`），可与正式版并排运行；业务数据仍共享 `~/.zcode`。

## 行为

`scripts/build-and-link-zcode.sh`（默认：构建 → 快照 → 安装）：

1. 以 `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 pnpm bundle:desktop` 构建，产出 `packages/desktop/dist/mac-arm64/ZCode Preview.app`。
2. 校验产物的 `CFBundleIdentifier` 必须等于 `dev.zcode.app.preview`，否则中止（防止把 production 身份构建装进本管线后被官方更新器覆盖）。
3. 将 `.app` 原样 ditto 进不可变快照目录 `<lib-root>/packages/<yyyymmdd-HHMM>-<gitsha8>[-dirty]/`，并写入 `manifest.json`（时间、git sha、版本、bundle id、主二进制 sha256、构建环境）。
4. 翻转 `<lib-root>/current` → 新快照，旧目标记为 `previous-good`（相对链接，目录树可整体移动）。
5. 将 `current` 快照安装（先删后 ditto）到 `--app-install-path`（默认 `/Applications/ZCode Preview.app`），并校验安装副本主二进制 sha256 与快照一致。
6. 按新旧保留 `--keep-snapshots`（默认 3）个非保护快照；`current` 与 `previous-good` 目标永不修剪。
7. 若检测到 ZCode Preview 正在运行，只提示手动重启，绝不杀进程。

子命令语义：`--rollback` 交换 `current`/`previous-good` 并重装；`--no-build` 复用最近一次 bundle 产物；`--no-install` 只做快照；`--list` 仅列快照。

`scripts/smoke-test-zcode-preview.sh`：静态校验安装副本的 plist 身份/版本与 `current` 快照 manifest 一致；若 Preview 未运行则 `open -n` 启动、确认进程与 `Application Support/ZCode Preview` userData 出现后用 AppleScript 退出，不影响正在运行的正式版。

## 所有权与不变量

- 快照目录与 `current`/`previous-good` 指针的唯一所有者是构建脚本；人工只读。
- 安装副本是快照的派生物，随时可由 `--rollback` 或重装恢复；不存在安装副本独有的状态（业务状态在 `~/.zcode`，与本管线无关）。
- 快照不可变：创建后脚本不再写其内容；修剪只整目录删除。
- 只允许安装 Preview 身份构建；对安装目标做删除前必须再次读取其 plist 身份（不存在或为 `dev.zcode.app.preview` 才允许删除），防止误删其他应用。
- 默认 lib-root 为 `~/.local/lib/alphaheng/zcode`，与 Codex 快照根（`~/.local/lib/alphaheng/packages`）隔离，避免任一侧的修剪策略误伤对方。

## 失败语义

- 构建失败：不产生快照、不翻指针、不动安装副本。
- 身份校验失败：中止，退出码非 0。
- 安装校验失败（sha 不一致）：报告后退出非 0，保留快照供重试。
- `--rollback` 在没有 `previous-good` 时直接失败，不做猜测性回退。

## 验收

```bash
scripts/build-and-link-zcode.sh --list
scripts/build-and-link-zcode.sh            # 构建并安装
scripts/smoke-test-zcode-preview.sh        # 身份 + 启动/退出冒烟
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "/Applications/ZCode Preview.app/Contents/Info.plist"   # → dev.zcode.app.preview
```
