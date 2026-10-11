import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clapperboard, Pause, Play, SkipForward, Siren } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type {
  Alert,
  IncidentKind,
  IncidentRequest,
  Page,
  ReplayCommand,
  ReplayState,
  ReportSummary,
} from '@pic/shared';
import { api } from '../api/http';
import { ALERTS_KEY, REPLAY_KEY } from '../api/queries';
import Modal from './Modal';
import Popover from './Popover';
import { controlClass, primaryButtonClass, secondaryButtonClass } from './ui';

/** Pause/resume, speed and skip of the replay clock (admin only; the server enforces it too). */
export function ReplayControls() {
  const queryClient = useQueryClient();
  const replay = useQuery({
    queryKey: REPLAY_KEY,
    queryFn: () => api<ReplayState>('/admin/replay'),
  });
  const send = useMutation({
    mutationFn: (command: ReplayCommand) =>
      api<ReplayState>('/admin/replay', { method: 'POST', body: command }),
    onSuccess: (state) => queryClient.setQueryData(REPLAY_KEY, state),
  });
  const state = replay.data;

  return (
    <div className="grid gap-3">
      {state && (
        <p className="text-xs text-gray-500">
          {state.paused ? 'Paused' : 'Running'} · one snapshot per{' '}
          {state.tickMs / 1000 / state.speed} s
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={`${secondaryButtonClass} flex flex-1 items-center justify-center gap-1.5`}
          disabled={!state || send.isPending}
          onClick={() => send.mutate({ action: state?.paused ? 'resume' : 'pause' })}
        >
          {state?.paused ? (
            <Play className="size-3.5" aria-hidden />
          ) : (
            <Pause className="size-3.5" aria-hidden />
          )}
          {state?.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className={`${secondaryButtonClass} flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap`}
          disabled={!state || send.isPending}
          onClick={() => send.mutate({ action: 'jump_to_end' })}
          title="Skip to the last snapshot and pause there"
        >
          <SkipForward className="size-3.5" aria-hidden />
          Skip to last
        </button>
      </div>
      <label className="flex items-center justify-between gap-2 text-sm text-gray-700">
        Speed
        <select
          className={controlClass}
          disabled={!state || send.isPending}
          value={state?.speed ?? ''}
          onChange={(e) => send.mutate({ action: 'speed', value: Number(e.target.value) })}
        >
          {(state?.speeds ?? []).map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
      {(replay.isError || send.isError) && (
        <span role="alert" className="text-xs text-critical">
          {(send.error ?? replay.error)?.message}
        </span>
      )}
    </div>
  );
}

const KINDS: { value: IncidentKind; label: string; hint: string }[] = [
  {
    value: 'LATENCY_SPIKE',
    label: 'Latency spike',
    hint: 'Load time jumps above the critical threshold',
  },
  {
    value: 'REFRESH_FAILED',
    label: 'Refresh failed',
    hint: 'The latest refresh is reported as FAILED',
  },
];

/** All reports (the list endpoint is paged, so follow the pages). */
async function fetchAllReports(): Promise<ReportSummary[]> {
  const items: ReportSummary[] = [];
  for (let page = 1; ; page++) {
    const res = await api<Page<ReportSummary>>(`/reports?pageSize=100&page=${page}`);
    items.push(...res.items);
    if (res.items.length === 0 || items.length >= res.total) return items;
  }
}

function IncidentDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const reports = useQuery({ queryKey: ['reports', 'all'], queryFn: fetchAllReports });
  const [reportId, setReportId] = useState('');
  const [kind, setKind] = useState<IncidentKind>('LATENCY_SPIKE');
  const inject = useMutation({
    mutationFn: (body: IncidentRequest) => api<Alert>('/admin/incidents', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ALERTS_KEY });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reportId) inject.mutate({ reportId, kind });
  };

  return (
    <Modal title="Inject incident" onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4">
        <p className="text-sm text-gray-600">
          Creates a synthetic incident on one report at the current snapshot. The resulting alert is
          marked synthetic and is recorded in the audit log.
        </p>
        <label className="grid gap-1 text-sm text-gray-700">
          Report
          <select
            required
            className={controlClass}
            value={reportId}
            onChange={(e) => setReportId(e.target.value)}
            disabled={reports.isPending}
          >
            <option value="" disabled>
              {reports.isPending ? 'Loading reports…' : 'Choose a report'}
            </option>
            {reports.data?.map((r) => (
              <option key={r.reportId} value={r.reportId}>
                {r.reportId} · {r.reportName}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm text-gray-700">Kind</legend>
          {KINDS.map((k) => (
            <label key={k.value} className="flex items-start gap-2 text-sm text-gray-800">
              <input
                type="radio"
                name="kind"
                className="mt-1"
                checked={kind === k.value}
                onChange={() => setKind(k.value)}
              />
              <span>
                {k.label}
                <span className="block text-xs text-gray-500">{k.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {(inject.isError || reports.isError) && (
          <p role="alert" className="text-sm text-critical">
            {(inject.error ?? reports.error)?.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={primaryButtonClass}
            disabled={!reportId || inject.isPending}
          >
            {inject.isPending ? 'Injecting…' : 'Inject incident'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Admin-only header menu: replay controls and the incident dialog, behind one button. */
export default function AdminControls() {
  const [dialog, setDialog] = useState(false);
  return (
    <>
      <Popover
        label="Replay"
        icon={<Clapperboard className="size-4" aria-hidden />}
        panelClass="w-64 p-3"
      >
        <ReplayControls />
        <hr className="my-3 border-gray-200" />
        <button
          type="button"
          className={`${secondaryButtonClass} flex w-full items-center justify-center gap-1.5`}
          onClick={() => setDialog(true)}
        >
          <Siren className="size-3.5" aria-hidden />
          Inject incident
        </button>
      </Popover>
      {dialog && <IncidentDialog onClose={() => setDialog(false)} />}
    </>
  );
}
