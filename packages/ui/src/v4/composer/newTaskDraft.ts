import type { ComposerInitialConfig } from "@/store/zcodeSessionStoreTypes.js";
import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import {
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
  type ComposerScope,
  resolveComposerScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
  scope?: ComposerScope,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity, undefined, scope);
  return {
    ...draft,
    // 产品默认：新 prompt 的权限模式恒为 yolo（specs/new-prompt-default-permission.md）。
    // Recent 的 mode 是上次提交的回声（多数情况只是旧默认 build），不再回填新任务；
    // 用户在新草稿内的显式切换仍按 scope 草稿持久化，发送路径不改写。
    mode: "yolo",
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveDraftInitialModelSelection(view, null).selection ??
      undefined,
  };
}

/** 首次导入由导航动作显式传参；复用历史或已有文字草稿不覆盖。 */
export function resolveImportedComposerConfig(
  result: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    reused: boolean;
  },
  clientNamespace = "desktop",
): ComposerInitialConfig | undefined {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return undefined;
  const scope =
    readComposerWorkspaceScope(workspacePath, workspaceIdentity, clientNamespace) ??
    resolveComposerScope(null, workspaceIdentity, clientNamespace);
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  return root?.mode
    ? {
        mode: root.mode,
        planEnabled: root.planEnabled ?? false,
        modelSelection: root.modelSelection,
      }
    : {};
}
