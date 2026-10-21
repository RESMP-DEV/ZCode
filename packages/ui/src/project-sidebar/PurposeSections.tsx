import { useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Plus, MessageCirclePlus, ClipboardList, ListChevronsDownUp, ListChevronsUpDown } from "lucide-react";
import { TID_ATTENTION_DIGEST } from "@zcode/shared/test-ids";
import { WorkspacePurposeSection } from "@/WorkspaceSidebar/WorkspacePurposeSection.js";
import type { ProjectTree } from "@/project-sidebar/contract.js";
import {
  readSidebarPurposeSectionPreferences,
  persistSidebarPurposeSectionPreferences,
  reorderSidebarPurposeSections,
} from "@/lib/sidebarPurposeSectionPreferences.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 原因：横向拖动会撑宽 overflow-y:auto 的侧栏并触发水平自动滚动；在碰撞计算前固定纵轴。
const sectionDragModifiers: Modifier[] = [({ transform }) => ({ ...transform, x: 0 })];

/** 折叠和分区顺序继续使用旧偏好；项目/任务数据始终由 Host 提供。 */
export function PurposeSections({
  tree,
  projects,
  tasks,
  onAdd,
  onCreate,
  onCreateAttentionDigest,
  hasExpandedProjects,
  canToggleProjects,
  onToggleProjects,
}: {
  tree: ProjectTree;
  projects: ReactNode;
  tasks: ReactNode;
  onAdd(): void;
  onCreate(): void;
  onCreateAttentionDigest?: (locale: string) => void;
  hasExpandedProjects: boolean;
  canToggleProjects: boolean;
  onToggleProjects(): void;
}) {
  const { intl, locale } = useZCodeIntl();
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  // 分区头琥珀点 rollup（specs/workspace-attention-lifecycle.md 行为 2）：分区只渲染
  // 本地无项目任务，rollup 限定同一集合——项目内任务的阻塞由项目行琥珀点表达，不
  // 重复点亮分区头。收起时内容行不可见，汇总必须读 Host 树全量而不是行组件状态。
  const conversationAttention = tree.tasks.some(
    (task) =>
      !task.archived &&
      task.projectId == null &&
      task.hostId === "local" &&
      Boolean(task.pendingInteraction),
  );
  const [preferences, setPreferences] = useState(readSidebarPurposeSectionPreferences);
  const update = (next: typeof preferences) => {
    setPreferences(next);
    persistSidebarPurposeSectionPreferences(next);
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={sectionDragModifiers}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id)
          update({
            ...preferences,
            sectionOrder: reorderSidebarPurposeSections(
              preferences.sectionOrder,
              String(active.id),
              String(over.id),
            ),
          });
      }}
    >
      <SortableContext items={preferences.sectionOrder} strategy={verticalListSortingStrategy}>
        {/* 原因：auto 列被长标题的滚动副本撑宽，溢出检测反复增删副本导致整列闪动；
            单列使用 minmax(0, 1fr)，只由侧栏决定宽度，分页按钮才能稳定居中。 */}
        <div className="grid grid-cols-1 gap-3" data-purpose-section-list="true">
          {preferences.sectionOrder.map((id) => {
            const isProject = id === "projects";
            const title = msg(isProject ? "projects" : "tasks");
            const section = (
              <WorkspacePurposeSection
                sortableId={id}
                title={title}
                dragHandleLabel={intl.formatMessage(
                  { id: "workspaceSidebar.reorderSection" },
                  { section: title },
                )}
                testId={isProject ? "project-section" : "conversation-section"}
                open={isProject ? preferences.projectsExpanded : preferences.conversationsExpanded}
                attentionIndicator={!isProject && conversationAttention}
                onOpenChange={(open) =>
                  update({
                    ...preferences,
                    [isProject ? "projectsExpanded" : "conversationsExpanded"]: open,
                  })
                }
                action={
                  <>
                    {isProject && (
                      <ControlHintTooltip
                        title={msg(hasExpandedProjects ? "collapseAll" : "expandAll")}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-foreground-subtle hover:text-foreground"
                          data-testid="virtual-project-toggle-all"
                          aria-label={msg(hasExpandedProjects ? "collapseAll" : "expandAll")}
                          disabled={!canToggleProjects}
                          onClick={onToggleProjects}
                        >
                          {hasExpandedProjects ? (
                            <ListChevronsDownUp className="size-3.5" />
                          ) : (
                            <ListChevronsUpDown className="size-3.5" />
                          )}
                        </Button>
                      </ControlHintTooltip>
                    )}
                    {!isProject && onCreateAttentionDigest && (
                      // 待办摘要入口（specs/workspace-attention-lifecycle.md 行为 3）：
                      // 常驻入口，不依赖 rollup 点亮；候选为空时 host 仍会创建说明任务。
                      <ControlHintTooltip
                        title={intl.formatMessage({ id: "workspaceSidebar.attentionDigest" })}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-foreground-subtle hover:text-foreground"
                          data-testid={TID_ATTENTION_DIGEST}
                          aria-label={intl.formatMessage({
                            id: "workspaceSidebar.attentionDigest",
                          })}
                          onClick={() => onCreateAttentionDigest(locale)}
                        >
                          <ClipboardList className="size-3.5" />
                        </Button>
                      </ControlHintTooltip>
                    )}
                    <ControlHintTooltip title={msg(isProject ? "new" : "createTask")}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-foreground-subtle hover:text-foreground"
                        data-testid={isProject ? "virtual-project-add" : "virtual-project-new-task"}
                        aria-label={msg(isProject ? "new" : "createTask")}
                        onClick={isProject ? onAdd : onCreate}
                      >
                        {isProject ? (
                          <Plus className="size-3.5" />
                        ) : (
                          <MessageCirclePlus className="size-3.5" />
                        )}
                      </Button>
                    </ControlHintTooltip>
                  </>
                }
              >
                {isProject ? projects : tasks}
              </WorkspacePurposeSection>
            );
            return <div key={id}>{section}</div>;
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
