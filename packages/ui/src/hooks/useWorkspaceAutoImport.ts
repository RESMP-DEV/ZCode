// 侧栏项目自动导入：tab 恢复完成后扫描 git 项目目录，把缺失的 workspace
// 以「仅确保可见」的方式补进侧栏（不激活、不抢占焦点、追加到列表尾部）。
import { useEffect, useRef } from "react";
import type { IFileService, ISettingService } from "@zcode/services";
import { logger } from "@/logger.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type TabStore } from "@/store/tabStore.js";

export interface WorkspaceAutoImportServices {
  settingService: ISettingService;
  fileService: IFileService;
}

export interface WorkspaceAutoImportScanResult {
  scanned: number;
  imported: number;
}

/** 每轮导入的候选上限：避免大盘机器一次性把侧栏刷爆；用户可关闭设置或收敛 roots。 */
const WORKSPACE_AUTO_IMPORT_MAX_RESULTS = 24;

/**
 * 执行一轮自动导入扫描。启动 hook 与设置页「立即扫描」共用同一条路径：
 * 读取设置 → host 侧发现候选 → 对当前侧栏缺失的路径 ensureWorkspaceTab(append)。
 * 失败向外抛出由调用方决定提示方式；启动路径只记日志。
 */
export async function runWorkspaceAutoImportScan(
  services: WorkspaceAutoImportServices,
  tabStore: TabStore,
): Promise<WorkspaceAutoImportScanResult> {
  const settings = await services.settingService.get();
  if (settings.workspaceAutoImportEnabled === false) {
    return { scanned: 0, imported: 0 };
  }
  const candidates = await services.fileService.discoverWorkspaceCandidates({
    roots: settings.workspaceAutoImportRoots ?? [],
    maxDepth: 2,
    maxResults: WORKSPACE_AUTO_IMPORT_MAX_RESULTS,
  });
  const existingPaths = new Set(
    tabStore
      .getState()
      .tabs.filter(isWorkspaceTab)
      .map((tab) => tab.workspacePath),
  );
  let imported = 0;
  for (const workspacePath of candidates) {
    if (existingPaths.has(workspacePath)) {
      continue;
    }
    // ensureWorkspaceTab 不改变 activeTabId；append 选项让批量导入落到列表尾部，
    // 不打乱用户手工维护的侧栏顺序。重复路径由 store 内 isSameWorkspaceTab 兜底去重。
    tabStore.getState().ensureWorkspaceTab(workspacePath, { append: true });
    imported += 1;
  }
  if (imported > 0) {
    logger.info(
      `[WorkspaceAutoImport] 自动导入完成 scanned=${candidates.length} imported=${imported}`,
    );
  }
  return { scanned: candidates.length, imported };
}

/**
 * 启动后执行一次自动导入。`enabled` 应由调用方限定为「承担会话恢复/持久化的主窗口
 * 且首轮 tab 恢复已完成」，避免次级窗口重复导入或与恢复流程竞争。
 */
export function useWorkspaceAutoImport(params: {
  services: WorkspaceAutoImportServices | undefined;
  enabled: boolean;
}): void {
  const { services, enabled } = params;
  const tabStore = useTabStoreApi();
  const ranRef = useRef(false);
  useEffect(() => {
    if (!services || !enabled || ranRef.current) {
      return;
    }
    ranRef.current = true;
    void runWorkspaceAutoImportScan(services, tabStore).catch((error: unknown) => {
      // 自动导入是纯增益路径：任何失败都不允许影响启动。
      logger.warn(
        `[WorkspaceAutoImport] 自动导入扫描失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, [services, enabled, tabStore]);
}
