# 文件树空目录自动收起

状态：已实现（2026-09-25，验证：pnpm typecheck / pnpm lint / pnpm architecture:check --changed 全绿；packages/ui 无单测入口）。本文是左侧文件树空目录呈现的唯一 spec。

## 背景与问题

- 左侧文件树里目录展开是纯懒加载：点击把路径加入 `expandedPaths` 并 `readdir`。目录为空时行仍保持展开态（chevron 朝下、下方没有任何行），看起来像「卡住了」。
- 产品决定：已加载且确实没有任何子项的目录一律按收起态呈现（auto-collapsed）。

## 产品规则

- 「空」的判定：目录已加载（`loadedDirectoryPaths` 命中）、不在加载中、无读取错误，且合并 Git deleted 补全行后的 children 为 0。加载中或出错时不得收起，避免闪烁/掩盖错误。
- 呈现层裁决，不改用户意图：`flattenWorkspaceFileTreeRows` 在投影时对满足空判定的目录强制 `expanded: false`；`expandedPaths`（用户意图）不删除。
  - 目录因文件被删而变空（watcher 刷新）：自动呈现为收起。
  - 目录重新出现子项：仍在 `expandedPaths` 中，随下一帧投影自然恢复展开。
  - 用户点击空目录：`expandedPaths` 照常翻转，但投影保持收起（空目录没有可展开的内容）；chevron 保持收起朝向。
- compact 链（单子目录压缩 `a/b`）同样适用：判定作用于压缩后终端目录的真实 children。

## 所有者与事件顺序

```
useWorkspaceFileTreeData（owner: expandedPaths / childrenByDirectory / loaded / loading / error）
  → readdir 完成 → childrenByDirectory 写入（含 watcher 强刷路径）
  → useWorkspaceFileTreeRows → flattenWorkspaceFileTreeRows
      目录行 expanded = 空判定 ? false : expandedPaths 命中
  → 行视图 chevron / aria-expanded 只读投影，无第二状态
```

## 验收场景

1. 展开一个空目录：加载完成后行呈现收起态，chevron 不再朝下，下方无空隙。
2. 展开的目录内文件被全部删除（watcher 刷新）：该目录自动变为收起态。
3. 收起态空目录新增文件（watcher 刷新 + 该目录仍在 expandedPaths）：目录恢复展开并显示新行。
4. 目录读取失败（远程断连等）：不收起，沿用错误呈现；正在刷新中的目录不闪收起。
5. 根目录为空：树显示既有空态提示（`workspaceFileTree.empty`），不涉及本裁决。
