import {
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_CREATE_MENU,
} from "@zcode/shared";
import type { AutomationSchedulingStatusView } from "@zcode/services";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AutomationSwitchToggle } from "@/settings/AutomationSwitchToggle.js";
import {
  AutomationChevronDownIcon,
  AutomationInfoIcon,
} from "@/settings/AutomationIcons.js";
import { Button } from "@/components/ui/button.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";

export {
  AutomationAddScheduleIcon,
  AutomationCancelActionIcon,
  AutomationChevronDownIcon,
  AutomationClockIcon,
  AutomationContinueIcon,
  AutomationEditActionIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationInfoIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationRefreshIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationIcons.js";

/** 设置页返回入口仅高亮图标与文本，保留点击热区但不显示 hover/focus 背景。 */
export const AUTOMATION_BACK_TRIGGER_CLASSNAME =
  "-m-1 inline-flex w-fit max-w-full min-w-0 items-center gap-1 bg-transparent p-1 text-ui-base leading-5 text-foreground-subtle transition-colors hover:text-foreground active:text-foreground focus-visible:text-foreground focus-visible:outline-none";

// 修复原因：space-y 给行内 label 添加 margin 时会受字体行盒影响，实际视觉间距小于设计稿的 6px。
export const AUTOMATION_FORM_FIELD_CLASSNAME = "flex flex-col gap-1.5";

export type AutomationSettingsHistoryTab = "settings" | "history";

/** 定时与闲时共用运行历史空态，防止透明留白与卡片容器样式再次漂移。 */
export function AutomationHistoryEmptyState({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[226px] items-center justify-center rounded-xl border border-dashed border-card-border bg-background px-4 text-center text-ui-base text-foreground-subtle">
      {children}
    </div>
  );
}

/** 定时与闲时设置页复用 Hooks scope tabs 的 pill 视觉，避免详情页分段样式漂移。 */
export function AutomationSettingsHistoryTabs({
  value,
  settingsLabel,
  historyLabel,
  onValueChange,
}: {
  value: AutomationSettingsHistoryTab;
  settingsLabel: string;
  historyLabel: string;
  onValueChange: (value: AutomationSettingsHistoryTab) => void;
}) {
  return (
    <SettingsSegmentedTabs
      value={value}
      items={[
        { value: "settings", label: settingsLabel },
        { value: "history", label: historyLabel },
      ]}
      onValueChange={onValueChange}
    />
  );
}

/** Keep-awake 提示条；开关值由调用方接入全局共享设置，而非页面级 mock store。 */
export function AutomationKeepAwakeNotice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // 桌面断点曾清空提示栏的垂直内边距，导致实际样式偏离 12px 规格。
  return (
    <div
      data-automations-keep-awake
      className="flex min-h-11 w-full items-center gap-3 overflow-hidden rounded-[10px] bg-surface px-3 py-3 text-foreground-subtle"
    >
      <span
        className="flex size-5 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <AutomationInfoIcon className="size-4" />
      </span>
      <p className="min-w-0 flex-1 text-ui-base leading-5">
        {intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
      </p>
      <AutomationSwitchToggle
        checked={checked}
        ariaLabel={intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
        onChange={onChange}
        color="blue"
        size="sm"
      />
    </div>
  );
}

/**
 * 系统级调度状态卡（specs/automation-system-scheduling.md）：展示 OS 注册调度模式、
 * 最近 tick 与漂移告警；开关执行 enable（安装 OS 注册，显式系统状态变更）/ disable。
 * 状态为 null（读取失败）时显示 app 模式兜底文案，不让诊断面拖垮列表。
 */
export function AutomationSystemSchedulingCard({
  status,
  busy,
  onToggle,
}: {
  status: AutomationSchedulingStatusView | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const systemOn = status?.config.mode === "system" && status.registration.installed;
  const statusLine = !systemOn
    ? intl.formatMessage({ id: "automations.scheduling.statusAppMode" })
    : intl.formatMessage({ id: "automations.scheduling.statusSystemMode" }, {
        kind: status?.registration.kind ?? "",
      });
  const lastTick = status?.config.lastTickAt
    ? `${intl.formatMessage({ id: "automations.scheduling.lastTickLabel" })}${new Date(
        status.config.lastTickAt,
      ).toLocaleString(locale)}`
    : intl.formatMessage({ id: "automations.scheduling.lastTickNever" });
  return (
    <div
      data-automations-system-scheduling
      className="flex min-h-11 w-full flex-col gap-1 overflow-hidden rounded-[10px] bg-surface px-3 py-3 text-foreground-subtle"
    >
      <div className="flex w-full items-center gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
          <AutomationInfoIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ui-base leading-5 text-foreground">
            {intl.formatMessage({ id: "automations.scheduling.title" })}
          </p>
          <p className="text-ui-sm leading-4">
            {statusLine} · {lastTick}
          </p>
        </div>
        <AutomationSwitchToggle
          checked={systemOn}
          ariaLabel={intl.formatMessage({ id: "automations.scheduling.title" })}
          onChange={busy ? () => {} : onToggle}
          color="blue"
          size="sm"
        />
      </div>
      {status?.warnings.length ? (
        <p className="pl-8 text-ui-sm leading-4 text-warning">{status.warnings.join("；")}</p>
      ) : null}
    </div>
  );
}

export function AutomationCreateDropdown({
  onViaChat,
  onManually,
}: {
  onViaChat: () => void;
  onManually: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <div className="inline-flex h-7 items-center overflow-hidden rounded-lg">
        <Button
          type="button"
          variant="default"
          size="default"
          className="rounded-none border-0"
          data-testid={TID_AUTOMATION_CREATE_MANUALLY}
          onClick={onManually}
        >
          {intl.formatMessage({ id: "automations.createManually" })}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="icon-md"
            data-testid={TID_AUTOMATION_CREATE_MENU}
            aria-label={intl.formatMessage({ id: "automations.create" })}
            className="!w-6 rounded-none border-0"
          >
            <AutomationChevronDownIcon size={14} />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-auto min-w-0"
      >
        <DropdownMenuItem className="pr-6" onSelect={onViaChat}>
          {intl.formatMessage({ id: "automations.createViaChat" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
