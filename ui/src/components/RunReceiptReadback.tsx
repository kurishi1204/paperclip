import { useQuery } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { ApiError, detachInflightGet } from "../api/client";
import { accessApi } from "../api/access";
import { useAccountIdentity } from "../api/companies-query";
import type { NativeRunReceiptReadback } from "../api/heartbeat-receipts";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";

type RunScope = Pick<HeartbeatRun, "id" | "companyId" | "agentId" | "status"> & {
  // Older Run responses/types omit these server-owned fields: absence stays unknown.
  runtimeMode?: unknown; nativeIssueId?: unknown;
};

function receiptMatchesRun(receipt: NativeRunReceiptReadback, run: RunScope): boolean {
  return receipt.schema === "paperclip.native-run-receipt-readback.v1"
    && receipt.scope?.runId === run.id
    && receipt.scope.companyId === run.companyId
    && receipt.scope.agentId === run.agentId
    && Array.isArray(receipt.results?.rows)
    && Array.isArray(receipt.effects?.rows)
    && Array.isArray(receipt.authority?.environmentLeases?.rows)
    && typeof receipt.authority?.run?.status === "string"
    && Array.isArray(receipt.comparison?.reasons)
    && Boolean(receipt.finalization && receipt.decision);
}

function companyRunLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "開始待ち", running: "実行中として記録", succeeded: "正常終了として記録",
    interrupted: "中断として記録", scheduled_retry: "再実行予定として記録",
    failed: "失敗として記録", timed_out: "時間切れとして記録", cancelled: "取消として記録",
  };
  return labels[status] ?? "状態を確認できません";
}

function finalizationLabel(receipt: NativeRunReceiptReadback): string {
  const phase = receipt.finalization.record?.phase;
  if (receipt.finalization.state !== "found" || !phase) return "終了処理の記録が見つかりません";
  if (phase === "committed") return "終了処理の確定記録があります";
  if (phase === "terminal_failure") return "終了処理の失敗が記録されています";
  if (phase === "retryable_failure") return "終了処理が保留されています";
  return "終了処理の確定は未確認です";
}

function deliveryLabel(receipt: NativeRunReceiptReadback): string {
  if (!receipt.effects.complete) return "返却処理の一覧は全体未確認です";
  if (receipt.effects.state !== "found" || receipt.effects.rows.length === 0) {
    return "返却処理の配達記録は未確認です";
  }
  return receipt.effects.rows.every((effect) => effect.deliveryState === "delivered")
    ? "表示した処理の配達記録があります。相手の実読・採否は別に確認が必要です"
    : "未配達または状態未確認の処理が残っています";
}

function comparisonLabel(receipt: NativeRunReceiptReadback): string {
  if (receipt.comparison.state === "conflicting") return "結果または処理の紐付けに不一致があります";
  if (receipt.comparison.state === "accepted_same_hash") return "指定された固定版と受領記録が一致しています";
  if (receipt.comparison.state === "missing") return "このRunの結果受領記録は見つかりません。未処理の証明ではありません";
  if (!receipt.comparison.expectedCanonicalSha256) return "比較する固定版が指定されていないため、対象版との一致は未確認です";
  return "固定版との一致を確認できていません";
}

function TechnicalRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <div className="space-y-1"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono break-all">{value ?? "記録なし"}</dd></div>;
}

