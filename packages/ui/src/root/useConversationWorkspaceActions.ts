import { useCallback, useRef } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";
import type { TabStoreState } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

export function useConversationWorkspaceActions({
  services,
  addTab,
  setWorkspaceActionError,
}: {
  services: IServiceAccessor;
  addTab: TabStoreState["addTab"];
  setWorkspaceActionError: (error: string | null) => void;
}) {
  const handleSelectConversationWorkspace = useCallback(
    (path: string) => {
      // 对话工作区是 app 管理的共享 cwd，不属于用户项目：不走跨窗口项目激活，
      // 也不写 recentProjects，只用 purpose 让展示层把它归到“对话”。
      logger.info("[Root] select conversation workspace", { path });
      addTab(path, { workspacePurpose: "conversation" });
      setWorkspaceActionError(null);
    },
    [addTab, setWorkspaceActionError],
  );

  const handleResolveConversationWorkspace = useCallback(async () => {
    try {
      const result = await services.fileService.ensureConversationWorkspace();
      setWorkspaceActionError(null);
      return result.path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Root] ensure conversation workspace failed", { error });
      setWorkspaceActionError(message);
      throw error;
    }
  }, [services.fileService, setWorkspaceActionError]);

  const handleEnsureConversationWorkspace = useCallback(async () => {
    const path = await handleResolveConversationWorkspace();
    handleSelectConversationWorkspace(path);
    return path;
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  const handleCreateConversationTask = useCallback(async () => {
    try {
      const path = await handleResolveConversationWorkspace();
      handleSelectConversationWorkspace(path);
      // “对话 +”是显式目标，不应被当前 split pane / workbench group 的项目绑定覆盖。
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      useZCodeSessionStore.getState().startDraft(path);
    } catch {
      // handleResolveConversationWorkspace 已记录错误并保留当前 workspace。
    }
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  const attentionDigestInFlightRef = useRef(false);
  const handleCreateAttentionDigest = useCallback(
    async (locale: string) => {
      // 摘要派发一次点击就是一个 agent 任务；连点会在 conversation workspace
      // 里堆出重复任务，这里用本地在途守卫挡住。
      if (attentionDigestInFlightRef.current) {
        return;
      }
      attentionDigestInFlightRef.current = true;
      try {
        const path = await handleResolveConversationWorkspace();
        const result = await services.zcodeTaskService.createAttentionDigestTask({ locale });
        handleSelectConversationWorkspace(path);
        // 与“对话 +”同款：显式目标不被 pane/group 的项目绑定覆盖。
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
        useZCodeSessionStore.getState().setActiveTaskId(path, result.taskId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Root] create attention digest task failed", { error });
        setWorkspaceActionError(message);
      } finally {
        attentionDigestInFlightRef.current = false;
      }
    },
    [
      handleResolveConversationWorkspace,
      handleSelectConversationWorkspace,
      services.zcodeTaskService,
      setWorkspaceActionError,
    ],
  );

  return {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleCreateAttentionDigest,
  };
}