/** Only allowlisted metadata belongs here; never spread a Run or raw result into the view. */
export function RunReceiptReadbackView({ run, receipt, pending, error }: {
  run: RunScope;
  receipt?: NativeRunReceiptReadback | null;
  pending?: boolean;
  error?: unknown;
}) {
  // A failed authorization/read never leaves previously fetched owner metadata visible.
  const current = !error && receipt && receiptMatchesRun(receipt, run) ? receipt : null;
  const denied = error instanceof ApiError && error.status === 403;
  return <section aria-label="保存結果と会社への返却" className="rounded-lg border border-border p-4 space-y-3 text-sm">
    <h3 className="font-medium">保存結果と会社への返却</h3>
    {error ? <p role="alert" className="text-muted-foreground">{denied
      ? "この受領記録は会社所有者だけが確認できます。結果の有無は未確認です。"
      : "最新の受領記録を取得できません。結果の有無は未確認です。"}{current ? " 以下は前回取得した記録です。" : ""}</p> : null}
    {!current ? <p className="text-muted-foreground">{error ? "Runの実行状態と受領記録の取得可否は別に確認します。"
      : pending ? "受領記録を確認しています。"
      : receipt ? "対象Runと一致する受領記録を確認できません。"
      : "この応答には受領記録が含まれていません。対応するAPIからの取得が必要です。"}</p> : <>
      <p className="text-xs text-muted-foreground">確認時点 <time dateTime={current.observedAtUTC}>{formatDateTime(current.observedAtUTC, { includeSeconds: true })}</time>。担当や資源の現在の稼働を保証する情報ではありません。</p>
      <dl className="space-y-3">
        <div className="space-y-1"><dt className="font-medium">保存された結果</dt><dd>{current.results.rows.some((result) => result.schemaStatus === "accepted")
          ? "結果の受領記録が保存されています。"
          : current.results.complete ? "検証済みの結果受領記録は未確認です。" : "結果受領記録の一覧は全体未確認です。"}</dd>
          {!current.results.complete && <dd className="text-muted-foreground">取得範囲に上限があるため、結果全体は未確認です。</dd>}</div>
        <div className="space-y-1"><dt className="font-medium">会社Run・返却</dt><dd>{companyRunLabel(current.authority.run.status)}。{finalizationLabel(current)}</dd><dd>{deliveryLabel(current)}</dd></div>
        <div className="space-y-1"><dt className="font-medium">受領の照合</dt><dd>{comparisonLabel(current)}</dd>
          {!current.comparison.complete && <dd className="text-muted-foreground">照合に必要な結果全体を確認できていません。</dd>}
          {current.decision.state !== "found" && <dd className="text-muted-foreground">会社の処置判断との紐付けは未確認です。</dd>}
          {!current.authority.issue && <dd className="text-muted-foreground">元Taskの担当・処置の記録は未確認です。</dd>}
          {!current.authority.environmentLeases.complete && <dd className="text-muted-foreground">保持資源の記録は全体未確認です。</dd>}</div>
      </dl>
      <p className="text-xs text-muted-foreground">ここで確認できるのは技術上の保存・処理記録です。会社担当は、対象版のQA・採否と返却先の実受領を元の記録で確認してください。</p>
      <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">照合に使う技術記録</summary>
        <div className="pt-3 space-y-3">
          <dl className="space-y-2"><TechnicalRow label="Run" value={current.scope.runId} /><TechnicalRow label="照合状態" value={current.comparison.state} />
            <TechnicalRow label="終了処理" value={current.finalization.record?.phase} /><TechnicalRow label="終了処理の試行" value={current.finalization.record?.attempt} />
            <TechnicalRow label="終了処理の結果ID" value={current.finalization.record?.resultId} /><TechnicalRow label="終了処理の判定ID" value={current.finalization.record?.assessmentId} />
            <TechnicalRow label="処置判断" value={current.decision.record?.id} />
            <TechnicalRow label="処置の反映状態" value={current.decision.record?.applicationState} />
            <TechnicalRow label="Taskの実行Run" value={current.authority.issue?.executionRunId} /><TechnicalRow label="Taskの作業保有Run" value={current.authority.issue?.checkoutRunId} />
            <TechnicalRow label="照合理由" value={current.comparison.reasons.join(" · ") || null} /></dl>
          <div className="space-y-2"><p className="font-medium">結果受領記録</p>{current.results.rows.map((result) => <dl key={result.id} className="space-y-1"><TechnicalRow label="受領ID" value={result.id} /><TechnicalRow label="検証状態" value={result.schemaStatus} /><TechnicalRow label="結果SHA256" value={result.canonicalSha256} /><TechnicalRow label="保存日時" value={result.createdAt} /></dl>)}</div>
          <div className="space-y-2"><p className="font-medium">返却処理の記録</p>{current.effects.rows.map((effect) => <dl key={effect.id} className="space-y-1"><TechnicalRow label="処理ID" value={effect.id} /><TechnicalRow label="処理種別" value={effect.effectKind} /><TechnicalRow label="配達状態" value={effect.deliveryState} /></dl>)}</div>
          <div className="space-y-2"><p className="font-medium">保持資源の記録</p>{current.authority.environmentLeases.rows.map((lease) => <dl key={lease.id} className="space-y-1"><TechnicalRow label="記録ID" value={lease.id} /><TechnicalRow label="保持状態" value={lease.status} /><TechnicalRow label="後始末の状態" value={lease.cleanupStatus} /></dl>)}</div>
        </div>
      </details>
    </>}
  </section>;
}

function ReceiptUnavailable({ children }: { children: React.ReactNode }) {
  return <section aria-label="保存結果と会社への返却" className="rounded-lg border border-border p-4 space-y-3 text-sm">
    <h3 className="font-medium">保存結果と会社への返却</h3>
    <p className="text-muted-foreground">{children}</p>
  </section>;
}

function OwnerReceiptReadback({ run, viewerScope }: { run: RunScope; viewerScope: string }) {
  const query = useQuery({
    queryKey: queryKeys.runReceiptReadback(run.companyId, run.id, run.status, viewerScope),
    queryFn: ({ signal }) => heartbeatsApi.receiptReadback(run.id, { signal }),
    retry: false,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  // Remounts must obtain a fresh authorized response before showing cached data.
  return <RunReceiptReadbackView run={run}
    receipt={query.isFetchedAfterMount && !query.isFetching ? query.data?.receiptReadback : null}
    pending={query.isPending || query.isFetching} error={query.error} />;
}

export function RunReceiptReadback({ run }: { run: RunScope }) {
  const identity = useAccountIdentity();
  const supported = run.runtimeMode === "native" && typeof run.nativeIssueId === "string" && run.nativeIssueId.length > 0;
  const unsupported = (typeof run.runtimeMode === "string" && run.runtimeMode !== "native")
    || (run.runtimeMode === "native" && run.nativeIssueId === null);
  const access = useQuery({
    queryKey: queryKeys.runReceiptViewerAccess(identity.userId),
    queryFn: () => {
      // The shared client coalesces by URL, not account. Do not join an old viewer's request.
      detachInflightGet("/cli-auth/me");
      return accessApi.getCurrentBoardAccess();
    },
    enabled: supported && identity.settled && !identity.failed,
    retry: false,
    gcTime: 0,
    refetchOnMount: "always",
  });
  if (unsupported) return <ReceiptUnavailable>このRunはnative受領記録の表示対象外です。結果が存在しないという意味ではありません。</ReceiptUnavailable>;
  if (!supported) return <ReceiptUnavailable>このRunのnative実行情報は未確認です。保存結果が存在しないという意味ではありません。</ReceiptUnavailable>;
  if (!identity.settled || identity.failed || access.isError || !access.isFetchedAfterMount || access.isFetching || !access.data) {
    return <ReceiptUnavailable>閲覧者と会社所有者の権限を確認できていません。保存結果は未確認です。</ReceiptUnavailable>;
  }
  const viewer = access.data;
  // local_implicit/admin is not an owner grant. Even a local board needs the exact membership.
  const identityMatches = identity.userId !== null ? viewer.userId === identity.userId
    : viewer.source === "local_implicit" && viewer.userId === "local-board";
  if (!identityMatches || !viewer.userId) return <ReceiptUnavailable>閲覧者の認証文脈が一致しません。保存結果は未確認です。</ReceiptUnavailable>;
  const owner = viewer.memberships?.some((membership) => membership.companyId === run.companyId
    && membership.status === "active" && membership.membershipRole === "owner");
  if (!owner) return <ReceiptUnavailable>この受領記録は会社所有者だけが確認できます。保存結果は未確認です。</ReceiptUnavailable>;
  const viewerScope = JSON.stringify([identity.userId, viewer.userId, viewer.source, viewer.keyId]);
  return <OwnerReceiptReadback key={viewerScope} run={run} viewerScope={viewerScope} />;
}
